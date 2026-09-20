export const ENGINE_VERSION = 'dg-1.1.0-double-symbol'
export const MIN_BET = 10
export const MAX_BET = 10000
export const BUY_BONUS_COST_MULTIPLIER = 100
export const FREE_SPINS_AWARD = 15
export const RETRIGGER_SPINS = 5
export const TRIGGER_SCATTERS = 4
export const RETRIGGER_SCATTERS = 3
export const ANTE_MULTIPLIER = 1.25
export const COLS = 6
export const ROWS = 5
export const MIN_PAY_COUNT = 8
export const BETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const

export const SCATTER_ID = 0
export const MULT_ID = -2

export type SymbolDef = {
	id: number
	name: string
	w: number
	pays: number[]
	isScatter?: boolean
	color: string
}

export const SYMS: SymbolDef[] = [
	{ id: 0, name: 'Стакан', w: 1.4, pays: [0, 0, 0, 0, 0], isScatter: true, color: '#7dd3fc' },
	{ id: 1, name: 'Пиво', w: 4.5, pays: [2, 2, 5, 5, 15], color: '#f59e0b' },
	{ id: 2, name: 'Сигарета', w: 5, pays: [1.5, 1.5, 2, 2, 12], color: '#e5e7eb' },
	{ id: 3, name: 'Зажигалка', w: 6.5, pays: [1, 1, 1.5, 1.5, 10], color: '#60a5fa' },
	{ id: 4, name: '10 руб', w: 8, pays: [0.8, 0.8, 1.2, 1.2, 8], color: '#e879f9' },
	{ id: 5, name: '5 руб', w: 10, pays: [0.5, 0.5, 1, 1, 5], color: '#7dd3fc' },
	{ id: 6, name: '2 руб', w: 11.5, pays: [0.4, 0.4, 0.9, 0.9, 4], color: '#86efac' },
	{ id: 7, name: '1 руб', w: 15, pays: [0.25, 0.25, 0.75, 0.75, 2], color: '#fbbf24' },
	{ id: 8, name: 'Бутылка водки', w: 3, pays: [2.5, 2.5, 10, 10, 25], color: '#bae6fd' },
	{ id: 9, name: 'Пьяница', w: 1.5, pays: [10, 10, 25, 25, 50], color: '#f87171' },
]

export const TW = SYMS.reduce((s, x) => s + x.w, 0)

export const ORB_MULTS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100, 250, 500, 1000] as const
export const ORB_NONE_WEIGHT = 79400
export const ORB_WEIGHTS = [6000, 4200, 3000, 1800, 600, 400, 1225, 875, 700, 420, 280, 700, 300, 60, 20, 20] as const
export const GLOBAL_MULT_CAP = 40
// Итоговая калибровка RTP (Return To Player) по результатам симуляции движка,
// чтобы казино всегда оставалось в плюсе независимо от цепочек фриспинов/множителей.
export const BASE_WIN_SCALE = 0.5
export const ANTE_WIN_SCALE = 0.54

export function publicPaytable() {
	return {
		engineVersion: ENGINE_VERSION,
		minBet: MIN_BET,
		maxBet: MAX_BET,
		bets: [...BETS],
		anteMultiplier: ANTE_MULTIPLIER,
		buyBonusCostMultiplier: BUY_BONUS_COST_MULTIPLIER,
		freeSpinsAward: FREE_SPINS_AWARD,
		retriggerSpins: RETRIGGER_SPINS,
		triggerScatters: TRIGGER_SCATTERS,
		retriggerScatters: RETRIGGER_SCATTERS,
		cols: COLS,
		rows: ROWS,
		payAnywhere: MIN_PAY_COUNT,
		symbols: SYMS.map((s) => ({
			id: s.id,
			name: s.name,
			pays: s.pays,
			isScatter: Boolean(s.isScatter),
			color: s.color,
		})),
	}
}
