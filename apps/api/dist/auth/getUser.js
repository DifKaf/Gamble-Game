import { prisma } from '../db.js';
export async function getAuthUser(request) { const payload = request.user; const user = await prisma.user.findUnique({ where: { id: payload.userId } }); if (!user)
    throw new Error('User not found'); return user; }
