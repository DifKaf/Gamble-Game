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
import { ensurePlayerIds } from './utils/ensurePlayerIds.js'
import { ensureIndexes } from './utils/ensureIndexes.js'
import { scheduleRetention } from './utils/retention.js'
// trustProxy обязателен на Railway: без него request.ip — это адрес прокси,
// один и тот же для всех игроков, и лимит запросов делится между всеми сразу.
const app=Fastify({logger:true,trustProxy:true})
await app.register(cors,{origin:process.env.FRONTEND_ORIGIN||true,credentials:true})
await app.register(jwt,{secret:process.env.JWT_SECRET!})
// Лимит считается на игрока (по токену), а не на весь сервер.
await app.register(rateLimit,{
 max:Number(process.env.RATE_LIMIT_MAX||300),
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
await app.register(authRoutes,{prefix:'/auth'}); await app.register(meRoutes,{prefix:'/me'}); await app.register(walletRoutes,{prefix:'/wallet'}); await app.register(bonusRoutes,{prefix:'/bonus'}); await app.register(gameRoutes,{prefix:'/games'}); await app.register(minesRoutes,{prefix:'/games/mines'}); await app.register(coinflipRoutes,{prefix:'/games/coinflip'}); await app.register(blackjackRoutes,{prefix:'/games/blackjack'}); await app.register(drunkardGateRoutes,{prefix:'/games/drunkard-gate'});
// Выдаём индивидуальный playerId всем игрокам до того, как принимать запросы.
await ensurePlayerIds(app.log)
// Индексы под лидерборд и историю: миграций в проекте нет, поэтому создаём на старте.
await ensureIndexes(app.log)
// Подрезаем старые ставки/выигрыши, чтобы не упереться в 0.5 ГБ бесплатного Neon.
scheduleRetention(app.log)
await app.listen({port:Number(process.env.PORT||4000),host:'0.0.0.0'})
