import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { publicPlayerId } from '../utils/playerId.js'

const RATE_RUB_PER_1000_GC = Number(process.env.P2P_RUB_PER_1000_GC || 10)
const MIN_GC = Number(process.env.P2P_MIN_GC || 1000)
const MAX_GC = Number(process.env.P2P_MAX_GC || 5000000)
const FEE_PCT = Math.max(0, Math.min(30, Number(process.env.P2P_FEE_PCT || 0)))
const METHODS = ['SBP', 'CARD', 'USDT'] as const

const createSchema = z.object({
  amountGc: z.number().int().min(MIN_GC).max(MAX_GC),
  method: z.enum(METHODS),
  destination: z.string().min(5).max(160),
  contact: z.string().max(80).optional()
})

function payoutMinor(amountGc: number) {
  return Math.max(0, Math.floor((amountGc / 1000) * RATE_RUB_PER_1000_GC * 100 * (1 - FEE_PCT / 100)))
}
function publicDeal(x: any) {
  return {
    id: x.id,
    amountGc: Number(x.amountGc),
    payoutRub: Number(x.payoutMinor) / 100,
    currency: x.currency,
    rateRubPer1000: Number(x.rateGcPerUnit) / 100,
    feePercent: x.feePercent,
    method: x.method,
    destination: x.destination,
    contact: x.contact,
    status: x.status,
    adminNote: x.adminNote,
    createdAt: x.createdAt,
    processedAt: x.processedAt,
    user: x.user ? { playerId: publicPlayerId(x.user), name: x.user.firstName || x.user.username || 'Игрок', username: x.user.username, photoUrl: x.user.photoUrl } : undefined
  }
}

export async function exchangeRoutes(app: FastifyInstance) {
  app.get('/config', async () => ({ rateRubPer1000: RATE_RUB_PER_1000_GC, minGc: MIN_GC, maxGc: MAX_GC, feePercent: FEE_PCT, methods: METHODS }))

  app.get('/my', { preHandler: [(app as any).authenticate] }, async (req) => {
    const u = await getAuthUser(req)
    const rows = await (prisma as any).exchangeRequest.findMany({ where: { userId: u.id }, orderBy: { createdAt: 'desc' }, take: 50 })
    return { items: rows.map(publicDeal) }
  })

  app.post('/requests', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
    const u: any = await getAuthUser(req)
    if (u.banned) return rep.code(403).send({ error: 'Аккаунт ограничен' })
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return rep.code(400).send({ error: 'Проверь сумму, способ и реквизиты' })
    const b = parsed.data
    try {
      const deal = await prisma.$transaction(async (tx) => {
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: u.id } })
        if (fresh.balance < BigInt(b.amountGc)) throw new Error('Insufficient balance')
        await applyBalanceChange({ tx, userId: u.id, amount: -BigInt(b.amountGc), type: 'ADMIN_ADJUSTMENT', source: 'p2p-escrow', metadata: { method: b.method } })
        return (tx as any).exchangeRequest.create({ data: { userId: u.id, amountGc: BigInt(b.amountGc), payoutMinor: BigInt(payoutMinor(b.amountGc)), currency: b.method === 'USDT' ? 'USDT' : 'RUB', rateGcPerUnit: BigInt(Math.round(RATE_RUB_PER_1000_GC * 100)), feePercent: FEE_PCT, method: b.method, destination: b.destination.trim(), contact: b.contact || null, status: 'OPEN' } })
      })
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
      return { balance: Number(fresh.balance), item: publicDeal(deal) }
    } catch (e: any) {
      if (e.message === 'Insufficient balance') return rep.code(400).send({ error: 'Недостаточно GC' })
      throw e
    }
  })

  app.post('/requests/:id/cancel', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
    const u = await getAuthUser(req)
    const id = String((req.params as any).id || '')
    try {
      const result = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe('UPDATE "ExchangeRequest" SET status = \'CANCELLED\', "processedAt" = NOW() WHERE id = $1 AND "userId" = $2 AND status = \'OPEN\' RETURNING "amountGc"', id, u.id) as any[]
        if (!rows.length) throw new Error('NOT_CANCELLABLE')
        return applyBalanceChange({ tx, userId: u.id, amount: BigInt(rows[0].amountGc), type: 'REFUND', source: 'p2p-cancel', metadata: { requestId: id } })
      })
      return { balance: Number(result.balance) }
    } catch (e: any) {
      if (e.message === 'NOT_CANCELLABLE') return rep.code(400).send({ error: 'Заявку нельзя отменить' })
      throw e
    }
  })
}
