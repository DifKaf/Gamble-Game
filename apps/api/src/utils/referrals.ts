import { randomUUID } from 'crypto'
import { prisma } from '../db.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { publicPlayerId, parsePlayerId } from './playerId.js'
import { ensureFeatureTables } from './ensureFeatureTables.js'
import { weekRange } from './weeklyStats.js'

function isMissingRelation(err: any) {
	const msg = String(err?.message || err || '')
	return /referral|Referral|does not exist|Unknown arg|Cannot read/i.test(msg)
}

function referralDelegate(client: any = prisma) {
	return client?.referral || null
}

async function ready() {
	try { await ensureFeatureTables() } catch {}
}

// Реферальная программа.
//
// Приглашающий получает бонус сразу и второй бонус, когда новичок наберёт
// оборот (чтобы не было выгодно плодить пустые аккаунты ради регистрационного бонуса).
const INVITER_BONUS = BigInt(Number(process.env.REFERRAL_BONUS_INVITER || 0))
const INVITEE_BONUS = BigInt(Number(process.env.REFERRAL_BONUS_INVITEE || 0))
const WEEK_SHARE_PCT = Math.max(0, Number(process.env.REFERRAL_WEEK_SHARE_PCT || 0.5))
// Привязать приглашение можно только в первые часы после регистрации,
// иначе старые игроки будут «приглашать» друг друга ради бонусов.
const ATTACH_WINDOW_MS = Number(process.env.REFERRAL_ATTACH_WINDOW_HOURS || 72) * 60 * 60 * 1000

export function inviteCode(user: { playerId?: number | null; id: string }) {
	return `ref_${publicPlayerId(user as any)}`
}

export function inviteLink(user: { playerId?: number | null; id: string }) {
	const bot = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim()
	const code = inviteCode(user)
	const appName = String(process.env.TELEGRAM_APP_NAME || '').trim()
	const origin = String(process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '').trim()
	const TG_BASE = String.fromCharCode(104,116,116,112,115) + "://t.me/"
	if (bot) {
		const base = appName ? TG_BASE + bot + "/" + appName : TG_BASE + bot
		return { url: `${base}?startapp=${code}`, code, configured: true }
	}
	if (origin) return { url: `${origin}?ref=${code}`, code, configured: true }
	return { url: code, code, configured: false }
}

// Принимаем и 'ref_120001', и '120001', и '#120001'.
export function parseRefCode(raw: unknown): number | null {
	const clean = String(raw || '').trim().replace(/^ref[_-]?/i, '')
	if (!clean) return null
	return parsePlayerId(clean)
}

export type AttachResult = {
	ok: boolean
	reason: string
	bonus: number
	referrer?: { playerId: number | string; username: string | null; name: string }
}

// Привязывает игрока к пригласившему. Идемпотентно: повторные вызовы не дают бонус снова.
export async function attachReferral(userId: string, rawCode: unknown): Promise<AttachResult> {
	const code = parseRefCode(rawCode)
	if (!code) return { ok: false, reason: 'invalid_code', bonus: 0 }

	await ready()
	const user = await prisma.user.findUnique({ where: { id: userId } })
	let existing: any = null
	try {
		const del = referralDelegate()
		existing = del
			? await del.findUnique({ where: { referredId: userId } })
			: (await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "Referral" WHERE "referredId" = $1 LIMIT 1`, userId))[0] || null
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	if (!user) return { ok: false, reason: 'user_not_found', bonus: 0 }
	if (existing) return { ok: false, reason: 'already_attached', bonus: 0 }

	if (Date.now() - new Date(user.createdAt).getTime() > ATTACH_WINDOW_MS) {
		return { ok: false, reason: 'window_closed', bonus: 0 }
	}

	const referrer = await prisma.user.findUnique({ where: { playerId: code } })
	if (!referrer) return { ok: false, reason: 'referrer_not_found', bonus: 0 }
	if (referrer.id === userId) return { ok: false, reason: 'self_invite', bonus: 0 }

	try {
		await prisma.$transaction(async (tx) => {
			const del = referralDelegate(tx)
			if (del) {
				await del.create({
					data: { referrerId: referrer.id, referredId: userId, registrationBonus: INVITER_BONUS }
				})
			} else {
				await tx.$executeRawUnsafe(
					`INSERT INTO "Referral" ("id","referrerId","referredId","registrationBonus","milestoneBonus","createdAt") VALUES ($1,$2,$3,$4,0,NOW())`,
					randomUUID(),
					referrer.id,
					userId,
					INVITER_BONUS
				)
			}
			if (INVITER_BONUS > 0n) {
				await applyBalanceChange({
					tx,
					userId: referrer.id,
					amount: INVITER_BONUS,
					type: 'BONUS',
					source: 'referral-signup',
					metadata: { referredId: userId, referredPlayerId: publicPlayerId(user) }
				})
			}
			if (INVITEE_BONUS > 0n) {
				await applyBalanceChange({
					tx,
					userId,
					amount: INVITEE_BONUS,
					type: 'BONUS',
					source: 'referral-welcome',
					metadata: { referrerId: referrer.id, referrerPlayerId: publicPlayerId(referrer) }
				})
			}
		})
	} catch (err: any) {
		if (String(err?.code) === 'P2002') return { ok: false, reason: 'already_attached', bonus: 0 }
		throw err
	}

	return {
		ok: true,
		reason: 'attached',
		bonus: Number(INVITEE_BONUS),
		referrer: {
			playerId: publicPlayerId(referrer),
			username: referrer.username,
			name: referrer.firstName || referrer.username || 'Игрок'
		}
	}
}

// 0.5% от ставок приглашённого за текущую неделю. Платится при открытии «Друзья».
export async function payReferralMilestones(referrerId: string) {
	if (WEEK_SHARE_PCT <= 0) return { paid: 0, count: 0 }

	await ready()
	let friends: Array<{ id: string; referredId: string }> = []
	try {
		const del = referralDelegate()
		friends = del
			? await del.findMany({ where: { referrerId }, select: { id: true, referredId: true } })
			: await prisma.$queryRawUnsafe(`SELECT "id", "referredId" FROM "Referral" WHERE "referrerId" = $1`, referrerId)
	} catch (err) {
		if (!isMissingRelation(err)) throw err
		return { paid: 0, count: 0 }
	}
	if (!friends.length) return { paid: 0, count: 0 }

	const { start, end } = weekRange()
	const weekKey = start.toISOString()
	let paid = 0n
	let count = 0

	for (const row of friends) {
		const agg = await prisma.gameSession.aggregate({
			where: { userId: row.referredId, status: 'FINISHED', createdAt: { gte: start, lt: end } },
			_sum: { betAmount: true }
		})
		const weeklyWager = Number(agg._sum?.betAmount || 0)
		const due = Math.floor(weeklyWager * WEEK_SHARE_PCT / 100)
		if (due <= 0) continue

		const alreadyRows = await prisma.walletTransaction.findMany({
			where: {
				userId: referrerId,
				source: 'referral-week',
				createdAt: { gte: start, lt: end }
			},
			select: { amount: true, metadata: true }
		})
		const already = alreadyRows.reduce((s, t: any) => {
			const meta = t.metadata || {}
			if (meta.referredId === row.referredId && meta.weekKey === weekKey) return s + Number(t.amount || 0)
			return s
		}, 0)
		const delta = due - already
		if (delta <= 0) continue

		await prisma.$transaction(async (tx) => {
			await applyBalanceChange({
				tx,
				userId: referrerId,
				amount: BigInt(delta),
				type: 'BONUS',
				source: 'referral-week',
				metadata: { referredId: row.referredId, weekKey, weeklyWager, percent: WEEK_SHARE_PCT }
			})
			const del = referralDelegate(tx)
			if (del) {
				await del.update({ where: { id: row.id }, data: { milestoneBonus: { increment: BigInt(delta) } } }).catch(async () => {
					await tx.$executeRawUnsafe(`UPDATE "Referral" SET "milestoneBonus" = "milestoneBonus" + $2 WHERE "id" = $1`, row.id, delta)
				})
			} else {
				await tx.$executeRawUnsafe(`UPDATE "Referral" SET "milestoneBonus" = "milestoneBonus" + $2 WHERE "id" = $1`, row.id, delta)
			}
		})
		paid += BigInt(delta)
		count++
	}

	return { paid: Number(paid), count }
}

export type ReferralStats = Awaited<ReturnType<typeof referralStats>>

export async function referralStats(userId: string) {
	const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
	const link = inviteLink(user)
	await ready()

	let rows: any[] = []
	try {
		const del = referralDelegate()
		rows = del
			? await del.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' }, take: 50 })
			: await prisma.$queryRawUnsafe(`SELECT * FROM "Referral" WHERE "referrerId" = $1 ORDER BY "createdAt" DESC LIMIT 50`, userId)
	} catch (err) {
		if (!isMissingRelation(err)) throw err
		rows = []
	}

	const ids = rows.map((r) => r.referredId)
	const friends = ids.length
		? await prisma.user.findMany({
				where: { id: { in: ids } },
				select: { id: true, playerId: true, username: true, firstName: true, photoUrl: true }
			})
		: []
	const byId = new Map(friends.map((f) => [f.id, f]))

	const { start, end } = weekRange()
	const wagerRows = ids.length
		? await prisma.gameSession.groupBy({
				by: ['userId'],
				where: { userId: { in: ids }, status: 'FINISHED', createdAt: { gte: start, lt: end } },
				_sum: { betAmount: true }
			})
		: []
	const wagerById = new Map(wagerRows.map((w) => [w.userId, Number(w._sum?.betAmount || 0)]))

	let invitedBy: any = null
	try {
		const del = referralDelegate()
		invitedBy = del
			? await del.findUnique({ where: { referredId: userId } })
			: (await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "Referral" WHERE "referredId" = $1 LIMIT 1`, userId))[0] || null
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	let inviter: any = null
	if (invitedBy) {
		const r = await prisma.user.findUnique({
			where: { id: invitedBy.referrerId },
			select: { id: true, playerId: true, username: true, firstName: true, photoUrl: true }
		})
		if (r) inviter = { playerId: publicPlayerId(r), username: r.username, name: r.firstName || r.username || 'Игрок', photoUrl: r.photoUrl }
	}

	let earned = 0
	const list = rows.map((r) => {
		const f: any = byId.get(r.referredId)
		const wagered = wagerById.get(r.referredId) || 0
		earned += Number(r.registrationBonus) + Number(r.milestoneBonus)
		return {
			playerId: f ? publicPlayerId(f) : null,
			username: f ? f.username : null,
			name: f ? f.firstName || f.username || 'Игрок' : 'Игрок',
			photoUrl: f ? f.photoUrl : null,
			joinedAt: r.createdAt,
			wagered,
			weekShare: Math.floor(wagered * WEEK_SHARE_PCT / 100),
			earned: Number(r.registrationBonus) + Number(r.milestoneBonus),
			milestoneDone: true,
			milestoneProgress: 100
		}
	})

	return {
		link: link.url,
		code: link.code,
		configured: link.configured,
		playerId: publicPlayerId(user),
		rewards: {
			inviter: Number(INVITER_BONUS),
			invitee: Number(INVITEE_BONUS),
			weekSharePct: WEEK_SHARE_PCT
		},
		invitedCount: rows.length,
		totalEarned: earned,
		inviter,
		friends: list
	}
}
