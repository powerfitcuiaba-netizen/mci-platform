# ==========================================================================
# MCI Platform — imagem da API.
#
# Só o backend. O frontend é um bundle estático do Vite e não é servido por
# este processo (src/app.js não serve arquivo estático): ele vai para um host
# estático ou CDN. Ver docs/DEPLOY.md.
#
# ESTADO DA VERIFICAÇÃO (8 de setembro de 2026)
#
# O build FOI tentado, com daemon Docker de pé, e não completou — por restrição
# de rede do ambiente, não por defeito deste arquivo. O que ficou provado e o
# que não ficou:
#
#   PROVADO  A imagem base baixa e roda (`node:22-bookworm-slim`).
#   PROVADO  A camada `apt-get install openssl ca-certificates` é NECESSÁRIA:
#            conferido dentro da imagem base, ela não traz openssl, nem
#            libssl, nem ca-certificates. Sem essa camada o engine do Prisma
#            não sobe.
#   PROVADO  A camada apt precisa vir ANTES do `npm ci`. Sem ca-certificates a
#            imagem não completa NENHUMA conexão HTTPS — nem ao registro do
#            npm. A ordem abaixo não é preferência, é requisito.
#   NÃO PROVADO  `npm ci`, `prisma generate`, as cópias, o usuário sem
#            privilégio, o HEALTHCHECK e o CMD. Nenhum deles chegou a executar.
#
# O ambiente bloqueia os repositórios Debian (403 em HTTPS, e o proxy responde
# 405 a HTTP simples), o que trava o `apt-get update` e, em cascata, todo o
# resto. Trate o primeiro build como parte do deploy, não como formalidade.
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

# O schema entra ANTES do `npm ci`: o postinstall do @prisma/client procura por
# ele, e instalar sem o schema presente deixa o passo de geração dependendo
# apenas da chamada explícita adiante.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Instalação completa, devDependencies inclusive, e ela permanece na imagem
# final de propósito: o CLI do Prisma precisa estar disponível para rodar
# `prisma migrate deploy` como passo de release. Instalar o CLI à parte já
# produziu, neste projeto, divergência de versão entre CLI e client — um bug
# real, não hipotético. Um único `npm ci` mantém os dois travados no lockfile.
RUN npm ci

# Explícito mesmo que o postinstall já tenha gerado: o passo é barato e não
# depende de o postinstall continuar existindo numa versão futura.
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
