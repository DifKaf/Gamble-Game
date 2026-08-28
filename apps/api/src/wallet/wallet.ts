import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

/**
 * «Удача новичка»: первые ставки любого пользователя получают повышенный шанс
 * на бонусный кредит сверху результата игры, чтобы новые игроки чаще уходили
 * в плюс. Это отдельный маркетинговый бонус (списывается с баланса казино),
 * а не подмена честного результата игры — сама игра всегда считается честно.
 * После стартового окна бонус плавно затухает до нуля, и дальше действуют
 * обычные (прибыльные для казино) шансы игр.
 */
const NEW_PLAYER_LUCK_FULL_GAMES = 3
const NEW_PLAYER_LUCK_TAPER_GAMES = 6
const NEW_PLAYER_LUCK_CHANCE = 0.7
const NEW_PLAYER_LUCK_MULTIPLIER = 1.5

function luckState(gamesPlayed: number): { chance: number; multiplier: number } {
	if (gamesPlayed < NEW_PLAYER_LUCK_FULL_GAMES) {
		return { chance: NEW_PLAYER_LUCK_CHANCE, multiplier: NEW_PLAYER_LUCK_MULTIPLIER }
	}
	if (gamesPlayed < NEW_PLAYER_LUCK_TAPER_GAMES) {
		const t =
			(gamesPlayed - NEW_PLAYER_LUCK_FULL_GAMES) /
			(NEW_PLAYER_LUCK_TAPER_GAMES - NEW_PLAYER_LUCK_FULL_GAMES)
		return {
			chance: NEW_PLAYER_LUCK_CHANCE * (1 - t),
			multiplier: NEW_PLAYER_LUCK_MULTIPLIER - (NEW_PLAYER_LUCK_MULTIPLIER - 1) * t,
		}
	}
	return { chance: 0, multiplier: 1 }
}

/**
 * Считает эту ставку как «сыгранную игру» для счётчика удачи новичка и, если
 * пользователь ещё в стартовом окне, с вероятностью chance доначисляет бонус
 * сверху ставки. Вызывать один раз на реальную ставку (списание BET / settleRound).
 */
async function grantNewPlayerLuck(tx: Tx, userId: string, stake: bigint, source?: string) {
	if (stake <= 0n) return
	const user = await tx.user.findUnique({ where: { id: userId } })
	if (!user) return
	const playedBefore = user.gamesPlayed
	await tx.user.update({ where: { id: userId }, data: { gamesPlayed: { increment: 1 } } })
	const { chance, multiplier } = luckState(playedBefore)
	if (chance <= 0 || multiplier <= 1) return
	if (Math.random() > chance) return
	const bonus = BigInt(Math.round(Number(stake) * (multiplier - 1)))
	if (bonus <= 0n) return
	const fresh = await tx.user.findUnique({ where: { id: userId } })
	if (!fresh) return
	const before = fresh.balance
	const after = before + bonus
	await tx.user.update({ where: { id: userId }, data: { balance: after } })
	await tx.walletTransaction.create({
		data: {
			userId,
			type: 'BONUS',
			amount: bonus,
			balanceBefore: before,
			balanceAfter: after,
			source: 'new-player-luck',
			metadata: { gamesPlayed: playedBefore, multiplier, forSource: source ?? null },
		},
	})
}

export async function applyBalanceChange(p: {
	tx: Tx
	userId: string
	amount: bigint
	type: 'BET' | 'WIN' | 'BONUS' | 'REFUND' | 'ADMIN_ADJUSTMENT'
	source?: string
	metadata?: any
}) {
	const user = await p.tx.user.findUnique({ where: { id: p.userId } })
	if (!user) throw new Error('User not found')
	const before = user.balance
	const after = before + p.amount
	if (after < 0n) throw new Error('Insufficient balance')
	const updated = await p.tx.user.update({ where: { id: p.userId }, data: { balance: after } })
	await p.tx.walletTransaction.create({
		data: {
			userId: p.userId,
			type: p.type,
			amount: p.amount,
			balanceBefore: before,
			balanceAfter: after,
			source: p.source,
			metadata: p.metadata,
		},
	})
	if (p.type === 'BET') {
		await grantNewPlayerLuck(p.tx, p.userId, -p.amount, p.source)
	}
	return updated
}

/**
 * Закрывает раунд одной строкой в кошельке вместо двух.
 *
 * Раньше каждый спин писал строку BET и строку WIN. На бесплатном Neon с 0.5 ГБ
 * это главный расход места: вторая строка не несёт новой информации — ставка и
 * выигрыш всё равно лежат в GameSession. Здесь пишется итог (payout − stake), а сами
 * слагаемые сохраняются в metadata, так что отчётность не теряется.
 */
export async function settleRound(p: {
	tx: Tx
	userId: string
	stake: bigint
	payout: bigint
	source: string
	metadata?: any
}) {
	const user = await p.tx.user.findUnique({ where: { id: p.userId } })
	if (!user) throw new Error('User not found')

	const before = user.balance
	if (before < p.stake) throw new Error('Insufficient balance')

	const net = p.payout - p.stake
	const after = before + net
	await p.tx.user.update({ where: { id: p.userId }, data: { balance: after } })

	await p.tx.walletTransaction.create({
		data: {
			userId: p.userId,
			type: p.payout > 0n ? 'WIN' : 'BET',
			amount: net,
			balanceBefore: before,
			balanceAfter: after,
			source: p.source,
			metadata: {
				...(p.metadata || {}),
				stake: Number(p.stake),
				payout: Number(p.payout),
				net: Number(net),
			},
		},
	})

	await grantNewPlayerLuck(p.tx, p.userId, p.stake, p.source)

	return p.tx.user.findUniqueOrThrow({ where: { id: p.userId } })
}
