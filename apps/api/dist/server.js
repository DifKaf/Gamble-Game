import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { walletRoutes } from './routes/wallet.js';
import { bonusRoutes } from './routes/bonus.js';
import { gameRoutes } from './routes/games.js';
import { minesRoutes } from './routes/mines.js';
import { coinflipRoutes } from './routes/coinflip.js';
import { blackjackRoutes } from './routes/blackjack.js';
const app = Fastify({ logger: true });
await app.register(cors, { origin: process.env.FRONTEND_ORIGIN || true, credentials: true });
await app.register(jwt, { secret: process.env.JWT_SECRET });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
app.decorate('authenticate', async function (request, reply) { try {
    await request.jwtVerify();
}
catch {
    return reply.code(401).send({ error: 'Unauthorized' });
} });
app.get('/health', async () => ({ ok: true }));
await app.register(authRoutes, { prefix: '/auth' });
await app.register(meRoutes, { prefix: '/me' });
await app.register(walletRoutes, { prefix: '/wallet' });
await app.register(bonusRoutes, { prefix: '/bonus' });
await app.register(gameRoutes, { prefix: '/games' });
await app.register(minesRoutes, { prefix: '/games/mines' });
await app.register(coinflipRoutes, { prefix: '/games/coinflip' });
await app.register(blackjackRoutes, { prefix: '/games/blackjack' });
await app.listen({ port: Number(process.env.PORT || 4000), host: '0.0.0.0' });
