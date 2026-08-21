// Deterministic pseudo-unique 6-digit player id derived from a user's UUID.
// Same input id always produces the same output id, and different ids produce
// well-distributed different outputs (unlike naively extracting digit chars
// from the UUID, which collides heavily for ids sharing a similar prefix).
export function computePlayerId(id: string): string {
	const str = String(id || '')
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 131 + str.charCodeAt(i)) % 900000
		if (hash < 0) hash += 900000
	}
	return String(100000 + hash)
}
