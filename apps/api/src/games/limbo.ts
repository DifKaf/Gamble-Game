import { randomFloat } from '../utils/random.js'

// Limbo — как на крупных крипто-казино: игрок выбирает целевой множитель,
// сервер генерирует случайный «потолок». Если потолок ≥ цели — выплата ставка × цель.
// P(потолок ≥ x) = (1 − преимущество) / x, поэтому RTP одинаков для любой цели.
export const LIMBO_HOUSE_EDGE = 0.01
export const LIMBO_MIN_TARGET = 1.01
export const LIMBO_MAX_TARGET = 1000

export function limboCrashPoint(): number {
  const r = randomFloat()
  const raw = (1 - LIMBO_HOUSE_EDGE) / (1 - r)
  return Math.max(1, Math.floor(raw * 100) / 100)
}

export function playLimbo(p:{betAmount:number; payload?:{target?:number}}){
  const t = Number(p.payload?.target)
  const target = Math.min(LIMBO_MAX_TARGET, Math.max(LIMBO_MIN_TARGET, Number.isFinite(t) ? Math.floor(t*100)/100 : 2))
  const result = limboCrashPoint()
  const win = result >= target
  const winAmount = win ? Math.floor(p.betAmount * target) : 0
  const chance = Math.round((1 - LIMBO_HOUSE_EDGE) / target * 10000) / 100
  return { game:'limbo', target, result, chance, win, multiplier: win ? target : 0, winAmount }
}
