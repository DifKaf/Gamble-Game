import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange, settleRound } from '../wallet/wallet.js'
import { buyBonusCost, playSpin, stakeFor } from '../games/dogHouse/engine.js'
import { newSeed, seedHash } from '../games/dogHouse/rng.js'
import {
	BUY_BONUS_COST_MULTIPLIER,
	ENGINE_VERSION,
	MAX_BET,
	MIN_BET,
	publicPaytable,
} from '../games/dogHouse/config.js'

const SOURCE = 'dog-house'
const MAX_BUY_BET = Math.floor(MAX_BET / BUY_BONUS_COST_MULTIPLIER)

const spinSchema = z.object({
	betAmount: z.number().int().min(MIN_BET).max(MAX_BET),
	requestId: z.string().min(1).max(120).optional(),
	clientSeed: z.string().max(120).optional(),
})
const buySchema = z.object({
	betAmount: z.number().int().min(MIN_BET).max(MAX_BUY_BET),
	requestId: z.string().min(1).max(120).optional(),
	clientSeed: z.string().max(120).optional(),
})

function isDogRound(round: any) {
	return (round?.lastSpin as any)?.game === 'dog-house'
}

async function findDogRound(tx: any, userId: string) {
	const rows = await tx.slotSession.findMany({
		where: { userId, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
		orderBy: { createdAt: 'desc' },
		take: 8,
	})
	return rows.find(isDogRound) || null
}

function roundView(round: any) {
	if (!round) return null
	const spin = round.lastSpin || {}
	return {
		id: round.id,
		game: 'dog-house',
		stake: Number(round.stake),
		purchased: round.purchased,
		freeSpinsLeft: round.freeSpinsLeft,
		freeSpinsTotal: round.freeSpinsTotal,
		roundWin: Number(round.roundWin),
		status: round.status,
		stickyWilds: spin.stickyWilds || [],
	}
}

const CAT_HOUSE_LOCKED = true

export async function dogHouseRoutes(app: FastifyInstance) {
	app.get('/config', async () => publicPaytable())

	app.get('/state', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		if (CAT_HOUSE_LOCKED) return rep.code(423).send({ error: 'Слот временно закрыт' })
		const user = await getAuthUser(req)
		const round = await findDogRound(prisma, user.id)
		return { balance: Number(user.balance), engineVersion: ENGINE_VERSION, round: roundView(round) }
	})

	app.post('/spin', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		if (CAT_HOUSE_LOCKED) return rep.code(423).send({ error: 'Слот временно закрыт' })
		const user = await getAuthUser(req)
		const parsed = spinSchema.safeParse(req.body)
		if (!parsed.success) return rep.code(400).send({ error: `Ставка от ${MIN_BET} до ${MAX_BET}` })
		const body = parsed.data
		const clientSeed = body.clientSeed ?? ''
		try {
			return await prisma.$transaction(async (tx) => {
				const active = await findDogRound(tx, user.id)
				if (active) {
					const nonce = active.nonce + 1
					const locked = await tx.slotSession.updateMany({
						where: { id: active.id, nonce: active.nonce, status: 'CREATED' },
						data: { nonce },
					})
					if (!locked.count) throw new Error('spin locked')
					const last = (active.lastSpin || {}) as any
					const outcome = playSpin({
						stake: Number(active.stake),
						seed: active.seed,
						nonce,
						clientSeed: active.clientSeed || clientSeed,
						mode: 'free',
						freeSpinsLeft: active.freeSpinsLeft,
						stickyWilds: last.stickyWilds || [],
					})
					let balance = Number((await tx.user.findUniqueOrThrow({ where: { id: user.id } })).balance)
					if (outcome.win > 0) {
						const updated = await applyBalanceChange({
							tx, userId: user.id, amount: BigInt(outcome.win), type: 'WIN', source: SOURCE,
							metadata: { mode: 'free', roundId: active.id, win: outcome.win },
						})
						balance = Number(updated.balance)
					}
					const roundWin = active.roundWin + BigInt(outcome.win)
					const finished = outcome.freeSpinsLeft <= 0
					const updatedRound = await tx.slotSession.update({
						where: { id: active.id },
						data: {
							freeSpinsLeft: outcome.freeSpinsLeft,
							freeSpinsTotal: active.freeSpinsTotal + outcome.freeSpinsAwarded,
							roundWin,
							status: finished ? 'FINISHED' : 'CREATED',
							finishedAt: finished ? new Date() : null,
							lastRequestId: body.requestId ?? null,
							lastSpin: outcome as any,
						},
					})
					return { balance, spin: outcome, round: roundView(updatedRound), roundWin: Number(roundWin) }
				}

				const stake = stakeFor(body.betAmount)
				const seed = newSeed()
				const outcome = playSpin({ stake, seed, nonce: 1, clientSeed, mode: 'base' })
				const final = await settleRound({
					tx, userId: user.id, stake: BigInt(stake), payout: BigInt(outcome.win), source: SOURCE,
					metadata: { mode: 'base', scatters: outcome.scatters },
				})
				await tx.gameSession.create({
					data: {
						requestId: body.requestId,
						userId: user.id,
						gameCode: 'DRUNKARD_GATE',
						status: 'FINISHED',
						betAmount: BigInt(stake),
						winAmount: BigInt(outcome.win),
						multiplier: outcome.multiplier,
						result: outcome as any,
						finishedAt: new Date(),
					},
				})
				let round = null
				if (outcome.freeSpinsAwarded > 0) {
					round = await tx.slotSession.create({
						data: {
							userId: user.id,
							stake: BigInt(stake),
							freeSpinsLeft: outcome.freeSpinsLeft,
							freeSpinsTotal: outcome.freeSpinsAwarded,
							seed,
							clientSeed,
							nonce: 1,
							lastSpin: { ...outcome, stickyWilds: [] } as any,
						},
					})
				}
				return {
					balance: Number(final.balance),
					spin: outcome,
					round: roundView(round),
					fairness: { engineVersion: ENGINE_VERSION, seedHash: seedHash(seed), nonce: 1, seed },
				}
			})
		} catch (e: any) {
			if (e?.message === 'Insufficient balance') return rep.code(400).send({ error: 'Недостаточно Gamble Coin' })
			throw e
		}
	})

	app.post('/buy-bonus', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		if (CAT_HOUSE_LOCKED) return rep.code(423).send({ error: 'Слот временно закрыт' })
		const user = await getAuthUser(req)
		const parsed = buySchema.safeParse(req.body)
		if (!parsed.success) return rep.code(400).send({ error: `Ставка от ${MIN_BET} до ${MAX_BUY_BET}` })
		const body = parsed.data
		const cost = buyBonusCost(body.betAmount)
		try {
			return await prisma.$transaction(async (tx) => {
				const active = await findDogRound(tx, user.id)
				if (active) return rep.code(409).send({ error: 'Фриспины уже идут' })
				const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
				if (fresh.balance < BigInt(cost)) throw new Error('Insufficient balance')
				const updated = await applyBalanceChange({
					tx, userId: user.id, amount: -BigInt(cost), type: 'BET', source: SOURCE,
					metadata: { kind: 'buy-bonus', stake: body.betAmount },
				})
				const seed = newSeed()
				const round = await tx.slotSession.create({
					data: {
						userId: user.id,
						stake: BigInt(stakeFor(body.betAmount)),
						cost: BigInt(cost),
						purchased: true,
						freeSpinsLeft: 8,
						freeSpinsTotal: 8,
						seed,
						clientSeed: body.clientSeed || '',
						nonce: 0,
						lastSpin: { game: 'dog-house', stickyWilds: [] } as any,
					},
				})
				return { balance: Number(updated.balance), cost, round: roundView(round) }
			})
		} catch (e: any) {
			if (e?.message === 'Insufficient balance') return rep.code(400).send({ error: 'Недостаточно Gamble Coin' })
			throw e
		}
	})
}
