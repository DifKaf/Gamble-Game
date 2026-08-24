import { prisma } from '../db.js'
import { cached } from './cache.js'
import { ensureFeatureTables } from './ensureFeatureTables.js'

// Ежедневные квесты.
// Прогресс считается по раундам текущего дня. В базе лежит только факт получения награды.
const TZ_OFFSET_MIN = Number(process.env.WEEK_TZ_OFFSET_MINUTES || 180)
const TTL_MS = Number(process.env.QUESTS_TTL_MS || 10000)
const REWARD_SCALE = Number(process.env.QUEST_REWARD_SCALE || 1)

export type QuestKind = 'rounds' | 'wager' | 'variety' | 'multiplier'

export type QuestDef = {
	code: string
	kind: QuestKind
	title: string
	description: string
	target: number
	reward: number
	icon: string
}

const RAW_QUESTS: Array<QuestDef> = [
	{ code: 'rounds20', kind: 'rounds', title: 'Разминка', description: 'Сделай 20 ставок в любых играх', target: 20, reward: 500, icon: '🎯' },
	{ code: 'wager5000', kind: 'wager', title: 'Оборот', description: 'Прокрути 5 000 GC за день', target: 5000, reward: 1000, icon: '🔁' },
	{ code: 'variety3', kind: 'variety', title: 'Разнообразие', description: 'Сыграй в 3 разные игры', target: 3, reward: 750, icon: '🎲' },
	{ code: 'multi10', kind: 'multiplier', title: 'Крупный куш', description: 'Поймай выигрыш от ×10', target: 10, reward: 1500, icon: '💰' }
]

export const QUESTS: Array<QuestDef> = RAW_QUESTS.map((q) => ({
	...q,
	reward: Math.max(1, Math.round(q.reward * (REWARD_SCALE > 0 ? REWARD_SCALE : 1)))
}))

export function questByCode(code: string) {
	return QUESTS.find((q) => q.code === code) || null
}

export function dayRange(now: Date = new Date()) {
	const offsetMs = TZ_OFFSET_MIN * 60 * 1000
	const shifted = new Date(now.getTime() + offsetMs)
	const startShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0)
	const start = new Date(startShifted - offsetMs)
	const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
	const periodKey = new Date(startShifted).toISOString().slice(0, 10)
	return { start, end, periodKey }
}

export type QuestProgressItem = QuestDef & {
	current: number
	done: boolean
	claimed: boolean
}

export type QuestProgress = {
	periodKey: string
	resetAt: string
	quests: Array<QuestProgressItem>
	claimableReward: number
}

function isMissingRelation(err: any) {
	const msg = String(err?.message || err || '')
	return /questClaim|QuestClaim|does not exist|Unknown arg|Cannot read/i.test(msg)
}

async function loadClaims(userId: string, periodKey: string): Promise<string[]> {
	try {
		await ensureFeatureTables()
	} catch {}
	try {
		const del = (prisma as any).questClaim
		if (del) {
			const rows = await del.findMany({ where: { userId, periodKey }, select: { questCode: true } })
			return rows.map((c: any) => c.questCode)
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		const rows = await prisma.$queryRawUnsafe<Array<{ questCode: string }>>(
			`SELECT "questCode" FROM "QuestClaim" WHERE "userId" = $1 AND "periodKey" = $2`,
			userId,
			periodKey
		)
		return rows.map((r) => r.questCode)
	} catch {
		return []
	}
}

export async function createQuestClaim(data: { userId: string; questCode: string; periodKey: string; reward: bigint }, tx?: any) {
	const client = tx || prisma
	const del = (client as any).questClaim
	if (del) {
		return del.create({ data })
	}
	const { randomUUID } = await import('crypto')
	await client.$executeRawUnsafe(
		`INSERT INTO "QuestClaim" ("id","userId","questCode","periodKey","reward","claimedAt") VALUES ($1,$2,$3,$4,$5,NOW())`,
		randomUUID(),
		data.userId,
		data.questCode,
		data.periodKey,
		data.reward
	)
}

export async function questProgress(userId: string): Promise<QuestProgress> {
	const { start, end, periodKey } = dayRange()

	return cached(`quests:${userId}:${periodKey}`, TTL_MS, async () => {
		const where = { userId, status: 'FINISHED' as const, createdAt: { gte: start, lt: end } }

		let rounds = 0
		let wagered = 0
		let variety = 0
		let bestMultiplier = 0
		try {
			const [agg, groups] = await Promise.all([
				prisma.gameSession.aggregate({ where, _sum: { betAmount: true }, _max: { multiplier: true }, _count: { _all: true } }),
				prisma.gameSession.groupBy({ by: ['gameCode'], where })
			])
			rounds = agg._count?._all || 0
			wagered = Number(agg._sum?.betAmount || 0)
			variety = groups.length
			bestMultiplier = Number(agg._max?.multiplier || 0)
		} catch {}

		const claimedCodes = await loadClaims(userId, periodKey).catch(() => [] as string[])
		const claimed = new Set(claimedCodes)

		const quests = QUESTS.map((q) => {
			const current =
				q.kind === 'rounds' ? rounds : q.kind === 'wager' ? wagered : q.kind === 'variety' ? variety : bestMultiplier
			return {
				...q,
				current: Math.round(current * 100) / 100,
				done: current >= q.target,
				claimed: claimed.has(q.code)
			}
		})

		return {
			periodKey,
			resetAt: end.toISOString(),
			quests,
			claimableReward: quests.filter((q) => q.done && !q.claimed).reduce((sum, q) => sum + q.reward, 0)
		}
	})
}
