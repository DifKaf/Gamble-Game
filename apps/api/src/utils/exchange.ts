import { randomUUID } from 'crypto'
import { prisma } from '../db.js'
import { ensureFeatureTables } from './ensureFeatureTables.js'
import { publicPlayerId } from './playerId.js'

// P2P-биржа: продавец держит GC в эскроу, покупатель платит ему напрямую.
// Сервер сам никому ничего не переводит в деньгах — только держит монеты до подтверждения.

export const EXCHANGE_STATUSES = ['OPEN', 'DEAL', 'PAID', 'COMPLETED', 'CANCELLED', 'DISPUTED', 'PENDING'] as const
export const ACTIVE_SELL_STATUSES = ['OPEN', 'DEAL', 'PAID', 'PENDING'] as const

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
	const methods = String(process.env.EXCHANGE_METHODS || 'card,crypto,sbp')
		.split(',')
		.map((m) => m.trim().toLowerCase())
		.filter((m) => m && m !== 'stars')

	return {
		p2p: true,
		enabled: envFlag('EXCHANGE_ENABLED', true),
		currency: String(process.env.EXCHANGE_CURRENCY || 'RUB'),
		rateGcPerUnit: Math.max(1, Number(process.env.EXCHANGE_RATE_GC_PER_UNIT || 1000)),
		minGc: Math.max(1, Number(process.env.EXCHANGE_MIN_GC || 5000)),
		maxGcPerWeek: Math.max(0, Number(process.env.EXCHANGE_MAX_GC_PER_WEEK || 1000000)),
		feePercent: Math.min(90, Math.max(0, Number(process.env.EXCHANGE_FEE_PERCENT || 0))),
		requireWager: Math.max(0, Number(process.env.EXCHANGE_REQUIRE_WAGER || 50000)),
		maxPending: Math.max(1, Number(process.env.EXCHANGE_MAX_PENDING || 3)),
		dealTimeoutMin: Math.max(5, Number(process.env.EXCHANGE_DEAL_TIMEOUT_MIN || 30)),
		methods: methods.map((m) => ({ code: m, title: METHOD_TITLES[m] || m, hint: METHOD_HINTS[m] || 'Реквизиты для оплаты', logo: m })),
		note: String(process.env.EXCHANGE_NOTE || 'Игроки меняются напрямую. GC держатся в эскроу, пока продавец не подтвердит оплату.')
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

export function methodTitle(code: string) {
	return METHOD_TITLES[code] || code
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

export function quoteExchange(amountGc: number, priceMinor?: number): ExchangeQuote {
	const cfg = exchangeConfig()
	const payoutMinor = Math.max(0, Math.floor(Number(priceMinor || Math.floor((amountGc / cfg.rateGcPerUnit) * 100))))
	const feeMinor = Math.floor((payoutMinor * cfg.feePercent) / 100)
	const rate = amountGc > 0 && payoutMinor > 0 ? Math.round((amountGc / (payoutMinor / 100)) * 100) / 100 : cfg.rateGcPerUnit
	return {
		amountGc,
		payoutMinor,
		payout: payoutMinor / 100,
		feePercent: cfg.feePercent,
		feeMinor,
		currency: cfg.currency,
		rateGcPerUnit: rate
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
let exchangeReady = false
export async function ensureExchangeReady() {
	if (exchangeReady) return
	if (!ensuring) {
		ensuring = ensureFeatureTables().catch(() => undefined).then(() => {
			exchangeReady = true
		}).finally(() => {
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
		buyerId: row.buyerId || row.buyerid || null,
		amountGc: row.amountGc ?? row.amountgc,
		payoutMinor: row.payoutMinor ?? row.payoutminor ?? 0,
		currency: row.currency || 'RUB',
		rateGcPerUnit: row.rateGcPerUnit ?? row.rategcperunit ?? 0,
		feePercent: row.feePercent ?? row.feepercent ?? 0,
		method: row.method,
		destination: row.destination,
		contact: row.contact ?? null,
		status: row.status === 'PENDING' ? 'OPEN' : (row.status || 'OPEN'),
		adminNote: row.adminNote ?? row.adminnote ?? null,
		createdAt: row.createdAt ?? row.createdat,
		takenAt: row.takenAt ?? row.takenat ?? null,
		paidAt: row.paidAt ?? row.paidat ?? null,
		receiptUrl: row.receiptUrl ?? row.receipturl ?? null,
		disputeReason: row.disputeReason ?? row.disputereason ?? null,
		processedAt: row.processedAt ?? row.processedat ?? null,
		kind: row.kind || 'SELL',
		minGc: row.minGc ?? row.mingc ?? 0,
		maxGc: row.maxGc ?? row.maxgc ?? row.amountGc ?? row.amountgc ?? 0
	}
}

export async function weeklyExchangeUsage(userId: string) {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) {
			const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
			const agg = await del.aggregate({
				where: { userId, createdAt: { gte: since }, status: { in: ['OPEN', 'DEAL', 'PAID', 'COMPLETED', 'PENDING'] } },
				_sum: { amountGc: true }
			})
			return Number(agg._sum?.amountGc || 0)
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		const rows = await prisma.$queryRawUnsafe<Array<{ total: any }>>(
			`SELECT COALESCE(SUM("amountGc"), 0) AS total FROM "ExchangeRequest" WHERE "userId" = $1 AND "createdAt" >= NOW() - INTERVAL '7 days' AND "status" IN ('OPEN','DEAL','PAID','COMPLETED','PENDING')`,
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
		if (del) return del.count({ where: { userId, status: { in: ['OPEN', 'DEAL', 'PAID', 'PENDING'] } } })
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		const rows = await prisma.$queryRawUnsafe<Array<{ n: any }>>(
			`SELECT COUNT(*)::int AS n FROM "ExchangeRequest" WHERE "userId" = $1 AND "status" IN ('OPEN','DEAL','PAID','PENDING')`,
			userId
		)
		return Number(rows?.[0]?.n || 0)
	} catch {
		return 0
	}
}

export async function listExchangeRequests(where: { userId?: string; buyerId?: string; status?: string; mineUserId?: string }, take = 50, order: 'asc' | 'desc' = 'desc') {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) {
			const prismaWhere: any = {}
			if (where.mineUserId) prismaWhere.OR = [{ userId: where.mineUserId }, { buyerId: where.mineUserId }]
			else {
				if (where.userId) prismaWhere.userId = where.userId
				if (where.buyerId) prismaWhere.buyerId = where.buyerId
			}
			if (where.status && where.status !== 'ALL') {
				prismaWhere.status = where.status === 'OPEN' ? { in: ['OPEN', 'PENDING'] } : where.status
			}
			const rows = await del.findMany({ where: prismaWhere, orderBy: { createdAt: order }, take })
			return rows.map(mapRow)
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	const clauses: string[] = []
	const params: any[] = []
	if (where.mineUserId) {
		params.push(where.mineUserId)
		clauses.push(`("userId" = $${params.length} OR "buyerId" = $${params.length})`)
	} else {
		if (where.userId) {
			params.push(where.userId)
			clauses.push(`"userId" = $${params.length}`)
		}
		if (where.buyerId) {
			params.push(where.buyerId)
			clauses.push(`"buyerId" = $${params.length}`)
		}
	}
	if (where.status && where.status !== 'ALL') {
		if (where.status === 'OPEN') clauses.push(`"status" IN ('OPEN','PENDING')`)
		else {
			params.push(where.status)
			clauses.push(`"status" = $${params.length}`)
		}
	}
	const sql = `SELECT * FROM "ExchangeRequest"${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY "createdAt" ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${Math.max(1, Math.min(200, take))}`
	const rows = await prisma.$queryRawUnsafe<any[]>(sql, ...params)
	return rows.map(mapRow)
}

export async function findExchangeRequest(id: string) {
	await ensureExchangeReady()
	try {
		const del = exchangeDelegate()
		if (del) return mapRow(await del.findUnique({ where: { id } }))
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
	rateGcPerUnit: bigint | number
	feePercent: number
	method: string
	destination: string
	contact: string | null
	status?: string
	kind?: string
	minGc?: bigint
	maxGc?: bigint
}, tx?: any) {
	await ensureExchangeReady()
	const client = tx || prisma
	const id = randomUUID()
	// Always use raw SQL here because Prisma Client on Railway may be generated
	// from an older schema and silently omit/ignore new P2P fields.
	await client.$executeRawUnsafe(
		`INSERT INTO "ExchangeRequest" ("id","userId","amountGc","payoutMinor","currency","rateGcPerUnit","feePercent","method","destination","contact","status","kind","minGc","maxGc","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())`,
		id,
		data.userId,
		data.amountGc,
		data.payoutMinor,
		data.currency,
		BigInt(Math.max(1, Math.round(Number(data.rateGcPerUnit) || 1))),
		data.feePercent,
		data.method,
		data.destination,
		data.contact,
		data.status || 'OPEN',
		data.kind || 'SELL',
		data.minGc || data.amountGc,
		data.maxGc || data.amountGc
	)
	const rows = await client.$queryRawUnsafe(`SELECT * FROM "ExchangeRequest" WHERE "id" = $1 LIMIT 1`, id)
	return mapRow(rows?.[0]) || {
		id,
		userId: data.userId,
		buyerId: null,
		amountGc: data.amountGc,
		payoutMinor: data.payoutMinor,
		currency: data.currency,
		rateGcPerUnit: data.rateGcPerUnit,
		feePercent: data.feePercent,
		method: data.method,
		destination: data.destination,
		contact: data.contact,
		status: data.status || 'OPEN',
		kind: data.kind || 'SELL',
		minGc: data.minGc || data.amountGc,
		maxGc: data.maxGc || data.amountGc,
		createdAt: new Date()
	}
}

export async function updateOffer(id: string, expectedStatus: string | string[], data: Record<string, any>, tx?: any) {
	const client = tx || prisma
	const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]
	const del = exchangeDelegate(client)
	if (del) {
		try {
			return await del.updateMany({ where: { id, status: { in: statuses } }, data })
		} catch (err) {
			if (!isMissingRelation(err) && !/Unknown arg|receiptUrl/i.test(String((err as any)?.message || ''))) throw err
		}
	}
	const sets: string[] = []
	const params: any[] = [id]
	for (const [key, value] of Object.entries(data)) {
		params.push(value)
		sets.push(`"${key}" = $${params.length}`)
	}
	const statusParams = statuses.map((s) => {
		params.push(s)
		return `$${params.length}`
	})
	const res = await client.$executeRawUnsafe(
		`UPDATE "ExchangeRequest" SET ${sets.join(', ')} WHERE "id" = $1 AND "status" IN (${statusParams.join(',')})`,
		...params
	)
	return { count: Number(res || 0) }
}

export async function updateExchangeStatus(id: string, status: string, extra?: { adminNote?: string | null; processedAt?: Date }, tx?: any) {
	return updateOffer(id, ['OPEN', 'PENDING', 'DEAL', 'PAID'], {
		status,
		adminNote: extra?.adminNote ?? null,
		processedAt: extra?.processedAt || new Date()
	}, tx)
}

export async function expireStaleDeals() {
	const cfg = exchangeConfig()
	const cutoff = new Date(Date.now() - cfg.dealTimeoutMin * 60 * 1000)
	try {
		const del = exchangeDelegate()
		if (del) {
			await del.updateMany({
				where: { status: 'DEAL', takenAt: { lt: cutoff } },
				data: { status: 'OPEN', buyerId: null, takenAt: null }
			})
			return
		}
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	try {
		await prisma.$executeRawUnsafe(
			`UPDATE "ExchangeRequest" SET "status" = 'OPEN', "buyerId" = NULL, "takenAt" = NULL WHERE "status" = 'DEAL' AND "takenAt" IS NOT NULL AND "takenAt" < $1`,
			cutoff
		)
	} catch {}
}

function publicUser(u: any) {
	if (!u) return null
	return {
		playerId: publicPlayerId(u),
		username: u.username || null,
		name: u.firstName || u.username || 'Игрок',
		photoUrl: u.photoUrl || null
	}
}

export async function enrichOffers(rows: any[], viewerId?: string, opts?: { admin?: boolean }) {
	const ids = Array.from(new Set(rows.flatMap((r) => [r.userId, r.buyerId].filter(Boolean))))
	const users = ids.length
		? await prisma.user.findMany({
			where: { id: { in: ids } },
			select: { id: true, playerId: true, username: true, firstName: true, photoUrl: true }
		})
		: []
	const byId = new Map(users.map((u) => [u.id, u]))
	return rows.map((row) => serializeRequest(row, { viewerId, seller: byId.get(row.userId), buyer: row.buyerId ? byId.get(row.buyerId) : null, admin: opts?.admin }))
}

export function serializeRequest(row: any, opts?: { full?: boolean; viewerId?: string; seller?: any; buyer?: any; admin?: boolean }) {
	const mapped = mapRow(row) || row
	const viewerId = opts?.viewerId
	const isParty = !!(viewerId && (viewerId === mapped.userId || viewerId === mapped.buyerId))
	const showFull = !!(opts?.full || opts?.admin || isParty)
	const quote = quoteExchange(Number(mapped.amountGc), Number(mapped.payoutMinor))
	const role = viewerId === mapped.userId ? 'seller' : viewerId === mapped.buyerId ? 'buyer' : 'viewer'
	return {
		id: mapped.id,
		amountGc: Number(mapped.amountGc),
		payout: Number(mapped.payoutMinor) / 100,
		payoutMinor: Number(mapped.payoutMinor),
		currency: mapped.currency,
		rateGcPerUnit: Number(mapped.rateGcPerUnit) || quote.rateGcPerUnit,
		feePercent: mapped.feePercent,
		method: mapped.method,
		methodTitle: methodTitle(mapped.method),
		destination: showFull ? mapped.destination : maskDestination(mapped.destination),
		contact: showFull ? (mapped.contact || null) : null,
		status: mapped.status,
		adminNote: mapped.adminNote || null,
		createdAt: mapped.createdAt,
		takenAt: mapped.takenAt || null,
		paidAt: mapped.paidAt || null,
		receiptUrl: showFull ? (mapped.receiptUrl || null) : null,
		disputeReason: mapped.disputeReason || null,
		processedAt: mapped.processedAt || null,
		kind: mapped.kind || 'SELL',
		minGc: Number(mapped.minGc || mapped.amountGc || 0),
		maxGc: Number(mapped.maxGc || mapped.amountGc || 0),
		role,
		mine: role !== 'viewer',
		seller: publicUser(opts?.seller),
		buyer: publicUser(opts?.buyer)
	}
}
