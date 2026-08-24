-- Уникальные ID игроков
--
-- После `npm run prisma:migrate` колонка User.playerId уже существует и всем
-- текущим пользователям выданы значения 1, 2, 3, ...
-- Этот скрипт делает ID шестизначными (100001, 100002, ...), как в интерфейсе.
--
-- Запустить один раз после миграции:
--   psql "$DATABASE_URL" -f prisma/sql/player-id.sql

-- 1. Сдвигаем уже выданные маленькие ID в диапазон 100001+
UPDATE "User"
SET "playerId" = "playerId" + 100000
WHERE "playerId" < 100000;

-- 2. Следующие регистрации продолжают нумерацию с максимума + 1
SELECT setval(
  pg_get_serial_sequence('"User"', 'playerId'),
  GREATEST((SELECT COALESCE(MAX("playerId"), 100000) FROM "User"), 100000)
);
