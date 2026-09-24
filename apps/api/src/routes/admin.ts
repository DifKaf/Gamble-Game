import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
import { applyBalanceChange } from '../wallet/wallet.js'
import { publicPlayerId, parsePlayerId } from '../utils/playerId.js'
import { sendTelegramMessage } from '../utils/telegram.js'
import { profilePayload } from '../utils/profile.js'
import { isExchangeAdmin } from '../utils/admin.js'

function requireAdmin(user: any, reply: any) {
	if (!isExchangeAdmin(user.telegramId)) { reply.code(403).send({ error: 'Нет доступа' }); return false }
	return true
}
function publicAdminUser(u: any) { return { id:u.id, playerId:publicPlayerId(u), telegramId:String(u.telegramId), username:u.username, firstName:u.firstName, lastName:u.lastName, photoUrl:u.photoUrl, balance:Number(u.balance), banned:Boolean(u.banned), banReason:u.banReason||null, createdAt:u.createdAt } }
function dealView(row:any){ return { id:row.id,status:row.status,amountGc:Number(row.amountGc),payout:Number(row.payoutMinor)/100,currency:row.currency,method:row.method,destination:row.destination,sellerId:row.userId,buyerId:row.buyerId,disputeReason:row.disputeReason||null,adminNote:row.adminNote,createdAt:row.createdAt } }
export async function adminRoutes(app: FastifyInstance) {
	// Все переводы между игроками: поиск по нику/ID отправителя или получателя, по 20 на страницу.
	app.get('/transfers',{preHandler:[(app as any).authenticate]},async(request,reply)=>{
		const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return
		const q:any=request.query||{}
		const page=Math.max(1,parseInt(String(q.page||'1'),10)||1); const per=20
		const term=String(q.q||'').replace(/^@/,'').trim()
		const where:any={source:'transfer-out'}
		if(term){
			const or:any[]=[{username:{contains:term,mode:'insensitive'}},{firstName:{contains:term,mode:'insensitive'}}]
			const pid:any=/^[#\s\d]+$/.test(term)?parsePlayerId(term):null
			if(pid) or.push({playerId:pid})
			const found=await prisma.user.findMany({where:{OR:or},select:{id:true},take:50})
			const ids=found.map((u:any)=>u.id)
			if(!ids.length) return {transfers:[],page:1,pages:0,total:0}
			where.OR=[{userId:{in:ids}},...ids.map((id:string)=>({metadata:{path:['counterpartyId'],equals:id}}))]
		}
		const [total,rows]=await Promise.all([
			prisma.walletTransaction.count({where}),
			prisma.walletTransaction.findMany({where,orderBy:{createdAt:'desc'},skip:(page-1)*per,take:per})
		])
		const ids=new Set<string>()
		rows.forEach((r:any)=>{ ids.add(r.userId); const c=(r.metadata||{}).counterpartyId; if(c) ids.add(String(c)) })
		const users=ids.size?await prisma.user.findMany({where:{id:{in:Array.from(ids)}}}):[]
		const by=new Map(users.map((u:any)=>[u.id,u]))
		const view=(u:any,m:any)=>u?{id:u.id,playerId:publicPlayerId(u),username:u.username||null,name:u.firstName||u.username||'Игрок'}:{id:null,playerId:(m&&m.counterpartyPlayerId)||null,username:(m&&m.counterpartyUsername)||null,name:(m&&m.counterpartyName)||'Игрок'}
		return {page,pages:Math.ceil(total/per),total,transfers:rows.map((r:any)=>{ const m:any=r.metadata||{}; return {id:r.id,amount:Math.abs(Number(r.amount)),createdAt:r.createdAt,from:view(by.get(r.userId),null),to:view(m.counterpartyId?by.get(String(m.counterpartyId)):null,m)} })}
	})
	app.get('/me',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const user=await getAuthUser(request); if(!requireAdmin(user,reply)) return; return {ok:true,admin:true} })
	app.get('/overview',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const user=await getAuthUser(request); if(!requireAdmin(user,reply)) return; const [users,banned,open,disputed,paid]=await Promise.all([prisma.user.count(),prisma.user.count({where:{banned:true} as any}).catch(()=>0),(prisma as any).exchangeRequest.count({where:{status:'OPEN'}}).catch(()=>0),(prisma as any).exchangeRequest.count({where:{status:'DISPUTED'}}).catch(()=>0),(prisma as any).exchangeRequest.count({where:{status:'PAID'}}).catch(()=>0)]); return {users,banned,openOffers:open,disputed,paid} })
	app.get('/users',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const user=await getAuthUser(request); if(!requireAdmin(user,reply)) return; const q=String((request.query as any).q||'').replace(/^@/,'').trim(); const where:any={}; if(q){ const or:any[]=[{username:{contains:q,mode:'insensitive'}},{firstName:{contains:q,mode:'insensitive'}}]; const pid=parsePlayerId(q); if(pid)or.push({playerId:pid}); where.OR=or } const rows=await prisma.user.findMany({where,orderBy:{createdAt:'desc'},take:30}); return {users:rows.map(publicAdminUser)} })
	app.get('/users/:id',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const id=String((request.params as any).id||''); const row=await prisma.user.findUnique({where:{id}}); if(!row)return reply.code(404).send({error:'Игрок не найден'}); const profile=await profilePayload(row.id); const deals=await (prisma as any).exchangeRequest.findMany({where:{OR:[{userId:row.id},{buyerId:row.id}]},orderBy:{createdAt:'desc'},take:12}).catch(()=>[]); return {user:publicAdminUser(row),profile,deals:deals.map(dealView)} })
	app.post('/users/:id/adjust',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const parsed=z.object({amount:z.number().int().min(-10000000).max(10000000),note:z.string().max(200).optional()}).safeParse(request.body); if(!parsed.success||!parsed.data.amount)return reply.code(400).send({error:'Укажите сумму'}); const id=String((request.params as any).id||''); const target=await prisma.user.findUnique({where:{id}}); if(!target)return reply.code(404).send({error:'Игрок не найден'}); const updated=await prisma.$transaction(tx=>applyBalanceChange({tx,userId:target.id,amount:BigInt(parsed.data.amount),type:'ADMIN_ADJUSTMENT',source:'admin-adjust',metadata:{adminId:admin.id,note:parsed.data.note||''}})); void sendTelegramMessage(target.telegramId, `🛠 Админ изменил ваш баланс на ${parsed.data.amount} GC.`); return {ok:true,user:{...publicAdminUser(target),balance:Number(updated.balance)}} })
	app.post('/users/:id/ban',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const parsed=z.object({banned:z.boolean(),reason:z.string().max(200).optional()}).safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'Укажите статус'}); const id=String((request.params as any).id||''); const row=await prisma.user.update({where:{id},data:{banned:parsed.data.banned,banReason:parsed.data.banned?(parsed.data.reason||'Нарушение правил'):null} as any}); return {ok:true,user:publicAdminUser(row)} })
	app.get('/deals',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const rows=await (prisma as any).exchangeRequest.findMany({orderBy:{createdAt:'desc'},take:80}); return {deals:rows.map(dealView)} })
	app.get('/maintenance',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const rows=await prisma.$queryRawUnsafe('SELECT "value" FROM "AppSetting" WHERE "key"=$1 LIMIT 1','maintenance') as any[]; const value=rows[0]?.value||{}; return {enabled:Boolean(value.enabled),message:value.message||'Технические работы'} })
	app.post('/maintenance',{preHandler:[(app as any).authenticate]},async(request,reply)=>{ const admin=await getAuthUser(request); if(!requireAdmin(admin,reply)) return; const parsed=z.object({enabled:z.boolean(),message:z.string().max(200).optional()}).safeParse(request.body); if(!parsed.success)return reply.code(400).send({error:'Укажите статус техработ'}); const value={enabled:parsed.data.enabled,message:parsed.data.message||'Технические работы'}; await prisma.$executeRawUnsafe('INSERT INTO "AppSetting" ("key","value","updatedAt") VALUES ($1,$2::jsonb,NOW()) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value", "updatedAt"=NOW()','maintenance',JSON.stringify(value)); return value })
}
