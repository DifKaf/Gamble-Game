import { prisma } from '../db.js'

function numEnv(name: string, fallback: number) {
	const n = Number(process.env[name])
	return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function antifraudConfig() {
	return {
		maxTransferPerDay: numEnv('AF_MAX_TRANSFER_DAY', 250000),
		maxTransferOnce: numEnv('AF_MAX_TRANSFER_ONCE', 100000),
		winCooldownMs: numEnv('AF_WIN_COOLDOWN_MS', 30 * 60 * 1000),
		bigWinGc: numEnv('AF_BIG_WIN_GC', 50000)
	}
}

export function isUserBanned(user: any) {
	return Boolean(user?.banned || user?.isBanned)
}

export function banError() {
	return { error: 'Аккаунт заблокирован. Напишите в поддержку.' }
}

export async function dailyOutgoing(userId: string, sources: string[]) {
	const from = new Date()
	from.setHours(0, 0, 0, 0)
	const rows = await prisma.walletTransaction.findMany({
		where: {
			userId,
			source: { in: sources },
			createdAt: { gte: from },
			amount: { lt: 0 }
		},
		select: { amount: true }
	})
	return rows.reduce((s, r) => s + Math.abs(Number(r.amount || 0)), 0)
}

export async function assertCanTransfer(user: any, amount: number) {
	if (isUserBanned(user)) throw new Error('BANNED')
	const cfg = antifraudConfig()
	if (amount > cfg.maxTransferOnce) {
		throw new Error(`TRANSFER_ONCE:${cfg.maxTransferOnce}`)
	}
	const used = await dailyOutgoing(user.id, ['transfer-out'])
	if (used + amount > cfg.maxTransferPerDay) {
		throw new Error(`TRANSFER_DAY:${Math.max(0, cfg.maxTransferPerDay - used)}`)
	}
}

export async function recentBigWin(userId: string) {
	const cfg = antifraudConfig()
	if (!cfg.bigWinGc || !cfg.winCooldownMs) return null
	const since = new Date(Date.now() - cfg.winCooldownMs)
	const win = await prisma.walletTransaction.findFirst({
		where: {
			userId,
			type: 'WIN',
			amount: { gte: BigInt(cfg.bigWinGc) },
			createdAt: { gte: since }
		},
		orderBy: { createdAt: 'desc' }
	})
	if (!win) return null
	const unlockAt = new Date(win.createdAt.getTime() + cfg.winCooldownMs)
	if (unlockAt.getTime() <= Date.now()) return null
	return { unlockAt, amount: Number(win.amount) }
}


export function mapAntifraudError(err: any) {
	const msg = String(err?.message || '')
	if (msg === 'BANNED') return { code: 403, error: 'Аккаунт заблокирован. Напишите в поддержку.' }
	if (msg.startsWith('TRANSFER_ONCE:')) return { code: 400, error: `Максимум за один перевод — ${msg.split(':')[1]} GC` }
	if (msg.startsWith('TRANSFER_DAY:')) return { code: 400, error: `Дневной лимит переводов. Осталось ${msg.split(':')[1]} GC` }
	return null
}
