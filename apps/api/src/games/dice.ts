import { randomInt } from '../utils/random.js'
// Множители = честные шансы × (1 − 3% преимущества казино), как в «Минах».
// P(<7) = P(>7) = 15/36, P(=7) = 6/36. Раньше ×1.9 давало RTP ~79%, ×5 — ~83%.
export const DICE_MULTIPLIERS = { over: 2.33, under: 2.33, exact: 5.82 } as const
export function playDice(p:{betAmount:number; payload?:{mode?:'over'|'under'|'exact'; target?:number}}){
  const mode=p.payload?.mode||'over'
  const d1=randomInt(6)+1
  const d2=randomInt(6)+1
  const roll=d1+d2
  const win=mode==='exact'?roll===7:(mode==='under'?roll<7:roll>7)
  const multiplier=DICE_MULTIPLIERS[mode==='exact'?'exact':mode==='under'?'under':'over']
  const winAmount=win?Math.floor(p.betAmount*multiplier):0
  return {game:'dice',dice:[d1,d2],d1,d2,roll,mode,target:mode==='exact'?7:7,win,multiplier,winAmount}
}
