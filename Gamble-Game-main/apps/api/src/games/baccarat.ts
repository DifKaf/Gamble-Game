type BacSide = 'player' | 'banker' | 'tie'

export function playBaccarat(p:{
  betAmount:number
  payload?:{ side?:BacSide; bets?:Array<{side?:string; amount?:number}> }
}){
  function card(){ return Math.floor(Math.random()*13)+1 }
  function val(c:number){ return c>=10?0:c }
  const player=[card(),card()]
  const banker=[card(),card()]
  const playerTotal=(val(player[0])+val(player[1]))%10
  const bankerTotal=(val(banker[0])+val(banker[1]))%10
  const winner:BacSide=playerTotal===bankerTotal?'tie':(playerTotal>bankerTotal?'player':'banker')

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
    if(winner==='tie' && b.side!=='tie'){
      refundAmount += b.amount
      return { ...b, payout:b.amount, push:true }
    }
    if(b.side===winner){
      const multiplier=winner==='tie'?8:(winner==='banker'?1.95:2)
      const payout=Math.floor(b.amount*multiplier)
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
    win:winAmount>0,
    multiplier,
    winAmount,
    paidWin,
    refundAmount,
    bets:settled
  }
}
