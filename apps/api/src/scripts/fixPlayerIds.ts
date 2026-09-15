import 'dotenv/config'
import { prisma } from '../db.js'
import { ensurePlayerIds } from '../utils/ensurePlayerIds.js'

// Ручной запуск: npm run fix:player-ids
// То же самое, что делает API на старте, но без поднятия сервера.
await ensurePlayerIds()

const users = (await prisma.$queryRawUnsafe(
	'SELECT "playerId", username FROM "User" ORDER BY "playerId" ASC LIMIT 50'
)) as Array<{ playerId: number; username: string | null }>
for (const u of users) console.log(u.playerId, u.username ? '@' + u.username : '')

await prisma.$disconnect()
