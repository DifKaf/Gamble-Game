import { FastifyInstance } from 'fastify'
import { getAuthUser } from '../auth/getUser.js'
import { prisma } from '../db.js'
import { publicPlayerId } from '../utils/playerId.js'
import { cached } from '../utils/cache.js'
import { weeklyStats } from '../utils/weeklyStats.js'
import { profilePayload } from '../utils/profile.js'

// Лидерборд одинаков для всех, пересчитывать его на каждый запрос смысла нет.
const LEADERBOARD_TTL_MS = Number(process.env.LEADERBOARD_TTL_MS || 45000)

const publicSelect = { id: true, playerId: true, username: true, firstName: true, lastName: true, photoUrl: true, balance: true } as const

function toPublic(u: any) {
	return {
		id: u.id,
		playerId: publicPlayerId(u),
		username: u.username,
		firstName: u.firstName,
		lastName: u.lastName,
		photoUrl: u.photoUrl,
		balance: Number(u.balance)
	}
}

export async function meRoutes(app: FastifyInstance) {
	app.get('/', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		return {
			id: u.id,
			playerId: publicPlayerId(u as any),
			telegramId: u.telegramId.toString(),
			username: u.username,
			firstName: u.firstName,
			lastName: u.lastName,
			photoUrl: u.photoUrl,
			balance: Number(u.balance),
			banned: Boolean((u as any).banned),
			admin: String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || "").split(",").map((x)=>x.trim()).includes(String(u.telegramId||"")),
			createdAt: u.createdAt
		}
	})

	app.get('/profile', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		return profilePayload(u.id)
	})

	app.get('/leaderboard', { preHandler: [(app as any).authenticate] }, async () => {
		return cached('leaderboard:50', LEADERBOARD_TTL_MS, async () => {
			// Админы не должны попадать в лидерборд по балансу, так что берём запас с запасом
			// и добираем telegramId только для проверки, наружу не отдаётся.
			const adminCount = String(process.env.ADMIN_TELEGRAM_IDS || '').split(',').filter((s) => s.trim()).length
			const rows = await prisma.user.findMany({
				orderBy: { balance: 'desc' },
				take: 50 + adminCount,
				select: { ...publicSelect, telegramId: true }
			})
			const users = rows.filter((u) => !String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || "").split(",").map((x)=>x.trim()).includes(String(u.telegramId||""))).slice(0, 50)
			return { users: users.map(toPublic) }
		})
	})

	app.get('/weekly-top', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		return cached('weekly-top:10:' + u.id, 30000, async () => {
			const now = new Date()
			const day = now.getUTCDay() || 7
			const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 1, 0, 0, 0))
			const prizes = [30000,20000,15000,10000,7000,6000,5000,3000,2500,1500]
			const rows = await prisma.gameSession.groupBy({
				by: ['userId'],
				where: { status: 'FINISHED', finishedAt: { gte: start } },
				_sum: { winAmount: true, betAmount: true },
				_count: { _all: true },
				orderBy: { _sum: { winAmount: 'desc' } },
				take: 10
			})
			const ids = rows.map((r) => r.userId)
			const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: publicSelect }) : []
			const byId = new Map(users.map((x:any)=>[x.id,x]))
			const items = rows.map((r:any, i:number) => {
				const usr:any = byId.get(r.userId) || {}
				return { place: i+1, prize: prizes[i] || 0, user: toPublic(usr), weeklyWin: Number(r._sum.winAmount || 0), weeklyBet: Number(r._sum.betAmount || 0), games: Number(r._count._all || 0), mine: r.userId === u.id }
			})
			return { prizePool: 100000, periodStart: start.toISOString(), periodEnd: 'Конец недели', items }
		})
	})

	// Статистика за текущую неделю (окно с понедельника, обнуляется само).
	app.get('/stats', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		return weeklyStats(u.id)
	})

	app.get('/maintenance', { preHandler: [(app as any).authenticate] }, async () => {
		const rows = await prisma.$queryRawUnsafe('SELECT "value" FROM "AppSetting" WHERE "key"=$1 LIMIT 1', 'maintenance') as any[]
		const value = rows[0]?.value || {}
		return { enabled: Boolean(value.enabled), message: value.message || 'Технические работы' }
	})

	// Поиск получателя перевода: по @username ИЛИ по началу цифрового ID.
	app.get('/users/search', { preHandler: [(app as any).authenticate] }, async (req) => {
		const q = String((req.query as any).q || '').replace(/^@/, '').trim()
		if (q.length < 1) return { users: [] }

		const byUsername = await prisma.user.findMany({
			where: { username: { contains: q, mode: 'insensitive' } },
			take: 8,
			select: publicSelect
		})

		let byPlayerId: any[] = []
		const digits = q.replace(/\D/g, '')
		if (digits.length >= 2) {
			// Префиксный поиск по ID: "1000" находит 100012, 100047 и т.д.
			let rows: Array<{ id: string }> = []
			try {
				rows = await prisma.$queryRawUnsafe(
					'SELECT id FROM "User" WHERE CAST("playerId" AS TEXT) LIKE $1 ORDER BY "playerId" ASC LIMIT 8',
					digits + '%'
				)
			} catch (err) {
				// Старая база без колонки playerId: подсказки по username остаются работать.
				req.log?.warn({ err }, 'playerId search unavailable')
			}
			const ids = rows.map((r) => r.id)
			if (ids.length) {
				byPlayerId = await prisma.user.findMany({ where: { id: { in: ids } }, select: publicSelect })
			}
		}

		const seen = new Set<string>()
		const users: any[] = []
		for (const u of [...byPlayerId, ...byUsername]) {
			if (seen.has(u.id)) continue
			seen.add(u.id)
			users.push(toPublic(u))
		}
		return { users: users.slice(0, 8) }
	})

	// CatClicker is hidden/disabled. Compatibility endpoints are instant no-op
	// so old cached clients do not hit DB or load the server.
	app.get('/cat-clicker', { preHandler: [(app as any).authenticate] }, async () => {
		return { disabled: true, paws: 0, mood: 100, gcToday: 0, day: new Date().toISOString().slice(0,10), up: { food: 0, toy: 0, scratch: 0, bed: 0 }, last: Date.now() }
	})

	app.post('/cat-clicker', { preHandler: [(app as any).authenticate] }, async () => {
		return { ok: true, disabled: true }
	})

}
