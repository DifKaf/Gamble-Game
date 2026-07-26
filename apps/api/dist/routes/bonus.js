import { prisma } from '../db.js';
import { getAuthUser } from '../auth/getUser.js';
import { applyBalanceChange } from '../wallet/wallet.js';
export async function bonusRoutes(app) { app.post('/daily', { preHandler: [app.authenticate] }, async (req, rep) => { const u = await getAuthUser(req); const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); const old = await prisma.dailyBonus.findFirst({ where: { userId: u.id, claimedAt: { gte: dayStart } } }); if (old)
    return rep.code(400).send({ error: 'Daily bonus already claimed' }); const amount = 200n; const updated = await prisma.$transaction(async (tx) => { await tx.dailyBonus.create({ data: { userId: u.id, amount } }); return applyBalanceChange({ tx, userId: u.id, amount, type: 'BONUS', source: 'daily_bonus' }); }); return { amount: Number(amount), balance: Number(updated.balance) }; }); }
