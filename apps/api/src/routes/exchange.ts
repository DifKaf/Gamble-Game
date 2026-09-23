import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { publicPlayerId } from '../utils/playerId.js'
import { assertCanTransfer, mapAntifraudError, isUserBanned } from '../utils/antifraud.js'
import { sendTelegramMessage } from '../utils/telegram.js'

const FEE_PCT = Number(process.env.P2P_FEE_PERCENT || 0)
const GC_PER_RUB = Number(process.env.P2P_GC_PER_RUB || 1000)
const MIN_GC = Number(process.env.P2P_MIN_GC || 100)
const MAX_GC = Number(process.env.P2P_MAX_GC || 1000000)
const METHODS = ['SBP','UMONEY','CARD'] as const
const offerSchema = z.object({ amountGc:z.number().int().min(MIN_GC).max(MAX_GC), rateRubPer1000:z.number().positive().max(10000000), minBuyRub:z.number().positive().optional(), maxBuyRub:z.number().positive().optional(), method:z.enum(METHODS).default('SBP'), paymentDetails:z.string().max(280).optional(), comment:z.string().max(200).optional(), intent:z.enum(['sell','buy']).default('sell') })
const idSchema = z.object({ id:z.string().min(1) })
const paySchema = z.object({ receipt:z.string().max(6000000).optional() })
const disputeSchema = z.object({ reason:z.string().min(3).max(300) })
const takeBodySchema = z.object({ paymentDetails:z.string().max(280).optional(), amountRub:z.number().positive().optional(), amountGc:z.number().positive().optional() }).optional()

function userView(u:any){ return u ? { id:u.id, playerId:publicPlayerId(u), username:u.username, firstName:u.firstName, photoUrl:u.photoUrl } : null }
function intentOf(row:any):'sell'|'buy'{ return row.contact&&String(row.contact).includes(':buy')?'buy':'sell' }
function roleIds(row:any){ const intent=intentOf(row); return intent==='buy' ? {sellerId:row.buyerId||null,buyerId:row.userId} : {sellerId:row.userId,buyerId:row.buyerId||null} }
function dealView(row:any, viewerId?:string){
 const intent=intentOf(row); const creator=row.user; const counterparty=row.buyer; const roles=roleIds(row)
 const seller=intent==='buy'?counterparty:creator; const buyer=intent==='buy'?creator:counterparty
 const participant=viewerId&&(viewerId===roles.sellerId||viewerId===roles.buyerId)
 return { id:row.id, status:row.status, amountGc:Number(row.amountGc), priceRub:Number(row.payoutMinor)/100, currency:row.currency, rate:Number(row.rateGcPerUnit)||GC_PER_RUB, feePercent:Number(row.feePercent)||FEE_PCT, method:row.method, paymentDetails:participant?row.destination:undefined, offerId:'#'+String(row.id||'').slice(-8).toUpperCase(), rateRubPer1000:Number(row.rateGcPerUnit||0)/100, comment:'', intent, minBuyRub:(row.contact&&String(row.contact).startsWith('limits:'))?Number(String(row.contact).split(':')[1]||0):0, maxBuyRub:Number(row.payoutMinor)/100, paymentTimeoutMinutes:15, creator:userView(creator), seller:userView(seller), buyer:userView(buyer), isCreator:viewerId?row.userId===viewerId:false, isMine:viewerId?roles.sellerId===viewerId:false, isBuyer:viewerId?roles.buyerId===viewerId:false, receipt:(participant&&(row.status==='PAID'||row.status==='COMPLETED'))?(row.disputeReason||null):null, createdAt:row.createdAt, processedAt:row.processedAt }
}
async function loadDeal(id:string){ return prisma.exchangeRequest.findUnique({ where:{id}, include:{ user:true, buyer:true } as any } as any) }

// P2P выключен по умолчанию (P2P_ENABLED=true — включить). Когда выключен, нельзя создавать
// и принимать новые сделки, но уже начатые можно довести: оплатить, подтвердить, отменить
// или открыть спор — иначе монеты в эскроу застрянут.
const P2P_ENABLED = String(process.env.P2P_ENABLED || 'false') === 'true'
const P2P_BLOCKED_WHEN_OFF = [/^\/offers\/?$/, /^\/offers\/[^/]+\/take$/, /^\/deals\/[^/]+\/accept$/]

export async function exchangeRoutes(app:FastifyInstance){
 app.addHook('onRequest', async(req,rep)=>{
  if(P2P_ENABLED || req.method!=='POST') return
  const path=String(req.url||'').split('?')[0].replace(/^\/exchange/,'')
  if(P2P_BLOCKED_WHEN_OFF.some(r=>r.test(path))) return rep.code(503).send({ error:'P2P временно отключён', p2pDisabled:true })
 })
 app.get('/config', async()=>({ enabled:P2P_ENABLED, minGc:MIN_GC, maxGc:MAX_GC, feePercent:FEE_PCT, suggestedRate:GC_PER_RUB, methods:METHODS }))
 app.get('/offers',{preHandler:[(app as any).authenticate]},async(req)=>{ const u=await getAuthUser(req); const rows=await prisma.exchangeRequest.findMany({where:{status:'OPEN'},orderBy:{createdAt:'desc'},take:40,include:{user:true,buyer:true} as any} as any); return {offers:rows.map(r=>dealView(r,u.id))} })
 app.get('/mine',{preHandler:[(app as any).authenticate]},async(req)=>{ const u=await getAuthUser(req); const rows=await prisma.exchangeRequest.findMany({where:{OR:[{userId:u.id},{buyerId:u.id}]},orderBy:{createdAt:'desc'},take:80,include:{user:true,buyer:true} as any} as any); return {deals:rows.map(r=>dealView(r,u.id))} })
 app.post('/offers',{preHandler:[(app as any).authenticate]},async(req,rep)=>{
  const u=await getAuthUser(req); if(isUserBanned(u)) return rep.code(403).send({error:'Аккаунт заблокирован'})
  const parsed=offerSchema.safeParse(req.body); if(!parsed.success) return rep.code(400).send({error:`Сумма от ${MIN_GC} до ${MAX_GC} GC`})
  const b=parsed.data; const details=String(b.paymentDetails||'').trim()
  if(b.intent==='sell'&&details.length<3) return rep.code(400).send({error:'Укажите реквизиты для получения оплаты'})
  if(b.intent==='sell'){ try{ await assertCanTransfer(u,b.amountGc) }catch(e:any){ const m=mapAntifraudError(e); if(m) return rep.code(m.code).send({error:m.error}); throw e } }
  try{
   const row=await prisma.$transaction(async tx=>{
    if(b.intent==='sell') await applyBalanceChange({tx,userId:u.id,amount:-BigInt(b.amountGc),type:'ADMIN_ADJUSTMENT',source:'p2p-escrow-lock',metadata:{method:b.method,rateRubPer1000:b.rateRubPer1000,intent:b.intent}})
    return (tx as any).exchangeRequest.create({data:{userId:u.id,amountGc:BigInt(b.amountGc),payoutMinor:BigInt(Math.round((b.amountGc/1000)*b.rateRubPer1000*100)),currency:'RUB',rateGcPerUnit:BigInt(Math.round(b.rateRubPer1000*100)),feePercent:0,method:b.method,destination:b.intent==='sell'?details:`Оплата через ${b.method}`,status:'OPEN',contact:'limits:'+Math.max(1,Math.min(Number(b.minBuyRub||((b.amountGc/1000)*b.rateRubPer1000)),((b.amountGc/1000)*b.rateRubPer1000)))+':'+b.intent,adminNote:b.comment||null}})
   })
   return {offer:dealView(await loadDeal(row.id),u.id),balance:Number((await prisma.user.findUniqueOrThrow({where:{id:u.id}})).balance)}
  }catch(e:any){ if(e.message==='Insufficient balance') return rep.code(400).send({error:'Недостаточно Gamble Coin'}); throw e }
 })
 app.post('/offers/:id/take',{preHandler:[(app as any).authenticate]},async(req,rep)=>{
  const u=await getAuthUser(req); const {id}=idSchema.parse(req.params); const body:any=takeBodySchema.parse(req.body||{})||{}; const row:any=await prisma.exchangeRequest.findUnique({where:{id}})
  if(!row) return rep.code(404).send({error:'Оффер не найден'}); if(row.userId===u.id) return rep.code(400).send({error:'Нельзя принять свой оффер'}); if(row.status!=='OPEN') return rep.code(400).send({error:'Оффер уже занят'})
  const intent=intentOf(row); const receiveDetails=String(body.paymentDetails||'').trim(); if(intent==='buy'&&receiveDetails.length<3) return rep.code(400).send({error:'Укажите, куда вы хотите получить оплату'})
  const unitMinor=Number(row.rateGcPerUnit)||1, fullGc=Number(row.amountGc), fullPayoutMinor=Number(row.payoutMinor)
  let reqPayoutMinor=body.amountRub&&body.amountRub>0?Math.round(body.amountRub*100):body.amountGc&&body.amountGc>0?Math.round(Math.round(body.amountGc)/1000*unitMinor):fullPayoutMinor
  if(reqPayoutMinor>=fullPayoutMinor) reqPayoutMinor=fullPayoutMinor
  let reqGc=reqPayoutMinor>=fullPayoutMinor?fullGc:Math.round(reqPayoutMinor*1000/unitMinor); if(reqGc>fullGc){reqGc=fullGc;reqPayoutMinor=fullPayoutMinor}
  if(reqGc<=0||reqPayoutMinor<=0) return rep.code(400).send({error:'Некорректная сумма'})
  if(intent==='buy'){ try{ await assertCanTransfer(u,reqGc) }catch(e:any){ const m=mapAntifraudError(e); if(m) return rep.code(m.code).send({error:m.error}); throw e } }
  const partial=reqPayoutMinor<fullPayoutMinor
  try{
   const dealRow=await prisma.$transaction(async tx=>{
    if(intent==='buy') await applyBalanceChange({tx,userId:u.id,amount:-BigInt(reqGc),type:'ADMIN_ADJUSTMENT',source:'p2p-escrow-lock',metadata:{offerId:id,intent:'buy'}})
    if(!partial){ const upd=await (tx as any).exchangeRequest.updateMany({where:{id,status:'OPEN'},data:{status:intent==='buy'?'DEAL':'WAITING_SELLER',buyerId:u.id,destination:intent==='buy'?receiveDetails:row.destination,processedAt:new Date()}}); if(!upd.count) throw new Error('TAKEN'); return (tx as any).exchangeRequest.findUnique({where:{id}}) }
    const dec=await (tx as any).exchangeRequest.updateMany({where:{id,status:'OPEN'},data:{amountGc:BigInt(fullGc-reqGc),payoutMinor:BigInt(fullPayoutMinor-reqPayoutMinor)}}); if(!dec.count) throw new Error('TAKEN')
    return (tx as any).exchangeRequest.create({data:{userId:row.userId,buyerId:u.id,amountGc:BigInt(reqGc),payoutMinor:BigInt(reqPayoutMinor),currency:row.currency,rateGcPerUnit:row.rateGcPerUnit,feePercent:row.feePercent||0,method:row.method,destination:intent==='buy'?receiveDetails:row.destination,status:intent==='buy'?'DEAL':'WAITING_SELLER',contact:row.contact,adminNote:row.adminNote,processedAt:new Date()}})
   })
   const creator=await prisma.user.findUnique({where:{id:row.userId}})
   if(creator) void sendTelegramMessage(creator.telegramId,intent==='buy'?`🤝 P2P ${('#'+String(dealRow.id||'').slice(-8).toUpperCase())}: продавец присоединился. Переведите оплату по указанным реквизитам.`:`🤝 P2P ${('#'+String(dealRow.id||'').slice(-8).toUpperCase())}: покупатель создал сделку. Примите её.`)
   return {deal:dealView(await loadDeal(dealRow.id),u.id),balance:Number((await prisma.user.findUniqueOrThrow({where:{id:u.id}})).balance)}
  }catch(e:any){ if(e.message==='TAKEN') return rep.code(400).send({error:'Оффер уже занят'}); if(e.message==='Insufficient balance') return rep.code(400).send({error:'Недостаточно Gamble Coin'}); throw e }
 })
 app.post('/deals/:id/accept',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req),{id}=idSchema.parse(req.params),row:any=await loadDeal(id); if(!row)return rep.code(404).send({error:'Сделка не найдена'}); const roles=roleIds(row); if(roles.sellerId!==u.id)return rep.code(403).send({error:'Принять может только продавец'}); if(row.status!=='WAITING_SELLER')return rep.code(400).send({error:'Сделку уже нельзя принять'}); await prisma.exchangeRequest.update({where:{id},data:{status:'DEAL',processedAt:new Date()} as any}); const buyer=roles.buyerId?await prisma.user.findUnique({where:{id:roles.buyerId}}):null; if(buyer)void sendTelegramMessage(buyer.telegramId,`✅ P2P ${('#'+String(id).slice(-8).toUpperCase())}: продавец принял сделку. Реквизиты доступны.`); return {deal:dealView(await loadDeal(id),u.id)} })
 app.post('/deals/:id/paid',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req),{id}=idSchema.parse(req.params),b=paySchema.parse(req.body||{}),row:any=await loadDeal(id); if(!row)return rep.code(404).send({error:'Сделка не найдена'}); const roles=roleIds(row); if(roles.buyerId!==u.id)return rep.code(403).send({error:'Это не ваша сделка'}); if(row.status!=='DEAL')return rep.code(400).send({error:'Сделка не ожидает оплату'}); await prisma.exchangeRequest.update({where:{id},data:{status:'PAID',disputeReason:b.receipt||null,processedAt:new Date()} as any}); const seller=roles.sellerId?await prisma.user.findUnique({where:{id:roles.sellerId}}):null; if(seller)void sendTelegramMessage(seller.telegramId,`✅ P2P ${('#'+String(id).slice(-8).toUpperCase())}: покупатель отметил оплату.`); return {deal:dealView(await loadDeal(id),u.id)} })
 app.post('/deals/:id/release',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req),{id}=idSchema.parse(req.params),row:any=await loadDeal(id); if(!row)return rep.code(404).send({error:'Сделка не найдена'}); const roles=roleIds(row); if(roles.sellerId!==u.id)return rep.code(403).send({error:'Подтвердить может только продавец'}); if(row.status!=='PAID')return rep.code(400).send({error:'Сначала покупатель должен отметить оплату'}); if(!roles.buyerId)return rep.code(400).send({error:'Покупатель не найден'}); const updated=await prisma.$transaction(async tx=>{const changed=await (tx as any).exchangeRequest.updateMany({where:{id,status:'PAID'},data:{status:'COMPLETED',processedAt:new Date()}});if(!changed.count)throw new Error('STATE');return applyBalanceChange({tx,userId:roles.buyerId!,amount:BigInt(row.amountGc),type:'ADMIN_ADJUSTMENT',source:'p2p-escrow-release',metadata:{dealId:id,sellerId:roles.sellerId}})}); const buyer=await prisma.user.findUnique({where:{id:roles.buyerId}}); if(buyer)void sendTelegramMessage(buyer.telegramId,`🪙 P2P ${('#'+String(id).slice(-8).toUpperCase())} завершён: +${Number(row.amountGc)} GC.`); return {deal:dealView(await loadDeal(id),u.id),balance:Number((await prisma.user.findUniqueOrThrow({where:{id:u.id}})).balance),buyerBalance:Number(updated.balance)} })
 app.post('/deals/:id/cancel',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req),{id}=idSchema.parse(req.params),row:any=await loadDeal(id); if(!row)return rep.code(404).send({error:'Сделка не найдена'}); const roles=roleIds(row); if(row.userId!==u.id&&row.buyerId!==u.id)return rep.code(403).send({error:'Нет доступа'}); if(!['OPEN','WAITING_SELLER','DEAL'].includes(row.status))return rep.code(400).send({error:'Нельзя отменить'}); const intent=intentOf(row),refundId=intent==='buy'?(row.status==='OPEN'?null:roles.sellerId):roles.sellerId; const updated=await prisma.$transaction(async tx=>{const changed=await (tx as any).exchangeRequest.updateMany({where:{id,status:{in:['OPEN','WAITING_SELLER','DEAL']}},data:{status:'CANCELLED',processedAt:new Date()}});if(!changed.count)throw new Error('STATE');return refundId?applyBalanceChange({tx,userId:refundId,amount:BigInt(row.amountGc),type:'REFUND',source:'p2p-escrow-refund',metadata:{dealId:id}}):null}); return {deal:dealView(await loadDeal(id),u.id),balance:updated?Number(updated.balance):Number((await prisma.user.findUniqueOrThrow({where:{id:u.id}})).balance)} })
 app.post('/deals/:id/dispute',{preHandler:[(app as any).authenticate]},async(req,rep)=>{ const u=await getAuthUser(req),{id}=idSchema.parse(req.params),b=disputeSchema.parse(req.body),row:any=await loadDeal(id); if(!row)return rep.code(404).send({error:'Сделка не найдена'}); if(row.userId!==u.id&&row.buyerId!==u.id)return rep.code(403).send({error:'Нет доступа'}); await prisma.exchangeRequest.update({where:{id},data:{status:'DISPUTED',disputeReason:b.reason,processedAt:new Date()} as any}); return {deal:dealView(await loadDeal(id),u.id)} })
}
