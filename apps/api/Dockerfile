# ---------- сборка ----------
FROM node:20-bookworm-slim AS build
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
# Без этих файлов tsc падает: маршрут слота импортирует серверный движок.
RUN test -f src/games/drunkardGate/engine.ts \
 && test -f src/games/drunkardGate/rng.ts \
 && test -f src/games/drunkardGate/config.ts \
 && test -f src/games/dogHouse/engine.ts \
 && test -f src/games/dogHouse/config.ts \
 && npm run build
# В рантайм берём только production-зависимости (сгенерированный Prisma Client остаётся).
RUN npm prune --omit=dev --no-audit --no-fund

# ---------- запуск ----------
FROM node:20-bookworm-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 4000
# node напрямую (а не npm start), чтобы SIGTERM от Railway доходил до сервера и он останавливался плавно.
CMD ["node","dist/server.js"]
