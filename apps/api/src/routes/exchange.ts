import { FastifyInstance } from 'fastify'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { sendTelegramMessage, sendTelegramPhoto } from '../utils/telegram.js'
import { isUserBanned } from '../utils/antifraud.js'
import { publicPlayerId } from '../utils/playerId.js'
import {
	exchangeConfig,
	isExchangeAdmin,
	quoteExchange,
	serializeRequest,
	listExchangeRequests,
	findExchangeRequest,
	createExchangeRequest,
	updateOffer,
	ensureExchangeReady,
	enrichOffers,
	expireStaleDeals
} from '../utils/exchange.js'

const offerSchema = z.object({
	amountGc: z.number().int().positive().max(100000000),
	price: z.number().positive().max(1000000), // RUB за 1000 GC
	method: z.string().min(2).max(20).default('card'),
	destination: z.string().max(160).optional().default('P2P'),
	contact: z.string().max(80).optional(),
	minRub: z.number().positive().optional(),
	maxRub: z.number().positive().optional()
})

const takeSchema = z.object({ rub: z.number().positive().optional(), amountRub: z.number().positive().optional(), amountGc: z.number().int().positive().optional() })
const chatSchema = z.object({ message: z.string().min(1).max(500) })
const adminActionSchema = z.object({ action: z.enum(['complete', 'cancel', 'paid', 'reject', 'release', 'refund']), note: z.string().max(300).optional() })

async function loadOfferOr404(id: string, reply: any) {
	const row = await findExchangeRequest(id)
	if (!row) { reply.code(404).send({ error: 'Объявление не найдено' }); return null }
	return row
}
const rubMinor = (v:number)=>Math.round(Number(v||0)*100)
const gcFromRub = (rubMinorValue:number, pricePer1000Minor:number)=>Math.floor((rubMinorValue * 1000) / Math.max(1, pricePer1000Minor))
const rubFromGc = (gc:number, pricePer1000Minor:number)=>Math.round((gc / 1000) * pricePer1000Minor)

export async function exchangeRoutes(app: FastifyInstance) {
	app.get('/config', { preHandler: [(app as any).authenticate] }, async (request) => {
		const user = await getAuthUser(request); const cfg = exchangeConfig()
		return { ...cfg, balance: Number(user.balance), usedThisWeek:0, weekRemaining:null, pendingCount:0, wager:{ current:0, required:0, ok:true }, canRequest:cfg.enabled, example: quoteExchange(1000, 1000), priceUnitGc: 1000, averagePricePer1000: 10 }
	})
	app.get('/quote', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const amount = Number((request.query as any).amountGc); const price = Number(String((request.query as any).price||'10').replace(',','.'))
		if (!Number.isFinite(amount)||amount<=0) return reply.code(400).send({ error:'Укажите сумму GC' })
		return quoteExchange(Math.floor(amount), rubMinor(price))
	})
	app.get('/offers', { preHandler: [(app as any).authenticate] }, async (request) => { const user=await getAuthUser(request); const rows=await listExchangeRequests({status:'OPEN'},80,'desc'); return { offers: await enrichOffers(rows.filter((r:any)=>String(r.kind||'SELL')==='SELL'), user.id) } })
	app.get('/buy-requests', { preHandler: [(app as any).authenticate] }, async (request) => { const user=await getAuthUser(request); const rows=await listExchangeRequests({status:'OPEN'},80,'desc'); const offers=await enrichOffers(rows.filter((r:any)=>String(r.kind||'SELL')==='BUY'), user.id); return { offers, requests:offers } })
	app.get('/my', { preHandler: [(app as any).authenticate] }, async (request) => { const user=await getAuthUser(request); const rows=await listExchangeRequests({mineUserId:user.id},80,'desc'); return { offers: await enrichOffers(rows, user.id) } })
	app.get('/requests', { preHandler: [(app as any).authenticate] }, async (request) => { const user=await getAuthUser(request); const rows=await listExchangeRequests({mineUserId:user.id},80,'desc'); const offers=await enrichOffers(rows,user.id); return {requests:offers,offers} })

	app.post('/offers', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user=await getAuthUser(request); const cfg=exchangeConfig(); if(!cfg.enabled) return reply.code(403).send({error:'Биржа временно закрыта'}); if(isUserBanned(user)) return reply.code(403).send({error:'Аккаунт заблокирован'})
		const parsed=offerSchema.safeParse(request.body); if(!parsed.success) return reply.code(400).send({error:'Заполните сумму GC, цену за 1К GC, лимиты и реквизиты'})
		const d=parsed.data, amountGc=d.amountGc, priceMinor=rubMinor(d.price), minRubMinor=rubMinor(d.minRub||0), maxRubMinor=rubMinor(d.maxRub||0), totalRubMinor=rubFromGc(amountGc, priceMinor)
		if(amountGc<cfg.minGc) return reply.code(400).send({error:`Минимальная сумма — ${cfg.minGc} GC`})
		if(priceMinor<1) return reply.code(400).send({error:'Укажите цену за 1К GC'})
		if(minRubMinor<=0||maxRubMinor<minRubMinor||maxRubMinor>totalRubMinor) return reply.code(400).send({error:`Лимит должен быть от 1 до ${totalRubMinor/100} RUB`})
		if(BigInt(amountGc)>user.balance) return reply.code(400).send({error:'Недостаточно Gamble Coin'})
		const method=d.method.toLowerCase(); if(!cfg.methods.some(m=>m.code===method)) return reply.code(400).send({error:'Недоступный способ оплаты'})
		try { const row=await prisma.$transaction(async tx=>{ const created=await createExchangeRequest({userId:user.id, amountGc:BigInt(amountGc), payoutMinor:BigInt(priceMinor), currency:cfg.currency, rateGcPerUnit:quoteExchange(amountGc,priceMinor).rateGcPerUnit, feePercent:cfg.feePercent, method, destination:(d.destination||'').trim(), contact:d.contact?.trim()||null, status:'OPEN', kind:'SELL', minGc:BigInt(gcFromRub(minRubMinor,priceMinor)), maxGc:BigInt(gcFromRub(maxRubMinor,priceMinor)), minRubMinor:BigInt(minRubMinor), maxRubMinor:BigInt(maxRubMinor)}, tx); await applyBalanceChange({tx,userId:user.id,amount:-BigInt(amountGc),type:'ADMIN_ADJUSTMENT',source:'p2p-hold',metadata:{offerId:created.id}}); return created }); const fresh=await prisma.user.findUniqueOrThrow({where:{id:user.id}}); const [offer]=await enrichOffers([row],user.id); return {ok:true,offer,request:offer,balance:Number(fresh.balance)} } catch(e:any){ if(e.message==='Insufficient balance') return reply.code(400).send({error:'Недостаточно Gamble Coin'}); request.log?.error({err:e},'p2p offer create failed'); return reply.code(500).send({error:'Не удалось выставить объявление'}) }
	})

	app.post('/buy-requests', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user=await getAuthUser(request); const cfg=exchangeConfig(); const parsed=offerSchema.safeParse(request.body); if(!cfg.enabled) return reply.code(403).send({error:'Биржа временно закрыта'}); if(!parsed.success) return reply.code(400).send({error:'Заполните сумму GC, цену за 1К GC и лимиты'})
		const d=parsed.data, amountGc=d.amountGc, priceMinor=rubMinor(d.price), minRubMinor=rubMinor(d.minRub||0), maxRubMinor=rubMinor(d.maxRub||0), totalRubMinor=rubFromGc(amountGc, priceMinor); const method=d.method.toLowerCase()
		if(amountGc<cfg.minGc) return reply.code(400).send({error:`Минимальная сумма — ${cfg.minGc} GC`}); if(priceMinor<1) return reply.code(400).send({error:'Укажите цену за 1К GC'}); if(minRubMinor<=0||maxRubMinor<minRubMinor||maxRubMinor>totalRubMinor) return reply.code(400).send({error:`Лимит должен быть от 1 до ${totalRubMinor/100} RUB`}); if(!cfg.methods.some(m=>m.code===method)) return reply.code(400).send({error:'Недоступный способ оплаты'})
		const row=await createExchangeRequest({userId:user.id, amountGc:BigInt(amountGc), payoutMinor:BigInt(priceMinor), currency:cfg.currency, rateGcPerUnit:quoteExchange(amountGc,priceMinor).rateGcPerUnit, feePercent:cfg.feePercent, method, destination:'P2P', contact:null, status:'OPEN', kind:'BUY', minGc:BigInt(gcFromRub(minRubMinor,priceMinor)), maxGc:BigInt(gcFromRub(maxRubMinor,priceMinor)), minRubMinor:BigInt(minRubMinor), maxRubMinor:BigInt(maxRubMinor)})
		const [offer]=await enrichOffers([row],user.id); return {ok:true,offer,request:offer,balance:Number(user.balance)}
	})

	app.post('/offers/:id/take', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row) return; if(row.userId===user.id) return reply.code(400).send({error:'Нельзя открыть свою сделку'}); if(row.status!=='OPEN'||row.kind!=='SELL') return reply.code(409).send({error:'Объявление недоступно'})
		const parsed=takeSchema.safeParse(request.body||{}); if(!parsed.success) return reply.code(400).send({error:'Укажите сумму сделки'}); const priceMinor=Number(row.payoutMinor); const minRubMinor=Number(row.minRubMinor||0), maxRubMinor=Number(row.maxRubMinor||0); const chosenRubMinor=parsed.data.rub||parsed.data.amountRub ? rubMinor(Number(parsed.data.rub||parsed.data.amountRub)) : rubFromGc(Number(parsed.data.amountGc||0), priceMinor)
		const totalRubMinor=rubFromGc(Number(row.amountGc),priceMinor); if(chosenRubMinor<minRubMinor||chosenRubMinor>Math.min(maxRubMinor,totalRubMinor)) return reply.code(400).send({error:`Введите сумму от ${minRubMinor/100} до ${Math.min(maxRubMinor,totalRubMinor)/100} RUB`})
		const finalGc=Math.min(Number(row.amountGc), gcFromRub(chosenRubMinor, priceMinor)); const remainingGc=Number(row.amountGc)-finalGc; const dealRubMinor=rubFromGc(finalGc, priceMinor)
		const upd=await updateOffer(row.id,['OPEN','PENDING'],{status:'DEAL',buyerId:user.id,amountGc:BigInt(finalGc),payoutMinor:BigInt(priceMinor),minGc:BigInt(finalGc),maxGc:BigInt(finalGc),minRubMinor:BigInt(dealRubMinor),maxRubMinor:BigInt(dealRubMinor),takenAt:new Date()}); if(!upd.count) return reply.code(409).send({error:'Объявление уже занято'})
		if(remainingGc>0){ const remainingRub=rubFromGc(remainingGc,priceMinor); await createExchangeRequest({userId:row.userId,amountGc:BigInt(remainingGc),payoutMinor:BigInt(priceMinor),currency:row.currency,rateGcPerUnit:row.rateGcPerUnit,feePercent:row.feePercent,method:row.method,destination:row.destination,contact:row.contact||null,status:'OPEN',kind:'SELL',minGc:BigInt(Math.min(remainingGc,Number(row.minGc||remainingGc))),maxGc:BigInt(remainingGc),minRubMinor:BigInt(Math.min(minRubMinor,remainingRub)),maxRubMinor:BigInt(Math.min(maxRubMinor,remainingRub))}) }
		const updated=await findExchangeRequest(row.id); const [offer]=await enrichOffers([updated],user.id); return {ok:true,offer}
	})

	app.post('/buy-requests/:id/take', { preHandler: [(app as any).authenticate] }, async (request, reply) => {
		const seller=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row) return; if(row.userId===seller.id) return reply.code(400).send({error:'Нельзя принять свою заявку'}); if(row.status!=='OPEN'||row.kind!=='BUY') return reply.code(409).send({error:'Заявка недоступна'}); if(seller.balance<BigInt(row.amountGc)) return reply.code(400).send({error:'Недостаточно GC для продажи'})
		const ok=await prisma.$transaction(async tx=>{ const upd=await updateOffer(row.id,['OPEN','PENDING'],{status:'DEAL',buyerId:seller.id,takenAt:new Date()},tx); if(!upd.count)return false; await applyBalanceChange({tx,userId:seller.id,amount:-BigInt(row.amountGc),type:'ADMIN_ADJUSTMENT',source:'p2p-buy-sell-hold',metadata:{offerId:row.id}}); return true }); if(!ok) return reply.code(409).send({error:'Заявка уже занята'}); const updated=await findExchangeRequest(row.id); const [offer]=await enrichOffers([updated],seller.id); const fresh=await prisma.user.findUniqueOrThrow({where:{id:seller.id}}); return {ok:true,offer,balance:Number(fresh.balance)}
	})

	app.post('/offers/:id/paid', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; if(row.buyerId!==user.id) return reply.code(403).send({error:'Отметить оплату может только покупатель'}); if(row.status!=='DEAL') return reply.code(400).send({error:'Сделка не в оплате'}); const upd=await updateOffer(row.id,'DEAL',{status:'PAID',paidAt:new Date()}); if(!upd.count) return reply.code(409).send({error:'Статус уже изменился'}); const updated=await findExchangeRequest(row.id); const [offer]=await enrichOffers([updated],user.id); return {ok:true,offer} })
	app.post('/offers/:id/confirm', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; if(row.userId!==user.id) return reply.code(403).send({error:'Подтвердить может только создатель объявления'}); if(!row.buyerId) return reply.code(400).send({error:'Нет второй стороны'}); if(row.status!=='PAID'&&row.status!=='DEAL') return reply.code(400).send({error:'Сделка не готова'}); const amount=BigInt(row.amountGc); const fee=BigInt(Math.floor(Number(amount)*Number(row.feePercent||0)/100)); const receiver=row.kind==='BUY'?row.userId:row.buyerId; const ok=await prisma.$transaction(async tx=>{ const upd=await updateOffer(row.id,['PAID','DEAL','DISPUTED'],{status:'COMPLETED',processedAt:new Date()},tx); if(!upd.count)return false; await applyBalanceChange({tx,userId:receiver,amount:amount-fee,type:'ADMIN_ADJUSTMENT',source:'p2p-release',metadata:{offerId:row.id,feeGc:Number(fee)}}); return true }); if(!ok)return reply.code(409).send({error:'Сделка уже обработана'}); const updated=await findExchangeRequest(row.id); const [offer]=await enrichOffers([updated],user.id); return {ok:true,offer} })
	app.post('/offers/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; const isMaker=row.userId===user.id, isTaker=row.buyerId===user.id; if(!isMaker&&!isTaker)return reply.code(403).send({error:'Это не ваша сделка'}); if(row.status==='PAID') return reply.code(400).send({error:'После оплаты отмена через спор'}); if(row.status==='DEAL'){ const upd=await updateOffer(row.id,'DEAL',{status:'OPEN',buyerId:null,takenAt:null}); if(!upd.count)return reply.code(409).send({error:'Статус уже изменился'}); const [offer]=await enrichOffers([await findExchangeRequest(row.id)],user.id); return {ok:true,offer} } if(!isMaker||row.status!=='OPEN') return reply.code(400).send({error:'Нельзя отменить'}); await prisma.$transaction(async tx=>{ const upd=await updateOffer(row.id,['OPEN','PENDING'],{status:'CANCELLED',processedAt:new Date()},tx); if(upd.count&&row.kind==='SELL') await applyBalanceChange({tx,userId:user.id,amount:BigInt(row.amountGc),type:'REFUND',source:'p2p-refund',metadata:{offerId:row.id}}) }); const [offer]=await enrichOffers([await findExchangeRequest(row.id)],user.id); const fresh=await prisma.user.findUniqueOrThrow({where:{id:user.id}}); return {ok:true,offer,balance:Number(fresh.balance)} })
	app.post('/offers/:id/dispute', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; if(row.userId!==user.id&&row.buyerId!==user.id)return reply.code(403).send({error:'Спор доступен только участникам'}); if(row.status!=='DEAL'&&row.status!=='PAID')return reply.code(400).send({error:'Спор можно открыть только по активной сделке'}); const reason=String((request.body as any)?.reason||'Открыт спор').slice(0,300); await updateOffer(row.id,[row.status],{status:'DISPUTED',disputeReason:reason}); const [offer]=await enrichOffers([await findExchangeRequest(row.id)],user.id); return {ok:true,offer} })
	app.post('/requests/:id/cancel', { preHandler: [(app as any).authenticate] }, async (request, reply) => app.inject({method:'POST',url:`/exchange/offers/${(request.params as any).id}/cancel`,headers:request.headers as any,payload:{}}).then(res=>{reply.code(res.statusCode); try{return JSON.parse(res.body)}catch{return{error:res.body}}}) )
	app.get('/offers/:id/chat', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; if(row.userId!==user.id&&row.buyerId!==user.id)return reply.code(403).send({error:'Чат доступен только участникам сделки'}); const rows=await prisma.$queryRawUnsafe('SELECT m."id",m."userId",m."message",m."createdAt",u."username",u."firstName" FROM "ExchangeChatMessage" m LEFT JOIN "User" u ON u."id"=m."userId" WHERE m."exchangeId"=$1 ORDER BY m."createdAt" ASC LIMIT 100', row.id) as any[]; return {messages:rows.map((m:any)=>({id:m.id,userId:m.userId,mine:m.userId===user.id,author:m.username?('@'+m.username):(m.firstName||'Игрок'),message:m.message,createdAt:m.createdAt}))} })
	app.post('/offers/:id/chat', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; if(row.userId!==user.id&&row.buyerId!==user.id)return reply.code(403).send({error:'Чат доступен только участникам сделки'}); const parsed=chatSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'Введите сообщение'}); await prisma.$executeRawUnsafe('INSERT INTO "ExchangeChatMessage" ("id","exchangeId","userId","message","createdAt") VALUES ($1,$2,$3,$4,NOW())', randomUUID(), row.id, user.id, parsed.data.message.trim()); return {ok:true} })
	app.get('/admin/requests', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const user=await getAuthUser(request); if(!isExchangeAdmin(user.telegramId))return reply.code(403).send({error:'Нет доступа'}); const status=String((request.query as any).status||'ALL').toUpperCase(); const rows=await listExchangeRequests({status},100,'asc'); return {requests:await enrichOffers(rows,user.id,{admin:true})} })
	app.post('/admin/requests/:id', { preHandler: [(app as any).authenticate] }, async (request, reply) => { const admin=await getAuthUser(request); if(!isExchangeAdmin(admin.telegramId))return reply.code(403).send({error:'Нет доступа'}); const row=await loadOfferOr404(String((request.params as any).id||''),reply); if(!row)return; const parsed=adminActionSchema.safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'action'}); if(['complete','paid','release'].includes(parsed.data.action)){ if(!row.buyerId)return reply.code(400).send({error:'Нет второй стороны'}); const amount=BigInt(row.amountGc); const receiver=row.kind==='BUY'?row.userId:row.buyerId; await prisma.$transaction(async tx=>{ const upd=await updateOffer(row.id,['OPEN','PENDING','DEAL','PAID','DISPUTED'],{status:'COMPLETED',adminNote:parsed.data.note||null,processedAt:new Date()},tx); if(upd.count) await applyBalanceChange({tx,userId:receiver,amount,type:'ADMIN_ADJUSTMENT',source:'p2p-admin-release',metadata:{offerId:row.id}}) }) } else { await prisma.$transaction(async tx=>{ const upd=await updateOffer(row.id,['OPEN','PENDING','DEAL','PAID','DISPUTED'],{status:'CANCELLED',adminNote:parsed.data.note||null,processedAt:new Date()},tx); if(upd.count&&row.kind==='SELL') await applyBalanceChange({tx,userId:row.userId,amount:BigInt(row.amountGc),type:'REFUND',source:'p2p-admin-refund',metadata:{offerId:row.id}}) }) } const [offer]=await enrichOffers([await findExchangeRequest(row.id)],admin.id,{admin:true}); return {ok:true,request:offer,offer} })
}
