import { FastifyInstance } from 'fastify'
import { prisma } from '../db.js'
import { getAuthUser } from '../auth/getUser.js'
export async function walletRoutes(app:FastifyInstance){ app.get('/transactions',{preHandler:[(app as any).authenticate]},async(req)=>{ const u=await getAuthUser(req); const txs=await prisma.walletTransaction.findMany({where:{userId:u.id},orderBy:{createdAt:'desc'},take:50}); return {transactions:txs.map(t=>({id:t.id,type:t.type,amount:Number(t.amount),balanceBefore:Number(t.balanceBefore),balanceAfter:Number(t.balanceAfter),source:t.source,metadata:t.metadata,createdAt:t.createdAt}))} }) }
