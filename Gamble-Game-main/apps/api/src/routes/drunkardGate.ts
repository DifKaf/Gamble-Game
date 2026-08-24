import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange, settleRound } from '../wallet/wallet.js'
import { playSpin, stakeFor } from '../games/drunkardGate/engine.js'
import { newSeed, seedHash } from '../games/drunkardGate/rng.js'
import {
	BUY_BONUS_COST_MULTIPLIER,
	ENGINE_VERSION,
	FREE_SPINS_AWARD,
	MAX_BET,
	MIN_BET,
	publicPaytable,
} from '../games/drunkardGate/config.js'

const SOURCE = 'drunkard-gate'
/** Стоимость покупки бонуса не должна выходить за максимальную ставку. */
const MAX_BUY_BET = Math.floor(MAX_BET / BUY_BONUS_COST_MULTIPLIER)

const spinSchema = z.object({
	betAmount: z.number().int().min(MIN_BET).max(MAX_BET),
	ante: z.boolean().optional(),
	requestId: z.string().min(1).max(120).optional(),
	clientSeed: z.string().max(120).optional(),
})

const buySchema = z.object({
	betAmount: z.number().int().min(MIN_BET).max(MAX_BUY_BET),
	requestId: z.string().min(1).max(120).optional(),
	clientSeed: z.string().max(120).optional(),
})

type SpinRecord = {
	game: 'drunkard-gate'
	kind: 'spin'
	engineVersion: string
	mode: 'base' | 'free'
	seed: string
	clientSeed: string
	nonce: number
	stake: number
	ante: boolean
	freeSpinsLeftBefore: number
	globalMultBefore: number
	win: number
	multiplier: number
	scatters: number
	cascades: number
	freeSpinsAwarded: number
}

/** Сжатая запись спина для БД: из неё спин восстанавливается покадрово. */
function toRecord(args: {
	outcome: ReturnType<typeof playSpin>
	seed: string
	clientSeed: string
	freeSpinsLeftBefore: number
	globalMultBefore: number
}): SpinRecord {
	const { outcome } = args
	return {
		game: 'drunkard-gate',
		kind: 'spin',
		engineVersion: outcome.engineVersion,
		mode: outcome.mode,
		seed: args.seed,
		clientSeed: args.clientSeed,
		nonce: outcome.nonce,
		stake: outcome.stake,
		ante: outcome.ante,
		freeSpinsLeftBefore: args.freeSpinsLeftBefore,
		globalMultBefore: args.globalMultBefore,
		win: outcome.win,
		multiplier: outcome.multiplier,
		scatters: outcome.scatters,
		cascades: outcome.cascades,
		freeSpinsAwarded: outcome.freeSpinsAwarded,
	}
}

/** Повторное проигрывание спина из записи (идемпотентные ретраи и аудит). */
function replay(record: SpinRecord) {
	return playSpin({
		seed: record.seed,
		nonce: record.nonce,
		clientSeed: record.clientSeed,
		stake: record.stake,
		ante: record.ante,
		mode: record.mode,
		freeSpinsLeft: record.freeSpinsLeftBefore,
		globalMult: record.globalMultBefore,
	})
}

function roundView(round: any) {
	if (!round) return null
	return {
		roundId: round.id,
		stake: Number(round.stake),
		ante: round.ante,
		purchased: round.purchased,
		freeSpinsLeft: round.freeSpinsLeft,
		freeSpinsTotal: round.freeSpinsTotal,
		globalMult: round.globalMult,
		roundWin: Number(round.roundWin),
		status: round.status,
	}
}

/**
 * Слот Drunkard Gate. Вся математика считается здесь; клиент получает готовый
 * сценарий анимации и актуальный баланс. Старый мост /wallet/game-adjust больше не нужен.
 */
export async function drunkardGateRoutes(app: FastifyInstance) {
	// Пейтейбл и правила — чтобы клиент ничего не дублировал у себя.
	app.get('/config', async () => publicPaytable())

	// Восстановление состояния после перезагрузки Mini App посреди бонусного раунда.
	app.get('/state', { preHandler: [(app as any).authenticate] }, async (req) => {
		const user = await getAuthUser(req)
		const round = await prisma.slotSession.findFirst({
			where: { userId: user.id, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
			orderBy: { createdAt: 'desc' },
		})
		return {
			balance: Number(user.balance),
			engineVersion: ENGINE_VERSION,
			round: roundView(round),
			fairness: round ? { seedHash: seedHash(round.seed), nonce: round.nonce } : null,
		}
	})

	// Обычный спин или следующий фриспин активного раунда.
	app.post('/spin', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		const user = await getAuthUser(req)
		const parsed = spinSchema.safeParse(req.body)
		if (!parsed.success) {
			return rep.code(400).send({ error: `Bet amount must be from ${MIN_BET} to ${MAX_BET}` })
		}
		const body = parsed.data
		const clientSeed = body.clientSeed ?? ''

		// Идемпотентность базовых спинов: повторный запрос не списывает ставку второй раз.
		if (body.requestId) {
			const existing = await prisma.gameSession.findUnique({ where: { requestId: body.requestId } })
			if (existing?.result && (existing.result as any).kind === 'spin') {
				const record = existing.result as SpinRecord
				const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
				return {
					replay: true,
					balance: Number(fresh.balance),
					spin: replay(record),
					round: roundView(
						await prisma.slotSession.findFirst({
							where: { userId: user.id, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
							orderBy: { createdAt: 'desc' },
						}),
					),
				}
			}
		}

		try {
			return await prisma.$transaction(async (tx) => {
				const active = await tx.slotSession.findFirst({
					where: { userId: user.id, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
					orderBy: { createdAt: 'desc' },
				})

				// ─── Фриспин: бесплатно, ставка и ante берутся из раунда, а не из запроса.
				if (active) {
					if (body.requestId && active.lastRequestId === body.requestId && active.lastSpin) {
						const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
						return {
							replay: true,
							balance: Number(fresh.balance),
							spin: replay(active.lastSpin as SpinRecord),
							round: roundView(active),
						}
					}

					const nonce = active.nonce + 1
					// Оптимистичная блокировка: два параллельных спина одного раунда невозможны.
					const locked = await tx.slotSession.updateMany({
						where: { id: active.id, nonce: active.nonce, status: 'CREATED' },
						data: { nonce },
					})
					if (locked.count === 0) {
						return rep.code(409).send({ error: 'Spin already in progress' })
					}

					const outcome = playSpin({
						seed: active.seed,
						nonce,
						clientSeed: active.clientSeed ?? '',
						stake: Number(active.stake),
						ante: active.ante,
						mode: 'free',
						freeSpinsLeft: active.freeSpinsLeft,
						globalMult: active.globalMult,
					})

					let balance = Number((await tx.user.findUniqueOrThrow({ where: { id: user.id } })).balance)
					if (outcome.win > 0) {
						const updated = await applyBalanceChange({
							tx,
							userId: user.id,
							amount: BigInt(outcome.win),
							type: 'WIN',
							source: SOURCE,
							metadata: { mode: 'free', roundId: active.id, nonce, win: outcome.win },
						})
						balance = Number(updated.balance)
					}

					const roundWin = active.roundWin + BigInt(outcome.win)
					const finished = outcome.freeSpinsLeft <= 0
					const record = toRecord({
						outcome,
						seed: active.seed,
						clientSeed: active.clientSeed ?? '',
						freeSpinsLeftBefore: active.freeSpinsLeft,
						globalMultBefore: active.globalMult,
					})

					const updatedRound = await tx.slotSession.update({
						where: { id: active.id },
						data: {
							freeSpinsLeft: outcome.freeSpinsLeft,
							freeSpinsTotal: active.freeSpinsTotal + outcome.freeSpinsAwarded,
							globalMult: outcome.globalMult,
							roundWin,
							status: finished ? 'FINISHED' : 'CREATED',
							finishedAt: finished ? new Date() : null,
							lastRequestId: body.requestId ?? null,
							lastSpin: record as any,
						},
					})

					if (finished) {
						const roundResult = {
							game: 'drunkard-gate',
							kind: 'free-spins-round',
							engineVersion: ENGINE_VERSION,
							roundId: active.id,
							purchased: active.purchased,
							stake: Number(active.stake),
							ante: active.ante,
							freeSpins: updatedRound.freeSpinsTotal,
							globalMult: outcome.globalMult,
							win: Number(roundWin),
							seed: active.seed,
							seedHash: seedHash(active.seed),
							nonces: [1, updatedRound.nonce],
						}
						const reference = active.cost > 0n ? Number(active.cost) : Number(active.stake)
						if (active.triggerGameSessionId) {
							await tx.gameSession.update({
								where: { id: active.triggerGameSessionId },
								data: {
									status: 'FINISHED',
									winAmount: roundWin,
									multiplier: Number(roundWin) / reference,
									result: roundResult as any,
									finishedAt: new Date(),
								},
							})
						} else {
							await tx.gameSession.create({
								data: {
									userId: user.id,
									gameCode: 'DRUNKARD_GATE',
									status: 'FINISHED',
									betAmount: 0n,
									winAmount: roundWin,
									multiplier: Number(roundWin) / reference,
									result: roundResult as any,
									finishedAt: new Date(),
								},
							})
						}
					}

					return {
						balance,
						spin: outcome,
						round: roundView(updatedRound),
						roundWin: Number(roundWin),
						fairness: {
							engineVersion: ENGINE_VERSION,
							seedHash: seedHash(active.seed),
							nonce,
							// Сид раскрывается только после завершения раунда.
							seed: finished ? active.seed : undefined,
						},
					}
				}

				// ─── Базовый спин.
				const ante = Boolean(body.ante)
				const stake = stakeFor(body.betAmount, ante)
				const stakeBig = BigInt(stake)

				const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
				if (fresh.balance < stakeBig) throw new Error('Insufficient balance')

				const seed = newSeed()
				const outcome = playSpin({
					seed,
					nonce: 1,
					clientSeed,
					stake,
					ante,
					mode: 'base',
					freeSpinsLeft: 0,
					globalMult: 0,
				})

				// Ставка и выигрыш сводятся в одну строку кошелька: на спинах это половина всей записи в базу.
				const settled = await settleRound({
					tx,
					userId: user.id,
					stake: stakeBig,
					payout: BigInt(outcome.win),
					source: SOURCE,
					metadata: { mode: 'base', bet: body.betAmount, ante, win: outcome.win, multiplier: outcome.multiplier },
				})
				let balance = Number(settled.balance)

				const record = toRecord({
					outcome,
					seed,
					clientSeed,
					freeSpinsLeftBefore: 0,
					globalMultBefore: 0,
				})

				await tx.gameSession.create({
					data: {
						requestId: body.requestId,
						userId: user.id,
						gameCode: 'DRUNKARD_GATE',
						status: 'FINISHED',
						betAmount: stakeBig,
						winAmount: BigInt(outcome.win),
						multiplier: outcome.multiplier,
						result: record as any,
						finishedAt: new Date(),
					},
				})

				let round: any = null
				if (outcome.triggeredFreeSpins) {
					round = await tx.slotSession.create({
						data: {
							userId: user.id,
							stake: stakeBig,
							cost: 0n,
							ante,
							purchased: false,
							freeSpinsLeft: outcome.freeSpinsLeft,
							freeSpinsTotal: outcome.freeSpinsAwarded,
							globalMult: 0,
							seed: newSeed(),
							clientSeed,
							nonce: 0,
							status: 'CREATED',
						},
					})
				}

				return {
					balance,
					spin: outcome,
					round: roundView(round),
					fairness: {
						engineVersion: ENGINE_VERSION,
						seedHash: seedHash(seed),
						nonce: 1,
						seed,
					},
				}
			})
		} catch (e: any) {
			if (e?.message === 'Insufficient balance') {
				return rep.code(400).send({ error: 'Insufficient balance' })
			}
			throw e
		}
	})

	// Покупка бонуса: ставка × 100 => 15 фриспинов.
	app.post('/buy-bonus', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		const user = await getAuthUser(req)
		const parsed = buySchema.safeParse(req.body)
		if (!parsed.success) {
			return rep.code(400).send({ error: `Bet amount must be from ${MIN_BET} to ${MAX_BUY_BET}` })
		}
		const body = parsed.data
		const cost = body.betAmount * BUY_BONUS_COST_MULTIPLIER

		if (body.requestId) {
			const existing = await prisma.gameSession.findUnique({ where: { requestId: body.requestId } })
			if (existing) {
				const round = await prisma.slotSession.findFirst({
					where: { userId: user.id, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
					orderBy: { createdAt: 'desc' },
				})
				const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
				return { replay: true, balance: Number(fresh.balance), cost, round: roundView(round) }
			}
		}

		try {
			return await prisma.$transaction(async (tx) => {
				const active = await tx.slotSession.findFirst({
					where: { userId: user.id, status: 'CREATED', freeSpinsLeft: { gt: 0 } },
				})
				if (active) return rep.code(409).send({ error: 'Free spins round already active' })

				const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
				const costBig = BigInt(cost)
				if (fresh.balance < costBig) throw new Error('Insufficient balance')

				const updated = await applyBalanceChange({
					tx,
					userId: user.id,
					amount: -costBig,
					type: 'BET',
					source: SOURCE,
					metadata: { mode: 'buy-bonus', bet: body.betAmount, cost },
				})

				const trigger = await tx.gameSession.create({
					data: {
						requestId: body.requestId,
						userId: user.id,
						gameCode: 'DRUNKARD_GATE',
						status: 'CREATED',
						betAmount: costBig,
						winAmount: 0n,
						multiplier: 0,
						result: {
							game: 'drunkard-gate',
							kind: 'buy-bonus',
							engineVersion: ENGINE_VERSION,
							bet: body.betAmount,
							cost,
							freeSpins: FREE_SPINS_AWARD,
						} as any,
					},
				})

				const seed = newSeed()
				const round = await tx.slotSession.create({
					data: {
						userId: user.id,
						stake: BigInt(body.betAmount),
						cost: costBig,
						ante: false,
						purchased: true,
						freeSpinsLeft: FREE_SPINS_AWARD,
						freeSpinsTotal: FREE_SPINS_AWARD,
						globalMult: 0,
						seed,
						clientSeed: body.clientSeed ?? '',
						nonce: 0,
						status: 'CREATED',
						triggerGameSessionId: trigger.id,
					},
				})

				return {
					balance: Number(updated.balance),
					cost,
					round: roundView(round),
					fairness: { engineVersion: ENGINE_VERSION, seedHash: seedHash(seed), nonce: 0 },
				}
			})
		} catch (e: any) {
			if (e?.message === 'Insufficient balance') {
				return rep.code(400).send({ error: 'Insufficient balance' })
			}
			throw e
		}
	})
}
