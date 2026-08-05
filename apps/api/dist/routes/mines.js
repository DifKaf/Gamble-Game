import { z } from 'zod';
import { prisma } from '../db.js';
import { getAuthUser } from '../auth/getUser.js';
import { applyBalanceChange } from '../wallet/wallet.js';
const startSchema = z.object({ betAmount: z.number().int().positive().max(1000000), mineCount: z.number().int().min(3).max(8) });
const openSchema = z.object({ sessionId: z.string(), cellIndex: z.number().int().min(0).max(24) });
const cashoutSchema = z.object({ sessionId: z.string() });
const stepMap = { 3: 0.15, 5: 0.28, 8: 0.5 };
function makeMines(count) { const s = new Set(); while (s.size < count)
    s.add(Math.floor(Math.random() * 25)); return Array.from(s); }
function payoutFor(bet, opened, mineCount) { const mult = Math.round((1 + opened * (stepMap[mineCount] || 0.28)) * 100) / 100; return { multiplier: mult, payout: Math.round(bet * mult) }; }
export async function minesRoutes(app) {
    app.post('/start', { preHandler: [app.authenticate] }, async (req, rep) => { const user = await getAuthUser(req); const body = startSchema.parse(req.body); const bet = BigInt(body.betAmount); try {
        return await prisma.$transaction(async (tx) => { const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } }); if (fresh.balance < bet)
            throw new Error('Insufficient balance'); await applyBalanceChange({ tx, userId: user.id, amount: -bet, type: 'BET', source: 'mines', metadata: { mineCount: body.mineCount } }); const session = await tx.minesSession.create({ data: { userId: user.id, betAmount: bet, mineCount: body.mineCount, minePositions: makeMines(body.mineCount), openedCells: [], status: 'CREATED' } }); const updated = await tx.user.findUniqueOrThrow({ where: { id: user.id } }); return { sessionId: session.id, balance: Number(updated.balance), mineCount: body.mineCount, openedCells: [], multiplier: 1, payout: 0, status: 'CREATED' }; });
    }
    catch (e) {
        if (e.message === 'Insufficient balance')
            return rep.code(400).send({ error: 'Insufficient balance' });
        throw e;
    } });
    app.post('/open', { preHandler: [app.authenticate] }, async (req, rep) => { const user = await getAuthUser(req); const body = openSchema.parse(req.body); return await prisma.$transaction(async (tx) => { const session = await tx.minesSession.findUniqueOrThrow({ where: { id: body.sessionId } }); if (session.userId !== user.id)
        return rep.code(403).send({ error: 'Forbidden' }); if (session.status !== 'CREATED')
        return rep.code(400).send({ error: 'Session finished' }); const mines = session.minePositions; const opened = session.openedCells; if (opened.includes(body.cellIndex))
        return { sessionId: session.id, hitMine: false, cellIndex: body.cellIndex, openedCells: opened, multiplier: session.multiplier, payout: payoutFor(Number(session.betAmount), opened.length, session.mineCount).payout, status: session.status, balance: Number((await tx.user.findUniqueOrThrow({ where: { id: user.id } })).balance) }; if (mines.includes(body.cellIndex)) {
        await tx.minesSession.update({ where: { id: session.id }, data: { status: 'FINISHED', finishedAt: new Date(), openedCells: [...opened, body.cellIndex], winAmount: 0n } });
        await tx.gameSession.create({ data: { userId: user.id, gameCode: 'MINES', status: 'FINISHED', betAmount: session.betAmount, winAmount: 0n, multiplier: 0, result: { hitMine: true, cellIndex: body.cellIndex, mines } } });
        const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        return { sessionId: session.id, hitMine: true, cellIndex: body.cellIndex, mines, balance: Number(fresh.balance), status: 'FINISHED' };
    } const next = [...opened, body.cellIndex]; const calc = payoutFor(Number(session.betAmount), next.length, session.mineCount); await tx.minesSession.update({ where: { id: session.id }, data: { openedCells: next, multiplier: calc.multiplier } }); const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } }); return { sessionId: session.id, hitMine: false, cellIndex: body.cellIndex, openedCells: next, multiplier: calc.multiplier, payout: calc.payout, balance: Number(fresh.balance), status: 'CREATED' }; }); });
    app.post('/cashout', { preHandler: [app.authenticate] }, async (req, rep) => { const user = await getAuthUser(req); const body = cashoutSchema.parse(req.body); return await prisma.$transaction(async (tx) => { const session = await tx.minesSession.findUniqueOrThrow({ where: { id: body.sessionId } }); if (session.userId !== user.id)
        return rep.code(403).send({ error: 'Forbidden' }); if (session.status !== 'CREATED')
        return rep.code(400).send({ error: 'Session finished' }); const opened = session.openedCells; if (opened.length === 0)
        return rep.code(400).send({ error: 'Open at least one cell' }); const calc = payoutFor(Number(session.betAmount), opened.length, session.mineCount); const updated = await applyBalanceChange({ tx, userId: user.id, amount: BigInt(calc.payout), type: 'WIN', source: 'mines', metadata: { sessionId: session.id, openedCells: opened, multiplier: calc.multiplier } }); await tx.minesSession.update({ where: { id: session.id }, data: { status: 'FINISHED', finishedAt: new Date(), winAmount: BigInt(calc.payout), multiplier: calc.multiplier } }); await tx.gameSession.create({ data: { userId: user.id, gameCode: 'MINES', status: 'FINISHED', betAmount: session.betAmount, winAmount: BigInt(calc.payout), multiplier: calc.multiplier, result: { cashout: true, openedCells: opened, payout: calc.payout } } }); return { sessionId: session.id, balance: Number(updated.balance), payout: calc.payout, multiplier: calc.multiplier, status: 'FINISHED' }; }); });
}
