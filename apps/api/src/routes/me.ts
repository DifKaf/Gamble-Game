import { FastifyInstance } from 'fastify'
import { getAuthUser } from '../auth/getUser.js'
import { prisma } from '../db.js'
export async function meRoutes(app:FastifyInstance){
 app.get('/',{preHandler:[(app as any).authenticate]},async(req)=>{ const u=await getAuthUser(req); return {id:u.id,playerId:('12'+String(u.id).replace(/\D/g,'').padStart(4,'0')).slice(0,6),telegramId:u.telegramId.toString(),username:u.username,firstName:u.firstName,lastName:u.lastName,photoUrl:u.photoUrl,balance:Number(u.balance),createdAt:u.createdAt} })
 app.get('/leaderboard',{preHandler:[(app as any).authenticate]},async()=>{ const users=await prisma.user.findMany({orderBy:{balance:'desc'},take:50,select:{id:true,username:true,firstName:true,lastName:true,photoUrl:true,balance:true}}); return {users:users.map(u=>({id:u.id,playerId:('12'+String(u.id).replace(/\D/g,'').padStart(4,'0')).slice(0,6),username:u.username,firstName:u.firstName,lastName:u.lastName,photoUrl:u.photoUrl,balance:Number(u.balance)}))} })
 app.get('/users/search',{preHandler:[(app as any).authenticate]},async(req)=>{ const q=String((req.query as any).q||'').replace(/^@/,'').trim(); if(q.length<1) return {users:[]}; const users=await prisma.user.findMany({where:{username:{contains:q,mode:'insensitive'}},take:8,select:{id:true,username:true,firstName:true,lastName:true,photoUrl:true,balance:true}}); return {users:users.map(u=>({id:u.id,playerId:('12'+String(u.id).replace(/\D/g,'').padStart(4,'0')).slice(0,6),username:u.username,firstName:u.firstName,lastName:u.lastName,photoUrl:u.photoUrl,balance:Number(u.balance)}))} })
}
