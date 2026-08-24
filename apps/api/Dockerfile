FROM node:20-bookworm-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
# Без этих файлов tsc падает: маршрут слота импортирует серверный движок.
RUN test -f src/games/drunkardGate/engine.ts \
 && test -f src/games/drunkardGate/rng.ts \
 && test -f src/games/drunkardGate/config.ts \
 && npm run build
EXPOSE 4000
CMD ["npm","start"]
