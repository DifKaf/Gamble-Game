import { prisma } from '../db.js'
import { cached } from './cache.js'

// Недельная статистика игрока.
//
// Неделя — это окно с понедельника 00:00 по МСК до следующего понедельника.
// Счётчики нигде не хранятся и не требуют крона: сумма всегда считается по раундам
// внутри текущего окна, поэтому в понедельник она обнуляется сама собой.

const TZ_OFFSET_MIN = Number(process.env.WEEK_TZ_OFFSET_MINUTES || 180) // МСК = UTC+3
const TTL_MS = Number(process.env.WEEKLY_STATS_TTL_MS || 20000)

export type WeekRange = { start: Date; end: Date }

/** Границы текущей игровой недели. */
export function weekRange(now: Date = new Date()): WeekRange {
	const shifted = new Date(now.getTime() + TZ_OFFSET_MIN * 60000)
	const weekday = (shifted.getUTCDay() + 6) % 7 // 0 = понедельник
	const startShifted = Date.UTC(
		shifted.getUTCFullYear(),
		shifted.getUTCMonth(),
		shifted.getUTCDate() - weekday,
		0,
		0,
		0,
		0
	)
	const start = new Date(startShifted - TZ_OFFSET_MIN * 60000)
	const end = new Date(start.getTime() + 7 * 86400000)
	return { start, end }
}

export type WeeklyStats = {
	wagered: number
	won: number
	best: number
	rounds: number
	weekStart: string
	weekEnd: string
}

/** Сумма ставок, выигрышей и лучший выигрыш игрока за текущую неделю. */
export async function weeklyStats(userId: string): Promise<WeeklyStats> {
	const { start, end } = weekRange()
	return cached(`weekly:${userId}:${start.getTime()}`, TTL_MS, async () => {
		const agg = await prisma.gameSession.aggregate({
			where: { userId, status: 'FINISHED', createdAt: { gte: start, lt: end } },
			_sum: { betAmount: true, winAmount: true },
			_max: { winAmount: true },
			_count: { _all: true },
		})
		return {
			wagered: Number(agg._sum.betAmount || 0n),
			won: Number(agg._sum.winAmount || 0n),
			best: Number(agg._max.winAmount || 0n),
			rounds: agg._count._all,
			weekStart: start.toISOString(),
			weekEnd: end.toISOString(),
		}
	})
}
