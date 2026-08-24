import { prisma } from '../db.js'

// Выдаёт индивидуальный playerId всем игрокам и держит нумерацию в диапазоне 100001+.
//
// Зачем это в коде, а не только в миграции: без колонки `playerId` все запросы,
// которые её выбирают, падают с ошибкой — и в профиле вместо ID показывался прочерк.
// Теперь API сам доводит схему до нужного вида на старте: достаточно перезалить сервер.
//
// Все шаги идемпотентные: повторный запуск ничего не ломает и ничего не сдвигает.
export async function ensurePlayerIds(log?: { info: (msg: string) => void; warn: (msg: string) => void }) {
	const info = (msg: string) => (log ? log.info(msg) : console.log(msg))
	const warn = (msg: string) => (log ? log.warn(msg) : console.warn(msg))

	try {
		// 1. Колонка + автоинкремент. SERIAL сразу заполняет существующие строки (1, 2, 3, ...).
		await prisma.$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "playerId" SERIAL')

		// 2. На случай строк, созданных без значения.
		await prisma.$executeRawUnsafe(
			'UPDATE "User" SET "playerId" = nextval(pg_get_serial_sequence(\'"User"\', \'playerId\')) WHERE "playerId" IS NULL'
		)

		// 3. Шестизначные ID: 1 -> 100001. Один раз, только для маленьких значений.
		const shifted = await prisma.$executeRawUnsafe(
			'UPDATE "User" SET "playerId" = "playerId" + 100000 WHERE "playerId" < 100000'
		)

		// 4. Следующие регистрации продолжают нумерацию с максимума.
		await prisma.$executeRawUnsafe(
			'SELECT setval(pg_get_serial_sequence(\'"User"\', \'playerId\'), GREATEST((SELECT COALESCE(MAX("playerId"), 100000) FROM "User"), 100000))'
		)

		// 5. Уникальность — чтобы два игрока не могли получить один ID.
		await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "User_playerId_key" ON "User"("playerId")')

		const rows = await prisma.$queryRawUnsafe<Array<{ total: bigint; min: number | null; max: number | null }>>(
			'SELECT COUNT(*)::bigint AS total, MIN("playerId") AS min, MAX("playerId") AS max FROM "User"'
		)
		const r = rows[0]
		info(
			`playerId ready: ${r ? Number(r.total) : 0} users, range ${r?.min ?? '-'}..${r?.max ?? '-'}` +
				(shifted ? `, shifted ${shifted} legacy ids into the 100001+ range` : '')
		)
	} catch (err: any) {
		// Не роняем API из-за прав на DDL или гонки двух инстансов на старте.
		warn(`ensurePlayerIds skipped: ${err?.message || err}`)
	}
}
