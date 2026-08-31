import { FastifyInstance } from 'fastify'
import { getAuthUser } from '../auth/getUser.js'
import { prisma } from '../db.js'
import { publicPlayerId } from '../utils/playerId.js'
import { cached } from '../utils/cache.js'
import { weeklyStats } from '../utils/weeklyStats.js'
import { profilePayload } from '../utils/profile.js'
import { isExchangeAdmin } from '../utils/exchange.js'

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
			admin: isExchangeAdmin(u.telegramId),
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
			const users = rows.filter((u) => !isExchangeAdmin(u.telegramId)).slice(0, 50)
			return { users: users.map(toPublic) }
		})
	})

	// Статистика за текущую неделю (окно с понедельника, обнуляется само).
	app.get('/stats', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		return weeklyStats(u.id)
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
				rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
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
}
