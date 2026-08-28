export const ENGINE_VERSION = 'dh-1.0.0'
export const MIN_BET = 10
export const MAX_BET = 10000
export const BUY_BONUS_COST_MULTIPLIER = 100
export const FREE_SPINS_AWARD = 8
export const RETRIGGER_SPINS = 8
export const TRIGGER_SCATTERS = 3
export const COLS = 5
export const ROWS = 3
export const LINES = 20
export const BETS = [10, 20, 50, 100, 200, 500, 1000, 2500, 5000, 10000] as const

export const WILD_ID = 1
export const SCATTER_ID = 0

export type SymbolDef = {
	id: number
	name: string
	w: number
	pays: [number, number, number]
	isScatter?: boolean
	isWild?: boolean
}

export const SYMS: SymbolDef[] = [
	{ id: 0, name: 'Scatter', w: 1.2, pays: [0, 0, 0], isScatter: true },
	{ id: 1, name: 'Wild', w: 1.6, pays: [2, 10, 50], isWild: true },
	{ id: 2, name: 'Girl', w: 2.2, pays: [2, 10, 50] },
	{ id: 3, name: 'Guy', w: 2.6, pays: [1.5, 8, 40] },
	{ id: 4, name: 'Purple', w: 3.4, pays: [1.2, 6, 30] },
	{ id: 5, name: 'Green', w: 4.2, pays: [1, 4, 20] },
	{ id: 6, name: 'Brown', w: 5, pays: [0.8, 3, 15] },
	{ id: 7, name: 'A', w: 7, pays: [0.5, 2, 10] },
	{ id: 8, name: 'K', w: 8, pays: [0.4, 1.5, 8] },
	{ id: 9, name: 'Q', w: 9, pays: [0.3, 1.2, 6] },
	{ id: 10, name: 'J', w: 10, pays: [0.25, 1, 5] },
	{ id: 11, name: '10', w: 11, pays: [0.2, 0.8, 4] },
]

export const TW = SYMS.reduce((s, x) => s + x.w, 0)

export const PAYLINES: number[][] = [
	[1, 1, 1, 1, 1],
	[0, 0, 0, 0, 0],
	[2, 2, 2, 2, 2],
	[0, 1, 2, 1, 0],
	[2, 1, 0, 1, 2],
	[0, 0, 1, 0, 0],
	[2, 2, 1, 2, 2],
	[1, 0, 0, 0, 1],
	[1, 2, 2, 2, 1],
	[0, 1, 1, 1, 0],
	[2, 1, 1, 1, 2],
	[1, 0, 1, 0, 1],
	[1, 2, 1, 2, 1],
	[0, 1, 0, 1, 0],
	[2, 1, 2, 1, 2],
	[1, 1, 0, 1, 1],
	[1, 1, 2, 1, 1],
	[0, 2, 0, 2, 0],
	[2, 0, 2, 0, 2],
	[0, 2, 2, 2, 0],
]

export function publicPaytable() {
	return {
		engineVersion: ENGINE_VERSION,
		minBet: MIN_BET,
		maxBet: MAX_BET,
		bets: [...BETS],
		buyBonusCostMultiplier: BUY_BONUS_COST_MULTIPLIER,
		freeSpinsAward: FREE_SPINS_AWARD,
		retriggerSpins: RETRIGGER_SPINS,
		triggerScatters: TRIGGER_SCATTERS,
		cols: COLS,
		rows: ROWS,
		lines: LINES,
		symbols: SYMS.map((s) => ({
			id: s.id,
			name: s.name,
			pays: s.pays,
			isScatter: Boolean(s.isScatter),
			isWild: Boolean(s.isWild),
		})),
	}
}
