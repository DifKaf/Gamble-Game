// Публичный ID игрока.
//
// Раньше ID вычислялся как хэш от UUID на каждом запросе. Из-за этого он
// не был по-настоящему уникальным (коллизии) и не был виден в базе, а клиент
// в оффлайн-режиме подставлял свой локальный фейковый ID (ID: 120001 у всех).
//
// Теперь каждому пользователю Postgres выдаёт уникальный последовательный
// `playerId` (см. `model User` в schema.prisma). Хэш остаётся только как
// fallback для старых строк, если миграция ещё не применена.

export function computePlayerId(id: string): string {
	const str = String(id || '')
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 131 + str.charCodeAt(i)) % 900000
		if (hash < 0) hash += 900000
	}
	return String(100000 + hash)
}

// Единственная функция, которой должны пользоваться роуты.
export function publicPlayerId(user: { id: string; playerId?: number | null } | null | undefined): string {
	if (!user) return ''
	if (typeof user.playerId === 'number' && user.playerId > 0) return String(user.playerId)
	return computePlayerId(user.id)
}

// Нормализует ввод пользователя ("ID 100042", "#100042", "100042") в число.
export function parsePlayerId(raw: string): number | null {
	const digits = String(raw || '').replace(/\D/g, '')
	if (!digits) return null
	const n = Number(digits)
	return Number.isSafeInteger(n) && n > 0 ? n : null
}
