import { randomUUID } from 'crypto'
import { prisma } from '../db.js'
import { ensureFeatureTables } from './ensureFeatureTables.js'

// Биржа: обмен GC на деньги.
//
// Сервер сам никому ничего не платит. Здесь только очередь заявок:
// игрок резервирует GC, оператор вручную проверяет и отмечает выплату.

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

function envFlag(name: string, fallback: boolean) {
	const raw = process.env[name]
	if (raw == null || raw === '') return fallback
	return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

export function exchangeConfig() {
	const methods = String(process.env.EXCHANGE_METHODS || 'card,crypto,stars,sbp')
		.split(',')
		.map((m) => m.trim().toLowerCase())
		.filter(Boolean)

	return {
		// Если переменная не задана, биржа открыта: иначе экран всегда показывает ошибку/закрыто.
		enabled: envFlag('EXCHANGE_ENABLED', true),
		currency: String(process.env.EXCHANGE_CURRENCY || 'RUB'),
		rateGcPerUnit: Math.max(1, Number(process.env.EXCHANGE_RATE_GC_PER_UNIT || 1000)),
		minGc: Math.max(1, Number(process.env.EXCHANGE_MIN_GC || 100000)),
		maxGcPerWeek: Math.max(0, Number(process.env.EXCHANGE_MAX_GC_PER_WEEK || 1000000)),
		feePercent: Math.min(90, Math.max(0, Number(process.env.EXCHANGE_FEE_PERCENT || 0))),
		requireWager: Math.max(0, Number(process.env.EXCHANGE_REQUIRE_WAGER || 50000)),
		maxPending: Math.max(1, Number(process.env.EXCHANGE_MAX_PENDING || 1)),
		methods: methods.map((m) => ({ code: m, title: METHOD_TITLES[m] || m, hint: METHOD_HINTS[m] || 'Реквизиты для выплаты' })),
		note: String(process.env.EXCHANGE_NOTE || 'Заявки обрабатываются вручную в течение 24 часов.')
	}
}

export function isExchangeAdmin(telegramId: bigint | string | number) {
	const list = String(process.env.ADMIN_TELEGRAM_IDS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
	return list.includes(String(telegramId))
}

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

function exchangeDelegate(client: any = prisma) {
	return client?.exchangeRequest || null
}

function isMissingRelation(err: any) {
	const msg = String(err?.message || err || '')
	return /exchangeRequest|ExchangeRequest|does not exist|Unknown arg|Cannot read/i.test(msg)
}

let ensuring: Promise<void> | null = null
export async function ensureExchangeReady() {
	if (!ensuring) {
		ensuring = ensureFeatureTables().catch(() => undefined).finally(() => {
			ensuring = null
		})
	}
	await ensuring
}

function mapRow(row: any) {
	if (!row) return null
	return {
		id: row.id,
		userId: row.userId || row.userid,
		amountGc: row.amountGc ?? row.amountgc,
		payoutMinor: row.payoutMinor ?? row.payoutminor ?? 0,
		currency: row.currency || 'RUB',
		rateGcPerUnit: row.rateGcPerUnit ?? row.rategcperunit ?? 0,
		feePercent: row.feePercent ?? row.feepercent ?? 0,
		method: row.method,
		destination: row.destination,
		contact: row.contact ?? null,
		status: row.status || 'PENDING',
		adminNote: row.adminNote ?? row.adminnote ?? null,
		createdAt: row.createdAt ?? row.createdat,
		processedAt: row.processedAt ?? row.processedat ?? null
	}
}

export async function weeklyExchangeUsage(userId: string) {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) {
			const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
			const agg = await del.aggregate({
				where: { userId, createdAt: { gte: since }, status: { in: ['PENDING', 'PAID'] } },
				_sum: { amountGc: true }
			})
			return Number(agg._sum?.amountGc || 0)
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		const rows = await prisma.$queryRawUnsafe<Array<{ total: any }>>(
			`SELECT COALESCE(SUM("amountGc"), 0) AS total FROM "ExchangeRequest" WHERE "userId" = $1 AND "createdAt" >= NOW() - INTERVAL '7 days' AND "status" IN ('PENDING','PAID')`,
			userId
		)
		return Number(rows?.[0]?.total || 0)
	} catch {
		return 0
	}
}

export async function lifetimeWager(userId: string) {
	try {
		const agg = await prisma.gameSession.aggregate({
			where: { userId, status: 'FINISHED' },
			_sum: { betAmount: true }
		})
		return Number(agg._sum?.betAmount || 0)
	} catch {
		return 0
	}
}

export async function countPendingRequests(userId: string) {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) return del.count({ where: { userId, status: 'PENDING' } })
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		const rows = await prisma.$queryRawUnsafe<Array<{ n: any }>>(
			`SELECT COUNT(*)::int AS n FROM "ExchangeRequest" WHERE "userId" = $1 AND "status" = 'PENDING'`,
			userId
		)
		return Number(rows?.[0]?.n || 0)
	} catch {
		return 0
	}
}

export async function listExchangeRequests(where: { userId?: string; status?: string }, take = 50, order: 'asc' | 'desc' = 'desc') {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) {
			return del.findMany({
				where: where.status && where.status !== 'ALL' ? where : (where.userId ? { userId: where.userId } : {}),
				orderBy: { createdAt: order },
				take
			})
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	const clauses: string[] = []
	const params: any[] = []
	if (where.userId) {
		params.push(where.userId)
		clauses.push(`"userId" = $${params.length}`)
	}
	if (where.status && where.status !== 'ALL') {
		params.push(where.status)
		clauses.push(`"status" = $${params.length}`)
	}
	const sql = `SELECT * FROM "ExchangeRequest"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY "createdAt" ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${Math.max(1, Math.min(200, take))}`
	const rows = await prisma.$queryRawUnsafe<any[]>(sql, ...params)
	return rows.map(mapRow)
}

export async function findExchangeRequest(id: string) {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) return del.findUnique({ where: { id } })
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	const rows = await prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ExchangeRequest" WHERE "id" = $1 LIMIT 1`, id)
	return mapRow(rows?.[0])
}

export async function createExchangeRequest(data: {
	userId: string
	amountGc: bigint
	payoutMinor: bigint
	currency: string
	rateGcPerUnit: bigint
	feePercent: number
	method: string
	destination: string
	contact: string | null
	status?: string
}, tx?: any) {
	await ensureExchangeReady()
	const client = tx || prisma
	const del = exchangeDelegate(client)
	if (del) {
		return del.create({
			data: {
				userId: data.userId,
				amountGc: data.amountGc,
				payoutMinor: data.payoutMinor,
				currency: data.currency,
				rateGcPerUnit: data.rateGcPerUnit,
				feePercent: data.feePercent,
				method: data.method,
				destination: data.destination,
				contact: data.contact,
				status: data.status || 'PENDING'
			}
		})
	}
	const id = randomUUID()
	await client.$executeRawUnsafe(
		`INSERT INTO "ExchangeRequest" ("id","userId","amountGc","payoutMinor","currency","rateGcPerUnit","feePercent","method","destination","contact","status","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
		id,
		data.userId,
		data.amountGc,
		data.payoutMinor,
		data.currency,
		data.rateGcPerUnit,
		data.feePercent,
		data.method,
		data.destination,
		data.contact,
		data.status || 'PENDING'
	)
	return findExchangeRequest(id)
}

export async function updateExchangeStatus(id: string, status: string, extra?: { adminNote?: string | null; processedAt?: Date }, tx?: any) {
	const client = tx || prisma
	const del = exchangeDelegate(client)
	if (del) {
		return del.updateMany({
			where: { id, status: 'PENDING' },
			data: { status, adminNote: extra?.adminNote ?? undefined, processedAt: extra?.processedAt || new Date() }
		})
	}
	const res = await client.$executeRawUnsafe(
		`UPDATE "ExchangeRequest" SET "status" = $2, "adminNote" = COALESCE($3, "adminNote"), "processedAt" = $4 WHERE "id" = $1 AND "status" = 'PENDING'`,
		id,
		status,
		extra?.adminNote ?? null,
		extra?.processedAt || new Date()
	)
	return { count: Number(res || 0) }
}

export function serializeRequest(row: any, opts?: { full?: boolean }) {
	const mapped = mapRow(row) || row
	return {
		id: mapped.id,
		amountGc: Number(mapped.amountGc),
		payout: Number(mapped.payoutMinor) / 100,
		currency: mapped.currency,
		rateGcPerUnit: Number(mapped.rateGcPerUnit),
		feePercent: mapped.feePercent,
		method: mapped.method,
		methodTitle: METHOD_TITLES[mapped.method] || mapped.method,
		destination: opts?.full ? mapped.destination : maskDestination(mapped.destination),
		contact: mapped.contact || null,
		status: mapped.status,
		adminNote: mapped.adminNote || null,
		createdAt: mapped.createdAt,
		processedAt: mapped.processedAt || null
	}
}
