# ==========================================================================
# MCI Platform — imagem da API.
#
# Só o backend. O frontend é um bundle estático do Vite e não é servido por
# este processo (src/app.js não serve arquivo estático): ele vai para um host
# estático ou CDN. Ver docs/DEPLOY.md.
#
# ATENÇÃO: esta imagem NUNCA foi construída. O ambiente onde o arquivo foi
# escrito não tem daemon Docker, então `docker build` não foi executado e o
# resultado não foi verificado. Trate o primeiro build como parte do deploy,
# não como formalidade.
# ==========================================================================

# Base Debian slim, não Alpine: o Prisma resolve o binário de engine pela
# libssl do sistema, e trocar para musl muda o engine baixado. Evitar essa
# variável a mais no primeiro deploy vale os megabytes.
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# openssl é requisito de runtime do engine do Prisma.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Instalação completa, devDependencies inclusive, e ela permanece na imagem
# final de propósito: o CLI do Prisma precisa estar disponível para rodar
# `prisma migrate deploy` como passo de release. Instalar o CLI à parte já
# produziu, neste projeto, divergência de versão entre CLI e client — um bug
# real, não hipotético. Um único `npm ci` mantém os dois travados no lockfile.
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY server.js ./

# Usuário sem privilégio. A imagem node já traz `node` (uid 1000); o processo
# não tem motivo para rodar como root.
USER node

EXPOSE 3000

# /health responde sem tocar no banco: é liveness. Quem decide se o contêiner
# recebe tráfego é /ready, que verifica o PostgreSQL — esse é papel do
# orquestrador (readinessProbe), não do HEALTHCHECK da imagem.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Sem `npm start`: o npm vira PID 1 e engole o SIGTERM, e o encerramento
# ordenado do server.js (fecha conexões, desconecta o Prisma) nunca roda.
CMD ["node", "server.js"]
