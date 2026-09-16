import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
const RATE=Number(process.env.P2P_RUB_PER_1000_GC||10), MIN=1000, MAX=5000000
const schema=z.object({amountGc:z.number().int().min(MIN).max(MAX),method:z.enum(['SBP','CARD','USDT']),destination:z.string().min(5).max(160),contact:z.string().max(80).optional()})
const rub=(gc:number)=>Math.floor((gc/1000)*RATE*100)
const pub=(x:any)=>({id:x.id,amountGc:Number(x.amountGc),payoutRub:Number(x.payoutMinor)/100,method:x.method,status:x.status,destination:x.destination,contact:x.contact,createdAt:x.createdAt})
export async function exchangeRoutes(app:FastifyInstance){
 app.get('/config',async()=>({rateRubPer1000:RATE,minGc:MIN,maxGc:MAX,feePercent:0,methods:['SBP','CARD','USDT']}))
 app.get('/my',{preHandler:[(app as any).authenticate]},async(req)=>{const u=await getAuthUser(req); const rows=await (prisma as any).exchangeRequest.findMany({where:{userId:u.id},orderBy:{createdAt:'desc'},take:50}); return {items:rows.map(pub)}})
 app.post('/requests',{preHandler:[(app as any).authenticate]},async(req,rep)=>{const u:any=await getAuthUser(req); if(u.banned)return rep.code(403).send({error:'Аккаунт ограничен'}); const ps=schema.safeParse(req.body); if(!ps.success)return rep.code(400).send({error:'Проверь сумму, способ и реквизиты'}); const b=ps.data; try{const deal=await prisma.$transaction(async tx=>{await applyBalanceChange({tx,userId:u.id,amount:-BigInt(b.amountGc),type:'ADMIN_ADJUSTMENT',source:'p2p-escrow',metadata:{method:b.method}}); return (tx as any).exchangeRequest.create({data:{userId:u.id,amountGc:BigInt(b.amountGc),payoutMinor:BigInt(rub(b.amountGc)),currency:b.method==='USDT'?'USDT':'RUB',rateGcPerUnit:BigInt(RATE*100),method:b.method,destination:b.destination,contact:b.contact||null,status:'OPEN'}})}); const fresh=await prisma.user.findUniqueOrThrow({where:{id:u.id}}); return {balance:Number(fresh.balance),item:pub(deal)}}catch(e:any){if(e.message==='Insufficient balance')return rep.code(400).send({error:'Недостаточно GC'}); throw e}})
 app.post('/requests/:id/cancel',{preHandler:[(app as any).authenticate]},async(req,rep)=>{const u=await getAuthUser(req); const id=String((req.params as any).id||''); try{const user=await prisma.$transaction(async tx=>{const rows=await tx.$queryRawUnsafe('UPDATE "ExchangeRequest" SET status=\'CANCELLED\', "processedAt"=NOW() WHERE id=$1 AND "userId"=$2 AND status=\'OPEN\' RETURNING "amountGc"',id,u.id) as any[]; if(!rows.length)throw new Error('NO'); return applyBalanceChange({tx,userId:u.id,amount:BigInt(rows[0].amountGc),type:'REFUND',source:'p2p-cancel',metadata:{requestId:id}})}); return {balance:Number(user.balance)}}catch(e:any){return rep.code(400).send({error:'Заявку нельзя отменить'})}})
}
