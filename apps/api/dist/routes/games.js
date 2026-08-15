import { z } from 'zod';
import { prisma } from '../db.js';
import { getAuthUser } from '../auth/getUser.js';
import { applyBalanceChange } from '../wallet/wallet.js';
import { playCoinflip } from '../games/coinflip.js';
import { playDice } from '../games/dice.js';
import { playRoulette } from '../games/roulette.js';
import { playDrunkardGate } from '../games/drunkardGate.js';
import { playBaccarat } from '../games/baccarat.js';
const schema = z.object({ betAmount: z.number().int().min(10).max(5000000), requestId: z.string().optional(), payload: z.any().optional() });
export async function gameRoutes(app) {
    app.get('/:gameCode/history', { preHandler: [app.authenticate] }, async (req, rep) => { const { gameCode } = req.params; const sessions = await prisma.gameSession.findMany({ where: gameCode === 'baccarat' ? { gameCode: 'DRUNKARD_GATE', status: 'FINISHED', result: { path: ['game'], equals: 'baccarat' } } : { gameCode: mapGameCode(gameCode), status: 'FINISHED' }, orderBy: { createdAt: 'desc' }, take: 30, include: { user: { select: { username: true, firstName: true, lastName: true, photoUrl: true } } } }); return { items: sessions.map(x => ({ id: x.id, gameCode: x.gameCode, playerName: x.user.firstName || x.user.username || 'Игрок', playerPhotoUrl: x.user.photoUrl, betAmount: Number(x.betAmount), winAmount: Number(x.winAmount), multiplier: x.multiplier, result: x.result, createdAt: x.createdAt })) }; });
    app.post('/:gameCode/bet', { preHandler: [app.authenticate] }, async (req, rep) => { const u = await getAuthUser(req); const { gameCode } = req.params; const parsed = schema.safeParse(req.body); if (!parsed.success)
        return rep.code(400).send({ error: 'Bet amount must be from 10 to 5,000,000' }); const body = parsed.data; if (body.requestId) {
        const existing = await prisma.gameSession.findUnique({ where: { requestId: body.requestId } });
        if (existing)
            return { balance: Number((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).balance), result: existing.result };
    } try {
        return await prisma.$transaction(async (tx) => { const fresh = await tx.user.findUniqueOrThrow({ where: { id: u.id } }); const bet = BigInt(body.betAmount); if (fresh.balance < bet)
            throw new Error('Insufficient balance'); await applyBalanceChange({ tx, userId: u.id, amount: -bet, type: 'BET', source: gameCode, metadata: body.payload }); const result = playGame(gameCode, { betAmount: body.betAmount, payload: body.payload }); let final = await tx.user.findUniqueOrThrow({ where: { id: u.id } }); if (result.winAmount > 0)
            final = await applyBalanceChange({ tx, userId: u.id, amount: BigInt(result.winAmount), type: 'WIN', source: gameCode, metadata: result }); await tx.gameSession.create({ data: { requestId: body.requestId, userId: u.id, gameCode: mapGameCode(gameCode), status: 'FINISHED', betAmount: bet, winAmount: BigInt(result.winAmount), multiplier: result.multiplier, result, finishedAt: new Date() } }); return { balance: Number(final.balance), result }; });
    }
    catch (e) {
        if (e.message === 'Insufficient balance')
            return rep.code(400).send({ error: 'Insufficient balance' });
        throw e;
    } });
}
function playGame(code, p) { if (code === 'coinflip')
    return playCoinflip(p); if (code === 'dice')
    return playDice(p); if (code === 'roulette')
    return playRoulette(p); if (code === 'drunkard-gate')
    return playDrunkardGate(p); throw new Error('Unknown game'); }
function mapGameCode(code) { if (code === 'coinflip')
    return 'COINFLIP'; if (code === 'dice')
    return 'DICE'; if (code === 'roulette')
    return 'ROULETTE'; if (code === 'drunkard-gate')
    return 'DRUNKARD_GATE'; if (code === 'mines')
    return 'MINES'; if (code === 'blackjack')
    return 'BLACKJACK'; throw new Error('Unknown game'); }
