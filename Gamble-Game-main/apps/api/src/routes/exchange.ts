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
	serializeRequest
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
	// Курс, лимиты и готовность игрока к обмену.
	app.get('/config', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		const [usedWeek, wagered, pending] = await Promise.all([
			weeklyExchangeUsage(user.id),
			lifetimeWager(user.id),
			prisma.exchangeRequest.count({ where: { userId: user.id, status: 'PENDING' } })
		])

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

	// Предварительный расчёт без создания заявки.
	app.get('/quote', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const amount = Number((request.query as any).amountGc)
		if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: 'Укажите сумму в GC' })
		return quoteExchange(Math.floor(amount))
	})

	// Создать заявку: GC списываются сразу (резерв), выплата подтверждается вручную.
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
			prisma.exchangeRequest.count({ where: { userId: user.id, status: 'PENDING' } })
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
				const row = await tx.exchangeRequest.create({
					data: {
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
					}
				})
				// Резерв: GC списываются сразу, чтобы их нельзя было проиграть или перевести.
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
			throw e
		}
	})

	// Свои заявки.
	app.get('/requests', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		const rows = await prisma.exchangeRequest.findMany({
			where: { userId: user.id },
			orderBy: { createdAt: 'desc' },
			take: 50
		})
		return { requests: rows.map((r) => serializeRequest(r)) }
	})

	// Отмена своей заявки с возвратом GC.
	app.post('/requests/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await prisma.exchangeRequest.findUnique({ where: { id } })
		if (!row || row.userId !== user.id) return reply.code(404).send({ error: 'Заявка не найдена' })
		if (row.status !== 'PENDING') return reply.code(400).send({ error: 'Заявка уже обработана' })

		await prisma.$transaction(async (tx) => {
			// Фильтр по status — защита от гонки с оператором: возврат только один раз.
			const upd = await tx.exchangeRequest.updateMany({
				where: { id: row.id, status: 'PENDING' },
				data: { status: 'CANCELLED', processedAt: new Date() }
			})
			if (!upd.count) return
			await applyBalanceChange({
				tx,
				userId: user.id,
				amount: row.amountGc,
				type: 'REFUND',
				source: 'exchange-refund',
				metadata: { requestId: row.id, reason: 'cancelled_by_user' }
			})
		})

		const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
		return { ok: true, balance: Number(fresh.balance) }
	})

	// --- Операторская часть: ADMIN_TELEGRAM_IDS ---

	app.get('/admin/requests', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		if (!isExchangeAdmin(user.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })

		const status = String((request.query as any).status || 'PENDING').toUpperCase()
		const rows = await prisma.exchangeRequest.findMany({
			where: status === 'ALL' ? {} : { status },
			orderBy: { createdAt: 'asc' },
			take: 100
		})
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

	// Отметить выплату (GC не возвращаются) или отклонить (GC возвращаются игроку).
	app.post('/admin/requests/:id', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const admin = await getAuthUser(request)
		if (!isExchangeAdmin(admin.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })

		const parsed = adminActionSchema.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'action: paid | reject' })

		const id = String((request.params as any).id || '')
		const row = await prisma.exchangeRequest.findUnique({ where: { id } })
		if (!row) return reply.code(404).send({ error: 'Заявка не найдена' })
		if (row.status !== 'PENDING') return reply.code(400).send({ error: 'Заявка уже обработана' })

		const note = parsed.data.note?.trim() || null

		await prisma.$transaction(async (tx) => {
			const upd = await tx.exchangeRequest.updateMany({
				where: { id: row.id, status: 'PENDING' },
				data: { status: parsed.data.action === 'paid' ? 'PAID' : 'REJECTED', adminNote: note, processedAt: new Date() }
			})
			if (!upd.count) return
			if (parsed.data.action === 'reject') {
				await applyBalanceChange({
					tx,
					userId: row.userId,
					amount: row.amountGc,
					type: 'REFUND',
					source: 'exchange-refund',
					metadata: { requestId: row.id, reason: 'rejected', note }
				})
			}
		})

		const updatedRow = await prisma.exchangeRequest.findUniqueOrThrow({ where: { id: row.id } })
		return { ok: true, request: serializeRequest(updatedRow, { full: true }) }
	})
}
