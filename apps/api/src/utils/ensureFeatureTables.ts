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

	// Биржа: заявки на P2P-обмен GC. Монеты продавца замораживаются в эскроу.
	`CREATE TABLE IF NOT EXISTS "ExchangeRequest" (
		"id" TEXT NOT NULL,
		"userId" TEXT NOT NULL,
		"buyerId" TEXT,
		"amountGc" BIGINT NOT NULL,
		"payoutMinor" BIGINT NOT NULL DEFAULT 0,
		"currency" TEXT NOT NULL DEFAULT 'RUB',
		"rateGcPerUnit" BIGINT NOT NULL DEFAULT 0,
		"feePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
		"method" TEXT NOT NULL,
		"destination" TEXT NOT NULL,
		"contact" TEXT,
		"status" TEXT NOT NULL DEFAULT 'OPEN',
		"disputeReason" TEXT,
		"adminNote" TEXT,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		"processedAt" TIMESTAMP(3),
		CONSTRAINT "ExchangeRequest_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_status_createdAt_idx" ON "ExchangeRequest"("status", "createdAt")`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_userId_createdAt_idx" ON "ExchangeRequest"("userId", "createdAt")`,
	`CREATE INDEX IF NOT EXISTS "ExchangeRequest_buyerId_createdAt_idx" ON "ExchangeRequest"("buyerId", "createdAt")`,
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banned" BOOLEAN NOT NULL DEFAULT false`,
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "banReason" TEXT`,

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
	`ALTER TABLE "SlotSession" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3)`,

	// Анти-гонка для бонусов (аудит бонусов/рефералов): если `prisma db push` на деплое
	// по каким-то причинам не применится (как раньше с SlotSession на Railway), эти таблицы/колонки
	// всё равно будут созданы на старте API, и атомарные защиты от гонок не сломаются из-за
	// отсутствующей структуры в базе.
	// gamesPlayed отсутствовал здесь и это ломало ВСЕ роуты, читающие пользователя
	// (включая /auth/telegram и /auth/dev), с ошибкой P2022 "column does not exist",
	// если `prisma db push` не был выполнен на проде после добавления фичи "удача новичка".
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "gamesPlayed" INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastWheelSpinAt" TIMESTAMP(3)`,
	`ALTER TABLE "DailyBonus" ADD COLUMN IF NOT EXISTS "dayKey" TEXT NOT NULL DEFAULT ''`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "DailyBonus_userId_dayKey_key" ON "DailyBonus"("userId", "dayKey")`,
	`CREATE TABLE IF NOT EXISTS "PromoCode" (
		"id" TEXT NOT NULL,
		"code" TEXT NOT NULL,
		"amount" BIGINT NOT NULL,
		"maxUses" INTEGER NOT NULL DEFAULT 1,
		"usedCount" INTEGER NOT NULL DEFAULT 0,
		"creatorId" TEXT NOT NULL,
		"creatorUsername" TEXT,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode"("code")`,
	`CREATE TABLE IF NOT EXISTS "PromoRedemption" (
		"id" TEXT NOT NULL,
		"code" TEXT NOT NULL,
		"userId" TEXT NOT NULL,
		"amount" BIGINT NOT NULL,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "PromoRedemption_code_userId_key" ON "PromoRedemption"("code", "userId")`,
	`CREATE INDEX IF NOT EXISTS "PromoRedemption_code_idx" ON "PromoRedemption"("code")`,
	`CREATE TABLE IF NOT EXISTS "ReferralWeeklyPayout" (
		"id" TEXT NOT NULL,
		"referrerId" TEXT NOT NULL,
		"referredId" TEXT NOT NULL,
		"weekKey" TEXT NOT NULL,
		"amount" BIGINT NOT NULL,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "ReferralWeeklyPayout_pkey" PRIMARY KEY ("id")
	)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS "ReferralWeeklyPayout_referrerId_referredId_weekKey_key" ON "ReferralWeeklyPayout"("referrerId", "referredId", "weekKey")`,

	// CatClicker: серверное сохранение прогресса, чтобы ПК и телефон видели один прогресс.
	`CREATE TABLE IF NOT EXISTS "CatClickerState" (
		"userId" TEXT NOT NULL,
		"paws" BIGINT NOT NULL DEFAULT 0,
		"mood" DOUBLE PRECISION NOT NULL DEFAULT 50,
		"gcToday" BIGINT NOT NULL DEFAULT 0,
		"dayKey" TEXT NOT NULL DEFAULT '',
		"upgrades" JSONB NOT NULL DEFAULT '{"food":0,"toy":0,"scratch":0,"bed":0}'::jsonb,
		"lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "CatClickerState_pkey" PRIMARY KEY ("userId")
	)`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "paws" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "mood" DOUBLE PRECISION NOT NULL DEFAULT 50`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "gcToday" BIGINT NOT NULL DEFAULT 0`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "dayKey" TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "upgrades" JSONB NOT NULL DEFAULT '{"food":0,"toy":0,"scratch":0,"bed":0}'::jsonb`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE "CatClickerState" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,

	// App settings: maintenance mode switch controlled by admin panel.
	`CREATE TABLE IF NOT EXISTS "AppSetting" (
		"key" TEXT NOT NULL,
		"value" JSONB NOT NULL DEFAULT '{}'::jsonb,
		"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
		CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
	)`
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