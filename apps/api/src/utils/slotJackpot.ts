import { randomInt } from 'crypto'
import { prisma } from '../db.js'

// Прогрессивный джекпот Drunkard Gate. Пополняется только из ставок игроков,
// выплачивается только накопленное — казино на нём никогда не теряет.
export const JACKPOT_GAME = 'drunkard-gate'
export const JACKPOT_PCT = Number(process.env.DG_JACKPOT_PCT ?? 1.5)
export const JACKPOT_MIN = Number(process.env.DG_JACKPOT_MIN ?? 20000)
// Шанс срыва = ставка / JACKPOT_ODDS (ставка 100 -> 1 из 20 000, 10 000 -> 1 из 200).
export const JACKPOT_ODDS = Number(process.env.DG_JACKPOT_ODDS ?? 2000000)

let ensured: Promise<void> | null = null
export function ensureJackpotTable() {
	if (!ensured) {
		ensured = (async () => {
			await prisma.$executeRawUnsafe(
				`CREATE TABLE IF NOT EXISTS "SlotJackpot" ("game" TEXT PRIMARY KEY, "amount" BIGINT NOT NULL DEFAULT 0, "lastWinAmount" BIGINT NOT NULL DEFAULT 0, "lastWinUserId" TEXT, "lastWinName" TEXT, "lastWinAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
			)
			await prisma.$executeRawUnsafe(
				`INSERT INTO "SlotJackpot" ("game", "amount") VALUES ($1, 0) ON CONFLICT ("game") DO NOTHING`,
				JACKPOT_GAME,
			)
		})().catch((e) => {
			ensured = null
			throw e
		})
	}
	return ensured
}

export async function getJackpot() {
	await ensureJackpotTable()
	const rows: any[] = await prisma.$queryRawUnsafe(
		`SELECT "amount", "lastWinAmount", "lastWinName", "lastWinAt" FROM "SlotJackpot" WHERE "game" = $1`,
		JACKPOT_GAME,
	)
	const r = rows[0] || {}
	return {
		amount: Number(r.amount || 0),
		min: JACKPOT_MIN,
		lastWin: r.lastWinAt ? { amount: Number(r.lastWinAmount || 0), name: r.lastWinName || null, at: r.lastWinAt } : null,
	}
}

/** Внутри транзакции базового спина: пополняет пул и разыгрывает его. */
export async function contributeAndRoll(tx: any, stake: number, userId: string, name: string | null) {
	const add = Math.max(0, Math.floor((stake * JACKPOT_PCT) / 100))
	const rows: any[] = await tx.$queryRawUnsafe(
		`UPDATE "SlotJackpot" SET "amount" = "amount" + $2, "updatedAt" = NOW() WHERE "game" = $1 RETURNING "amount"`,
		JACKPOT_GAME,
		add,
	)
	const pool = Number(rows[0]?.amount || 0)
	if (pool < JACKPOT_MIN) return { pool, won: 0 }
	const chance = Math.min(1, stake / JACKPOT_ODDS)
	if (randomInt(0, 1_000_000_000) >= Math.floor(chance * 1_000_000_000)) return { pool, won: 0 }
	const hit: any[] = await tx.$queryRawUnsafe(
		`UPDATE "SlotJackpot" SET "amount" = 0, "lastWinAmount" = $2, "lastWinUserId" = $3, "lastWinName" = $4, "lastWinAt" = NOW(), "updatedAt" = NOW() WHERE "game" = $1 AND "amount" = $2 RETURNING "amount"`,
		JACKPOT_GAME,
		pool,
		userId,
		name,
	)
	if (!hit.length) return { pool, won: 0 }
	return { pool: 0, won: pool }
}
