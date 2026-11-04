# SB Signage — imagem para deploy em VPS/nuvem (Railway, Fly.io, Render, etc.)
FROM node:22-slim
WORKDIR /app

COPY package*.json ./
# baixa o binário do ffmpeg no install (ffmpeg-static); dependências de desenvolvimento ficam de fora
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY THIRD_PARTY_NOTICES.md ./

# Fuso da agenda e dos relatórios — o container roda em UTC, a agenda não.
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    SIGNAGE_TZ=America/Sao_Paulo \
    TRUST_PROXY=1
# o volume precisa pertencer ao usuário sem privilégios que roda o servidor
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
