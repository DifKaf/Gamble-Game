import { prisma } from '../db.js'

// Индексы, без которых частые запросы читают таблицу целиком.
// Создаются на старте, так же как playerId: в проекте нет папки migrations,
// а ручной psql на проде делать никто не будет.
const STATEMENTS: Array<{ name: string; sql: string }> = [
	{
		// Новая игра Limbo: значение enum добавляем без миграции.
		name: 'TransactionType_DEPOSIT',
		sql: `ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'DEPOSIT'`,
	},
	{
		name: 'GameCode_LIMBO',
		sql: `ALTER TYPE "GameCode" ADD VALUE IF NOT EXISTS 'LIMBO'`,
	},
	{
		// Лидерборд: ORDER BY balance DESC LIMIT 50 без индекса = сортировка всех игроков.
		name: 'User_balance_idx',
		sql: 'CREATE INDEX IF NOT EXISTS "User_balance_idx" ON "User"("balance" DESC)',
	},
	{
		// Лив-история по каждой игре: WHERE gameCode + status ORDER BY createdAt DESC.
		name: 'GameSession_gameCode_status_createdAt_idx',
		sql: 'CREATE INDEX IF NOT EXISTS "GameSession_gameCode_status_createdAt_idx" ON "GameSession"("gameCode", "status", "createdAt" DESC)',
	},
	{
		// Нужен очистке старых строк кошелька.
		name: 'WalletTransaction_createdAt_idx',
		sql: 'CREATE INDEX IF NOT EXISTS "WalletTransaction_createdAt_idx" ON "WalletTransaction"("createdAt")',
	},
	{
		// История переводов конкретного игрока.
		name: 'WalletTransaction_userId_source_createdAt_idx',
		sql: 'CREATE INDEX IF NOT EXISTS "WalletTransaction_userId_source_createdAt_idx" ON "WalletTransaction"("userId", "source", "createdAt" DESC)',
	},
]

export async function ensureIndexes(log?: { info: (msg: string) => void; warn: (msg: string) => void }) {
	const info = (msg: string) => (log ? log.info(msg) : console.log(msg))
	const warn = (msg: string) => (log ? log.warn(msg) : console.warn(msg))

	const created: string[] = []
	for (const statement of STATEMENTS) {
		try {
			await prisma.$executeRawUnsafe(statement.sql)
			created.push(statement.name)
		} catch (err: any) {
			// Нет прав на DDL или таблицы ещё нет — не повод не поднимать API.
			warn(`index ${statement.name} skipped: ${err?.message || err}`)
		}
	}
	if (created.length) info(`indexes ready: ${created.join(', ')}`)
}
