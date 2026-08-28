# MCI Campeonatos — imagem única servindo API e interface.
#
# O frontend é estático depois de construído: não precisa de processo próprio,
# e um segundo container só para servir três arquivos custaria mais do que
# resolve. O Express serve o `dist/` e a API na mesma origem, o que também
# elimina a necessidade de CORS em produção.

# ---------------------------------------------------------------- interface
FROM node:24.16-alpine AS frontend

WORKDIR /app/frontend

# Os manifestos vêm antes do código: enquanto eles não mudarem, o Docker
# reaproveita a camada de instalação e o build não baixa nada de novo.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---------------------------------------------------------- dependências API
FROM node:24.16-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma

# `npm ci` sem --omit=dev de propósito: o CLI do Prisma é devDependency e
# precisa existir para gerar o client e aplicar migration no arranque.
RUN npm ci && npx prisma generate

# ------------------------------------------------------------------ runtime
FROM node:24.16-alpine AS runtime

# tini responde a SIGTERM e encaminha ao Node, para que o encerramento
# ordenado que o server.js implementa realmente aconteça no `docker stop`.
RUN apk add --no-cache tini

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Diretório dos documentos. É ponto de montagem: sem volume, o que for enviado
# desaparece no próximo deploy — a imagem é descartável, o volume não.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
VOLUME ["/app/uploads"]
ENV STORAGE_DIR=/app/uploads

# Nunca como root. A imagem do Node já traz o usuário `node`.
USER node

EXPOSE 3000

# /health responde sem tocar em banco: mede se o processo está vivo, que é o
# que um healthcheck de container deve medir. Prontidão para receber tráfego é
# outra pergunta, e /ready responde a ela.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
