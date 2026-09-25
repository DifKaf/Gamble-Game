import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'
import { weeklyStats } from '../utils/weeklyStats.js'
import { publicPlayerId } from '../utils/playerId.js'
import { withCustomEmoji } from '../utils/telegram.js'

// Команды в чате Telegram: игрок пишет «баланс», «бал», «статистика», «профиль»,
// «bal» или «balance» — бот отвечает визитной карточкой игрока.
//
// Как бот получает сообщения (TELEGRAM_UPDATES_MODE):
//   auto (по умолчанию) — webhook, если у сервиса есть публичный домен Railway, иначе polling;
//   polling — бот сам забирает сообщения у Telegram (удобно локально);
//   webhook — Telegram присылает сообщения на POST /telegram/webhook. URL берётся из
//             TELEGRAM_WEBHOOK_URL или RAILWAY_PUBLIC_DOMAIN, секрет — из TELEGRAM_WEBHOOK_SECRET
//             или автоматически выводится из токена бота;
//   off     — функция выключена.
//
// ВАЖНО для групп: у бота должен быть выключен Privacy Mode (@BotFather → /setprivacy → Disable)
// или бот должен быть админом чата. Иначе Telegram не отдаёт боту обычные сообщения.

const TELEGRAM_API = 'https://api.telegram.org/bot'
const COOLDOWN_MS = Number(process.env.TELEGRAM_CARD_COOLDOWN_MS || 5000)

const TRIGGERS = new Set([
	'статистика', 'стата', 'стат', 'баланс', 'бал', 'профиль', 'профайл',
	'bal', 'balance', 'stats', 'stat', 'profile',
])

function botToken() {
	return String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
}

// Публичный домен сервиса. Railway сам кладёт его в RAILWAY_PUBLIC_DOMAIN.
function publicBaseUrl(): string {
	const explicit = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '')
	if (explicit) return explicit
	const domain = String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim()
	return domain ? `https://${domain}` : ''
}

function webhookUrl(): string {
	const explicit = String(process.env.TELEGRAM_WEBHOOK_URL || '').trim()
	if (explicit) return explicit
	const base = publicBaseUrl()
	return base ? `${base}/telegram/webhook` : ''
}

// Если секрет не задан, выводим его из токена бота: он одинаковый на всех репликах
// и после каждого деплоя, а посторонним неизвестен.
function webhookSecret(): string {
	const explicit = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim()
	if (explicit) return explicit
	const token = botToken()
	return token ? createHash('sha256').update(`gg-webhook:${token}`).digest('hex').slice(0, 48) : ''
}

// auto (по умолчанию): webhook, если у сервиса есть публичный домен (Railway), иначе polling.
function mode(): 'polling' | 'webhook' | 'off' {
	const m = String(process.env.TELEGRAM_UPDATES_MODE || 'auto').trim().toLowerCase()
	if (m === 'webhook' || m === 'off' || m === 'polling') return m
	return webhookUrl() ? 'webhook' : 'polling'
}

// Если задан список чатов — отвечаем только в них (плюс личка с ботом).
function chatAllowed(chat: any) {
	const list = String(process.env.TELEGRAM_COMMAND_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean)
	if (!list.length || chat?.type === 'private') return true
	return list.includes(String(chat?.id)) || (chat?.username && list.includes('@' + chat.username))
}

export function isCardTrigger(text: string): boolean {
	let t = String(text || '').trim().toLowerCase().replace(/ё/g, 'е')
	t = t.replace(/^[\/!.]+/, '').replace(/@[a-z0-9_]+$/i, '').replace(/[\s.!?,)]+$/g, '').trim()
	return TRIGGERS.has(t)
}

function esc(s: string) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function gc(v: bigint | number) {
	const s = typeof v === 'bigint' ? v.toString() : String(Math.floor(Number(v) || 0))
	return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function plural(n: number, one: string, few: string, many: string) {
	const a = Math.abs(n) % 100, b = a % 10
	if (a > 10 && a < 20) return many
	if (b === 1) return one
	if (b >= 2 && b <= 4) return few
	return many
}

export async function buildPlayerCard(from: any): Promise<string> {
	const user = await prisma.user.findUnique({ where: { telegramId: BigInt(from.id) } })
	const tgName = esc([from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Игрок')
	if (!user) {
		return [
			`👋 <b>${tgName}</b>, вы ещё не заходили в Gamble.`,
			'',
			'Откройте приложение — и ваша визитка игрока появится здесь.',
		].join('\n')
	}
	const week = await weeklyStats(user.id)
	const name = esc([user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || tgName)
	// Ник — ссылка на профиль игрока: по юзернейму, а если его нет — по Telegram ID.
	const uname = String(user.username || from.username || '').replace(/[^A-Za-z0-9_]/g, '')
	const href = uname ? `https://t.me/${uname}` : `tg://user?id=${String(from.id).replace(/\D/g, '')}`
	const reg = new Date(user.createdAt)
	const regDate = reg.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric' })
	const days = Math.max(0, Math.floor((Date.now() - reg.getTime()) / 86400000))
	const daysText = days === 0 ? 'сегодня' : `${days} ${plural(days, 'день', 'дня', 'дней')}`

	return [
		`👤 <a href="${href}">${name}</a>(ID:${esc(publicPlayerId(user))})`,
		`💰 Баланс: <b>${gc(user.balance)} GC</b>`,
		`🎲 Наиграно за неделю: <b>${gc(week.wagered)} GC</b>`,
		`├ раундов: ${gc(week.rounds)}`,
		`└ лучший выигрыш: ${gc(week.best)} GC`,
		`📅 В игре с: ${regDate} (${daysText})`,
	].join('\n')
}

async function tg(method: string, payload: any) {
	const res = await fetch(TELEGRAM_API + botToken() + '/' + method, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	})
	return (await res.json().catch(() => ({}))) as any
}

function playButton() {
	const link = String(process.env.TELEGRAM_MINIAPP_LINK || '').trim()
	return /^https:\/\//.test(link) ? { inline_keyboard: [[{ text: '🎮 Играть в Gamble', url: link }]] } : undefined
}

async function replyCard(msg: any, text: string) {
	const base = {
		chat_id: msg.chat.id,
		parse_mode: 'HTML',
		link_preview_options: { is_disabled: true },
		reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
		reply_markup: playButton(),
	}
	const rich = withCustomEmoji(text)
	const r = await tg('sendMessage', { ...base, text: rich })
	if (!r?.ok && rich !== text) await tg('sendMessage', { ...base, text })
}

const lastCard = new Map<string, number>()

export async function handleTelegramUpdate(update: any, log?: any) {
	try {
		const msg = update?.message
		if (!msg?.text || !msg.from || msg.from.is_bot) return
		if (!isCardTrigger(msg.text) || !chatAllowed(msg.chat)) return
		// Антиспам: не чаще одной карточки в COOLDOWN_MS на игрока.
		const key = String(msg.from.id)
		const now = Date.now()
		if (now - (lastCard.get(key) || 0) < COOLDOWN_MS) return
		lastCard.set(key, now)
		if (lastCard.size > 5000) lastCard.clear()
		await replyCard(msg, await buildPlayerCard(msg.from))
	} catch (err) {
		log?.warn?.({ err }, 'telegram chat command failed')
	}
}

// Webhook-режим: Telegram шлёт обновления сюда.
export async function telegramBotRoutes(app: FastifyInstance) {
	app.post('/webhook', async (req, rep) => {
		if (mode() !== 'webhook') return rep.code(404).send({ ok: false })
		const secret = webhookSecret()
		if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return rep.code(401).send({ ok: false })
		// Отвечаем Telegram сразу, карточку шлём в фоне.
		void handleTelegramUpdate(req.body, app.log)
		return { ok: true }
	})
}

let polling = false

/** Останавливает polling при выключении сервиса (деплой на Railway шлёт SIGTERM). */
export function stopTelegramBot() {
	polling = false
}

export async function startTelegramBot(log: any) {
	if (!botToken()) { log.info('TELEGRAM_BOT_TOKEN не задан — команды в чате выключены'); return }
	const m = mode()
	if (m === 'off') return
	if (m === 'webhook') {
		const url = webhookUrl()
		const secret = webhookSecret()
		if (!url || !secret) { log.warn('Режим webhook: нужен публичный домен (RAILWAY_PUBLIC_DOMAIN) или TELEGRAM_WEBHOOK_URL'); return }
		const r = await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false }).catch(() => null)
		log.info({ ok: r?.ok, description: r?.description, url }, 'Telegram webhook')
		return
	}
	// polling: не ломаем чужой webhook, если он уже настроен у бота.
	const info = await tg('getWebhookInfo', {}).catch(() => null)
	if (info?.result?.url) {
		log.warn(`У бота уже есть webhook (${info.result.url}). Команды в чате через polling не запущены. Поставьте TELEGRAM_UPDATES_MODE=webhook или удалите старый webhook.`)
		return
	}
	if (polling) return
	polling = true
	log.info('Команды в чате Telegram: polling запущен')
	void (async () => {
		let offset = 0
		while (polling) {
			try {
				const r = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] })
				if (!r?.ok) {
					// 409 — сообщения забирает другой экземпляр (например, во время деплоя). Ждём.
					await new Promise((res) => setTimeout(res, r?.error_code === 409 ? 15000 : 5000))
					continue
				}
				for (const u of r.result || []) {
					offset = Math.max(offset, Number(u.update_id) + 1)
					void handleTelegramUpdate(u, log)
				}
			} catch {
				await new Promise((res) => setTimeout(res, 5000))
			}
		}
	})()
}
