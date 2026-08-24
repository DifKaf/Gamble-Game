// Проверка подписки на Telegram-канал через Bot API (getChatMember).
//
// Чтобы это работало, бот из TELEGRAM_BOT_TOKEN должен быть админом канала,
// а сам канал указан в TELEGRAM_CHANNEL (например @gamble_channel или -1001234567890).

const TELEGRAM_API = 'https://api.telegram.org/bot'
const OK_STATUSES = ['creator', 'administrator', 'member']
const OK_TTL_MS = Number(process.env.TG_SUB_OK_TTL_MS || 300000) // подписан — помним 5 минут
const BAD_TTL_MS = Number(process.env.TG_SUB_BAD_TTL_MS || 20000) // не подписан — 20 секунд
// Если Telegram недоступен или бот не админ: пропускать игроков или нет.
const FAIL_OPEN = String(process.env.TELEGRAM_SUB_FAIL_OPEN || 'false') === 'true'

export type SubscriptionCheck = {
	ok: boolean
	configured: boolean
	channel: string | null
	url: string | null
	reason?: string
}

const memo = new Map<string, { value: SubscriptionCheck; expiresAt: number }>()

export function channelSetting() {
	const raw = String(process.env.TELEGRAM_CHANNEL || process.env.TELEGRAM_CHANNEL_ID || '').trim()
	const explicitUrl = String(process.env.TELEGRAM_CHANNEL_URL || '').trim()
	if (!raw) return { chatId: '', label: null as string | null, url: explicitUrl || null }
	if (/^-?\d+$/.test(raw)) {
		// Числовой id — ссылку берём из отдельной переменной, если она задана.
		const label = explicitUrl ? '@' + explicitUrl.split('/').filter(Boolean).pop() : null
		return { chatId: raw, label, url: explicitUrl || null }
	}
	const handle = raw.replace(/^https?:\/\//, '').replace(/^t\.me\//, '').replace(/^@/, '')
	return {
		chatId: '@' + handle,
		label: '@' + handle,
		url: explicitUrl || 'https://t.me/' + handle,
	}
}

export async function checkChannelSubscription(telegramId: string | bigint): Promise<SubscriptionCheck> {
	const channel = channelSetting()
	const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()

	// Канал или токен не настроены — требование не применяется (локальная разработка).
	if (!channel.chatId || !token) {
		return { ok: true, configured: false, channel: channel.label, url: channel.url, reason: 'not_configured' }
	}

	const key = channel.chatId + ':' + String(telegramId)
	const hit = memo.get(key)
	if (hit && hit.expiresAt > Date.now()) return hit.value

	let value: SubscriptionCheck
	try {
		const query =
			'/getChatMember?chat_id=' +
			encodeURIComponent(channel.chatId) +
			'&user_id=' +
			encodeURIComponent(String(telegramId))
		const res = await fetch(TELEGRAM_API + token + query)
		const body: any = await res.json().catch(() => ({}))

		if (body && body.ok) {
			const status = String(body.result?.status || '')
			const isMember = OK_STATUSES.includes(status) || (status === 'restricted' && body.result?.is_member === true)
			value = { ok: isMember, configured: true, channel: channel.label, url: channel.url, reason: status }
		} else {
			const description = String(body?.description || 'telegram_error')
			// Игрок никогда не был в канале — это нормальный ответ «не подписан», а не сбой.
			const notFound = /user not found|participant/i.test(description)
			value = {
				ok: notFound ? false : FAIL_OPEN,
				configured: true,
				channel: channel.label,
				url: channel.url,
				reason: description,
			}
		}
	} catch (err: any) {
		value = {
			ok: FAIL_OPEN,
			configured: true,
			channel: channel.label,
			url: channel.url,
			reason: err?.message || 'request_failed',
		}
	}

	memo.set(key, { value, expiresAt: Date.now() + (value.ok ? OK_TTL_MS : BAD_TTL_MS) })
	if (memo.size > 5000) {
		for (const [k, v] of memo) if (v.expiresAt <= Date.now()) memo.delete(k)
	}
	return value
}
