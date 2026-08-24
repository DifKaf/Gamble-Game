import { prisma } from '../db.js'

// Биржа: обмен GC на деньги.
//
// ВАЖНО: сервер сам никому ничего не платит. Здесь только очередь заявок:
// игрок резервирует GC, оператор вручную проверяет и отмечает выплату.
// Реальные деньги уходят вне приложения, потому что выплаты выигрышей — это уже
// лицензируемая деятельность и требует платёжного провайдера и проверки личности.
//
// По умолчанию биржа ВЫКЛЮЧЕНА (EXCHANGE_ENABLED=false) — включается осознанно.

export const EXCHANGE_STATUSES = ['PENDING', 'PAID', 'REJECTED', 'CANCELLED'] as const

const METHOD_TITLES: Record<string, string> = {
	card: 'Карта банка',
	crypto: 'USDT (TRC-20)',
	stars: 'Telegram Stars',
	sbp: 'СБП по номеру телефона'
}

const METHOD_HINTS: Record<string, string> = {
	card: 'Номер карты, 16–19 цифр',
	crypto: 'Адрес кошелька USDT TRC-20',
	stars: 'Ваш @username в Telegram',
	sbp: 'Номер телефона и банк'
}

export function exchangeConfig() {
	const methods = String(process.env.EXCHANGE_METHODS || 'card,crypto,stars')
		.split(',')
		.map((m) => m.trim().toLowerCase())
		.filter(Boolean)

	return {
		enabled: String(process.env.EXCHANGE_ENABLED || 'false') === 'true',
		currency: String(process.env.EXCHANGE_CURRENCY || 'RUB'),
		// Сколько GC стоит одна единица валюты (1000 GC = 1 ₽ по умолчанию).
		rateGcPerUnit: Math.max(1, Number(process.env.EXCHANGE_RATE_GC_PER_UNIT || 1000)),
		minGc: Math.max(1, Number(process.env.EXCHANGE_MIN_GC || 100000)),
		maxGcPerWeek: Math.max(0, Number(process.env.EXCHANGE_MAX_GC_PER_WEEK || 1000000)),
		feePercent: Math.min(90, Math.max(0, Number(process.env.EXCHANGE_FEE_PERCENT || 0))),
		// Антифрод: без отыгрыша нельзя выводить подаренные и переведённые GC.
		requireWager: Math.max(0, Number(process.env.EXCHANGE_REQUIRE_WAGER || 50000)),
		maxPending: Math.max(1, Number(process.env.EXCHANGE_MAX_PENDING || 1)),
		methods: methods.map((m) => ({ code: m, title: METHOD_TITLES[m] || m, hint: METHOD_HINTS[m] || 'Реквизиты для выплаты' })),
		note: String(process.env.EXCHANGE_NOTE || 'Заявки обрабатываются вручную в течение 24 часов.')
	}
}

// Список Telegram ID операторов, которые могут подтверждать выплаты.
export function isExchangeAdmin(telegramId: bigint | string | number) {
	const list = String(process.env.ADMIN_TELEGRAM_IDS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	return list.includes(String(telegramId))
}

// В ответах API реквизиты показываем только частично.
export function maskDestination(raw: string) {
	const s = String(raw || '').trim()
	if (s.length <= 4) return s ? '****' : ''
	if (s.startsWith('@')) return s
	return '*'.repeat(Math.min(8, Math.max(2, s.length - 4))) + s.slice(-4)
}

export type ExchangeQuote = {
	amountGc: number
	payoutMinor: number
	payout: number
	feePercent: number
	feeMinor: number
	currency: string
	rateGcPerUnit: number
}

// Перевод GC в деньги. Считаем в копейках/центах, чтобы не ловить ошибки округления.
export function quoteExchange(amountGc: number): ExchangeQuote {
	const cfg = exchangeConfig()
	const gross = Math.floor((amountGc / cfg.rateGcPerUnit) * 100)
	const feeMinor = Math.floor((gross * cfg.feePercent) / 100)
	const payoutMinor = Math.max(0, gross - feeMinor)
	return {
		amountGc,
		payoutMinor,
		payout: payoutMinor / 100,
		feePercent: cfg.feePercent,
		feeMinor,
		currency: cfg.currency,
		rateGcPerUnit: cfg.rateGcPerUnit
	}
}

// Сколько GC игрок уже заявил к обмену за последние 7 дней (без отклонённых и отменённых).
export async function weeklyExchangeUsage(userId: string) {
	const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
	const agg = await prisma.exchangeRequest.aggregate({
		where: { userId, createdAt: { gte: since }, status: { in: ['PENDING', 'PAID'] } },
		_sum: { amountGc: true }
	})
	return Number(agg._sum?.amountGc || 0)
}

// Общий отыгранный оборот — условие доступа к бирже.
export async function lifetimeWager(userId: string) {
	const agg = await prisma.gameSession.aggregate({
		where: { userId, status: 'FINISHED' },
		_sum: { betAmount: true }
	})
	return Number(agg._sum?.betAmount || 0)
}

export function serializeRequest(row: any, opts?: { full?: boolean }) {
	return {
		id: row.id,
		amountGc: Number(row.amountGc),
		payout: Number(row.payoutMinor) / 100,
		currency: row.currency,
		rateGcPerUnit: Number(row.rateGcPerUnit),
		feePercent: row.feePercent,
		method: row.method,
		methodTitle: METHOD_TITLES[row.method] || row.method,
		destination: opts?.full ? row.destination : maskDestination(row.destination),
		contact: row.contact || null,
		status: row.status,
		adminNote: row.adminNote || null,
		createdAt: row.createdAt,
		processedAt: row.processedAt || null
	}
}
