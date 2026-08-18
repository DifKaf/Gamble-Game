import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'

const startSchema = z.object({ betAmount:z.number().int().min(10).max(5000000), side:z.enum(['heads','tails']) })
const continueSchema = z.object({ sessionId:z.string(), side:z.enum(['heads','tails']) })
const cashoutSchema = z.object({ sessionId:z.string() })
const PER_FLIP_MULTIPLIER = 1.9
function multiplierFor(streak:number){ return Math.round(Math.pow(PER_FLIP_MULTIPLIER, streak)*100)/100 }
function payoutFor(bet:number, streak:number){ if(streak<=0) return { multiplier:0, payout:0 }; const mult=multiplierFor(streak); return { multiplier:mult, payout:Math.round(bet*mult) } }
function flip():'heads'|'tails'{ return Math.random()<0.5 ? 'heads' : 'tails' }

export async function coinflipRoutes(app:FastifyInstance){
 app.post('/start',{preHandler:[(app as any).authenticate]},async(req,rep)=>{
  const user=await getAuthUser(req)
  const parsed=startSchema.safeParse(req.body)
  if(!parsed.success) return rep.code(400).send({error:'Bet amount must be from 10 to 5,000,000'})
  const body=parsed.data
  const bet=BigInt(body.betAmount)
  try{
   return await prisma.$transaction(async tx=>{
    const fresh=await tx.user.findUniqueOrThrow({where:{id:user.id}})
    if(fresh.balance<bet) throw new Error('Insufficient balance')
    await applyBalanceChange({tx,userId:user.id,amount:-bet,type:'BET',source:'coinflip',metadata:{side:body.side}})
    const session=await tx.coinflipSession.create({data:{userId:user.id,betAmount:bet,streak:0,multiplier:1,status:'CREATED'}})
    const result=flip()
    const win=result===body.side
    if(!win){
     await tx.coinflipSession.update({where:{id:session.id},data:{status:'FINISHED',finishedAt:new Date(),winAmount:0n}})
     await tx.gameSession.create({data:{userId:user.id,gameCode:'COINFLIP',status:'FINISHED',betAmount:bet,winAmount:0n,multiplier:0,result:{side:body.side,result,win:false,streak:0}}})
     const fin=await tx.user.findUniqueOrThrow({where:{id:user.id}})
     return {sessionId:session.id,result,win:false,streak:0,multiplier:0,payout:0,balance:Number(fin.balance),status:'FINISHED'}
    }
    const calc=payoutFor(Number(bet),1)
    await tx.coinflipSession.update({where:{id:session.id},data:{streak:1,multiplier:calc.multiplier}})
    const fin=await tx.user.findUniqueOrThrow({where:{id:user.id}})
    return {sessionId:session.id,result,win:true,streak:1,multiplier:calc.multiplier,payout:calc.payout,balance:Number(fin.balance),status:'CREATED'}
   })
  }catch(e:any){ if(e.message==='Insufficient balance') return rep.code(400).send({error:'Insufficient balance'}); throw e }
 })
 app.post('/continue',{preHandler:[(app as any).authenticate]},async(req,rep)=>{
  const user=await getAuthUser(req)
  const parsed=continueSchema.safeParse(req.body)
  if(!parsed.success) return rep.code(400).send({error:'Invalid request'})
  const body=parsed.data
  return await prisma.$transaction(async tx=>{
   const session=await tx.coinflipSession.findUniqueOrThrow({where:{id:body.sessionId}})
   if(session.userId!==user.id) return rep.code(403).send({error:'Forbidden'})
   if(session.status!=='CREATED' || session.streak<1) return rep.code(400).send({error:'Session finished'})
   const result=flip()
   const win=result===body.side
   if(!win){
    await tx.coinflipSession.update({where:{id:session.id},data:{status:'FINISHED',finishedAt:new Date(),winAmount:0n}})
    await tx.gameSession.create({data:{userId:user.id,gameCode:'COINFLIP',status:'FINISHED',betAmount:session.betAmount,winAmount:0n,multiplier:0,result:{side:body.side,result,win:false,streak:session.streak}}})
    const fresh=await tx.user.findUniqueOrThrow({where:{id:user.id}})
    return {sessionId:session.id,result,win:false,streak:0,multiplier:0,payout:0,balance:Number(fresh.balance),status:'FINISHED'}
   }
   const nextStreak=session.streak+1
   const calc=payoutFor(Number(session.betAmount),nextStreak)
   await tx.coinflipSession.update({where:{id:session.id},data:{streak:nextStreak,multiplier:calc.multiplier}})
   const fresh=await tx.user.findUniqueOrThrow({where:{id:user.id}})
   return {sessionId:session.id,result,win:true,streak:nextStreak,multiplier:calc.multiplier,payout:calc.payout,balance:Number(fresh.balance),status:'CREATED'}
  })
 })
 app.post('/cashout',{preHandler:[(app as any).authenticate]},async(req,rep)=>{
  const user=await getAuthUser(req)
  const parsed=cashoutSchema.safeParse(req.body)
  if(!parsed.success) return rep.code(400).send({error:'Invalid session'})
  const body=parsed.data
  return await prisma.$transaction(async tx=>{
   const session=await tx.coinflipSession.findUniqueOrThrow({where:{id:body.sessionId}})
   if(session.userId!==user.id) return rep.code(403).send({error:'Forbidden'})
   if(session.status!=='CREATED') return rep.code(400).send({error:'Session finished'})
   if(session.streak<1) return rep.code(400).send({error:'Flip at least once'})
   const calc=payoutFor(Number(session.betAmount),session.streak)
   const updated=await applyBalanceChange({tx,userId:user.id,amount:BigInt(calc.payout),type:'WIN',source:'coinflip',metadata:{sessionId:session.id,streak:session.streak,multiplier:calc.multiplier}})
   await tx.coinflipSession.update({where:{id:session.id},data:{status:'FINISHED',finishedAt:new Date(),winAmount:BigInt(calc.payout),multiplier:calc.multiplier}})
   await tx.gameSession.create({data:{userId:user.id,gameCode:'COINFLIP',status:'FINISHED',betAmount:session.betAmount,winAmount:BigInt(calc.payout),multiplier:calc.multiplier,result:{cashout:true,streak:session.streak,payout:calc.payout}}})
   return {sessionId:session.id,balance:Number(updated.balance),payout:calc.payout,multiplier:calc.multiplier,status:'FINISHED'}
  })
 })
}
