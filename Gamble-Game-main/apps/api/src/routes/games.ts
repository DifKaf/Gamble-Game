import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { settleRound } from '../wallet/wallet.js'
import { cached } from '../utils/cache.js'
import { playCoinflip } from '../games/coinflip.js'
import { playDice } from '../games/dice.js'
import { playRoulette } from '../games/roulette.js'
import { playDrunkardGate } from '../games/drunkardGate.js'
import { playBaccarat } from '../games/baccarat.js'
const schema=z.object({betAmount:z.number().int().min(10).max(5000000),requestId:z.string().optional(),payload:z.any().optional()})

// Живая история одна и та же для всех игроков, поэтому её достаточно считать
// раз в несколько секунд, а не на каждый запрос каждого клиента.
const HISTORY_TTL_MS=Number(process.env.HISTORY_TTL_MS||4000)
const HISTORY_CODES=['dice','coinflip','roulette','mines','blackjack','baccarat']

async function loadGameHistory(gameCode:string,userId:string|null){
 const baseWhere:any = gameCode==='baccarat' ? {gameCode:'DRUNKARD_GATE' as any,status:'FINISHED',result:{path:['game'],equals:'baccarat'}} : {gameCode:mapGameCode(gameCode),status:'FINISHED'}
 const where = userId ? Object.assign({},baseWhere,{userId}) : baseWhere
 const sessions=await prisma.gameSession.findMany({where,orderBy:{createdAt:'desc'},take:30,include:{user:{select:{username:true,firstName:true,lastName:true,photoUrl:true}}}})
 return sessions.map(x=>({id:x.id,gameCode:x.gameCode,playerName:x.user.firstName || x.user.username || 'Игрок',playerPhotoUrl:x.user.photoUrl,betAmount:Number(x.betAmount),winAmount:Number(x.winAmount),multiplier:x.multiplier,result:x.result,createdAt:x.createdAt}))
}

function readHistory(gameCode:string,userId:string|null){
 return cached('gh:'+gameCode+':'+(userId||'live'),HISTORY_TTL_MS,()=>loadGameHistory(gameCode,userId))
}

export async function gameRoutes(app:FastifyInstance){
 // Одна пачка вместо шести запросов: экран игр раньше дёргал историю по каждой игре отдельно.
 app.get('/history',{preHandler:[(app as any).authenticate]},async(req)=>{ const u=await getAuthUser(req); const scope=String((req.query as any).scope||'live'); const raw=String((req.query as any).codes||''); const requested=raw?raw.split(',').map(c=>c.trim()).filter(Boolean):HISTORY_CODES; const codes=requested.filter(c=>HISTORY_CODES.includes(c)).slice(0,10); const userId=scope==='mine'?u.id:null; const pairs=await Promise.all(codes.map(async code=>[code,{items:await readHistory(code,userId)}] as [string,{items:any}])); return {scope,histories:Object.fromEntries(pairs)} })
 app.get('/:gameCode/history',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req); const {gameCode}=req.params as {gameCode:string}; const scope=String((req.query as any).scope||'live'); const items=await readHistory(gameCode,scope==='mine'?u.id:null); return {items} })
 app.post('/:gameCode/bet',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req); const {gameCode}=req.params as {gameCode:string}; const parsed=schema.safeParse(req.body); if(!parsed.success) return rep.code(400).send({error:'Bet amount must be from 10 to 5,000,000'}); const body=parsed.data; if(body.requestId){ const existing=await prisma.gameSession.findUnique({where:{requestId:body.requestId}}); if(existing) return {balance:Number((await prisma.user.findUniqueOrThrow({where:{id:u.id}})).balance), result:existing.result} } try{ return await prisma.$transaction(async tx=>{ const fresh=await tx.user.findUniqueOrThrow({where:{id:u.id}}); const bet=BigInt(body.betAmount); if(fresh.balance<bet) throw new Error('Insufficient balance'); const result=playGame(gameCode,{betAmount:body.betAmount,payload:body.payload}); /* Одна строка в кошельке на раунд вместо пары BET+WIN. */ const final=await settleRound({tx,userId:u.id,stake:bet,payout:BigInt(result.winAmount),source:gameCode,metadata:{payload:body.payload,multiplier:result.multiplier}}); await tx.gameSession.create({data:{requestId:body.requestId,userId:u.id,gameCode:mapGameCode(gameCode),status:'FINISHED',betAmount:bet,winAmount:BigInt(result.winAmount),multiplier:result.multiplier,result,finishedAt:new Date()}}); return {balance:Number(final.balance),result} }) } catch(e:any){ if(e.message==='Insufficient balance') return rep.code(400).send({error:'Insufficient balance'}); throw e } }) }
function playGame(code:string,p:any){ if(code==='coinflip')return playCoinflip(p); if(code==='dice')return playDice(p); if(code==='roulette')return playRoulette(p); if(code==='drunkard-gate')return playDrunkardGate(p); if(code==='baccarat')return playBaccarat(p); throw new Error('Unknown game') }
function mapGameCode(code:string){ if(code==='coinflip')return 'COINFLIP'; if(code==='dice')return 'DICE'; if(code==='roulette')return 'ROULETTE'; if(code==='drunkard-gate')return 'DRUNKARD_GATE'; if(code==='mines')return 'MINES'; if(code==='blackjack')return 'BLACKJACK'; if(code==='baccarat')return 'DRUNKARD_GATE'; throw new Error('Unknown game') }
