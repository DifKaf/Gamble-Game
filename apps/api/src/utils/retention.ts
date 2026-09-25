import { prisma } from '../db.js'

// Очистка старых строк: любой тариф Postgres (включая Railway Postgres) имеет
// конечный лимит диска, а каждый спин пишет строку в кошелёк и строку истории
// игры. Без подрезки место рано или поздно кончится, и база перестанет принимать
// запись. Подбери RETENTION_DAYS / SESSION_RETENTION_DAYS под свой тариф и нагрузку.
//
// Переводы между игроками НЕ удаляются никогда — это история кошелька,
// которая должна сохраняться. Удаляются только ставки/выигрыши и завершённые раунды.

const BATCH = 5000
const MAX_BATCHES = 40

type Log = { info: (msg: string) => void; warn: (msg: string) => void }

async function deleteInBatches(sql: string, cutoff: Date): Promise<number> {
	let total = 0
	for (let i = 0; i < MAX_BATCHES; i++) {
		const removed = await prisma.$executeRawUnsafe(sql, cutoff)
		total += removed
		if (removed < BATCH) break
	}
	return total
}

export async function pruneOldRows(log?: Log) {
	const info = (msg: string) => (log ? log.info(msg) : console.log(msg))
	const warn = (msg: string) => (log ? log.warn(msg) : console.warn(msg))

	// Railway Pro: диска хватает, поэтому по умолчанию храним полгода истории.
	// RETENTION_DAYS=0 — не удалять историю ставок вовсе.
	const days = Number(process.env.RETENTION_DAYS ?? 180)
	const sessionDays = Math.max(Number(process.env.SESSION_RETENTION_DAYS || 30), 1)
	if (!Number.isFinite(days) || days <= 0) {
		info('retention: выключена (RETENTION_DAYS=0)')
		return
	}
	if (days < 3) warn('retention: RETENTION_DAYS меньше 3 — используем 3')
	const cutoff = new Date(Date.now() - Math.max(days, 3) * 86400000)
	const sessionCutoff = new Date(Date.now() - sessionDays * 86400000)

	try {
		// Ставки и выигрыши старше RETENTION_DAYS. ctid-батчи вместо одного огромного
		// DELETE, чтобы не держать длинную блокировку таблицы.
		const wallet = await deleteInBatches(
			`DELETE FROM "WalletTransaction" WHERE ctid IN (
				SELECT ctid FROM "WalletTransaction"
				WHERE "createdAt" < $1
				  AND ("source" IS NULL OR "source" NOT IN ('transfer-in', 'transfer-out'))
				LIMIT ${BATCH}
			)`,
			cutoff
		)

		const rounds = await deleteInBatches(
			`DELETE FROM "GameSession" WHERE ctid IN (
				SELECT ctid FROM "GameSession" WHERE "createdAt" < $1 LIMIT ${BATCH}
			)`,
			cutoff
		)

		// Завершённые сессии игр нужны только на время раунда, их держим совсем коротко.
		let sessions = 0
		for (const table of ['MinesSession', 'CoinflipSession', 'BlackjackSession', 'SlotSession']) {
			sessions += await deleteInBatches(
				`DELETE FROM "${table}" WHERE ctid IN (
					SELECT ctid FROM "${table}"
					WHERE "status" <> 'CREATED' AND "createdAt" < $1
					LIMIT ${BATCH}
				)`,
				sessionCutoff
			)
		}

		if (wallet || rounds || sessions) {
			info(`retention: removed ${wallet} wallet rows, ${rounds} game rounds, ${sessions} game sessions`)
		} else {
			info(`retention: nothing to remove (window ${days}d / sessions ${sessionDays}d)`)
		}
	} catch (err: any) {
		warn(`retention skipped: ${err?.message || err}`)
	}
}

/** Запускает очистку на старте и дальше раз в сутки. */
export function scheduleRetention(log?: Log) {
	// Не нагружаем базу в первые минуты после деплоя — очистка стартует чуть позже.
	const first = setTimeout(() => void pruneOldRows(log), 5 * 60 * 1000)
	if (typeof first.unref === 'function') first.unref()
	const timer = setInterval(() => void pruneOldRows(log), 24 * 60 * 60 * 1000)
	if (typeof timer.unref === 'function') timer.unref()
	return timer
}
