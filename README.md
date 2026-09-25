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
3. Где деплоим: Railway (API) + Railway Postgres (БД, добавляется как отдельный сервис в том же проекте).

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

## Railway Pro

### Что изменилось в v16
- **Бот через webhook автоматически.** `TELEGRAM_UPDATES_MODE=auto` (по умолчанию): на Railway адрес берётся из `RAILWAY_PUBLIC_DOMAIN`, секрет выводится из токена бота. Ничего задавать не нужно. Локально бот работает через polling.
- **История хранится дольше:** ставки и выигрыши 180 дней (`RETENTION_DAYS`, `0` — не удалять), завершённые сессии 30 дней (`SESSION_RETENTION_DAYS`). Очистка стартует через 5 минут после деплоя. Переводы между игроками не удаляются никогда.
- **Лимит запросов** 600 в минуту на игрока (`RATE_LIMIT_MAX`).
- **Плавная остановка:** при деплое сервер дожидается текущих ставок и спинов, закрывает базу и выходит, без обрывов.
- **`GET /health/db`** проверяет базу (для мониторинга).
- **Облегчённый Docker-образ:** многоэтапная сборка, в образе только production-зависимости.
- **`apps/api/railway.json`:** healthcheck `/health`, перезапуск при падении, перекрытие при деплое без простоя.

### Настройка в Railway
1. Сервис API → Settings → **Config-as-code** → путь `/apps/api/railway.json`.
2. Variables: если раньше было `TELEGRAM_UPDATES_MODE=polling`, удалите переменную или поставьте `auto`.
3. Ресурсы: для начала хватит **1 реплики** с 2 vCPU / 2 ГБ RAM. Кеш и лимиты хранятся в памяти процесса, поэтому для нескольких реплик понадобится Redis.

### Переезд базы с Neon на Railway Postgres
1. В проекте Railway: **+ New → Database → PostgreSQL**.
2. Включите техработы в админке.
3. Перенесите данные:
   ```bash
   OLD_DATABASE_URL='<строка Neon>' NEW_DATABASE_URL='<DATABASE_PUBLIC_URL из Railway Postgres>' ./scripts/migrate-db.sh
   ```
   Скрипт сверит число игроков и сумму балансов.
4. В API поставьте `DATABASE_URL=${{Postgres.DATABASE_URL}}` (внутренняя сеть, без платы за трафик) и задеплойте.
5. Выключите техработы. Neon держите ещё пару недель как резервную копию.
6. В Railway Postgres включите **Backups** (на Pro — ежедневные).
