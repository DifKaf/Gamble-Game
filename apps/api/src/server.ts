import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { authRoutes } from './routes/auth.js'
import { meRoutes } from './routes/me.js'
import { walletRoutes } from './routes/wallet.js'
import { bonusRoutes } from './routes/bonus.js'
import { gameRoutes } from './routes/games.js'
import { minesRoutes } from './routes/mines.js'
import { coinflipRoutes } from './routes/coinflip.js'
import { blackjackRoutes } from './routes/blackjack.js'
import { drunkardGateRoutes } from './routes/drunkardGate.js'
import { dogHouseRoutes } from './routes/dogHouse.js'
import { questRoutes } from './routes/quests.js'
import { referralRoutes } from './routes/referrals.js'
import { adminRoutes } from './routes/admin.js'
import { exchangeRoutes } from './routes/exchange.js'
import { depositRoutes } from './routes/deposit.js'
import { telegramBotRoutes, startTelegramBot, stopTelegramBot } from './bot/chatCommands.js'
import { prisma } from './db.js'
import { resolveBotInfo } from './utils/referrals.js'
import { ensurePlayerIds } from './utils/ensurePlayerIds.js'
import { ensureFeatureTables } from './utils/ensureFeatureTables.js'
import { ensureIndexes } from './utils/ensureIndexes.js'
import { scheduleRetention } from './utils/retention.js'
// trustProxy обязателен на Railway: без него request.ip — это адрес прокси,
// один и тот же для всех игроков, и лимит запросов делится между всеми сразу.
const app=Fastify({logger:true,trustProxy:true,bodyLimit:3*1024*1024})
await app.register(cors,{origin:process.env.FRONTEND_ORIGIN||true,credentials:true})
await app.register(jwt,{secret:process.env.JWT_SECRET!})
// Лимит считается на игрока (по токену), а не на весь сервер.
await app.register(rateLimit,{
 max:Number(process.env.RATE_LIMIT_MAX||600),
 timeWindow:'1 minute',
 cache:20000,
 allowList:(req:any)=>req.url==='/health',
 keyGenerator:(req:any)=>{
  const raw=String(req.headers?.authorization||'')
  const token=raw.startsWith('Bearer ')?raw.slice(7).trim():''
  if(token){
   // rate-limit — глобальный хук, он срабатывает до jwtVerify, поэтому токен разбираем сами.
   try{ const payload:any=(app as any).jwt.decode(token); const id=payload&&(payload.sub||payload.id||payload.userId); if(id) return 'u:'+String(id) }catch{}
   return 't:'+token.slice(-40)
  }
  return 'ip:'+req.ip
 },
})
// POST без тела (например, кручение колеса фортуны) больше не падает с 400 Bad Request.
app.addContentTypeParser('application/json',{parseAs:'string'},(_req:any,body:any,done:any)=>{ const raw=typeof body==='string'?body.trim():''; if(!raw) return done(null,{}); try{ done(null,JSON.parse(raw)) }catch(err:any){ err.statusCode=400; done(err,undefined) } })
app.decorate('authenticate',async function(request:any,reply:any){try{await request.jwtVerify()}catch{return reply.code(401).send({error:'Unauthorized'})}})
app.get('/health',async()=>({ok:true}))
// Проверка базы: удобно для мониторинга (UptimeRobot и т.п.). Healthcheck Railway смотрит /health.
app.get('/health/db',async(_req:any,reply:any)=>{ const t=Date.now(); try{ await prisma.$queryRawUnsafe('SELECT 1'); return {ok:true,dbMs:Date.now()-t} }catch(err:any){ return reply.code(503).send({ok:false,error:String(err?.message||err)}) } })
await app.register(telegramBotRoutes,{prefix:'/telegram'})
await app.register(authRoutes,{prefix:'/auth'}); await app.register(meRoutes,{prefix:'/me'}); await app.register(walletRoutes,{prefix:'/wallet'}); await app.register(bonusRoutes,{prefix:'/bonus'}); await app.register(gameRoutes,{prefix:'/games'}); await app.register(minesRoutes,{prefix:'/games/mines'}); await app.register(coinflipRoutes,{prefix:'/games/coinflip'}); await app.register(blackjackRoutes,{prefix:'/games/blackjack'}); await app.register(drunkardGateRoutes,{prefix:'/games/drunkard-gate'}); await app.register(dogHouseRoutes,{prefix:'/games/dog-house'}); await app.register(questRoutes,{prefix:'/quests'}); await app.register(referralRoutes,{prefix:'/referrals'}); await app.register(exchangeRoutes,{prefix:'/exchange'}); await app.register(depositRoutes,{prefix:'/deposit'}); await app.register(adminRoutes,{prefix:'/admin'});
// Выдаём индивидуальный playerId всем игрокам до того, как принимать запросы.
await ensurePlayerIds(app.log)
// Индексы под лидерборд и историю: миграций в проекте нет, поэтому создаём на старте.
await ensureIndexes(app.log)
// Таблицы рефералов, квестов и биржи: миграций нет, поэтому создаём на старте.
await ensureFeatureTables(app.log)
// Подрезаем очень старые ставки/выигрыши (по умолчанию старше 180 дней), чтобы база не росла бесконечно.
scheduleRetention(app.log)
// Плавная остановка: при деплое Railway шлёт SIGTERM — дожидаемся текущих запросов
// (ставок, спинов), закрываем соединения с базой и только потом выходим.
let shuttingDown=false
for(const sig of ['SIGTERM','SIGINT'] as const){
 process.on(sig,async()=>{
  if(shuttingDown) return
  shuttingDown=true
  app.log.info(`${sig}: останавливаем сервер`)
  stopTelegramBot()
  const force=setTimeout(()=>process.exit(0),15000); force.unref()
  try{ await app.close() }catch{}
  try{ await prisma.$disconnect() }catch{}
  process.exit(0)
 })
}
await app.listen({port:Number(process.env.PORT||4000),host:'0.0.0.0'})
// Визитка игрока в чате: «баланс», «бал», «статистика», «профиль», «bal», «balance».
void startTelegramBot(app.log)
void resolveBotInfo()
