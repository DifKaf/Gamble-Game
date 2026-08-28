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
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_status_createdAt_idx" ON "ExchangeRequest"("status", "createdAt")`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "payoutMinor" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'RUB'`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "rateGcPerUnit" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "feePercent" DOUBLE PRECISION NOT NULL DEFAULT 0`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "method" TEXT NOT NULL DEFAULT 'card'`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "destination" TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "contact" TEXT`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'PENDING'`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "adminNote" TEXT`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3)`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "buyerId" TEXT`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "takenAt" TIMESTAMP(3)`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3)`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "receiptUrl" TEXT`,
	`ALTER TABLE "ExchangeRequest" ADD COLUMN IF NOT EXISTS "disputeReason" TEXT`,
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banned" BOOLEAN NOT NULL DEFAULT false`,
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banReason" TEXT`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_buyerId_createdAt_idx" ON "ExchangeRequest"("buyerId", "createdAt")`,
	`UPDATE "ExchangeRequest" SET "status" = 'OPEN' WHERE "status" = 'PENDING'`,

	// Бонусный раунд слотов (Drunkard Gate, The Dog House): фриспины живут на сервере.
	// `prisma db push` в start-скрипте не создавал эту таблицу на Railway (среда
	// игнорировала обновлённый start-скрипт), поэтому создаём её здесь же, как и
	// остальные таблицы без каталога миграций — гарантированно на каждом старте API.
	`CREATE TABLE IF NOT EXISTS "SlotSession" (
		"id" TEXT NOT NULL,
		"userId" TEXT NOT NULL,
		"gameCode" "GameCode" NOT NULL DEFAULT 'DRUNKARD_GATE',
		"status" "GameSessionStatus" NOT NULL DEFAULT 'CREATED',
		"stake" BIGINT NOT NULL,
		"cost" BIGINT NOT NULL DEFAULT 0,
		"ante" BOOLEAN NOT NULL DEFAULT false,
		"purchased" BOOLEAN NOT NULL DEFAULT false,
		"freeSpinsLeft" INTEGER NOT NULL DEFAULT 0,
		"freeSpinsTotal" INTEGER NOT NULL DEFAULT 0,
		"globalMult" DOUBLE PRECISION NOT NULL DEFAULT 0,
		"roundWin" BIGINT NOT NULL DEFAULT 0,
		"seed" TEXT NOT NULL,
		"clientSeed" TEXT NOT NULL DEFAULT '',
		"nonce" INTEGER NOT NULL DEFAULT 0,
		"lastRequestId" TEXT,
		"lastSpin" JSONB,
		"triggerGameSessionId" TEXT,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		"finishedAt" TIMESTAMP(3),
		CONSTRAINT "SlotSession_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE INDEX IF NOT EXISTS "SlotSession_userId_status_createdAt_idx" ON "SlotSession"("userId", "status", "createdAt")`,
	// На случай если таблица уже была создана раньше в неполном виде — докатываем недостающие колонки.
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "cost" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "ante" BOOLEAN NOT NULL DEFAULT false`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "purchased" BOOLEAN NOT NULL DEFAULT false`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "freeSpinsLeft" INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "freeSpinsTotal" INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "globalMult" DOUBLE PRECISION NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "roundWin" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "clientSeed" TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "nonce" INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "lastRequestId" TEXT`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "lastSpin" JSONB`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "triggerGameSessionId" TEXT`,
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3)`
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
