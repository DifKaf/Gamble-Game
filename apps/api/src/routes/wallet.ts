import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'

const gameAdjustSchema = z.object({
  amount: z.number().int().min(-1000000).max(10000000),
  source: z.string().default('drunkard-gate'),
  metadata: z.any().optional()
})

export async function walletRoutes(app: FastifyInstance) {
  app.get('/transactions', {
    preHandler: [(app as any).authenticate]
  }, async (request) => {
    const user = await getAuthUser(request)

    const transactions = await prisma.walletTransaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50
    })

    return {
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        balanceBefore: Number(t.balanceBefore),
        balanceAfter: Number(t.balanceAfter),
        source: t.source,
        metadata: t.metadata,
        createdAt: t.createdAt
      }))
    }
  })

  // Temporary bridge for the legacy Drunkard Gate iframe.
  // It keeps the server balance in Neon synchronized while the full slot math
  // is being moved to the backend. Negative amount = BET, positive = WIN.
  app.post('/game-adjust', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = gameAdjustSchema.parse(request.body)

    if (body.amount === 0) {
      return { balance: Number(user.balance) }
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        return applyBalanceChange({
          tx,
          userId: user.id,
          amount: BigInt(body.amount),
          type: body.amount < 0 ? 'BET' : 'WIN',
          source: body.source,
          metadata: body.metadata
        })
      })

      return { balance: Number(updated.balance) }
    } catch (e: any) {
      if (e.message === 'Insufficient balance') {
        return reply.code(400).send({ error: 'Insufficient balance' })
      }
      throw e
    }
  })
}
