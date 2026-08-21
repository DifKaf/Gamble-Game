import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { computePlayerId } from '../utils/playerId.js'

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

  // Look up another player by @username or by their 6-digit player ID, for
  // showing a preview before sending a transfer.
  app.get('/lookup', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
    const raw = String((request.query as any).q || '').replace(/^@/, '').trim()
    if (!raw) return reply.code(400).send({ error: 'Введите username или ID игрока' })
    let found: any = null
    if (/^\d{4,8}$/.test(raw)) {
      const candidates = await prisma.user.findMany({ select: { id: true, username: true, firstName: true, lastName: true, photoUrl: true } })
      found = candidates.find((c) => computePlayerId(c.id) === raw) || null
    } else {
      found = await prisma.user.findFirst({ where: { username: raw }, select: { id: true, username: true, firstName: true, lastName: true, photoUrl: true } })
    }
    if (!found) return reply.code(404).send({ error: 'Игрок не найден' })
    return { id: found.id, playerId: computePlayerId(found.id), username: found.username, firstName: found.firstName, lastName: found.lastName, photoUrl: found.photoUrl }
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
    if(!parsed.success) return reply.code(400).send({error:'Введите username/ID и сумму'})
    const raw = parsed.data.username.replace(/^@/,'').trim()
    if(!raw) return reply.code(400).send({error:'Введите username или ID игрока'})
    const amount = BigInt(parsed.data.amount)
    let recipient: any = null
    if (/^\d{4,8}$/.test(raw)) {
      const candidates = await prisma.user.findMany({ select: { id: true } })
      const match = candidates.find((c) => computePlayerId(c.id) === raw)
      if (match) recipient = await prisma.user.findUnique({ where: { id: match.id } })
    } else {
      recipient = await prisma.user.findFirst({ where: { username: raw } })
    }
    if(!recipient) return reply.code(404).send({error:'Игрок не найден'})
    if(recipient.id === user.id) return reply.code(400).send({error:'Нельзя перевести самому себе'})
    const recipientLabel = recipient.username || computePlayerId(recipient.id)
    try{
      const result = await prisma.$transaction(async tx=>{
        await applyBalanceChange({tx,userId:user.id,amount:-amount,type:'ADMIN_ADJUSTMENT',source:'transfer-out',metadata:{to:recipientLabel,toPlayerId:computePlayerId(recipient.id)}})
        await applyBalanceChange({tx,userId:recipient.id,amount:amount,type:'ADMIN_ADJUSTMENT',source:'transfer-in',metadata:{from:user.username||computePlayerId(user.id),fromPlayerId:computePlayerId(user.id)}})
        return tx.user.findUniqueOrThrow({where:{id:user.id}})
      })
      return {balance:Number(result.balance), recipient:{id:recipient.id, username:recipient.username, playerId:computePlayerId(recipient.id), firstName:recipient.firstName}, amount:Number(amount)}
    }catch(e:any){ if(e.message==='Insufficient balance') return reply.code(400).send({error:'Недостаточно Gamble Coin'}); throw e }
  })

}
