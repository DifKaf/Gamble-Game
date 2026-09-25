// Крошечный TTL-кэш в памяти процесса.
//
// Задача: снять с базы однотипные запросы, которые все игроки шлют одновременно
// (лив-история игр, лидерборд). Результат один и тот же для всех, а значит считать
// его достаточно раз в несколько секунд.
//
// Важно: кэш живёт в памяти одного инстанса. При масштабировании в несколько
// реплик нужен будет Redis — сейчас сервис один, так что этого достаточно.

type Entry = { value: unknown; expiresAt: number }

const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
const MAX_ENTRIES = 500

function sweep() {
	const now = Date.now()
	for (const [key, entry] of store) {
		if (entry.expiresAt <= now) store.delete(key)
	}
	// Аварийный предохранитель от роста памяти на ключах с user id.
	if (store.size > MAX_ENTRIES) {
		const extra = store.size - MAX_ENTRIES
		let i = 0
		for (const key of store.keys()) {
			if (i++ >= extra) break
			store.delete(key)
		}
	}
}

/**
 * Возвращает значение из кэша или считает его один раз.
 *
 * Параллельные запросы с одним ключом ждут один и тот же promise, иначе при всплеске
 * нагрузки сотня игроков одновременно ушла бы в базу (cache stampede).
 */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
	const now = Date.now()
	const hit = store.get(key)
	if (hit && hit.expiresAt > now) return hit.value as T

	const running = inflight.get(key)
	if (running) return running as Promise<T>

	const task = loader()
		.then((value) => {
			store.set(key, { value, expiresAt: Date.now() + ttlMs })
			inflight.delete(key)
			if (store.size > MAX_ENTRIES) sweep()
			return value
		})
		.catch((err) => {
			inflight.delete(key)
			// Если есть протухшее значение — отдаём его, чтобы моргание базы не ломало экран.
			if (hit) return hit.value as T
			throw err
		})

	inflight.set(key, task)
	return task as Promise<T>
}

/** Сбросить все ключи с указанным префиксом. */
export function invalidate(prefix: string) {
	for (const key of store.keys()) {
		if (key.startsWith(prefix)) store.delete(key)
	}
}
