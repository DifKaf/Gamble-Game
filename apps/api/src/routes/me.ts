import { FastifyInstance } from 'fastify'
import { getAuthUser } from '../auth/getUser.js'
import { prisma } from '../db.js'
import { publicPlayerId } from '../utils/playerId.js'

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
			createdAt: u.createdAt
		}
	})

	app.get('/leaderboard', { preHandler: [(app as any).authenticate] }, async () => {
		const users = await prisma.user.findMany({ orderBy: { balance: 'desc' }, take: 50, select: publicSelect })
		return { users: users.map(toPublic) }
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
			const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
				'SELECT id FROM "User" WHERE CAST("playerId" AS TEXT) LIKE $1 ORDER BY "playerId" ASC LIMIT 8',
				digits + '%'
			)
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
