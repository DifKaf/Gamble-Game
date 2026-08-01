import { z } from 'zod';
import { prisma } from '../db.js';
import { getAuthUser } from '../auth/getUser.js';
import { applyBalanceChange } from '../wallet/wallet.js';
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];
function drawCard() {
    const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
    const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    return { rank, suit };
}
function cardValue(rank) {
    if (rank === 'A')
        return 11;
    if (rank === 'K' || rank === 'Q' || rank === 'J')
        return 10;
    return parseInt(rank, 10);
}
function handTotal(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards) {
        total += cardValue(c.rank);
        if (c.rank === 'A')
            aces++;
    }
    while (total > 21 && aces > 0) {
        total -= 10;
        aces--;
    }
    return { total, soft: aces > 0 };
}
function isBlackjack(cards) {
    return cards.length === 2 && handTotal(cards).total === 21;
}
function dealerShouldHit(cards) {
    return handTotal(cards).total < 17;
}
function playDealer(cards) {
    const result = [...cards];
    while (dealerShouldHit(result)) {
        result.push(drawCard());
    }
    return result;
}
function computeOutcome(playerCards, dealerCards, doubled, betAmount) {
    const player = handTotal(playerCards);
    const dealer = handTotal(dealerCards);
    const playerBJ = isBlackjack(playerCards);
    const dealerBJ = isBlackjack(dealerCards);
    const totalBet = doubled ? betAmount * 2 : betAmount;
    if (player.total > 21) {
        return { outcome: 'lose', winAmount: 0 };
    }
    if (playerBJ && dealerBJ) {
        return { outcome: 'push', winAmount: totalBet };
    }
    if (playerBJ) {
        return { outcome: 'blackjack', winAmount: Math.floor(betAmount * 2.5) };
    }
    if (dealerBJ) {
        return { outcome: 'lose', winAmount: 0 };
    }
    if (dealer.total > 21) {
        return { outcome: 'win', winAmount: totalBet * 2 };
    }
    if (player.total > dealer.total) {
        return { outcome: 'win', winAmount: totalBet * 2 };
    }
    if (player.total < dealer.total) {
        return { outcome: 'lose', winAmount: 0 };
    }
    return { outcome: 'push', winAmount: totalBet };
}
async function settle(tx, session, userId) {
    const playerCards = session.playerCards;
    const dealerCards = session.dealerCards;
    const { outcome, winAmount } = computeOutcome(playerCards, dealerCards, session.doubled, Number(session.betAmount));
    if (winAmount > 0) {
        await applyBalanceChange({
            tx,
            userId,
            amount: BigInt(winAmount),
            type: 'WIN',
            source: 'blackjack',
            metadata: { outcome }
        });
    }
    const totalBet = session.doubled ? session.betAmount * BigInt(2) : session.betAmount;
    await tx.gameSession.create({
        data: {
            userId,
            gameCode: 'BLACKJACK',
            status: 'FINISHED',
            betAmount: totalBet,
            winAmount: BigInt(winAmount),
            multiplier: Number(totalBet) > 0 ? winAmount / Number(totalBet) : 0,
            result: { outcome, playerCards, dealerCards },
            finishedAt: new Date()
        }
    });
    return tx.blackjackSession.update({
        where: { id: session.id },
        data: {
            status: 'FINISHED',
            dealerHoleHidden: false,
            outcome,
            winAmount: BigInt(winAmount),
            finishedAt: new Date()
        }
    });
}
function serialize(session, balance) {
    const playerCards = session.playerCards;
    const dealerCards = session.dealerCards;
    const playerHand = handTotal(playerCards);
    const awaitingInsurance = session.insuranceOffered && !session.insuranceResolved;
    const canAct = session.status === 'CREATED' && !awaitingInsurance;
    const visibleDealerCards = session.dealerHoleHidden ? [dealerCards[0]] : dealerCards;
    const dealerTotal = session.dealerHoleHidden ? cardValue(dealerCards[0].rank) : handTotal(dealerCards).total;
    return {
        sessionId: session.id,
        status: session.status,
        balance,
        playerCards,
        playerTotal: playerHand.total,
        playerSoft: playerHand.soft,
        dealerCards: visibleDealerCards,
        dealerTotal,
        dealerHoleHidden: session.dealerHoleHidden,
        betAmount: Number(session.betAmount),
        doubled: session.doubled,
        insuranceOffered: session.insuranceOffered,
        insuranceBet: Number(session.insuranceBet),
        insuranceResolved: session.insuranceResolved,
        awaitingInsurance,
        outcome: session.outcome,
        winAmount: Number(session.winAmount),
        canHit: canAct && playerHand.total < 21,
        canStand: canAct,
        canDouble: canAct && playerCards.length === 2 && !session.doubled
    };
}
const startSchema = z.object({
    betAmount: z.number().int().positive().max(1000000)
});
const sessionIdSchema = z.object({
    sessionId: z.string()
});
const insuranceSchema = z.object({
    sessionId: z.string(),
    take: z.boolean()
});
export async function blackjackRoutes(app) {
    app.post('/start', {
        preHandler: [app.authenticate]
    }, async (request, reply) => {
        const user = await getAuthUser(request);
        const body = startSchema.parse(request.body);
        const bet = BigInt(body.betAmount);
        try {
            const result = await prisma.$transaction(async (tx) => {
                const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                if (fresh.balance < bet) {
                    throw new Error('Insufficient balance');
                }
                await applyBalanceChange({
                    tx,
                    userId: user.id,
                    amount: -bet,
                    type: 'BET',
                    source: 'blackjack'
                });
                const playerCards = [drawCard(), drawCard()];
                const dealerCards = [drawCard(), drawCard()];
                const playerBJ = isBlackjack(playerCards);
                const dealerBJ = isBlackjack(dealerCards);
                const dealerUp = dealerCards[0];
                const insuranceAvailable = dealerUp.rank === 'A' && !playerBJ;
                const dealerUpIsTen = cardValue(dealerUp.rank) === 10;
                let session = await tx.blackjackSession.create({
                    data: {
                        userId: user.id,
                        betAmount: bet,
                        playerCards,
                        dealerCards,
                        dealerHoleHidden: true,
                        insuranceOffered: insuranceAvailable,
                        status: 'CREATED'
                    }
                });
                const shouldSettleNow = !insuranceAvailable && (playerBJ || (dealerUpIsTen && dealerBJ));
                if (shouldSettleNow) {
                    session = await settle(tx, session, user.id);
                }
                const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                return { session, balance: Number(updatedUser.balance) };
            });
            return serialize(result.session, result.balance);
        }
        catch (e) {
            if (e.message === 'Insufficient balance') {
                return reply.code(400).send({ error: 'Insufficient balance' });
            }
            throw e;
        }
    });
    app.post('/insurance', {
        preHandler: [app.authenticate]
    }, async (request, reply) => {
        const user = await getAuthUser(request);
        const body = insuranceSchema.parse(request.body);
        try {
            return await prisma.$transaction(async (tx) => {
                let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } });
                if (session.userId !== user.id) {
                    return reply.code(403).send({ error: 'Forbidden' });
                }
                if (session.status !== 'CREATED' || !session.insuranceOffered || session.insuranceResolved) {
                    return reply.code(400).send({ error: 'Insurance not available' });
                }
                const insuranceBet = body.take ? BigInt(Math.floor(Number(session.betAmount) / 2)) : BigInt(0);
                if (body.take) {
                    const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                    if (fresh.balance < insuranceBet) {
                        throw new Error('Insufficient balance');
                    }
                    await applyBalanceChange({
                        tx,
                        userId: user.id,
                        amount: -insuranceBet,
                        type: 'BET',
                        source: 'blackjack-insurance'
                    });
                }
                session = await tx.blackjackSession.update({
                    where: { id: session.id },
                    data: { insuranceResolved: true, insuranceBet }
                });
                const dealerBJ = isBlackjack(session.dealerCards);
                if (body.take && dealerBJ) {
                    await applyBalanceChange({
                        tx,
                        userId: user.id,
                        amount: insuranceBet * BigInt(3),
                        type: 'WIN',
                        source: 'blackjack-insurance'
                    });
                }
                if (dealerBJ) {
                    session = await settle(tx, session, user.id);
                }
                const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                return serialize(session, Number(updatedUser.balance));
            });
        }
        catch (e) {
            if (e.message === 'Insufficient balance') {
                return reply.code(400).send({ error: 'Insufficient balance' });
            }
            throw e;
        }
    });
    app.post('/hit', {
        preHandler: [app.authenticate]
    }, async (request, reply) => {
        const user = await getAuthUser(request);
        const body = sessionIdSchema.parse(request.body);
        return await prisma.$transaction(async (tx) => {
            let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } });
            if (session.userId !== user.id) {
                return reply.code(403).send({ error: 'Forbidden' });
            }
            if (session.status !== 'CREATED') {
                return reply.code(400).send({ error: 'Session finished' });
            }
            if (session.insuranceOffered && !session.insuranceResolved) {
                return reply.code(400).send({ error: 'Resolve insurance first' });
            }
            const playerCards = [...session.playerCards, drawCard()];
            session = await tx.blackjackSession.update({
                where: { id: session.id },
                data: { playerCards }
            });
            const { total } = handTotal(playerCards);
            if (total >= 21) {
                const dealerCards = total > 21 ? session.dealerCards : playDealer(session.dealerCards);
                session = await tx.blackjackSession.update({
                    where: { id: session.id },
                    data: { dealerCards }
                });
                session = await settle(tx, session, user.id);
            }
            const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
            return serialize(session, Number(updatedUser.balance));
        });
    });
    app.post('/stand', {
        preHandler: [app.authenticate]
    }, async (request, reply) => {
        const user = await getAuthUser(request);
        const body = sessionIdSchema.parse(request.body);
        return await prisma.$transaction(async (tx) => {
            let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } });
            if (session.userId !== user.id) {
                return reply.code(403).send({ error: 'Forbidden' });
            }
            if (session.status !== 'CREATED') {
                return reply.code(400).send({ error: 'Session finished' });
            }
            if (session.insuranceOffered && !session.insuranceResolved) {
                return reply.code(400).send({ error: 'Resolve insurance first' });
            }
            const dealerCards = playDealer(session.dealerCards);
            session = await tx.blackjackSession.update({
                where: { id: session.id },
                data: { dealerCards }
            });
            session = await settle(tx, session, user.id);
            const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
            return serialize(session, Number(updatedUser.balance));
        });
    });
    app.post('/double', {
        preHandler: [app.authenticate]
    }, async (request, reply) => {
        const user = await getAuthUser(request);
        const body = sessionIdSchema.parse(request.body);
        try {
            return await prisma.$transaction(async (tx) => {
                let session = await tx.blackjackSession.findUniqueOrThrow({ where: { id: body.sessionId } });
                if (session.userId !== user.id) {
                    return reply.code(403).send({ error: 'Forbidden' });
                }
                if (session.status !== 'CREATED') {
                    return reply.code(400).send({ error: 'Session finished' });
                }
                if (session.insuranceOffered && !session.insuranceResolved) {
                    return reply.code(400).send({ error: 'Resolve insurance first' });
                }
                const playerCards0 = session.playerCards;
                if (playerCards0.length !== 2 || session.doubled) {
                    return reply.code(400).send({ error: 'Double not available' });
                }
                const fresh = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                if (fresh.balance < session.betAmount) {
                    throw new Error('Insufficient balance');
                }
                await applyBalanceChange({
                    tx,
                    userId: user.id,
                    amount: -session.betAmount,
                    type: 'BET',
                    source: 'blackjack-double'
                });
                const playerCards = [...playerCards0, drawCard()];
                session = await tx.blackjackSession.update({
                    where: { id: session.id },
                    data: { playerCards, doubled: true }
                });
                const { total } = handTotal(playerCards);
                const dealerCards = total > 21 ? session.dealerCards : playDealer(session.dealerCards);
                session = await tx.blackjackSession.update({
                    where: { id: session.id },
                    data: { dealerCards }
                });
                session = await settle(tx, session, user.id);
                const updatedUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
                return serialize(session, Number(updatedUser.balance));
            });
        }
        catch (e) {
            if (e.message === 'Insufficient balance') {
                return reply.code(400).send({ error: 'Insufficient balance' });
            }
            throw e;
        }
    });
}
