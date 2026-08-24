import { prisma } from '../db.js'
export async function getAuthUser(request:any){ const payload=request.user as {userId:string}; const user=await prisma.user.findUnique({where:{id:payload.userId}}); if(!user) throw new Error('User not found'); return user }
