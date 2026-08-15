import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'

type Card = { rank: string; suit: string }

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SUITS = ['S', 'H', 'D', 'C']

function drawCard(): Card {
  const rank = RANKS[Math.floor(Math.random() * RANKS.length)]
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)]
  return { rank, suit }
}

function cardValue(rank: string): number {
  if (rank === 'A') return 11
  if (rank === 'K' || rank === 'Q' || rank === 'J') return 10
  return parseInt(rank, 10)
}

function handTotal(cards: Card[]): { total: number; soft: boolean } {
  const safeCards = (cards || []).filter(Boolean) as Card[]
  let total = 0
  let aces = 0
  for (const c of safeCards) {
    total += cardValue(c.rank)
    if (c.rank === 'A') aces++
  }
  while (total > 21 && aces > 0) {
    total -= 10
    aces--
  }
  return { total, soft: aces > 0 }
}

function isBlackjack(cards: Card[]): boolean {
  const safeCards = (cards || []).filter(Boolean) as Card[]
  return safeCards.length === 2 && handTotal(safeCards).total === 21
}

function dealerShouldHit(cards: Card[]): boolean {
  return handTotal(cards).total < 17
}

function playDealer(cards: Card[]): Card[] {
  const result = [...cards]
  while (dealerShouldHit(result)) {
    result.push(drawCard())
  }
  return result
}

function computeOutcome(playerCards: Card[], dealerCards: Card[], doubled: boolean, betAmount: number) {
  const player = handTotal(playerCards)
  const dealer = handTotal(dealerCards)
  const playerBJ = isBlackjack(playerCards)
  const dealerBJ = isBlackjack(dealerCards)
  const totalBet = doubled ? betAmount * 2 : betAmount

  if (player.total > 21) {
    return { outcome: 'lose', winAmount: 0 }
  }
  if (playerBJ && dealerBJ) {
    return { outcome: 'push', winAmount: totalBet }
  }
  if (playerBJ) {
    return { outcome: 'blackjack', winAmount: Math.floor(betAmount * 2.5) }
  }
  if (dealerBJ) {
    return { outcome: 'lose', winAmount: 0 }
  }
  if (dealer.total > 21) {
    return { outcome: 'win', winAmount: totalBet * 2 }
  }
  if (player.total > dealer.total) {
    return { outcome: 'win', winAmount: totalBet * 2 }
  }
  if (player.total < dealer.total) {
    return { outcome: 'lose', winAmount: 0 }
  }
  return { outcome: 'push', winAmount: totalBet }
}

async function settle(tx: any, session: any, userId: string) {
  const playerCards = session.playerCards as Card[]
  const dealerCards = session.dealerCards as Card[]
  const { outcome, winAmount } = computeOutcome(playerCards, dealerCards, session.doubled, Number(session.betAmount))

  if (winAmount > 0) {
    await applyBalanceChange({
      tx,
      userId,
      amount: BigInt(winAmount),
      type: 'WIN',
      source: 'blackjack',
      metadata: { outcome }
    })
  }

  const totalBet = session.doubled ? session.betAmount * BigInt(2) : session.betAmount

  await tx.gameSession.create({
    data: {
      userId,
      gameCode: 'BLACKJACK',
      status: 'FINISHED',
      betAmount: totalBet,
      winAmount: BigInt(winAmount),
      multiplier: Number(totalBet) > 0 ? winAmount / Number(totalBet) : 0,
      result: { outcome, playerCards, dealerCards },
      finishedAt: new Date()
    }
  })

  return tx.blackjackSession.update({
    where: { id: session.id },
    data: {
      status: 'FINISHED',
      dealerHoleHidden: false,
      outcome,
      winAmount: BigInt(winAmount),
      finishedAt: new Date()
    }
  })
}

function serialize(session: any, balance: number) {
  const playerCards = ((session.playerCards || []) as Card[]).filter(Boolean)
  const dealerCards = ((session.dealerCards || []) as Card[]).filter(Boolean)
  const playerHand = handTotal(playerCards)
  const awaitingInsurance = session.insuranceOffered && !session.insuranceResolved
  const canAct = session.status === 'CREATED' && !awaitingInsurance

  const dealerUpCard = dealerCards[0] || null
  const visibleDealerCards = session.dealerHoleHidden ? (dealerUpCard ? [dealerUpCard] : []) : dealerCards
  const dealerTotal = session.dealerHoleHidden ? (dealerUpCard ? cardValue(dealerUpCard.rank) : 0) : handTotal(dealerCards).total

  return {
    sessionId: session.id,
    status: session.status,
    balance,
    playerCards,
    playerTotal: playerHand.total,
    playerSoft: playerHand.soft,
    dealerCards: visibleDealerCards,
    dealerTotal,
    dealerHoleHidden: session.dealerHoleHidden,
    betAmount: Number(session.betAmount),
    doubled: session.doubled,
    insuranceOffered: session.insuranceOffered,
    insuranceBet: Number(session.insuranceBet),
    insuranceResolved: session.insuranceResolved,
    awaitingInsurance,
    outcome: session.outcome,
    winAmount: Number(session.winAmount),
    canHit: canAct && playerHand.total < 21,
    canStand: canAct,
    canDouble: canAct && playerCards.length === 2 && !session.doubled
  }
}

const startSchema = z.object({
  betAmount: z.number().int().min(10).max(5000000)
})

const sessionIdSchema = z.object({
  sessionId: z.string()
})

const insuranceSchema = z.object({
  sessionId: z.string(),
  take: z.boolean()
})

export async function blackjackRoutes(app: FastifyInstance) {
  app.post('/start', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = startSchema.parse(request.body)
    const bet = BigInt(body.betAmount)

    try {
      const result = await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })

        if (fresh.balance < bet) {
          throw new Error('Insufficient balance')
        }

        await applyBalanceChange({
          tx,
          userId: user.id,
          amount: -bet,
          type: 'BET',
          source: 'blackjack'
        })

        const playerCards = [drawCard(), drawCard()]
        const dealerCards = [drawCard(), drawCard()]
        const playerBJ = isBlackjack(playerCards)
        const dealerBJ = isBlackjack(dealerCards)
        const dealerUp = dealerCards[0]
        const insuranceAvailable = dealerUp.rank === 'A' && !playerBJ
        const dealerUpIsTen = cardValue(dealerUp.rank) === 10

        let session = await tx.blackjackSession.create({
          data: {
            userId: user.id,
            betAmount: bet,
            playerCards,
            dealerCards,
            dealerHoleHidden: true,
            insuranceOffered: insuranceAvailable,
            status: 'CREATED'
          }
        })

        const shouldSettleNow = !insuranceAvailable && (playerBJ || (dealerUpIsTen && dealerBJ))
        if (shouldSettleNow) {
          session = await settle(tx, session, user.id)
        }

        const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
        return { session, balance: Number(updatedUser.balance) }
      })

      return serialize(result.session, result.balance)
    } catch (e: any) {
      if (e.message === 'Insufficient balance') {
        return reply.code(400).send({ error: 'Insufficient balance' })
      }
      throw e
    }
  })

  app.post('/insurance', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = insuranceSchema.parse(request.body)

    try {
      return await prisma.$transaction(async (tx) => {
        let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } })

        if (session.userId !== user.id) {
          return reply.code(403).send({ error: 'Forbidden' })
        }

        if (session.status !== 'CREATED' || !session.insuranceOffered || session.insuranceResolved) {
          return reply.code(400).send({ error: 'Insurance not available' })
        }

        const insuranceBet = body.take ? BigInt(Math.floor(Number(session.betAmount) / 2)) : BigInt(0)

        if (body.take) {
          const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
          if (fresh.balance < insuranceBet) {
            throw new Error('Insufficient balance')
          }
          await applyBalanceChange({
            tx,
            userId: user.id,
            amount: -insuranceBet,
            type: 'BET',
            source: 'blackjack-insurance'
          })
        }

        session = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { insuranceResolved: true, insuranceBet }
        })

        const dealerBJ = isBlackjack(session.dealerCards as Card[])

        if (body.take && dealerBJ) {
          await applyBalanceChange({
            tx,
            userId: user.id,
            amount: insuranceBet * BigInt(3),
            type: 'WIN',
            source: 'blackjack-insurance'
          })
        }

        if (dealerBJ) {
          session = await settle(tx, session, user.id)
        }

        const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
        return serialize(session, Number(updatedUser.balance))
      })
    } catch (e: any) {
      if (e.message === 'Insufficient balance') {
        return reply.code(400).send({ error: 'Insufficient balance' })
      }
      throw e
    }
  })

  app.post('/hit', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = sessionIdSchema.parse(request.body)

    return await prisma.$transaction(async (tx) => {
      let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } })

      if (session.userId !== user.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      if (session.status !== 'CREATED') {
        return reply.code(400).send({ error: 'Session finished' })
      }

      if (session.insuranceOffered && !session.insuranceResolved) {
        return reply.code(400).send({ error: 'Resolve insurance first' })
      }

      const playerCards = [...(session.playerCards as Card[]), drawCard()]
      session = await tx.blackjackSession.update({
        where: { id: session.id },
        data: { playerCards }
      })

      const { total } = handTotal(playerCards)
      if (total >= 21) {
        const dealerCards = total > 21 ? (session.dealerCards as Card[]) : playDealer(session.dealerCards as Card[])
        session = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { dealerCards }
        })
        session = await settle(tx, session, user.id)
      }

      const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
      return serialize(session, Number(updatedUser.balance))
    })
  })

  app.post('/stand', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = sessionIdSchema.parse(request.body)

    return await prisma.$transaction(async (tx) => {
      let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } })

      if (session.userId !== user.id) {
        return reply.code(403).send({ error: 'Forbidden' })
      }

      if (session.status !== 'CREATED') {
        return reply.code(400).send({ error: 'Session finished' })
      }

      if (session.insuranceOffered && !session.insuranceResolved) {
        return reply.code(400).send({ error: 'Resolve insurance first' })
      }

      const dealerCards = playDealer(session.dealerCards as Card[])
      session = await tx.blackjackSession.update({
        where: { id: session.id },
        data: { dealerCards }
      })
      session = await settle(tx, session, user.id)

      const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
      return serialize(session, Number(updatedUser.balance))
    })
  })

  app.post('/double', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = sessionIdSchema.parse(request.body)

    try {
      return await prisma.$transaction(async (tx) => {
        let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } })

        if (session.userId !== user.id) {
          return reply.code(403).send({ error: 'Forbidden' })
        }

        if (session.status !== 'CREATED') {
          return reply.code(400).send({ error: 'Session finished' })
        }

        if (session.insuranceOffered && !session.insuranceResolved) {
          return reply.code(400).send({ error: 'Resolve insurance first' })
        }

        const playerCards0 = session.playerCards as Card[]
        if (playerCards0.length !== 2 || session.doubled) {
          return reply.code(400).send({ error: 'Double not available' })
        }

        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
        if (fresh.balance < BigInt(session.betAmount)) {
          throw new Error('Insufficient balance')
        }

        await applyBalanceChange({
          tx,
          userId: user.id,
          amount: -BigInt(session.betAmount),
          type: 'BET',
          source: 'blackjack-double'
        })

        const playerCards = [...playerCards0, drawCard()]
        session = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { playerCards, doubled: true }
        })

        const { total } = handTotal(playerCards)
        const dealerCards = total > 21 ? (session.dealerCards as Card[]) : playDealer(session.dealerCards as Card[])
        session = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { dealerCards }
        })
        session = await settle(tx, session, user.id)

        const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } })
        return serialize(session, Number(updatedUser.balance))
      })
    } catch (e: any) {
      if (e.message === 'Insufficient balance') {
        return reply.code(400).send({ error: 'Insufficient balance' })
      }
      throw e
    }
  })
}
