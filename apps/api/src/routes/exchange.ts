import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import {
	exchangeConfig,
	isExchangeAdmin,
	quoteExchange,
	weeklyExchangeUsage,
	lifetimeWager,
	serializeRequest,
	countPendingRequests,
	listExchangeRequests,
	findExchangeRequest,
	createExchangeRequest,
	updateExchangeStatus,
	ensureExchangeReady
} from '../utils/exchange.js'

const requestSchema = z.object({
	amountGc: z.number().int().positive().max(100000000),
	method: z.string().min(2).max(20),
	destination: z.string().min(4).max(120),
	contact: z.string().max(80).optional()
})

const adminActionSchema = z.object({
	action: z.enum(['paid', 'reject']),
	note: z.string().max(300).optional()
})

export async function exchangeRoutes(app: FastifyInstance) {
	app.get('/config', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		let usedWeek = 0
		let wagered = 0
		let pending = 0
		try {
			await ensureExchangeReady()
			;[usedWeek, wagered, pending] = await Promise.all([
				weeklyExchangeUsage(user.id),
				lifetimeWager(user.id),
				countPendingRequests(user.id)
			])
		} catch (err: any) {
			request.log?.warn({ err }, 'exchange config fallback without live stats')
		}

		const weekRemaining = cfg.maxGcPerWeek > 0 ? Math.max(0, cfg.maxGcPerWeek - usedWeek) : null
		const wagerOk = wagered >= cfg.requireWager

		return {
			...cfg,
			balance: Number(user.balance),
			usedThisWeek: usedWeek,
			weekRemaining,
			pendingCount: pending,
			wager: { current: wagered, required: cfg.requireWager, ok: wagerOk },
			canRequest: cfg.enabled && wagerOk && pending < cfg.maxPending,
			example: quoteExchange(cfg.minGc)
		}
	})

	app.get('/quote', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const amount = Number((request.query as any).amountGc)
		if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: 'Укажите сумму в GC' })
		return quoteExchange(Math.floor(amount))
	})

	app.post('/request', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		if (!cfg.enabled) return reply.code(403).send({ error: 'Биржа временно закрыта' })

		const parsed = requestSchema.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'Заполните сумму, способ и реквизиты' })

		const { amountGc, destination } = parsed.data
		const method = parsed.data.method.toLowerCase()
		if (!cfg.methods.some((m) => m.code === method)) return reply.code(400).send({ error: 'Недоступный способ выплаты' })
		if (amountGc < cfg.minGc) return reply.code(400).send({ error: `Минимальная сумма обмена — ${cfg.minGc} GC` })
		if (amountGc > Number(user.balance)) return reply.code(400).send({ error: 'Недостаточно Gamble Coin' })

		const [wagered, usedWeek, pending] = await Promise.all([
			lifetimeWager(user.id),
			weeklyExchangeUsage(user.id),
			countPendingRequests(user.id)
		])

		if (wagered < cfg.requireWager) {
			return reply.code(403).send({
				error: `Для обмена нужен отыгрыш от ${cfg.requireWager} GC. Сейчас: ${wagered} GC`,
				wager: { current: wagered, required: cfg.requireWager, ok: false }
			})
		}
		if (pending >= cfg.maxPending) return reply.code(409).send({ error: 'У вас уже есть заявка в обработке' })
		if (cfg.maxGcPerWeek > 0 && usedWeek + amountGc > cfg.maxGcPerWeek) {
			return reply.code(400).send({ error: `Недельный лимит — ${cfg.maxGcPerWeek} GC. Доступно: ${Math.max(0, cfg.maxGcPerWeek - usedWeek)} GC` })
		}

		const quote = quoteExchange(amountGc)
		if (quote.payoutMinor <= 0) return reply.code(400).send({ error: 'Сумма слишком мала для выплаты' })

		try {
			const created = await prisma.$transaction(async (tx) => {
				const row = await createExchangeRequest({
					userId: user.id,
					amountGc: BigInt(amountGc),
					payoutMinor: BigInt(quote.payoutMinor),
					currency: quote.currency,
					rateGcPerUnit: BigInt(quote.rateGcPerUnit),
					feePercent: quote.feePercent,
					method,
					destination: destination.trim(),
					contact: parsed.data.contact?.trim() || null,
					status: 'PENDING'
				}, tx)
				await applyBalanceChange({
					tx,
					userId: user.id,
					amount: -BigInt(amountGc),
					type: 'ADMIN_ADJUSTMENT',
					source: 'exchange-hold',
					metadata: { requestId: row.id, method, payout: quote.payout, currency: quote.currency }
				})
				return row
			})

			const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
			return { ok: true, request: serializeRequest(created), balance: Number(fresh.balance) }
		} catch (e: any) {
			if (e.message === 'Insufficient balance') return reply.code(400).send({ error: 'Недостаточно Gamble Coin' })
			request.log?.error({ err: e }, 'exchange request failed')
			return reply.code(500).send({ error: 'Не удалось создать заявку. Попробуйте ещё раз.' })
		}
	})

	app.get('/requests', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		try {
			const rows = await listExchangeRequests({ userId: user.id }, 50, 'desc')
			return { requests: rows.map((r) => serializeRequest(r)) }
		} catch (err: any) {
			request.log?.warn({ err }, 'exchange list fallback empty')
			return { requests: [] }
		}
	})

	app.post('/requests/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await findExchangeRequest(id)
		if (!row || row.userId !== user.id) return reply.code(404).send({ error: 'Заявка не найдена' })
		if (row.status !== 'PENDING') return reply.code(400).send({ error: 'Заявка уже обработана' })

		await prisma.$transaction(async (tx) => {
			const upd = await updateExchangeStatus(row.id, 'CANCELLED', { processedAt: new Date() }, tx)
			if (!upd.count) return
			await applyBalanceChange({
				tx,
				userId: user.id,
				amount: BigInt(row.amountGc),
				type: 'REFUND',
				source: 'exchange-refund',
				metadata: { requestId: row.id, reason: 'cancelled_by_user' }
			})
		})

		const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
		return { ok: true, balance: Number(fresh.balance) }
	})

	app.get('/admin/requests', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		if (!isExchangeAdmin(user.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })

		const status = String((request.query as any).status || 'PENDING').toUpperCase()
		const rows = await listExchangeRequests({ status }, 100, 'asc')
		const users = await prisma.user.findMany({
			where: { id: { in: rows.map((r) => r.userId) } },
			select: { id: true, playerId: true, username: true, firstName: true, telegramId: true }
		})
		const byId = new Map(users.map((u) => [u.id, u]))

		return {
			requests: rows.map((r) => {
				const u: any = byId.get(r.userId)
				return {
					...serializeRequest(r, { full: true }),
					player: u
						? {
								playerId: u.playerId,
								username: u.username,
								name: u.firstName || u.username || 'Игрок',
								telegramId: u.telegramId.toString()
						  }
						: null
				}
			})
		}
	})

	app.post('/admin/requests/:id', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const admin = await getAuthUser(request)
		if (!isExchangeAdmin(admin.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })

		const parsed = adminActionSchema.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'action: paid | reject' })

		const id = String((request.params as any).id || '')
		const row = await findExchangeRequest(id)
		if (!row) return reply.code(404).send({ error: 'Заявка не найдена' })
		if (row.status !== 'PENDING') return reply.code(400).send({ error: 'Заявка уже обработана' })

		const note = parsed.data.note?.trim() || null

		await prisma.$transaction(async (tx) => {
			const upd = await updateExchangeStatus(
				row.id,
				parsed.data.action === 'paid' ? 'PAID' : 'REJECTED',
				{ adminNote: note, processedAt: new Date() },
				tx
			)
			if (!upd.count) return
			if (parsed.data.action === 'reject') {
				await applyBalanceChange({
					tx,
					userId: row.userId,
					amount: BigInt(row.amountGc),
					type: 'REFUND',
					source: 'exchange-refund',
					metadata: { requestId: row.id, reason: 'rejected', note }
				})
			}
		})

		const updatedRow = await findExchangeRequest(row.id)
		return { ok: true, request: serializeRequest(updatedRow, { full: true }) }
	})
}
