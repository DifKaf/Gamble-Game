import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { sendTelegramMessage, sendTelegramPhoto } from '../utils/telegram.js'
import { publicPlayerId } from '../utils/playerId.js'
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
	updateOffer,
	ensureExchangeReady,
	enrichOffers,
	expireStaleDeals
} from '../utils/exchange.js'

const offerSchema = z.object({
	amountGc: z.number().int().positive().max(100000000),
	price: z.number().positive().max(100000000),
	method: z.string().min(2).max(20),
	destination: z.string().min(4).max(120),
	contact: z.string().max(80).optional()
})

const adminActionSchema = z.object({
	action: z.enum(['complete', 'cancel', 'paid', 'reject']),
	note: z.string().max(300).optional()
})

async function loadOfferOr404(id: string, reply: any) {
	const row = await findExchangeRequest(id)
	if (!row) {
		reply.code(404).send({ error: 'Оффер не найден' })
		return null
	}
	return row
}

export async function exchangeRoutes(app: FastifyInstance) {
	app.get('/config', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		let usedWeek = 0
		let wagered = 0
		let pending = 0
		try {
			await ensureExchangeReady()
			await expireStaleDeals()
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
		const price = Number((request.query as any).price)
		if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: 'Укажите сумму в GC' })
		const priceMinor = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : undefined
		return quoteExchange(Math.floor(amount), priceMinor)
	})

	app.get('/offers', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		try {
			await expireStaleDeals()
			const rows = await listExchangeRequests({ status: 'OPEN' }, 80, 'desc')
			return { offers: await enrichOffers(rows, user.id) }
		} catch (err: any) {
			request.log?.warn({ err }, 'exchange offers fallback empty')
			return { offers: [] }
		}
	})

	app.get('/my', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		try {
			await expireStaleDeals()
			const rows = await listExchangeRequests({ mineUserId: user.id }, 50, 'desc')
			return { offers: await enrichOffers(rows, user.id) }
		} catch (err: any) {
			request.log?.warn({ err }, 'exchange my fallback empty')
			return { offers: [] }
		}
	})

	// Совместимость со старым экраном: мои офферы.
	app.get('/requests', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request)
		try {
			const rows = await listExchangeRequests({ mineUserId: user.id }, 50, 'desc')
			const offers = await enrichOffers(rows, user.id)
			return { requests: offers, offers }
		} catch {
			return { requests: [], offers: [] }
		}
	})

	app.post('/offers', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		if (!cfg.enabled) return reply.code(403).send({ error: 'Биржа временно закрыта' })

		const parsed = offerSchema.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'Укажите сумму GC, цену, способ и реквизиты' })

		const amountGc = parsed.data.amountGc
		const method = parsed.data.method.toLowerCase()
		const destination = parsed.data.destination.trim()
		const contact = parsed.data.contact ? parsed.data.contact.trim() : null
		const priceMinor = Math.round(parsed.data.price * 100)

		if (!cfg.methods.some((m) => m.code === method)) return reply.code(400).send({ error: 'Недоступный способ оплаты' })
		if (amountGc < cfg.minGc) return reply.code(400).send({ error: `Минимальная сумма — ${cfg.minGc} GC` })
		if (priceMinor < 100) return reply.code(400).send({ error: 'Минимальная цена — 1 ' + cfg.currency })
		if (amountGc > Number(user.balance)) return reply.code(400).send({ error: 'Недостаточно Gamble Coin' })

		const [wagered, usedWeek, pending] = await Promise.all([
			lifetimeWager(user.id),
			weeklyExchangeUsage(user.id),
			countPendingRequests(user.id)
		])

		if (wagered < cfg.requireWager) {
			return reply.code(403).send({
				error: `Чтобы выставлять GC, нужен отыгрыш от ${cfg.requireWager} GC. Сейчас: ${wagered} GC`,
				wager: { current: wagered, required: cfg.requireWager, ok: false }
			})
		}
		if (pending >= cfg.maxPending) return reply.code(409).send({ error: `Можно держать не больше ${cfg.maxPending} активных объявлений` })
		if (cfg.maxGcPerWeek > 0 && usedWeek + amountGc > cfg.maxGcPerWeek) {
			return reply.code(400).send({ error: `Недельный лимит — ${cfg.maxGcPerWeek} GC. Доступно: ${Math.max(0, cfg.maxGcPerWeek - usedWeek)} GC` })
		}

		const quote = quoteExchange(amountGc, priceMinor)
		try {
			const created = await prisma.$transaction(async (tx) => {
				const row = await createExchangeRequest({
					userId: user.id,
					amountGc: BigInt(amountGc),
					payoutMinor: BigInt(priceMinor),
					currency: cfg.currency,
					rateGcPerUnit: quote.rateGcPerUnit,
					feePercent: quote.feePercent,
					method,
					destination,
					contact,
					status: 'OPEN'
				}, tx)
				await applyBalanceChange({
					tx,
					userId: user.id,
					amount: -BigInt(amountGc),
					type: 'ADMIN_ADJUSTMENT',
					source: 'p2p-hold',
					metadata: { offerId: row.id, method, price: quote.payout, currency: quote.currency }
				})
				return row
			})

			const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
			const [offer] = await enrichOffers([created], user.id)
			return { ok: true, offer, request: offer, balance: Number(fresh.balance) }
		} catch (e: any) {
			if (e.message === 'Insufficient balance') return reply.code(400).send({ error: 'Недостаточно Gamble Coin' })
			request.log?.error({ err: e }, 'p2p offer create failed')
			return reply.code(500).send({ error: 'Не удалось выставить объявление. Попробуйте ещё раз.' })
		}
	})

	// Старый путь создания заявки — тоже публикует P2P-оффер.
	app.post('/request', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const body: any = request.body || {}
		const price = Number(body.price || body.payout || 0)
		const cfg = exchangeConfig()
		const amountGc = Number(body.amountGc || 0)
		const inferred = price > 0 ? price : amountGc > 0 ? amountGc / cfg.rateGcPerUnit : 0
		;(request as any).body = {
			amountGc,
			price: inferred,
			method: body.method,
			destination: body.destination,
			contact: body.contact || body.destination
		}
		return app.inject({
			method: 'POST',
			url: '/exchange/offers',
			headers: request.headers as any,
			payload: (request as any).body
		}).then((res) => {
			reply.code(res.statusCode)
			try { return JSON.parse(res.body) } catch { return { error: res.body } }
		})
	})

	app.post('/offers/:id/take', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const cfg = exchangeConfig()
		if (!cfg.enabled) return reply.code(403).send({ error: 'Биржа временно закрыта' })
		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return
		if (row.userId === user.id) return reply.code(400).send({ error: 'Нельзя купить своё объявление' })
		if (row.status !== 'OPEN') return reply.code(409).send({ error: 'Объявление уже занято' })

		const upd = await updateOffer(row.id, ['OPEN', 'PENDING'], {
			status: 'DEAL',
			buyerId: user.id,
			takenAt: new Date()
		})
		if (!upd.count) return reply.code(409).send({ error: 'Объявление уже занято' })

		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], user.id)
		try {
			const seller = await prisma.user.findUnique({ where: { id: row.userId } })
			if (seller) {
				const buyerName = user.firstName || user.username || publicPlayerId(user)
				void sendTelegramMessage(
					seller.telegramId,
					`🛒 Ваш лот купили на P2P:\n${Number(row.amountGc)} GC за ${Number(row.payoutMinor) / 100} ${row.currency}\nПокупатель: ${buyerName} (ID ${publicPlayerId(user)})`
				)
			}
		} catch {}
		return { ok: true, offer }
	})

	app.post('/offers/:id/receipt', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return
		if (row.buyerId !== user.id) return reply.code(403).send({ error: 'Чек может отправить только покупатель' })
		if (row.status !== 'DEAL' && row.status !== 'PAID') return reply.code(400).send({ error: 'Сначала возьмите объявление' })
		const body: any = request.body || {}
		const image = String(body.image || body.receipt || '').trim()
		if (!image.startsWith('data:image/')) return reply.code(400).send({ error: 'Прикрепите скриншот или фото чека' })
		if (image.length > 2_500_000) return reply.code(400).send({ error: 'Файл слишком большой. Сожмите скриншот.' })

		await updateOffer(row.id, [row.status], { receiptUrl: image, status: row.status === 'DEAL' ? 'PAID' : row.status, paidAt: row.paidAt || new Date() })
		try {
			const seller = await prisma.user.findUnique({ where: { id: row.userId } })
			if (seller) {
				const buyerName = user.firstName || user.username || publicPlayerId(user)
				const caption = `🧾 Чек по P2P-сделке\n${Number(row.amountGc)} GC / ${Number(row.payoutMinor) / 100} ${row.currency}\nОт ${buyerName}`
				const sent = await sendTelegramPhoto(seller.telegramId, image, caption)
				if (!sent) void sendTelegramMessage(seller.telegramId, caption + '\nОткройте сделку в приложении, чтобы увидеть чек.')
			}
		} catch {}
		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], user.id)
		return { ok: true, offer }
	})

	app.post('/offers/:id/paid', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return
		if (row.buyerId !== user.id) return reply.code(403).send({ error: 'Отметить оплату может только покупатель' })
		if (row.status !== 'DEAL') return reply.code(400).send({ error: 'Сначала нужно взять объявление' })

		const upd = await updateOffer(row.id, 'DEAL', { status: 'PAID', paidAt: new Date() })
		if (!upd.count) return reply.code(409).send({ error: 'Статус сделки уже изменился' })
		try {
			const seller = await prisma.user.findUnique({ where: { id: row.userId } })
			if (seller) {
				const buyerName = user.firstName || user.username || publicPlayerId(user)
				void sendTelegramMessage(
					seller.telegramId,
					`💳 Покупатель отметил оплату по P2P:\n${Number(row.amountGc)} GC / ${Number(row.payoutMinor) / 100} ${row.currency}\nОт ${buyerName}\nПроверьте чек и подтвердите сделку.`
				)
			}
		} catch {}
		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], user.id)
		return { ok: true, offer }
	})

	app.post('/offers/:id/confirm', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return
		if (row.userId !== user.id) return reply.code(403).send({ error: 'Подтвердить получение может только продавец' })
		if (row.status !== 'PAID' && row.status !== 'DEAL') return reply.code(400).send({ error: 'Сделка ещё не готова к завершению' })
		if (!row.buyerId) return reply.code(400).send({ error: 'Покупатель не выбран' })

		const cfg = exchangeConfig()
		const amount = BigInt(row.amountGc)
		const feeGc = BigInt(Math.floor((Number(amount) * Number(row.feePercent || cfg.feePercent || 0)) / 100))
		const buyerGets = amount - feeGc
		if (buyerGets <= 0n) return reply.code(400).send({ error: 'Сумма слишком мала после комиссии' })

		try {
			const ok = await prisma.$transaction(async (tx) => {
				const upd = await updateOffer(row.id, ['PAID', 'DEAL'], {
					status: 'COMPLETED',
					processedAt: new Date()
				}, tx)
				if (!upd.count) return false
				await applyBalanceChange({
					tx,
					userId: row.buyerId,
					amount: buyerGets,
					type: 'ADMIN_ADJUSTMENT',
					source: 'p2p-release',
					metadata: { offerId: row.id, sellerId: row.userId, feeGc: Number(feeGc) }
				})
				return true
			})
			if (!ok) return reply.code(409).send({ error: 'Сделка уже обработана' })
		} catch (e: any) {
			request.log?.error({ err: e }, 'p2p confirm failed')
			return reply.code(500).send({ error: 'Не удалось завершить сделку' })
		}

		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], user.id)
		const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
		try {
			const buyer = await prisma.user.findUnique({ where: { id: row.buyerId } })
			if (buyer) {
				void sendTelegramMessage(
					buyer.telegramId,
					`✅ Продавец подтвердил P2P-сделку.\nВам зачислено ${Number(buyerGets)} GC.`
				)
			}
		} catch {}
		return { ok: true, offer, balance: Number(fresh.balance) }
	})

	app.post('/offers/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return

		const isSeller = row.userId === user.id
		const isBuyer = row.buyerId === user.id
		if (!isSeller && !isBuyer) return reply.code(403).send({ error: 'Это не ваша сделка' })

		if (row.status === 'PAID') {
			return reply.code(400).send({ error: 'После отметки «оплачено» отменить нельзя. Дождитесь подтверждения продавца.' })
		}

		// Покупатель или продавец снимает бронь — оффер снова на витрине.
		if (row.status === 'DEAL' && (isBuyer || isSeller)) {
			const upd = await updateOffer(row.id, 'DEAL', { status: 'OPEN', buyerId: null, takenAt: null })
			if (!upd.count) return reply.code(409).send({ error: 'Статус сделки уже изменился' })
			const updated = await findExchangeRequest(row.id)
			const [offer] = await enrichOffers([updated], user.id)
			return { ok: true, offer, released: false }
		}

		if (!isSeller || (row.status !== 'OPEN' && row.status !== 'PENDING')) {
			return reply.code(400).send({ error: 'Снять с витрины может только продавец' })
		}

		await prisma.$transaction(async (tx) => {
			const upd = await updateOffer(row.id, ['OPEN', 'PENDING'], {
				status: 'CANCELLED',
				processedAt: new Date()
			}, tx)
			if (!upd.count) return
			await applyBalanceChange({
				tx,
				userId: user.id,
				amount: BigInt(row.amountGc),
				type: 'REFUND',
				source: 'p2p-refund',
				metadata: { offerId: row.id, reason: 'cancelled_by_seller' }
			})
		})

		const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], user.id)
		return { ok: true, offer, balance: Number(fresh.balance), released: true }
	})

	app.post('/requests/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		return app.inject({
			method: 'POST',
			url: `/exchange/offers/${(request.params as any).id}/cancel`,
			headers: request.headers as any,
			payload: {}
		}).then((res) => {
			reply.code(res.statusCode)
			try { return JSON.parse(res.body) } catch { return { error: res.body } }
		})
	})

	app.get('/admin/requests', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user = await getAuthUser(request)
		if (!isExchangeAdmin(user.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })
		const status = String((request.query as any).status || 'ALL').toUpperCase()
		const rows = await listExchangeRequests({ status }, 100, 'asc')
		return { requests: await enrichOffers(rows, user.id, { admin: true }) }
	})

	app.post('/admin/requests/:id', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const admin = await getAuthUser(request)
		if (!isExchangeAdmin(admin.telegramId)) return reply.code(403).send({ error: 'Нет доступа' })

		const parsed = adminActionSchema.safeParse(request.body)
		if (!parsed.success) return reply.code(400).send({ error: 'action: complete | cancel' })

		const id = String((request.params as any).id || '')
		const row = await loadOfferOr404(id, reply)
		if (!row) return

		const action = parsed.data.action === 'paid' ? 'complete' : parsed.data.action === 'reject' ? 'cancel' : parsed.data.action
		const note = parsed.data.note?.trim() || null

		if (action === 'complete') {
			if (!row.buyerId) return reply.code(400).send({ error: 'Нет покупателя' })
			const amount = BigInt(row.amountGc)
			const feeGc = BigInt(Math.floor((Number(amount) * Number(row.feePercent || 0)) / 100))
			await prisma.$transaction(async (tx) => {
				const upd = await updateOffer(row.id, ['OPEN', 'PENDING', 'DEAL', 'PAID', 'DISPUTED'], {
					status: 'COMPLETED',
					adminNote: note,
					processedAt: new Date()
				}, tx)
				if (!upd.count) return
				await applyBalanceChange({
					tx,
					userId: row.buyerId,
					amount: amount - feeGc,
					type: 'ADMIN_ADJUSTMENT',
					source: 'p2p-admin-release',
					metadata: { offerId: row.id, note }
				})
			})
		} else {
			await prisma.$transaction(async (tx) => {
				const upd = await updateOffer(row.id, ['OPEN', 'PENDING', 'DEAL', 'PAID', 'DISPUTED'], {
					status: 'CANCELLED',
					adminNote: note,
					processedAt: new Date()
				}, tx)
				if (!upd.count) return
				if (row.status !== 'COMPLETED') {
					await applyBalanceChange({
						tx,
						userId: row.userId,
						amount: BigInt(row.amountGc),
						type: 'REFUND',
						source: 'p2p-admin-refund',
						metadata: { offerId: row.id, note }
					})
				}
			})
		}

		const updated = await findExchangeRequest(row.id)
		const [offer] = await enrichOffers([updated], admin.id, { admin: true })
		return { ok: true, request: offer, offer }
	})
}
