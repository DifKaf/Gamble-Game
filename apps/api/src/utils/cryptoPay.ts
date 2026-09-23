import { createHash, createHmac, timingSafeEqual } from 'crypto'

// Клиент Crypto Pay API (@CryptoBot). Документация: help.send.tg/en/articles/10279948-crypto-pay-api
// Токен выдаёт @CryptoBot → Crypto Pay → Создать приложение (для тестов — @CryptoTestnetBot).

export type CryptoInvoice = {
	invoice_id: number
	status: 'active' | 'paid' | 'expired'
	currency_type?: 'crypto' | 'fiat'
	fiat?: string
	asset?: string
	amount: string
	paid_asset?: string
	paid_amount?: string
	payload?: string
	bot_invoice_url?: string
	mini_app_invoice_url?: string
	web_app_invoice_url?: string
}

export function cryptoPayToken() {
	return String(process.env.CRYPTOPAY_TOKEN || '').trim()
}

export function cryptoPayEnabled() {
	return Boolean(cryptoPayToken()) && String(process.env.DEPOSITS_ENABLED || 'true') !== 'false'
}

function baseUrl() {
	return String(process.env.CRYPTOPAY_TESTNET || 'false') === 'true'
		? 'https://testnet-pay.crypt.bot/api/'
		: 'https://pay.crypt.bot/api/'
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const res = await fetch(baseUrl() + method, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': cryptoPayToken() },
		body: JSON.stringify(params),
	})
	const body: any = await res.json().catch(() => ({}))
	if (!body?.ok) {
		const name = body?.error?.name || body?.error?.code || res.status
		throw new Error('CryptoPay ' + method + ': ' + name)
	}
	return body.result as T
}

export function createInvoice(p: { amountUsd: string; payload: string; description: string; assets: string; expiresIn: number }) {
	return call<CryptoInvoice>('createInvoice', {
		currency_type: 'fiat',
		fiat: 'USD',
		accepted_assets: p.assets,
		amount: p.amountUsd,
		description: p.description.slice(0, 1024),
		payload: p.payload,
		expires_in: p.expiresIn,
		allow_comments: false,
		allow_anonymous: false,
	})
}

export async function getInvoice(invoiceId: number | string): Promise<CryptoInvoice | null> {
	const result: any = await call('getInvoices', { invoice_ids: String(invoiceId) })
	const items: CryptoInvoice[] = Array.isArray(result) ? result : result?.items || []
	return items.find((i) => String(i.invoice_id) === String(invoiceId)) || null
}

// Подпись вебхука: HMAC-SHA256(сырое тело, ключ = SHA256(токен)) в hex.
export function verifyWebhookSignature(rawBody: string, signature: string | undefined) {
	if (!signature || !cryptoPayToken()) return false
	const secret = createHash('sha256').update(cryptoPayToken()).digest()
	const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
	const a = Buffer.from(expected, 'hex')
	const b = Buffer.from(String(signature), 'hex')
	return a.length === b.length && timingSafeEqual(a, b)
}
