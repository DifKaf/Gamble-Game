import { prisma } from '../db.js'
import { weeklyStats } from './weeklyStats.js'

export type RankInfo = {
	level: number
	title: string
	xp: number
	nextXp: number | null
	progress: number
}

const LEVELS = [
	{ level: 1, title: 'Новичок', xp: 0 },
	{ level: 2, title: 'Игрок', xp: 25000 },
	{ level: 3, title: 'Завсегдатай', xp: 100000 },
	{ level: 4, title: 'Профи', xp: 350000 },
	{ level: 5, title: 'Ветеран', xp: 1000000 },
	{ level: 6, title: 'Легенда', xp: 3000000 }
]

export function rankFromXp(xp: number): RankInfo {
	const value = Math.max(0, Number(xp) || 0)
	let current = LEVELS[0]
	for (const row of LEVELS) {
		if (value >= row.xp) current = row
	}
	const next = LEVELS.find((row) => row.level === current.level + 1) || null
	const span = next ? next.xp - current.xp : 1
	const done = next ? Math.max(0, value - current.xp) : 1
	return {
		level: current.level,
		title: current.title,
		xp: value,
		nextXp: next ? next.xp : null,
		progress: next ? Math.min(100, Math.round((done / span) * 100)) : 100
	}
}

export async function lifetimeWagerForUser(userId: string) {
	const agg = await prisma.gameSession.aggregate({
		where: { userId, status: 'FINISHED' },
		_sum: { betAmount: true, winAmount: true },
		_max: { winAmount: true },
		_count: { _all: true }
	})
	return {
		wagered: Number(agg._sum.betAmount || 0n),
		won: Number(agg._sum.winAmount || 0n),
		best: Number(agg._max.winAmount || 0n),
		rounds: agg._count._all
	}
}

export function badgesFor(stats: { wagered: number; won: number; best: number; rounds: number }, week: { wagered: number }) {
	const list: Array<{ id: string; title: string; hint: string; unlocked: boolean }> = [
		{ id: 'first', title: 'Первая ставка', hint: 'Сыграйте любой раунд', unlocked: stats.rounds > 0 },
		{ id: 'hot', title: 'Горячая неделя', hint: 'Отыграйте 25 000 GC за неделю', unlocked: week.wagered >= 25000 },
		{ id: 'hunter', title: 'Охотник', hint: 'Лучший выигрыш от 10 000 GC', unlocked: stats.best >= 10000 },
		{ id: 'highroller', title: 'Хайроллер', hint: 'Отыграйте 250 000 GC всего', unlocked: stats.wagered >= 250000 },
		{ id: 'legend', title: 'Легенда зала', hint: 'Отыграйте 1 000 000 GC', unlocked: stats.wagered >= 1000000 }
	]
	return list
}

export async function profilePayload(userId: string) {
	const [life, week] = await Promise.all([lifetimeWagerForUser(userId), weeklyStats(userId)])
	return {
		rank: rankFromXp(life.wagered),
		lifetime: life,
		week,
		badges: badgesFor(life, week)
	}
}
