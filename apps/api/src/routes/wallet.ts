import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { computePlayerId, publicPlayerId, parsePlayerId } from '../utils/playerId.js'
import { sendTelegramMessage } from '../utils/telegram.js'
import { assertCanTransfer, mapAntifraudError } from '../utils/antifraud.js'

const gameAdjustSchema = z.object({
  amount: z.number().int().min(-1000000).max(10000000),
  source: z.string().default('drunkard-gate'),
  metadata: z.any().optional()
})

const transferSchema = z.object({ username: z.string().min(1), amount: z.number().int().positive().max(10000000) })

const publicUserSelect = { id: true, playerId: true, username: true, firstName: true, lastName: true, photoUrl: true } as const

// Найти игрока по @username или по цифровому ID.
async function findUserByHandle(raw: string) {
  const clean = String(raw || '').replace(/^@/, '').trim()
  if (!clean) return null

  if (/^[#\s\d]+$/.test(clean)) {
    const pid = parsePlayerId(clean)
    if (pid) {
      const byPlayerId = await prisma.user.findUnique({ where: { playerId: pid } })
      if (byPlayerId) return byPlayerId
    }
    // Fallback для старых хэш-ID, выданных до миграции.
    const digits = clean.replace(/\D/g, '')
    const candidates = await prisma.user.findMany({ select: { id: true } })
    const match = candidates.find((c) => computePlayerId(c.id) === digits)
    if (match) return prisma.user.findUnique({ where: { id: match.id } })
    return null
  }

  return prisma.user.findFirst({ where: { username: { equals: clean, mode: 'insensitive' } } })
}

// Сохраняем вторую сторону перевода, чтобы история могла показать аватарку, ник и ID.
function counterpartyMeta(u: any) {
  return {
    counterpartyId: u.id,
    counterpartyPlayerId: publicPlayerId(u),
    counterpartyUsername: u.username || null,
    counterpartyName: u.firstName || u.username || 'Игрок',
    counterpartyPhotoUrl: u.photoUrl || null
  }
}

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

  // Полная история переводов с данными второй стороны (аватар, ник, ID).
  app.get('/transfers', { preHandler: [(app as any).authenticate] }, async (request) => {
    const user = await getAuthUser(request)
    const limit = Math.min(Number((request.query as any).limit) || 100, 200)

    const rows = await prisma.walletTransaction.findMany({
      where: { userId: user.id, source: { in: ['transfer-in', 'transfer-out'] } },
      orderBy: { createdAt: 'desc' },
      take: limit
    })

    const ids = Array.from(new Set(rows.map((r) => (r.metadata as any)?.counterpartyId).filter(Boolean))) as string[]
    const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: publicUserSelect }) : []
    const byId = new Map(users.map((u) => [u.id, u]))

    return {
      transfers: rows.map((r) => {
        const meta: any = r.metadata || {}
        const cp: any = meta.counterpartyId ? byId.get(meta.counterpartyId) : null
        const direction = r.source === 'transfer-in' ? 'in' : 'out'
        return {
          id: r.id,
          direction,
          amount: Math.abs(Number(r.amount)),
          balanceAfter: Number(r.balanceAfter),
          createdAt: r.createdAt,
          counterparty: {
            id: cp ? cp.id : meta.counterpartyId || null,
            playerId: cp ? publicPlayerId(cp) : meta.counterpartyPlayerId || meta.toPlayerId || meta.fromPlayerId || null,
            username: cp ? cp.username : meta.counterpartyUsername || null,
            name: cp ? (cp.firstName || cp.username || 'Игрок') : meta.counterpartyName || meta.to || meta.from || 'Игрок',
            photoUrl: cp ? cp.photoUrl : meta.counterpartyPhotoUrl || null
          }
        }
      })
    }
  })

  // Превью получателя перед переводом: @username или цифровой ID.
  app.get('/lookup', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
    const raw = String((request.query as any).q || '').trim()
    if (!raw) return reply.code(400).send({ error: 'Введите username или ID игрока' })
    const found: any = await findUserByHandle(raw)
    if (!found) return reply.code(404).send({ error: 'Игрок не найден' })
    return {
      id: found.id,
      playerId: publicPlayerId(found),
      username: found.username,
      firstName: found.firstName,
      lastName: found.lastName,
      photoUrl: found.photoUrl
    }
  })

  // Старый мост баланса для iframe Drunkard Gate.
  // Слот теперь считается на сервере (POST /games/drunkard-gate/spin),
  // поэтому клиент больше не может сам назначать себе выигрыш по этому источнику.
  app.post('/game-adjust', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    const user = await getAuthUser(request)
    const body = gameAdjustSchema.parse(request.body)

    const isLegacySlot = body.source === 'drunkard-gate'
    if (isLegacySlot && process.env.ALLOW_LEGACY_GAME_ADJUST !== 'true') {
      return reply.code(410).send({ error: 'Legacy endpoint removed. Use POST /games/drunkard-gate/spin' })
    }

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
    if (!parsed.success) return reply.code(400).send({ error: 'Введите username/ID и сумму' })

    const raw = parsed.data.username.trim()
    if (!raw) return reply.code(400).send({ error: 'Введите username или ID игрока' })

    const amount = BigInt(parsed.data.amount)
    const recipient: any = await findUserByHandle(raw)
    if (!recipient) return reply.code(404).send({ error: 'Игрок не найден' })
    if (recipient.id === user.id) return reply.code(400).send({ error: 'Нельзя перевести самому себе' })
    try { await assertCanTransfer(user, Number(amount)) } catch (e: any) {
      const mapped = mapAntifraudError(e)
      if (mapped) return reply.code(mapped.code).send({ error: mapped.error })
      throw e
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        await applyBalanceChange({
          tx,
          userId: user.id,
          amount: -amount,
          type: 'ADMIN_ADJUSTMENT',
          source: 'transfer-out',
          metadata: counterpartyMeta(recipient)
        })
        await applyBalanceChange({
          tx,
          userId: recipient.id,
          amount: amount,
          type: 'ADMIN_ADJUSTMENT',
          source: 'transfer-in',
          metadata: counterpartyMeta(user)
        })
        return tx.user.findUniqueOrThrow({ where: { id: user.id } })
      })

      const fromName = user.firstName || user.username || publicPlayerId(user)
      void sendTelegramMessage(
        recipient.telegramId,
        `💸 Вам пришёл перевод в Gamble:\n+${Number(amount)} GC от ${fromName} (ID ${publicPlayerId(user)})`
      )
      return {
        balance: Number(result.balance),
        recipient: {
          id: recipient.id,
          username: recipient.username,
          playerId: publicPlayerId(recipient),
          firstName: recipient.firstName,
          photoUrl: recipient.photoUrl
        },
        amount: Number(amount)
      }
    } catch (e: any) {
      if (e.message === 'Insufficient balance') return reply.code(400).send({ error: 'Недостаточно Gamble Coin' })
      throw e
    }
  })

}
