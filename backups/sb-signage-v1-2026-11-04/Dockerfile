# SB Signage — imagem para deploy em VPS/nuvem (Railway, Fly.io, Render, etc.)
FROM node:20-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

ENV PORT=4000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 4000

CMD ["node", "server/index.js"]
