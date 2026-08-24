# Gamble Game Production MVP

Готовая стартовая структура для продакшен-перехода: backend API, PostgreSQL, Prisma, Telegram WebApp авторизация, JWT, общий серверный баланс, транзакции и MVP endpoints игр.

## Что уже сделано
- Fastify + TypeScript backend
- PostgreSQL + Prisma schema
- Telegram `initData` auth с проверкой подписи
- JWT protected API
- User с начальным балансом 1 000 000 GC
- WalletTransaction история
- Daily bonus
- Games API: coinflip, dice, roulette, drunkard-gate MVP
- Docker Compose для локальной БД и API
- Текущий frontend положен в `apps/web/index.html`

## Что нужно от тебя
1. Telegram Bot Token от @BotFather.
2. Домен/URL frontend для Telegram Mini App.
3. Где деплоим: Railway/Render/VPS + Neon/Supabase/PostgreSQL.

## Локальный запуск
```bash
docker compose up -d postgres
cd apps/api
cp ../../.env.example .env
# вставь TELEGRAM_BOT_TOKEN и JWT_SECRET
npm install
npm run prisma:migrate
npm run dev
```
Проверка: http://localhost:4000/health

## Dev login без Telegram
```bash
curl -X POST http://localhost:4000/auth/dev -H "Content-Type: application/json" -d '{"telegramId":123456}'
```

## Сборка API
В репозитории обязательны файлы движка слота:
- `apps/api/src/games/drunkardGate/engine.ts`
- `apps/api/src/games/drunkardGate/rng.ts`
- `apps/api/src/games/drunkardGate/config.ts`

Без них `npm run build` падает с `TS2307 Cannot find module '../games/drunkardGate/engine.js'`.
Если Docker берёт старый слой `COPY src`, пересобери без кэша.

## Следующий этап
Frontend сейчас включён как legacy HTML. Для настоящего production нужно заменить локальную логику баланса/рандома на вызовы API из `apps/api`. Backend уже подготовлен под это.
