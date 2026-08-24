import { prisma } from '../db.js'

// Создаёт таблицы для рефералов, квестов и биржи, если их ещё нет.
//
// В проекте нет каталога миграций (схема доводится до нужного вида на старте,
// как в ensurePlayerIds/ensureIndexes), поэтому новые фичи тоже приезжают
// вместе с деплоем API: достаточно перезалить сервер.
//
// Все шаги идемпотентные — повторный запуск ничего не ломает.
const STATEMENTS: Array<string> = [
	// Рефералы: кто кого пригласил и какие бонусы уже выплачены.
	`CREATE TABLE IF NOT EXISTS "Referral" (
		"id" TEXT NOT NULL,
		"referrerId" TEXT NOT NULL,
		"referredId" TEXT NOT NULL,
		"registrationBonus" BIGINT NOT NULL DEFAULT 0,
		"milestoneBonus" BIGINT NOT NULL DEFAULT 0,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
	)`,
	// Один игрок может быть приглашён только один раз.
	`CREATE UNIQUE INDEX IF NOT EXISTS "Referral_referredId_key" ON "Referral"("referredId")`,
	`CREATE INDEX IF NOT EXISTS "Referral_referrerId_createdAt_idx" ON "Referral"("referrerId", "createdAt")`,

	// Квесты: храним только факт получения награды, прогресс считается по раундам.
	`CREATE TABLE IF NOT EXISTS "QuestClaim" (
		"id" TEXT NOT NULL,
		"userId" TEXT NOT NULL,
		"questCode" TEXT NOT NULL,
		"periodKey" TEXT NOT NULL,
		"reward" BIGINT NOT NULL DEFAULT 0,
		"claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "QuestClaim_pkey" PRIMARY KEY ("id")
	)`,
	// Награду за один квест можно забрать один раз в сутки.
	`CREATE UNIQUE INDEX IF NOT EXISTS "QuestClaim_userId_questCode_periodKey_key" ON "QuestClaim"("userId", "questCode", "periodKey")`,
	`CREATE INDEX IF NOT EXISTS "QuestClaim_userId_claimedAt_idx" ON "QuestClaim"("userId", "claimedAt")`,

	// Биржа: заявки на обмен GC. Выплата подтверждается вручную оператором.
	`CREATE TABLE IF NOT EXISTS "ExchangeRequest" (
		"id" TEXT NOT NULL,
		"userId" TEXT NOT NULL,
		"amountGc" BIGINT NOT NULL,
		"payoutMinor" BIGINT NOT NULL DEFAULT 0,
		"currency" TEXT NOT NULL DEFAULT 'RUB',
		"rateGcPerUnit" BIGINT NOT NULL DEFAULT 0,
		"feePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
		"method" TEXT NOT NULL,
		"destination" TEXT NOT NULL,
		"contact" TEXT,
		"status" TEXT NOT NULL DEFAULT 'PENDING',
		"adminNote" TEXT,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		"processedAt" TIMESTAMP(3),
		CONSTRAINT "ExchangeRequest_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_userId_createdAt_idx" ON "ExchangeRequest"("userId", "createdAt")`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_status_createdAt_idx" ON "ExchangeRequest"("status", "createdAt")`
]

export async function ensureFeatureTables(log?: { info: (msg: string) => void; warn: (msg: string) => void }) {
	const info = (msg: string) => (log ? log.info(msg) : console.log(msg))
	const warn = (msg: string) => (log ? log.warn(msg) : console.warn(msg))

	let applied = 0
	for (const sql of STATEMENTS) {
		try {
			await prisma.$executeRawUnsafe(sql)
			applied++
		} catch (err: any) {
			// Не роняем API из-за прав на DDL или гонки двух инстансов на старте.
			warn(`ensureFeatureTables step skipped: ${err?.message || err}`)
		}
	}
	info(`feature tables ready: ${applied}/${STATEMENTS.length} statements ok`)
}
