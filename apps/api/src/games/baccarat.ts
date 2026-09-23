import { randomInt } from '../utils/random.js'
type BacSide = 'player' | 'banker' | 'tie'

// Классический Punto Banco: третья карта по официальным правилам.
// Выплаты: игрок ×2, банкир ×1.95 (комиссия 5%), ничья ×9 (8:1).
// Преимущество казино: ~1.24% / ~1.06% / ~14.4%.
export const BACCARAT_MULTIPLIERS: Record<BacSide, number> = { player: 2, banker: 1.95, tie: 9 }

function card() { return randomInt(13) + 1 }
function val(c: number) { return c >= 10 ? 0 : c }
function total(cards: number[]) { return cards.reduce((s, c) => s + val(c), 0) % 10 }

function bankerDraws(bankerTotal: number, playerThird: number | null) {
  if (playerThird === null) return bankerTotal <= 5
  const t = val(playerThird)
  if (bankerTotal <= 2) return true
  if (bankerTotal === 3) return t !== 8
  if (bankerTotal === 4) return t >= 2 && t <= 7
  if (bankerTotal === 5) return t >= 4 && t <= 7
  if (bankerTotal === 6) return t === 6 || t === 7
  return false
}

export function dealBaccarat() {
  const player = [card(), card()]
  const banker = [card(), card()]
  const natural = total(player) >= 8 || total(banker) >= 8
  let playerThird: number | null = null
  if (!natural) {
    if (total(player) <= 5) { playerThird = card(); player.push(playerThird) }
    if (bankerDraws(total(banker), playerThird)) banker.push(card())
  }
  const playerTotal = total(player)
  const bankerTotal = total(banker)
  const winner: BacSide = playerTotal === bankerTotal ? 'tie' : playerTotal > bankerTotal ? 'player' : 'banker'
  return { player, banker, playerTotal, bankerTotal, winner, natural }
}

export function playBaccarat(p:{
  betAmount:number
  payload?:{ side?:BacSide; bets?:Array<{side?:string; amount?:number}> }
}){
  const { player, banker, playerTotal, bankerTotal, winner, natural } = dealBaccarat()

  const rawBets = Array.isArray(p.payload?.bets) ? p.payload!.bets! : []
  const bets = rawBets
    .map((b)=>({ side:(b.side==='banker'||b.side==='tie'||b.side==='player'?b.side:'player') as BacSide, amount:Math.max(0, Math.floor(Number(b.amount)||0)) }))
    .filter((b)=>b.amount>0)
  if(!bets.length){
    bets.push({ side:(p.payload?.side||'player'), amount:p.betAmount })
  }

  let paidWin=0
  let refundAmount=0
  const settled=bets.map((b)=>{
    // При ничьей ставки на игрока и банкира возвращаются.
    if(winner==='tie' && b.side!=='tie'){
      refundAmount += b.amount
      return { ...b, payout:b.amount, push:true }
    }
    if(b.side===winner){
      const payout=Math.floor(b.amount*BACCARAT_MULTIPLIERS[winner])
      paidWin += payout
      return { ...b, payout, push:false }
    }
    return { ...b, payout:0, push:false }
  })

  const winAmount=paidWin+refundAmount
  const multiplier=p.betAmount>0?winAmount/p.betAmount:0
  return {
    game:'baccarat',
    selected:p.payload?.side||bets[0]?.side||'player',
    winner,
    player,
    banker,
    playerTotal,
    bankerTotal,
    natural,
    win:winAmount>0,
    multiplier,
    winAmount,
    paidWin,
    refundAmount,
    bets:settled
  }
}
