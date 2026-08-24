import { createHash, randomBytes } from 'crypto'

export function newSeed() {
	return randomBytes(32).toString('hex')
}

export function seedHash(seed: string) {
	return createHash('sha256').update(String(seed || '')).digest('hex')
}

/** Детерминированный ГПСЧ: одинаковые seed/nonce/clientSeed всегда дают один спин. */
export function makeRng(seed: string, nonce: number, clientSeed = '') {
	let counter = 0
	const random = () => {
		const h = createHash('sha256')
			.update(`${seed}:${clientSeed}:${nonce}:${counter++}`)
			.digest()
		return h.readUInt32BE(0) / 0x100000000
	}
	return { random }
}
