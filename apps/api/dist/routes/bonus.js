import { z } from 'zod';
import { prisma } from '../db.js';
import { getAuthUser } from '../auth/getUser.js';
import { applyBalanceChange } from '../wallet/wallet.js';
const promoCreateSchema = z.object({ code: z.string().min(2).max(32), amount: z.number().int().positive().max(10000000) });
const promoRedeemSchema = z.object({ code: z.string().min(2).max(32) });
function norm(code) { return code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''); }
export async function bonusRoutes(app) {
    app.post('/daily', { preHandler: [app.authenticate] }, async (req, rep) => { const u = await getAuthUser(req); const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); const old = await prisma.dailyBonus.findFirst({ where: { userId: u.id, claimedAt: { gte: dayStart } } }); if (old)
        return rep.code(400).send({ error: 'Daily bonus already claimed' }); const amount = 200n; const updated = await prisma.$transaction(async (tx) => { await tx.dailyBonus.create({ data: { userId: u.id, amount } }); return applyBalanceChange({ tx, userId: u.id, amount, type: 'BONUS', source: 'daily_bonus' }); }); return { amount: Number(amount), balance: Number(updated.balance) }; });
    app.post('/promocode/create', { preHandler: [app.authenticate] }, async (req, rep) => { const u = await getAuthUser(req); const parsed = promoCreateSchema.safeParse(req.body); if (!parsed.success)
        return rep.code(400).send({ error: 'Введите код и сумму' }); const code = norm(parsed.data.code); if (!code)
        return rep.code(400).send({ error: 'Введите код промокода' }); const exists = await prisma.walletTransaction.findFirst({ where: { source: 'promo-create', metadata: { path: ['code'], equals: code } } }); if (exists)
        return rep.code(400).send({ error: 'Такой промокод уже есть' }); await prisma.walletTransaction.create({ data: { userId: u.id, type: 'ADMIN_ADJUSTMENT', amount: 0n, balanceBefore: u.balance, balanceAfter: u.balance, source: 'promo-create', metadata: { code, amount: parsed.data.amount, creatorId: u.id, creatorUsername: u.username, active: true } } }); return { code, amount: parsed.data.amount }; });
    app.post('/promocode/redeem', { preHandler: [app.authenticate] }, async (req, rep) => { const u = await getAuthUser(req); const parsed = promoRedeemSchema.safeParse(req.body); if (!parsed.success)
        return rep.code(400).send({ error: 'Введите промокод' }); const code = norm(parsed.data.code); const promo = await prisma.walletTransaction.findFirst({ where: { source: 'promo-create', metadata: { path: ['code'], equals: code } }, orderBy: { createdAt: 'desc' } }); if (!promo)
        return rep.code(404).send({ error: 'Промокод не найден' }); const meta = promo.metadata || {}; if (meta.creatorId === u.id)
        return rep.code(400).send({ error: 'Нельзя активировать свой промокод' }); const used = await prisma.walletTransaction.findFirst({ where: { userId: u.id, source: 'promo-redeem', metadata: { path: ['code'], equals: code } } }); if (used)
        return rep.code(400).send({ error: 'Ты уже активировал этот промокод' }); const amount = BigInt(Number(meta.amount) || 0); if (amount <= 0n)
        return rep.code(400).send({ error: 'Промокод недействителен' }); const updated = await prisma.$transaction(async (tx) => { const fresh = await tx.user.findUniqueOrThrow({ where: { id: u.id } }); await tx.walletTransaction.create({ data: { userId: u.id, type: 'BONUS', amount: 0n, balanceBefore: fresh.balance, balanceAfter: fresh.balance, source: 'promo-redeem', metadata: { code, promoId: promo.id } } }); return applyBalanceChange({ tx, userId: u.id, amount, type: 'BONUS', source: 'promocode', metadata: { code, promoId: promo.id } }); }); return { code, amount: Number(amount), balance: Number(updated.balance) }; });
}
