import { getAuthUser } from '../auth/getUser.js';
export async function meRoutes(app) { app.get('/', { preHandler: [app.authenticate] }, async (req) => { const u = await getAuthUser(req); return { id: u.id, telegramId: u.telegramId.toString(), username: u.username, firstName: u.firstName, lastName: u.lastName, photoUrl: u.photoUrl, balance: Number(u.balance), createdAt: u.createdAt }; }); }
