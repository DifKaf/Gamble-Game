import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'

const startSchema = z.object({
  betAmount: z.number().int().positive().max(100000),
  mineCount: z.number().int().min(3).max(8)
})

const openSchema = z.object({
  sessionId: z.string(),
  cellIndex: z.number().int().min(0).max(24)
})

const cashoutSchema = z.object({
  sessionId: z.string()
})

const stepMap: Record<number, number> = {
  3: 0.15,
  5: 0.28,
  8: 0.5
}

function makeMines(count: number) {
  const mines = new Set<number>()

  while (mines.size < count) {
    mines.add(Math.floor(Math.random() * 25))
  }

  return Array.from(mines)
}

function payoutFor(bet: number, opened: number, mineCount: number) {
  const multiplier = Math.round(
    (1 + opened * (stepMap[mineCount] || 0.28)) * 100
  ) / 100

  return {
    multiplier,
    payout: Math.round(bet * multiplier)
  }
}

export async function minesRoutes(app: FastifyInstance) {
  app.post('/start', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = startSchema.parse(request.body)
    const bet = BigInt(body.betAmount)

    try {
      return await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUniqueOrThrow({
          where: {
            id: user.id
          }
        })

        if (fresh.balance < bet) {
          throw new Error('Insufficient balance')
        }

        await applyBalanceChange({
          tx,
          userId: user.id,
          amount: -bet,
          type: 'BET',
          source: 'mines',
          metadata: {
            mineCount: body.mineCount
          }
        })

        const session = await tx.minesSession.create({
          data: {
            userId: user.id,
            betAmount: bet,
            mineCount: body.mineCount,
            minePositions: makeMines(body.mineCount),
            openedCells: [],
            status: 'CREATED'
          }
        })

        const updated = await tx.user.findUniqueOrThrow({
          where: {
            id: user.id
          }
        })

        return {
          sessionId: session.id,
          balance: Number(updated.balance),
          mineCount: body.mineCount,
          openedCells: [],
          multiplier: 1,
          payout: 0,
          status: 'CREATED'
        }
      })
    } catch (e: any) {
      if (e.message === 'Insufficient balance') {
        return reply.code(400).send({
          error: 'Insufficient balance'
        })
      }

      throw e
    }
  })

  app.post('/open', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = openSchema.parse(request.body)

    return await prisma.$transaction(async (tx) => {
      const session = await tx.minesSession.findUniqueOrThrow({
        where: {
          id: body.sessionId
        }
      })

      if (session.userId !== user.id) {
        return reply.code(403).send({
          error: 'Forbidden'
        })
      }

      if (session.status !== 'CREATED') {
        return reply.code(400).send({
          error: 'Session finished'
        })
      }

      const mines = session.minePositions as number[]
      const opened = session.openedCells as number[]

      if (opened.includes(body.cellIndex)) {
        const fresh = await tx.user.findUniqueOrThrow({
          where: {
            id: user.id
          }
        })

        return {
          sessionId: session.id,
          hitMine: false,
          cellIndex: body.cellIndex,
          openedCells: opened,
          multiplier: session.multiplier,
          payout: payoutFor(
            Number(session.betAmount),
            opened.length,
            session.mineCount
          ).payout,
          status: session.status,
          balance: Number(fresh.balance)
        }
      }

      if (mines.includes(body.cellIndex)) {
        await tx.minesSession.update({
          where: {
            id: session.id
          },
          data: {
            status: 'FINISHED',
            finishedAt: new Date(),
            openedCells: [...opened, body.cellIndex],
            winAmount: BigInt(0)
          }
        })

        await tx.gameSession.create({
          data: {
            userId: user.id,
            gameCode: 'MINES',
            status: 'FINISHED',
            betAmount: session.betAmount,
            winAmount: BigInt(0),
            multiplier: 0,
            result: {
              hitMine: true,
              cellIndex: body.cellIndex,
              mines
            }
          }
        })

        const fresh = await tx.user.findUniqueOrThrow({
          where: {
            id: user.id
          }
        })

        return {
          sessionId: session.id,
          hitMine: true,
          cellIndex: body.cellIndex,
          mines,
          balance: Number(fresh.balance),
          status: 'FINISHED'
        }
      }

      const nextOpened = [...opened, body.cellIndex]
      const calc = payoutFor(
        Number(session.betAmount),
        nextOpened.length,
        session.mineCount
      )

      await tx.minesSession.update({
        where: {
          id: session.id
        },
        data: {
          openedCells: nextOpened,
          multiplier: calc.multiplier
        }
      })

      const fresh = await tx.user.findUniqueOrThrow({
        where: {
          id: user.id
        }
      })

      return {
        sessionId: session.id,
        hitMine: false,
        cellIndex: body.cellIndex,
        openedCells: nextOpened,
        multiplier: calc.multiplier,
        payout: calc.payout,
        balance: Number(fresh.balance),
        status: 'CREATED'
      }
    })
  })

  app.post('/cashout', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = cashoutSchema.parse(request.body)

    return await prisma.$transaction(async (tx) => {
      const session = await tx.minesSession.findUniqueOrThrow({
        where: {
          id: body.sessionId
        }
      })

      if (session.userId !== user.id) {
        return reply.code(403).send({
          error: 'Forbidden'
        })
      }

      if (session.status !== 'CREATED') {
        return reply.code(400).send({
          error: 'Session finished'
        })
      }

      const opened = session.openedCells as number[]

      if (opened.length === 0) {
        return reply.code(400).send({
          error: 'Open at least one cell'
        })
      }

      const calc = payoutFor(
        Number(session.betAmount),
        opened.length,
        session.mineCount
      )

      const updated = await applyBalanceChange({
        tx,
        userId: user.id,
        amount: BigInt(calc.payout),
        type: 'WIN',
        source: 'mines',
        metadata: {
          sessionId: session.id,
          openedCells: opened,
          multiplier: calc.multiplier
        }
      })

      await tx.minesSession.update({
        where: {
          id: session.id
        },
        data: {
          status: 'FINISHED',
          finishedAt: new Date(),
          winAmount: BigInt(calc.payout),
          multiplier: calc.multiplier
        }
      })

      await tx.gameSession.create({
        data: {
          userId: user.id,
          gameCode: 'MINES',
          status: 'FINISHED',
          betAmount: session.betAmount,
          winAmount: BigInt(calc.payout),
          multiplier: calc.multiplier,
          result: {
            cashout: true,
            openedCells: opened,
            payout: calc.payout
          }
        }
      })

      return {
        sessionId: session.id,
        balance: Number(updated.balance),
        payout: calc.payout,
        multiplier: calc.multiplier,
        status: 'FINISHED'
      }
    })
  })
}
