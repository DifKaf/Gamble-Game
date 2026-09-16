import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { parseTelegramUser, verifyTelegramInitData } from '../auth/telegram.js'
import { publicPlayerId } from '../utils/playerId.js'
import { attachReferral } from '../utils/referrals.js'
export async function authRoutes(app:FastifyInstance){
 app.post('/telegram', async(req,rep)=>{ const {initData,startParam}=z.object({initData:z.string().min(1),startParam:z.string().optional()}).parse(req.body); if(!verifyTelegramInitData(initData,process.env.TELEGRAM_BOT_TOKEN!)) return rep.code(401).send({error:'Invalid Telegram initData'}); const tg=parseTelegramUser(initData); if(!tg)return rep.code(400).send({error:'Telegram user missing'}); const user=await prisma.user.upsert({where:{telegramId:BigInt(tg.id)},update:{username:tg.username,firstName:tg.first_name,lastName:tg.last_name,photoUrl:tg.photo_url},create:{telegramId:BigInt(tg.id),username:tg.username,firstName:tg.first_name,lastName:tg.last_name,photoUrl:tg.photo_url,balance:0n}}); const token=app.jwt.sign({userId:user.id,telegramId:user.telegramId.toString()});
  // Реферальный код приходит в start_param мини-приложения. Ошибка привязки не должна ломать вход.
  let referral=null; const refRaw=startParam||new URLSearchParams(initData).get('start_param');
  if(refRaw){ try{ const res=await attachReferral(user.id,refRaw); if(res.ok) referral=res }catch(err:any){ req.log?.warn('attachReferral failed: '+(err?.message||err)) } }
  const fresh=referral?await prisma.user.findUniqueOrThrow({where:{id:user.id}}):user;
  return {token,referral,user:{id:fresh.id,playerId:publicPlayerId(fresh),telegramId:fresh.telegramId.toString(),username:fresh.username,firstName:fresh.firstName,lastName:fresh.lastName,photoUrl:fresh.photoUrl,balance:Number(fresh.balance),admin:String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || "").split(",").map((x)=>x.trim()).includes(String(fresh.telegramId||""))}} })
 app.post('/dev', async(req,rep)=>{ if(process.env.NODE_ENV!=='development') return rep.code(404).send(); const {telegramId}=z.object({telegramId:z.number().int()}).parse(req.body); const user=await prisma.user.upsert({where:{telegramId:BigInt(telegramId)},update:{},create:{telegramId:BigInt(telegramId),username:'dev_user',firstName:'Dev',balance:0n}}); const token=app.jwt.sign({userId:user.id,telegramId:user.telegramId.toString()}); return {token,user:{id:user.id,playerId:publicPlayerId(user),telegramId:user.telegramId.toString(),username:user.username,firstName:user.firstName,lastName:user.lastName,photoUrl:user.photoUrl,balance:Number(user.balance),admin:String(process.env.ADMIN_TELEGRAM_IDS || process.env.ADMIN_IDS || "").split(",").map((x)=>x.trim()).includes(String(user.telegramId||""))}} })
}
