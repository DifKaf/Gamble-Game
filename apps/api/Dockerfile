FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update -y \
  && apt-get install -y openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npm run prisma:generate

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 4000

CMD ["npm", "start"]
