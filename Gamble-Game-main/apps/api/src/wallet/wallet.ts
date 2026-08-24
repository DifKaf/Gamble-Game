import { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient

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
	const updated = await p.tx.user.update({ where: { id: p.userId }, data: { balance: after } })

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

	return updated
}
