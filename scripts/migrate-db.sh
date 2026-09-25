#!/usr/bin/env bash
# Перенос базы (например, Neon -> Railway Postgres) без потери данных.
#
# Использование:
#   OLD_DATABASE_URL='postgresql://...neon...' NEW_DATABASE_URL='postgresql://...railway...' ./scripts/migrate-db.sh
#
# NEW_DATABASE_URL — «DATABASE_PUBLIC_URL» из вкладки Variables сервиса Postgres в Railway.
# Перед запуском включите техработы в админке (или остановите API), чтобы во время
# копирования никто не делал ставок. Нужен pg_dump/pg_restore версии 16+.
set -euo pipefail
: "${OLD_DATABASE_URL:?укажите OLD_DATABASE_URL}"
: "${NEW_DATABASE_URL:?укажите NEW_DATABASE_URL}"

DUMP="gamble_game_$(date +%Y%m%d_%H%M%S).dump"
echo "1/3 Выгружаю старую базу в $DUMP ..."
pg_dump --format=custom --no-owner --no-privileges --dbname="$OLD_DATABASE_URL" --file="$DUMP"

echo "2/3 Загружаю в новую базу ..."
pg_restore --no-owner --no-privileges --clean --if-exists --dbname="$NEW_DATABASE_URL" "$DUMP"

echo "3/3 Сверяю количество игроков ..."
OLD_USERS=$(psql "$OLD_DATABASE_URL" -Atc 'SELECT count(*) FROM "User"')
NEW_USERS=$(psql "$NEW_DATABASE_URL" -Atc 'SELECT count(*) FROM "User"')
OLD_SUM=$(psql "$OLD_DATABASE_URL" -Atc 'SELECT coalesce(sum(balance),0) FROM "User"')
NEW_SUM=$(psql "$NEW_DATABASE_URL" -Atc 'SELECT coalesce(sum(balance),0) FROM "User"')
echo "Игроков: было $OLD_USERS, стало $NEW_USERS"
echo "Сумма балансов: было $OLD_SUM, стало $NEW_SUM"
if [ "$OLD_USERS" = "$NEW_USERS" ] && [ "$OLD_SUM" = "$NEW_SUM" ]; then
  echo "Готово. Дамп сохранён в $DUMP — храните его как резервную копию."
else
  echo "ВНИМАНИЕ: данные не совпадают, не переключайте DATABASE_URL." >&2
  exit 1
fi
