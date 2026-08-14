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

const transferSchema = z.object({ username:z.string().min(1), amount:z.number().int().positive().max(10000000) })

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

  app.post('/transfer', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
    const user = await getAuthUser(request)
    const parsed = transferSchema.safeParse(request.body)
    if(!parsed.success) return reply.code(400).send({error:'Введите username и сумму'})
    const username = parsed.data.username.replace(/^@/,'').trim()
    if(!username) return reply.code(400).send({error:'Введите username Telegram'})
    const amount = BigInt(parsed.data.amount)
    const recipient = await prisma.user.findFirst({ where: { username } })
    if(!recipient) return reply.code(404).send({error:'Игрок с таким username не найден'})
    if(recipient.id === user.id) return reply.code(400).send({error:'Нельзя перевести самому себе'})
    try{
      const result = await prisma.$transaction(async tx=>{
        await applyBalanceChange({tx,userId:user.id,amount:-amount,type:'ADMIN_ADJUSTMENT',source:'transfer-out',metadata:{to:username}})
        await applyBalanceChange({tx,userId:recipient.id,amount:amount,type:'ADMIN_ADJUSTMENT',source:'transfer-in',metadata:{from:user.username}})
        return tx.user.findUniqueOrThrow({where:{id:user.id}})
      })
      return {balance:Number(result.balance), recipient:{id:recipient.id, username:recipient.username, firstName:recipient.firstName}, amount:Number(amount)}
    }catch(e:any){ if(e.message==='Insufficient balance') return reply.code(400).send({error:'Недостаточно Gamble Coin'}); throw e }
  })

}
