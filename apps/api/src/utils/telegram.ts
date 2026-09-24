// Проверка подписки на Telegram-канал через Bot API (getChatMember).
//
// Чтобы это работало, бот из TELEGRAM_BOT_TOKEN должен быть админом канала,
// а сам канал указан в TELEGRAM_CHANNEL (например @gamble_channel или -1001234567890).

const TELEGRAM_API = 'https://api.telegram.org/bot'

function botToken() {
	return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
}

// Анимированные (кастомные) эмодзи Telegram.
// TELEGRAM_CUSTOM_EMOJI — JSON «обычный эмодзи → custom_emoji_id», например:
//   TELEGRAM_CUSTOM_EMOJI={"🤝":"5368324170671202286","✅":"5427009714745517609"}
// ID удобно взять из набора: npm run emoji:pack -- <имя_набора> (см. src/scripts/emojiPack.ts).
// Важно: Telegram разрешает ботам кастомные эмодзи, только если у бота есть доп. юзернейм
// с Fragment. Если Telegram откажет — сообщение уйдёт с обычными эмодзи, уведомление не потеряется.
let emojiMapCache: Array<[string, string]> | null = null
let customEmojiDisabled = false

function customEmojiMap(): Array<[string, string]> {
	if (emojiMapCache) return emojiMapCache
	let parsed: Record<string, unknown> = {}
	try {
		parsed = JSON.parse(String(process.env.TELEGRAM_CUSTOM_EMOJI || '{}'))
	} catch {
		console.warn('TELEGRAM_CUSTOM_EMOJI: неверный JSON, анимированные эмодзи выключены')
	}
	// Длинные ключи первыми: «❤️‍🔥» не должен распасться на «❤️».
	emojiMapCache = Object.entries(parsed)
		.filter(([k, v]) => k && /^\d{5,25}$/.test(String(v)))
		.map(([k, v]) => [k, String(v)] as [string, string])
		.sort((a, b) => b[0].length - a[0].length)
	return emojiMapCache
}

export function withCustomEmoji(text: string): string {
	const map = customEmojiMap()
	if (!map.length || customEmojiDisabled) return text
	let out = ''
	let i = 0
	outer: while (i < text.length) {
		// Не трогаем содержимое HTML-тегов.
		if (text[i] === '<') {
			const end = text.indexOf('>', i)
			if (end < 0) { out += text.slice(i); break }
			out += text.slice(i, end + 1); i = end + 1; continue
		}
		for (const [emoji, id] of map) {
			const plain = emoji.replace(/\uFE0F/g, '')
			for (const variant of plain === emoji ? [emoji] : [emoji, plain]) {
				if (text.startsWith(variant, i)) {
					out += `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`
					i += variant.length
					if (text[i] === '\uFE0F') i++
					continue outer
				}
			}
		}
		out += text[i]; i++
	}
	return out
}

// Убирает эмодзи из текста уведомления («💸 Вам пришёл перевод» → «Вам пришёл перевод»).
// Вернуть эмодзи можно переменной TELEGRAM_NOTIFY_EMOJI=true.
export function stripEmoji(text: string): string {
	return String(text)
		.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
		.replace(/[#*0-9]\uFE0F?\u20E3/gu, '')
		.replace(/(?:\p{Extended_Pictographic}|\p{Emoji_Modifier})(?:\uFE0F|\u200D|\p{Emoji_Modifier})*/gu, '')
		.replace(/[\uFE0F\u200D]/g, '')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/^[ \t]+/gm, '')
		.replace(/[ \t]+$/gm, '')
}

async function postMessage(token: string, chatId: string, text: string) {
	const res = await fetch(TELEGRAM_API + token + '/sendMessage', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
	})
	return (await res.json().catch(() => ({}))) as any
}

export async function sendTelegramMessage(telegramId: string | bigint | number, text: string) {
	const token = botToken()
	if (!token || telegramId == null || telegramId === '') return false
	const chatId = String(telegramId)
	if (String(process.env.TELEGRAM_NOTIFY_EMOJI || 'false') !== 'true') text = stripEmoji(text)
	try {
		const rich = withCustomEmoji(text)
		const body = await postMessage(token, chatId, rich)
		if (body?.ok) return true
		if (rich !== text) {
			// Боту нельзя кастомные эмодзи или ID устарел — шлём обычный текст.
			const description = String(body?.description || '')
			if (/custom emoji|emoji/i.test(description)) {
				customEmojiDisabled = true
				console.warn('Telegram отклонил анимированные эмодзи, выключаю до перезапуска: ' + description)
			}
			const plain = await postMessage(token, chatId, text)
			return Boolean(plain?.ok)
		}
		return false
	} catch {
		return false
	}
}

export async function sendTelegramPhoto(telegramId: string | bigint | number, photoBase64: string, caption?: string) {
	const token = botToken()
	if (!token || telegramId == null || telegramId === '') return false
	try {
		const raw = String(photoBase64 || '')
		const comma = raw.indexOf(',')
		const b64 = comma >= 0 ? raw.slice(comma + 1) : raw
		const buf = Buffer.from(b64, 'base64')
		if (!buf.length || buf.length > 8 * 1024 * 1024) return false
		const form = new FormData()
		form.set('chat_id', String(telegramId))
		if (caption) form.set('caption', caption.slice(0, 1000))
		form.set('photo', new Blob([buf], { type: 'image/jpeg' }), 'receipt.jpg')
		const res = await fetch(TELEGRAM_API + token + '/sendPhoto', { method: 'POST', body: form as any })
		const body: any = await res.json().catch(() => ({}))
		return Boolean(body?.ok)
	} catch {
		return false
	}
}
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
