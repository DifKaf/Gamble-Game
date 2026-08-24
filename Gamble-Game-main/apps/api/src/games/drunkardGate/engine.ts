import {
	ANTE_MULTIPLIER,
	COLS,
	ENGINE_VERSION,
	FREE_SPINS_AWARD,
	MIN_PAY_COUNT,
	MULT_ID,
	ORB_MULTS,
	ORB_NONE_WEIGHT,
	ORB_WEIGHTS,
	RETRIGGER_SCATTERS,
	RETRIGGER_SPINS,
	ROWS,
	SCATTER_ID,
	SYMS,
	TRIGGER_SCATTERS,
	TW,
	type SymbolDef,
} from './config.js'
import { makeRng } from './rng.js'

export type EncodedCell = {
	id: number
	kind: 'sym' | 'scatter' | 'mult'
	mult?: number
	color: string
	name: string
}

export type ClusterWin = {
	symId: number
	cells: Array<[number, number]>
	pay: number
}

export type SpinFrame = {
	grid: EncodedCell[][]
	clusters?: ClusterWin[]
	tumbleWin?: number
	spinWin?: number
	mults?: Array<{ c: number; r: number; mult: number }>
	appliedMult?: number
	winAfterMult?: number
}

export type PlaySpinInput = {
	seed: string
	nonce: number
	clientSeed?: string
	stake: number
	ante: boolean
	mode: 'base' | 'free'
	freeSpinsLeft: number
	globalMult: number
}

export type SpinOutcome = {
	engineVersion: string
	mode: 'base' | 'free'
	nonce: number
	stake: number
	ante: boolean
	win: number
	multiplier: number
	scatters: number
	cascades: number
	freeSpinsAwarded: number
	freeSpinsLeft: number
	globalMult: number
	triggeredFreeSpins: boolean
	frames: SpinFrame[]
}

type Cell = {
	id: number
	isScatter?: boolean
	isMult?: boolean
	mult?: number
	name: string
	color: string
}

type Rng = () => number

export function stakeFor(betAmount: number, ante: boolean) {
	return ante ? Math.round(betAmount * ANTE_MULTIPLIER) : betAmount
}

function cloneSym(s: SymbolDef): Cell {
	return { id: s.id, name: s.name, color: s.color, isScatter: Boolean(s.isScatter) }
}

function makeMult(m: number): Cell {
	return { id: MULT_ID, isMult: true, mult: m, name: '×' + m, color: '#fbbf24' }
}

function encode(cell: Cell): EncodedCell {
	if (cell.isMult) {
		return { id: MULT_ID, kind: 'mult', mult: cell.mult, color: cell.color, name: cell.name }
	}
	if (cell.isScatter || cell.id === SCATTER_ID) {
		return { id: SCATTER_ID, kind: 'scatter', color: cell.color, name: cell.name }
	}
	return { id: cell.id, kind: 'sym', color: cell.color, name: cell.name }
}

function encodeGrid(grid: Cell[][]): EncodedCell[][] {
	return grid.map((col) => col.map(encode))
}

function rSym(rng: Rng, ante: boolean): Cell {
	const scatterBonus = ante ? 2 : 0
	const totalW = TW + scatterBonus
	let r = rng() * totalW
	for (const s of SYMS) {
		const w = s.w + (s.id === SCATTER_ID ? scatterBonus : 0)
		r -= w
		if (r <= 0) return cloneSym(s)
	}
	return cloneSym(SYMS[7])
}

function rSymNoSc(rng: Rng, ante: boolean): Cell {
	let s = rSym(rng, ante)
	let guard = 0
	while (s.isScatter && ++guard < 40) s = rSym(rng, ante)
	return s.isScatter ? cloneSym(SYMS[7]) : s
}

function pickMultOrNone(rng: Rng): number | null {
	const tw = ORB_NONE_WEIGHT + ORB_WEIGHTS.reduce((a, b) => a + b, 0)
	let r = rng() * tw
	r -= ORB_NONE_WEIGHT
	if (r <= 0) return null
	for (let i = 0; i < ORB_MULTS.length; i++) {
		r -= ORB_WEIGHTS[i]
		if (r <= 0) return ORB_MULTS[i]
	}
	return null
}

function payIndex(n: number) {
	if (n >= 12) return 4
	if (n >= 11) return 3
	if (n >= 10) return 2
	if (n >= 9) return 1
	if (n >= 8) return 0
	return -1
}

function findClusters(grid: Cell[][]): Array<{ symId: number; cls: Array<[number, number]> }> {
	const groups: Record<number, Array<[number, number]>> = {}
	for (let c = 0; c < COLS; c++) {
		for (let r = 0; r < ROWS; r++) {
			const sym = grid[c][r]
			if (!sym || sym.isScatter || sym.isMult) continue
			;(groups[sym.id] = groups[sym.id] || []).push([c, r])
		}
	}
	const out: Array<{ symId: number; cls: Array<[number, number]> }> = []
	for (const sid of Object.keys(groups)) {
		const cls = groups[Number(sid)]
		if (cls.length >= MIN_PAY_COUNT) out.push({ symId: Number(sid), cls })
	}
	return out
}

function countScatters(grid: Cell[][]) {
	let n = 0
	for (let c = 0; c < COLS; c++) {
		for (let r = 0; r < ROWS; r++) {
			if (grid[c][r]?.isScatter) n++
		}
	}
	return n
}

function gridMults(grid: Cell[][]) {
	const a: Array<{ c: number; r: number; mult: number }> = []
	for (let c = 0; c < COLS; c++) {
		for (let r = 0; r < ROWS; r++) {
			const s = grid[c][r]
			if (s?.isMult && s.mult) a.push({ c, r, mult: s.mult })
		}
	}
	return a
}

function dealGrid(rng: Rng, ante: boolean): Cell[][] {
	const grid: Cell[][] = []
	for (let c = 0; c < COLS; c++) {
		grid[c] = []
		let hasSc = false
		for (let r = 0; r < ROWS; r++) {
			let s = rSym(rng, ante)
			if (s.isScatter) {
				if (hasSc) s = rSymNoSc(rng, ante)
				else hasSc = true
			}
			grid[c][r] = s
		}
	}
	return grid
}

function breakOpeningWins(grid: Cell[][], rng: Rng, ante: boolean) {
	if (findClusters(grid).length === 0 || rng() >= 0.5) return
	let guard = 0
	let clusters = findClusters(grid)
	while (clusters.length > 0 && guard < 20) {
		for (const g of clusters) {
			for (let i = 7; i < g.cls.length; i++) {
				const [cc, rr] = g.cls[i]
				let ns = rSymNoSc(rng, ante)
				let inner = 0
				while (ns.id === g.symId && ++inner < 20) ns = rSymNoSc(rng, ante)
				grid[cc][rr] = ns
			}
		}
		clusters = findClusters(grid)
		guard++
	}
}

function placeOpeningMult(grid: Cell[][], rng: Rng) {
	const mv = pickMultOrNone(rng)
	if (mv == null) return
	const spots: Array<[number, number]> = []
	for (let c = 0; c < COLS; c++) {
		for (let r = 0; r < ROWS; r++) {
			if (!grid[c][r].isScatter) spots.push([c, r])
		}
	}
	if (!spots.length) return
	const [c, r] = spots[Math.floor(rng() * spots.length)]
	grid[c][r] = makeMult(mv)
}

function drop(grid: Cell[][], wins: Array<[number, number]>, rng: Rng, ante: boolean) {
	const winSet = new Set(wins.map(([c, r]) => c + ':' + r))
	const newCells: Array<[number, number]> = []
	for (let c = 0; c < COLS; c++) {
		const survivors: Cell[] = []
		for (let r = 0; r < ROWS; r++) {
			if (!winSet.has(c + ':' + r) && grid[c][r]) survivors.push(grid[c][r])
		}
		const gaps = ROWS - survivors.length
		let hasSc = survivors.some((s) => s.isScatter)
		const next: Cell[] = []
		for (let i = 0; i < gaps; i++) {
			let s = rSym(rng, ante)
			if (s.isScatter) {
				if (hasSc) s = rSymNoSc(rng, ante)
				else hasSc = true
			}
			next.push(s)
			newCells.push([c, i])
		}
		for (const s of survivors) next.push(s)
		grid[c] = next
	}
	if (newCells.length) {
		const mv = pickMultOrNone(rng)
		if (mv != null) {
			const [c, r] = newCells[Math.floor(rng() * newCells.length)]
			grid[c][r] = makeMult(mv)
		}
	}
}

export function playSpin(input: PlaySpinInput): SpinOutcome {
	const rng = makeRng(input.seed, input.nonce, input.clientSeed ?? '').random
	const ante = Boolean(input.ante)
	const stake = Number(input.stake) || 0
	const mode = input.mode === 'free' ? 'free' : 'base'
	const grid = dealGrid(rng, ante)
	breakOpeningWins(grid, rng, ante)
	placeOpeningMult(grid, rng)

	const frames: SpinFrame[] = [{ grid: encodeGrid(grid) }]
	let scatterCount = countScatters(grid)
	let maxScatters = scatterCount
	let triggeredFreeSpins = false
	let freeSpinsAwarded = 0
	let freeSpinsLeft = input.freeSpinsLeft
	let globalMult = input.globalMult || 0
	let spinWin = 0
	let cascades = 0

	if (mode === 'base' && scatterCount >= TRIGGER_SCATTERS) {
		triggeredFreeSpins = true
		freeSpinsAwarded = FREE_SPINS_AWARD
		freeSpinsLeft = FREE_SPINS_AWARD
	} else {
		let retriggered = false
		if (mode === 'free' && scatterCount >= RETRIGGER_SCATTERS) {
			retriggered = true
			freeSpinsAwarded += RETRIGGER_SPINS
		}

		for (let step = 0; step < 50; step++) {
			const clusters = findClusters(grid)
			if (!clusters.length) break

			let rWin = 0
			const clusterWins: ClusterWin[] = clusters.map(({ symId, cls }) => {
				const sym = SYMS.find((s) => s.id === symId) || SYMS[7]
				const pi = payIndex(cls.length)
				const pay = pi >= 0 ? Math.round(sym.pays[pi] * stake) : 0
				rWin += pay
				return { symId, cells: cls, pay }
			})
			rWin = Math.round(rWin)
			spinWin += rWin
			cascades++

			const winCells = clusters.flatMap((g) => g.cls)
			drop(grid, winCells, rng, ante)
			scatterCount = countScatters(grid)
			if (scatterCount > maxScatters) maxScatters = scatterCount

			frames.push({
				grid: encodeGrid(grid),
				clusters: clusterWins,
				tumbleWin: rWin,
				spinWin,
			})

			if (mode === 'base' && scatterCount >= TRIGGER_SCATTERS) {
				triggeredFreeSpins = true
				freeSpinsAwarded = FREE_SPINS_AWARD
				freeSpinsLeft = FREE_SPINS_AWARD
				break
			}
			if (mode === 'free' && !retriggered && scatterCount >= RETRIGGER_SCATTERS) {
				retriggered = true
				freeSpinsAwarded += RETRIGGER_SPINS
			}
		}

		const finalMults = gridMults(grid)
		if (mode === 'base' && spinWin > 0 && finalMults.length) {
			const totMult = finalMults.reduce((a, b) => a + b.mult, 0)
			const bonus = Math.round(spinWin * (totMult - 1))
			spinWin += bonus
			frames.push({
				grid: encodeGrid(grid),
				mults: finalMults,
				appliedMult: totMult,
				spinWin,
				winAfterMult: spinWin,
			})
		}
		if (mode === 'free' && spinWin > 0) {
			const add = finalMults.reduce((a, b) => a + b.mult, 0)
			if (add > 0) {
				globalMult += add
				const bonus = Math.round(spinWin * (globalMult - 1))
				spinWin += bonus
				frames.push({
					grid: encodeGrid(grid),
					mults: finalMults,
					appliedMult: globalMult,
					spinWin,
					winAfterMult: spinWin,
				})
			}
		}

		if (mode === 'free') {
			freeSpinsLeft = Math.max(0, (input.freeSpinsLeft || 0) - 1 + freeSpinsAwarded)
		}
	}

	const win = Math.max(0, Math.round(spinWin))
	return {
		engineVersion: ENGINE_VERSION,
		mode,
		nonce: input.nonce,
		stake,
		ante,
		win,
		multiplier: stake > 0 ? win / stake : 0,
		scatters: Math.max(maxScatters, scatterCount),
		cascades,
		freeSpinsAwarded,
		freeSpinsLeft,
		globalMult,
		triggeredFreeSpins,
		frames,
	}
}
