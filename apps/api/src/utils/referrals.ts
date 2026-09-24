import { randomUUID } from 'crypto'
import { prisma } from '../db.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { publicPlayerId, parsePlayerId } from './playerId.js'
import { ensureFeatureTables } from './ensureFeatureTables.js'
import { weekRange } from './weeklyStats.js'

function isMissingRelation(err: any) {
	const msg = String(err?.message || err || '')
	return /referral|Referral|does not exist|Unknown arg|Cannot read/i.test(msg)
}

function referralDelegate(client: any = prisma) {
	return client?.referral || null
}

async function ready() {
	try { await ensureFeatureTables() } catch {}
}

// Реферальная программа.
//
// Приглашающий получает бонус сразу и второй бонус, когда новичок наберёт
// оборот (чтобы не было выгодно плодить пустые аккаунты ради регистрационного бонуса).
const INVITER_BONUS = BigInt(Number(process.env.REFERRAL_BONUS_INVITER || 0))
const INVITEE_BONUS = BigInt(Number(process.env.REFERRAL_BONUS_INVITEE || 0))
const WEEK_SHARE_PCT = Math.max(0, Number(process.env.REFERRAL_WEEK_SHARE_PCT || 0.5))
// Привязать приглашение можно только в первые часы после регистрации,
// иначе старые игроки будут «приглашать» друг друга ради бонусов.
const ATTACH_WINDOW_MS = Number(process.env.REFERRAL_ATTACH_WINDOW_HOURS || 72) * 60 * 60 * 1000

export function inviteCode(user: { playerId?: number | null; id: string }) {
	return `ref_${publicPlayerId(user as any)}`
}

// Юзернейм бота берём из TELEGRAM_BOT_USERNAME, а если её нет — у самого Telegram по токену (getMe).
// Так ссылка всегда открывает мини-приложение в Telegram, а не сайт.
let botInfo: { username: string; mainApp: boolean } | null = null
let botInfoAt = 0
export async function resolveBotInfo() {
	if (botInfo && Date.now() - botInfoAt < 6 * 60 * 60 * 1000) return botInfo
	const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim()
	if (!token) return botInfo
	try {
		const res = await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(2500) })
		const body: any = await res.json().catch(() => ({}))
		if (body?.ok && body.result?.username) {
			botInfo = { username: String(body.result.username), mainApp: Boolean(body.result.has_main_web_app) }
			botInfoAt = Date.now()
		}
	} catch {}
	return botInfo
}

export function miniAppLink() {
	const raw = String(process.env.TELEGRAM_MINIAPP_LINK || '').trim().replace(/[?&]startapp=[^&]*/, '')
	return /^https:\/\/t\.me\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+/.test(raw) ? raw : ''
}

export function inviteLink(user: { playerId?: number | null; id: string }) {
	const bot = (String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim()) || botInfo?.username || ''
	const code = inviteCode(user)
	const appName = String(process.env.TELEGRAM_APP_NAME || '').replace(/^\/+|\/+$/g, '').trim()
	const TG_BASE = String.fromCharCode(104,116,116,112,115) + "://t.me/"
	// Самый надёжный вариант: точная ссылка на рабочее Mini App (например t.me/MyBot/play).
	const direct = miniAppLink()
	if (direct) return { url: direct + (direct.includes('?') ? '&' : '?') + 'startapp=' + code, code, configured: true }
	if (bot) {
		// t.me/<bot>/<app>?startapp=… — открывает конкретное Mini App;
		// t.me/<bot>?startapp=… — открывает главное Mini App бота (настраивается в @BotFather).
		const base = appName ? TG_BASE + bot + "/" + appName : TG_BASE + bot
		return { url: `${base}?startapp=${code}`, code, configured: true }
	}
	// Никогда не отдаём ссылку на сайт: она открывается в браузере, а не в Telegram.
	return { url: code, code, configured: false }
}

// Принимаем и 'ref_120001', и '120001', и '#120001'.
export function parseRefCode(raw: unknown): number | null {
	const clean = String(raw || '').trim().replace(/^ref[_-]?/i, '')
	if (!clean) return null
	return parsePlayerId(clean)
}

export type AttachResult = {
	ok: boolean
	reason: string
	bonus: number
	referrer?: { playerId: number | string; username: string | null; name: string }
}

// Привязывает игрока к пригласившему. Идемпотентно: повторные вызовы не дают бонус снова.
export async function attachReferral(userId: string, rawCode: unknown): Promise<AttachResult> {
	const code = parseRefCode(rawCode)
	if (!code) return { ok: false, reason: 'invalid_code', bonus: 0 }

	await ready()
	const user = await prisma.user.findUnique({ where: { id: userId } })
	let existing: any = null
	try {
		const del = referralDelegate()
		existing = del
			? await del.findUnique({ where: { referredId: userId } })
			: ((await prisma.$queryRawUnsafe(`SELECT * FROM "Referral" WHERE "referredId" = $1 LIMIT 1`, userId)) as any[])[0] || null
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	if (!user) return { ok: false, reason: 'user_not_found', bonus: 0 }
	if (existing) return { ok: false, reason: 'already_attached', bonus: 0 }

	if (Date.now() - new Date(user.createdAt).getTime() > ATTACH_WINDOW_MS) {
		return { ok: false, reason: 'window_closed', bonus: 0 }
	}

	const referrer = await prisma.user.findUnique({ where: { playerId: code } })
	if (!referrer) return { ok: false, reason: 'referrer_not_found', bonus: 0 }
	if (referrer.id === userId) return { ok: false, reason: 'self_invite', bonus: 0 }

	try {
		await prisma.$transaction(async (tx) => {
			const del = referralDelegate(tx)
			if (del) {
				await del.create({
					data: { referrerId: referrer.id, referredId: userId, registrationBonus: INVITER_BONUS }
				})
			} else {
				await tx.$executeRawUnsafe(
					`INSERT INTO "Referral" ("id","referrerId","referredId","registrationBonus","milestoneBonus","createdAt") VALUES ($1,$2,$3,$4,0,NOW())`,
					randomUUID(),
					referrer.id,
					userId,
					INVITER_BONUS
				)
			}
			if (INVITER_BONUS > 0n) {
				await applyBalanceChange({
					tx,
					userId: referrer.id,
					amount: INVITER_BONUS,
					type: 'BONUS',
					source: 'referral-signup',
					metadata: { referredId: userId, referredPlayerId: publicPlayerId(user) }
				})
			}
			if (INVITEE_BONUS > 0n) {
				await applyBalanceChange({
					tx,
					userId,
					amount: INVITEE_BONUS,
					type: 'BONUS',
					source: 'referral-welcome',
					metadata: { referrerId: referrer.id, referrerPlayerId: publicPlayerId(referrer) }
				})
			}
		})
	} catch (err: any) {
		if (String(err?.code) === 'P2002') return { ok: false, reason: 'already_attached', bonus: 0 }
		throw err
	}

	return {
		ok: true,
		reason: 'attached',
		bonus: Number(INVITEE_BONUS),
		referrer: {
			playerId: publicPlayerId(referrer),
			username: referrer.username,
			name: referrer.firstName || referrer.username || 'Игрок'
		}
	}
}

// 0.5% от ставок приглашённого за текущую неделю. Платится при открытии «Друзья».
export async function payReferralMilestones(referrerId: string) {
	if (WEEK_SHARE_PCT <= 0) return { paid: 0, count: 0 }

	await ready()
	let friends: Array<{ id: string; referredId: string }> = []
	try {
		const del = referralDelegate()
		friends = del
			? await del.findMany({ where: { referrerId }, select: { id: true, referredId: true } })
			: await prisma.$queryRawUnsafe(`SELECT "id", "referredId" FROM "Referral" WHERE "referrerId" = $1`, referrerId)
	} catch (err) {
		if (!isMissingRelation(err)) throw err
		return { paid: 0, count: 0 }
	}
	if (!friends.length) return { paid: 0, count: 0 }

	const { start, end } = weekRange()
	const weekKey = start.toISOString()
	let paid = 0n
	let count = 0

	// Раньше "уже выплачено на этой неделе" считалось суммированием WalletTransaction без
	// какой-либо блокировки — параллельные вызовы (эта функция дёргается при каждом открытии
	// вкладки «Друзья») могли оба прочитать одно и то же "already" и оба доначислить одну и
	// ту же delta, задваивая выплату. Теперь дедупликация идёт через ReferralWeeklyPayout
	// с уникальным индексом (referrerId, referredId, weekKey) и CAS-обновлением: первое
	// создание строки или условный UPDATE ... WHERE amount = $already выигрывает гонку,
	// а проигравший запрос просто получает 0 затронутых строк / P2002 и ничего не начисляет.
	for (const row of friends) {
		const agg = await prisma.gameSession.aggregate({
			where: { userId: row.referredId, status: 'FINISHED', createdAt: { gte: start, lt: end } },
			_sum: { betAmount: true }
		})
		const weeklyWager = Number(agg._sum?.betAmount || 0)
		const due = Math.floor(weeklyWager * WEEK_SHARE_PCT / 100)
		if (due <= 0) continue

		try {
			const delta = await prisma.$transaction(async (tx) => {
				const existing = await tx.referralWeeklyPayout.findUnique({
					where: { referrerId_referredId_weekKey: { referrerId, referredId: row.referredId, weekKey } }
				})
				let deltaAmount: number
				if (!existing) {
					try {
						await tx.referralWeeklyPayout.create({
							data: { referrerId, referredId: row.referredId, weekKey, amount: BigInt(due) }
						})
					} catch (e: any) {
						if (String(e?.code) === 'P2002') return 0 // кто-то другой успел создать строку первым — ничего не начисляем
						throw e
					}
					deltaAmount = due
				} else {
					const already = Number(existing.amount)
					deltaAmount = due - already
					if (deltaAmount <= 0) return 0
					const upd = await tx.$executeRawUnsafe(
						`UPDATE "ReferralWeeklyPayout" SET amount = $1 WHERE id = $2 AND amount = $3`,
						BigInt(due),
						existing.id,
						existing.amount
					)
					if (!upd) return 0 // проиграли гонку CAS — кто-то другой уже обновил эту строку
				}
				// Один вызов applyBalanceChange внутри одной транзакции, независимо от ветки — без
				// второго вызова снаружи, который раньше мог бы случайно сработать для delta === due и задвоить выплату.
				await applyBalanceChange({
					tx,
					userId: referrerId,
					amount: BigInt(deltaAmount),
					type: 'BONUS',
					source: 'referral-week',
					metadata: { referredId: row.referredId, weekKey, weeklyWager, percent: WEEK_SHARE_PCT }
				})
				const del = referralDelegate(tx)
				if (del) {
					await del.update({ where: { id: row.id }, data: { milestoneBonus: { increment: BigInt(deltaAmount) } } }).catch(async () => {
						await tx.$executeRawUnsafe(`UPDATE "Referral" SET "milestoneBonus" = "milestoneBonus" + $2 WHERE "id" = $1`, row.id, deltaAmount)
					})
				} else {
					await tx.$executeRawUnsafe(`UPDATE "Referral" SET "milestoneBonus" = "milestoneBonus" + $2 WHERE "id" = $1`, row.id, deltaAmount)
				}
				return deltaAmount
			})
			if (delta > 0) {
				paid += BigInt(delta)
				count++
			}
		} catch (err) {
			if (!isMissingRelation(err)) throw err
		}
	}

	return { paid: Number(paid), count }
}

export type ReferralStats = Awaited<ReturnType<typeof referralStats>>

export async function referralStats(userId: string) {
	const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
	const link = inviteLink(user)
	await ready()

	let rows: any[] = []
	try {
		const del = referralDelegate()
		rows = del
			? await del.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' }, take: 50 })
			: await prisma.$queryRawUnsafe(`SELECT * FROM "Referral" WHERE "referrerId" = $1 ORDER BY "createdAt" DESC LIMIT 50`, userId)
	} catch (err) {
		if (!isMissingRelation(err)) throw err
		rows = []
	}

	const ids = rows.map((r) => r.referredId)
	const friends = ids.length
		? await prisma.user.findMany({
				where: { id: { in: ids } },
				select: { id: true, playerId: true, username: true, firstName: true, photoUrl: true }
			})
		: []
	const byId = new Map(friends.map((f) => [f.id, f]))

	const { start, end } = weekRange()
	const wagerRows = ids.length
		? await prisma.gameSession.groupBy({
				by: ['userId'],
				where: { userId: { in: ids }, status: 'FINISHED', createdAt: { gte: start, lt: end } },
				_sum: { betAmount: true }
			})
		: []
	const wagerById = new Map(wagerRows.map((w) => [w.userId, Number(w._sum?.betAmount || 0)]))

	let invitedBy: any = null
	try {
		const del = referralDelegate()
		invitedBy = del
			? await del.findUnique({ where: { referredId: userId } })
			: ((await prisma.$queryRawUnsafe(`SELECT * FROM "Referral" WHERE "referredId" = $1 LIMIT 1`, userId)) as any[])[0] || null
	} catch (err) {
		if (!isMissingRelation(err)) throw err
	}
	let inviter: any = null
	if (invitedBy) {
		const r = await prisma.user.findUnique({
			where: { id: invitedBy.referrerId },
			select: { id: true, playerId: true, username: true, firstName: true, photoUrl: true }
		})
		if (r) inviter = { playerId: publicPlayerId(r), username: r.username, name: r.firstName || r.username || 'Игрок', photoUrl: r.photoUrl }
	}

	let earned = 0
	const list = rows.map((r) => {
		const f: any = byId.get(r.referredId)
		const wagered = wagerById.get(r.referredId) || 0
		earned += Number(r.registrationBonus) + Number(r.milestoneBonus)
		return {
			playerId: f ? publicPlayerId(f) : null,
			username: f ? f.username : null,
			name: f ? f.firstName || f.username || 'Игрок' : 'Игрок',
			photoUrl: f ? f.photoUrl : null,
			joinedAt: r.createdAt,
			wagered,
			weekShare: Math.floor(wagered * WEEK_SHARE_PCT / 100),
			earned: Number(r.registrationBonus) + Number(r.milestoneBonus),
			milestoneDone: true,
			milestoneProgress: 100
		}
	})

	return {
		link: link.url,
		code: link.code,
		configured: link.configured,
		playerId: publicPlayerId(user),
		rewards: {
			inviter: Number(INVITER_BONUS),
			invitee: Number(INVITEE_BONUS),
			weekSharePct: WEEK_SHARE_PCT
		},
		invitedCount: rows.length,
		totalEarned: earned,
		inviter,
		friends: list
	}
}


// Публичные данные бота для построения ссылки на клиенте.
export async function publicBotInfo() {
	const env = String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim()
	const info = env ? null : await resolveBotInfo()
	return {
		username: env || info?.username || null,
		link: miniAppLink() || null,
		appName: String(process.env.TELEGRAM_APP_NAME || '').replace(/^\/+|\/+$/g, '').trim() || null
	}
}
