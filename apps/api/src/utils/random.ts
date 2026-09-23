import { randomBytes, randomInt as cryptoRandomInt } from 'crypto'

// Криптостойкий ГСЧ для всех игр. Math.random() предсказуем и не годится для ставок.

/** Целое число в диапазоне [0, max). */
export function randomInt(max: number): number {
	return cryptoRandomInt(0, max)
}

/** Дробное число в диапазоне [0, 1) с 48 битами точности. */
export function randomFloat(): number {
	// crypto.randomInt принимает диапазон строго меньше 2^48, поэтому берём 6 случайных байтов напрямую.
	return randomBytes(6).readUIntBE(0, 6) / 2 ** 48
}

/** Выбрать k уникальных чисел из [0, n) — частичная тасовка Фишера–Йетса. */
export function sampleUnique(n: number, k: number): number[] {
	const arr = Array.from({ length: n }, (_, i) => i)
	for (let i = 0; i < k; i++) {
		const j = i + randomInt(n - i)
		;[arr[i], arr[j]] = [arr[j], arr[i]]
	}
	return arr.slice(0, k)
}
