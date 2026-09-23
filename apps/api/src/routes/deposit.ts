import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { sendTelegramMessage } from '../utils/telegram.js'
import { createInvoice, cryptoPayEnabled, getInvoice, verifyWebhookSignature, CryptoInvoice } from '../utils/cryptoPay.js'

// Пополнение баланса GC через @CryptoBot. Только покупка: вывода нет.
const GC_PER_USD = Number(process.env.DEPOSIT_GC_PER_USD || 1000)
const MIN_USD = Number(process.env.DEPOSIT_MIN_USD || 1)
const MAX_USD = Number(process.env.DEPOSIT_MAX_USD || 500)
const ASSETS = String(process.env.DEPOSIT_ASSETS || 'USDT,TON,BTC').replace(/\s+/g, '')
const EXPIRES_IN = Number(process.env.DEPOSIT_INVOICE_TTL_SEC || 1800)
const MAX_PENDING = 3

const invoiceSchema = z.object({ amountUsd: z.number().min(MIN_USD).max(MAX_USD) })
const idSchema = z.object({ id: z.string().min(1).max(64) })

function p2pEnabled() {
	return String(process.env.P2P_ENABLED || 'false') === 'true'
}

type DepositRow = { id: string; userId: string; invoiceId: bigint; amountUsd: string; amountGc: bigint; status: string; payUrl: string | null; miniAppUrl: string | null }

async function loadDeposit(id: string) {
	const rows = (await prisma.$queryRawUnsafe(`SELECT * FROM "CryptoDeposit" WHERE id = $1`, id)) as DepositRow[]
	return rows[0] || null
}

function view(row: DepositRow) {
	return { id: row.id, status: row.status, amountUsd: Number(row.amountUsd), amountGc: Number(row.amountGc), payUrl: row.payUrl, miniAppUrl: row.miniAppUrl }
}

// Зачисление идемпотентно: статус меняется PENDING → PAID одним UPDATE, второй вызов
// (вебхук + проверка из приложения одновременно) просто ничего не найдёт.
async function settleInvoice(invoice: CryptoInvoice, log?: { warn: (m: string) => void }) {
	const depositId = String(invoice.payload || '')
	if (!depositId) return null
	const row = await loadDeposit(depositId)
	if (!row) return null
	if (String(row.invoiceId) !== String(invoice.invoice_id)) {
		log?.warn(`deposit ${depositId}: invoice mismatch`)
		return row
	}
	if (invoice.status === 'expired' && row.status === 'PENDING') {
		await prisma.$executeRawUnsafe(`UPDATE "CryptoDeposit" SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`, row.id)
		return { ...row, status: 'EXPIRED' }
	}
	if (invoice.status !== 'paid') return row
	// Сумма и валюта должны совпадать с тем, что мы выставили.
	if (invoice.fiat !== 'USD' || Math.abs(Number(invoice.amount) - Number(row.amountUsd)) > 0.001) {
		log?.warn(`deposit ${depositId}: amount mismatch ${invoice.amount} ${invoice.fiat}`)
		return row
	}
	const credited = await prisma.$transaction(async (tx) => {
		const upd = (await tx.$queryRawUnsafe(
			`UPDATE "CryptoDeposit" SET status = 'PAID', "paidAt" = NOW(), "paidAsset" = $2, "paidAmount" = $3
			 WHERE id = $1 AND status IN ('PENDING','EXPIRED') RETURNING "userId", "amountGc"`,
			row.id,
			invoice.paid_asset || null,
			invoice.paid_amount || null,
		)) as Array<{ userId: string; amountGc: bigint }>
		if (!upd.length) return null
		await applyBalanceChange({
			tx,
			userId: upd[0].userId,
			amount: BigInt(upd[0].amountGc),
			type: 'DEPOSIT',
			source: 'cryptobot',
			metadata: { depositId: row.id, invoiceId: String(invoice.invoice_id), usd: row.amountUsd, asset: invoice.paid_asset, paid: invoice.paid_amount },
		})
		return upd[0]
	})
	if (credited) {
		const user = await prisma.user.findUnique({ where: { id: credited.userId } })
		if (user?.telegramId) void sendTelegramMessage(user.telegramId as any, `💰 Пополнение через CryptoBot: +${Number(credited.amountGc)} GC зачислено.`)
	}
	return { ...row, status: 'PAID' }
}

export async function depositRoutes(app: FastifyInstance) {
	app.get('/config', async () => ({
		enabled: cryptoPayEnabled(),
		p2pEnabled: p2pEnabled(),
		gcPerUsd: GC_PER_USD,
		minUsd: MIN_USD,
		maxUsd: MAX_USD,
		assets: ASSETS.split(','),
	}))

	app.post('/invoice', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		if (!cryptoPayEnabled()) return rep.code(503).send({ error: 'Пополнение временно недоступно' })
		const u = await getAuthUser(req)
		const parsed = invoiceSchema.safeParse(req.body)
		if (!parsed.success) return rep.code(400).send({ error: `Сумма от ${MIN_USD} до ${MAX_USD} $` })
		const amountUsd = (Math.round(parsed.data.amountUsd * 100) / 100).toFixed(2)
		const amountGc = BigInt(Math.floor(Number(amountUsd) * GC_PER_USD))
		const pending = (await prisma.$queryRawUnsafe(
			`SELECT COUNT(*)::int AS n FROM "CryptoDeposit" WHERE "userId" = $1 AND status = 'PENDING' AND "createdAt" > NOW() - INTERVAL '30 minutes'`,
			u.id,
		)) as Array<{ n: number }>
		if ((pending[0]?.n || 0) >= MAX_PENDING) return rep.code(429).send({ error: 'У вас уже есть неоплаченные счета. Оплатите или подождите 30 минут.' })
		const id = randomUUID()
		let invoice: CryptoInvoice
		try {
			invoice = await createInvoice({
				amountUsd,
				payload: id,
				description: `Gamble: ${Number(amountGc).toLocaleString('ru-RU')} GC`,
				assets: ASSETS,
				expiresIn: EXPIRES_IN,
			})
		} catch (err: any) {
			req.log.error(err)
			return rep.code(502).send({ error: 'Не удалось создать счёт в CryptoBot' })
		}
		const payUrl = invoice.bot_invoice_url || null
		const miniAppUrl = invoice.mini_app_invoice_url || null
		await prisma.$executeRawUnsafe(
			`INSERT INTO "CryptoDeposit" (id, "userId", "invoiceId", "amountUsd", "amountGc", status, "payUrl", "miniAppUrl") VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7)`,
			id, u.id, BigInt(invoice.invoice_id), amountUsd, amountGc, payUrl, miniAppUrl,
		)
		return { id, status: 'PENDING', amountUsd: Number(amountUsd), amountGc: Number(amountGc), payUrl, miniAppUrl }
	})

	// Проверка из приложения: работает даже если вебхук не настроен.
	app.post('/:id/check', { preHandler: [(app as any).authenticate] }, async (req, rep) => {
		const u = await getAuthUser(req)
		const { id } = idSchema.parse(req.params)
		const row = await loadDeposit(id)
		if (!row || row.userId !== u.id) return rep.code(404).send({ error: 'Счёт не найден' })
		if (row.status !== 'PENDING') return view(row)
		try {
			const invoice = await getInvoice(String(row.invoiceId))
			if (!invoice) return view(row)
			const settled = await settleInvoice(invoice, req.log)
			return view((settled as DepositRow) || row)
		} catch (err: any) {
			req.log.warn(err?.message || err)
			return view(row)
		}
	})

	app.get('/mine', { preHandler: [(app as any).authenticate] }, async (req) => {
		const u = await getAuthUser(req)
		const rows = (await prisma.$queryRawUnsafe(`SELECT * FROM "CryptoDeposit" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 20`, u.id)) as DepositRow[]
		return { items: rows.map(view) }
	})

	// Вебхук CryptoBot. Отдельный контекст, чтобы получить сырое тело для проверки подписи.
	await app.register(async (hook) => {
		hook.removeContentTypeParser('application/json')
		hook.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: any, done: any) => {
			req.rawBody = typeof body === 'string' ? body : ''
			try { done(null, req.rawBody ? JSON.parse(req.rawBody) : {}) } catch (err: any) { err.statusCode = 400; done(err, undefined) }
		})
		hook.post('/webhook', async (req: any, rep) => {
			if (!verifyWebhookSignature(req.rawBody || '', req.headers['crypto-pay-api-signature'])) {
				return rep.code(401).send({ ok: false })
			}
			const update = req.body || {}
			if (update.update_type === 'invoice_paid' && update.payload?.invoice_id) {
				try {
					// Перепроверяем статус напрямую у CryptoBot, а не верим телу на слово.
					const invoice = await getInvoice(update.payload.invoice_id)
					if (invoice) await settleInvoice(invoice, req.log)
				} catch (err: any) {
					req.log.error(err)
					return rep.code(500).send({ ok: false })
				}
			}
			return { ok: true }
		})
	})
}
