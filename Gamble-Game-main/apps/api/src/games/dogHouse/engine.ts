import {
	BUY_BONUS_COST_MULTIPLIER,
	COLS,
	ENGINE_VERSION,
	FREE_SPINS_AWARD,
	LINES,
	PAYLINES,
	RETRIGGER_SPINS,
	ROWS,
	SCATTER_ID,
	SYMS,
	TRIGGER_SCATTERS,
	TW,
	WILD_ID,
} from './config.js'
import { makeRng } from './rng.js'

export type StickyWild = { c: number; r: number; mult: number }

export type LineWin = {
	line: number
	symbol: number
	count: number
	win: number
	mult: number
	positions: Array<{ c: number; r: number }>
}

export type SpinOutcome = {
	game: 'dog-house'
	engineVersion: string
	mode: 'base' | 'free'
	nonce: number
	stake: number
	grid: number[][]
	wildMults: Array<Array<number | null>>
	stickyWilds: StickyWild[]
	lines: LineWin[]
	win: number
	multiplier: number
	scatters: number
	freeSpinsAwarded: number
	freeSpinsLeft: number
}

function pickSymbol(rng: { random: () => number }, scatterBoost = false) {
	let roll = rng.random() * TW
	for (const s of SYMS) {
		let w = s.w
		if (scatterBoost && s.id === SCATTER_ID) w *= 3.2
		roll -= w
		if (roll <= 0) return s.id
	}
	return SYMS[SYMS.length - 1].id
}

function wildMult(rng: { random: () => number }) {
	return rng.random() < 0.35 ? 3 : 2
}

function fillGrid(rng: { random: () => number }, sticky: StickyWild[], scatterBoost: boolean) {
	const grid: number[][] = []
	const wildMults: Array<Array<number | null>> = []
	for (let c = 0; c < COLS; c++) {
		grid[c] = []
		wildMults[c] = []
		for (let r = 0; r < ROWS; r++) {
			const stuck = sticky.find((w) => w.c === c && w.r === r)
			if (stuck) {
				grid[c][r] = WILD_ID
				wildMults[c][r] = stuck.mult
				continue
			}
			let id = pickSymbol(rng, scatterBoost)
			if (id === WILD_ID && (c === 0 || c === COLS - 1)) id = pickSymbol(rng, false)
			grid[c][r] = id
			wildMults[c][r] = id === WILD_ID ? wildMult(rng) : null
		}
	}
	return { grid, wildMults }
}

function countScatters(grid: number[][]) {
	let n = 0
	for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) if (grid[c][r] === SCATTER_ID) n++
	return n
}

function evalLines(grid: number[][], wildMults: Array<Array<number | null>>, stake: number): LineWin[] {
	const lineBet = stake / LINES
	const wins: LineWin[] = []
	for (let li = 0; li < PAYLINES.length; li++) {
		const line = PAYLINES[li]
		let symbol = -1
		let count = 0
		let mult = 1
		const positions: Array<{ c: number; r: number }> = []
		for (let c = 0; c < COLS; c++) {
			const r = line[c]
			const id = grid[c][r]
			if (id === SCATTER_ID) break
			if (id === WILD_ID) {
				count++
				positions.push({ c, r })
				mult *= wildMults[c][r] || 1
				continue
			}
			if (symbol < 0) symbol = id
			if (id !== symbol) break
			count++
			positions.push({ c, r })
		}
		if (symbol < 0) {
			symbol = WILD_ID
		}
		if (count < 3) continue
		const def = SYMS.find((s) => s.id === symbol)
		if (!def) continue
		const pay = def.pays[count - 3] || 0
		if (pay <= 0) continue
		const win = Math.round(lineBet * pay * mult)
		if (win > 0) wins.push({ line: li, symbol, count, win, mult, positions })
	}
	return wins
}

export function playSpin(args: {
	stake: number
	seed: string
	nonce: number
	clientSeed?: string
	mode?: 'base' | 'free'
	freeSpinsLeft?: number
	stickyWilds?: StickyWild[]
	buyBonus?: boolean
}): SpinOutcome {
	const mode = args.mode || 'base'
	const rng = makeRng(args.seed, args.nonce, args.clientSeed || '')
	const prevSticky = mode === 'free' ? [...(args.stickyWilds || [])] : []
	const { grid, wildMults } = fillGrid(rng, prevSticky, Boolean(args.buyBonus) && mode === 'base')
	const scatters = countScatters(grid)
	const lines = evalLines(grid, wildMults, args.stake)
	const win = lines.reduce((s, x) => s + x.win, 0)
	let freeSpinsAwarded = 0
	let freeSpinsLeft = args.freeSpinsLeft || 0
	if (mode === 'base' && scatters >= TRIGGER_SCATTERS) {
		freeSpinsAwarded = FREE_SPINS_AWARD + Math.max(0, scatters - TRIGGER_SCATTERS) * 2
		freeSpinsLeft = freeSpinsAwarded
	} else if (mode === 'free') {
		freeSpinsLeft = Math.max(0, freeSpinsLeft - 1)
		if (scatters >= TRIGGER_SCATTERS) {
			freeSpinsAwarded = RETRIGGER_SPINS
			freeSpinsLeft += RETRIGGER_SPINS
		}
	}
	const stickyWilds: StickyWild[] = mode === 'free' ? [...prevSticky] : []
	if (mode === 'free') {
		for (let c = 0; c < COLS; c++) {
			for (let r = 0; r < ROWS; r++) {
				if (grid[c][r] === WILD_ID && !stickyWilds.some((w) => w.c === c && w.r === r)) {
					stickyWilds.push({ c, r, mult: wildMults[c][r] || 2 })
				}
			}
		}
	}
	return {
		game: 'dog-house',
		engineVersion: ENGINE_VERSION,
		mode,
		nonce: args.nonce,
		stake: args.stake,
		grid,
		wildMults,
		stickyWilds: mode === 'free' ? stickyWilds : [],
		lines,
		win,
		multiplier: args.stake > 0 ? win / args.stake : 0,
		scatters,
		freeSpinsAwarded,
		freeSpinsLeft,
	}
}

export function stakeFor(bet: number) {
	return Math.max(10, Math.round(Number(bet) || 10))
}

export function buyBonusCost(bet: number) {
	return stakeFor(bet) * BUY_BONUS_COST_MULTIPLIER
}
