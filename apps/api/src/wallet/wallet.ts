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
	// Атомарный UPDATE вместо "прочитать баланс -> сложить -> записать": под нагрузкой
	// два параллельных изменения баланса одного игрока могли перетереть друг друга
	// (lost update), и часть денег бесследно исчезала или начислялась мимо баланса.
	const rows = await tx.$queryRawUnsafe(
		`UPDATE "User" SET balance = balance + $1 WHERE id = $2 RETURNING balance`,
		bonus,
		userId,
	)
	if (!rows.length) return
	const after = rows[0].balance
	const before = after - bonus
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
	// Атомарный condition-UPDATE: баланс и проверка "не в минус" считаются в одном
	// SQL-выражении на актуальной (а не прочитанной секунды назад) строке. Раньше
	// баланс читался отдельным SELECT и затем перезаписывался вычисленным числом —
	// под параллельными запросами (например, два быстрых перевода/ставки подряд)
	// это давало classic lost update: одна из операций могла быть перетёрта другой.
	const rows = await p.tx.$queryRawUnsafe(
		`UPDATE "User" SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= 0 RETURNING balance`,
		p.amount,
		p.userId,
	)
	if (!rows.length) {
		const exists = await p.tx.user.findUnique({ where: { id: p.userId }, select: { id: true } })
		if (!exists) throw new Error('User not found')
		throw new Error('Insufficient balance')
	}
	const after = rows[0].balance
	const before = after - p.amount
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
	return p.tx.user.findUniqueOrThrow({ where: { id: p.userId } })
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
	const net = p.payout - p.stake
	// См. комментарий в applyBalanceChange: условный UPDATE считает баланс и
	// проверяет достаточность средств одной атомарной операцией на актуальной
	// строке, без гонки между параллельными раундами одного игрока.
	const rows = await p.tx.$queryRawUnsafe(
		`UPDATE "User" SET balance = balance + $1 WHERE id = $2 AND balance + $1 >= 0 RETURNING balance`,
		net,
		p.userId,
	)
	if (!rows.length) {
		const exists = await p.tx.user.findUnique({ where: { id: p.userId }, select: { id: true } })
		if (!exists) throw new Error('User not found')
		throw new Error('Insufficient balance')
	}
	const after = rows[0].balance
	const before = after - net

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
