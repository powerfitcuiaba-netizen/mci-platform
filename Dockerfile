# ==========================================================================
# MCI Platform — imagem da API.
#
# Só o backend. O frontend é um bundle estático do Vite e não é servido por
# este processo (src/app.js não serve arquivo estático): ele vai para um host
# estático ou CDN. Ver docs/DEPLOY.md.
#
# ESTADO DA VERIFICAÇÃO (8 de setembro de 2026, fase 12.4)
#
# A imagem FOI construída e EXECUTADA. Antes disso, em duas tentativas, não
# tinha sido — o que este bloco registra é o que ficou provado de fato, e com
# quais ressalvas.
#
# COMO foi construída, para que ninguém leia mais do que está escrito:
#   - `--build-arg BASE_IMAGE=node:22-bookworm` (a base CHEIA, que já traz
#     openssl e ca-certificates), porque o ambiente de verificação bloqueia
#     todos os espelhos Debian testados — nove deles, 403 no túnel do proxy;
#   - com duas linhas a mais, fora deste arquivo, injetando a CA do proxy que
#     intercepta TLS nesse ambiente. Sem elas o `npm ci` morre com
#     SELF_SIGNED_CERT_IN_CHAIN. É particularidade do ambiente, não do deploy.
#
# PROVADO
#   - openssl, libssl e ca-certificates NÃO vêm em `node:22-bookworm-slim`:
#     conferido dentro da imagem, os três ausentes. Sem eles o engine do
#     Prisma não sobe e nenhuma conexão HTTPS se completa, nem ao registro do
#     npm — por isso a camada de pacotes vem ANTES do `npm ci`. É requisito de
#     ordem, não preferência.
#   - `npm ci`, `npx prisma generate`, todas as cópias, o usuário sem
#     privilégio, o EXPOSE, o HEALTHCHECK e o CMD: a imagem construiu inteira.
#   - O processo roda como uid 1000 (`node`), não root.
#   - `/health` responde 200; `/ready` responde 200 com database, storage e
#     rls verdadeiros, contra um PostgreSQL real.
#   - Login autentica e o ranking público responde, com NODE_ENV=production.
#   - As guardas de partida funcionam DENTRO da imagem: sem configuração
#     completa, com JWT_SECRET curto, ou contra papel SUPERUSUÁRIO (em que o
#     RLS não teria efeito), o processo recusa subir e explica por quê.
#   - O HEALTHCHECK chega a `healthy` com código 0.
#   - `docker stop` encerra pelo caminho ordenado: o log registra o SIGTERM,
#     o processo sai com código 0 em 69 ms — não é morte por sinal.
#   - `npx prisma migrate deploy` roda a partir da própria imagem e cria as 73
#     tabelas com as 21 sob FORCE RLS. CLI e client na mesma versão (6.19.3),
#     que é a razão de as devDependencies permanecerem na imagem.
#
# NÃO PROVADO
#   - O `apt-get` em si, pelo bloqueio descrito acima. A camada de pacotes foi
#     exercitada só pelo ramo que a dispensa. Num ambiente com acesso ao apt é
#     o caminho trivial — mas trate o primeiro build do deploy como parte do
#     deploy, não como formalidade.
#   - A base padrão (`node:22-bookworm-slim`) não chegou a completar o build
#     AQUI, pelo mesmo motivo. A imagem provada nasceu da base cheia.
# ==========================================================================

# Imagem base parametrizada. Não é firula: este projeto já foi construído em
# dois ambientes que bloqueiam os repositórios Debian, e um deles bloqueava
# também o CDN do Docker Hub. Poder apontar para um espelho, ou para uma base
# já preparada pela organização, é a diferença entre construir e não construir.
# O padrão continua sendo a slim oficial.
ARG BASE_IMAGE=node:22-bookworm-slim

# Base Debian slim, não Alpine: o Prisma resolve o binário de engine pela
# libssl do sistema, e trocar para musl muda o engine baixado. Evitar essa
# variável a mais no primeiro deploy vale os megabytes.
FROM ${BASE_IMAGE} AS deps

WORKDIR /app

# openssl é requisito de runtime do engine do Prisma; ca-certificates é
# requisito de QUALQUER conexão HTTPS de dentro da imagem.
#
# A condição não é atalho: ela testa o requisito de verdade — os binários e o
# bundle de CA presentes — e não uma variável dizendo que estão. Numa base que
# já os traga (a `node:22-bookworm` cheia, ou uma base interna preparada), o
# apt seria trabalho repetido; na slim oficial, que não traz nenhum dos três,
# o ramo do apt é o que roda. Base sem os pacotes e sem acesso ao apt falha
# aqui, alto, que é onde tem de falhar.
RUN if command -v openssl >/dev/null 2>&1 && [ -f /etc/ssl/certs/ca-certificates.crt ]; then \
      echo "openssl e ca-certificates já presentes na base"; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

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

# O `sharp` usa binário pré-compilado por plataforma, resolvido no `npm ci`
# pelos pacotes opcionais do lockfile (@img/sharp-linux-x64 e o libvips
# correspondente). Duas consequências práticas:
#
#   - este estágio precisa ser da MESMA plataforma do runtime, e é: os dois
#     partem de ${BASE_IMAGE};
#   - `npm ci --omit=optional` quebraria o processamento de imagem em tempo de
#     execução, sem quebrar o build. Não use.
#
# O binário exige glibc 2.28 ou mais nova; bookworm traz 2.36.

# Explícito mesmo que o postinstall já tenha gerado: o passo é barato e não
# depende de o postinstall continuar existindo numa versão futura.
RUN npx prisma generate


# `ARG` não atravessa `FROM`: precisa ser redeclarado para valer neste estágio.
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE} AS runtime

WORKDIR /app

# openssl é requisito de runtime do engine do Prisma; ca-certificates é
# requisito de QUALQUER conexão HTTPS de dentro da imagem.
#
# A condição não é atalho: ela testa o requisito de verdade — os binários e o
# bundle de CA presentes — e não uma variável dizendo que estão. Numa base que
# já os traga (a `node:22-bookworm` cheia, ou uma base interna preparada), o
# apt seria trabalho repetido; na slim oficial, que não traz nenhum dos três,
# o ramo do apt é o que roda. Base sem os pacotes e sem acesso ao apt falha
# aqui, alto, que é onde tem de falhar.
RUN if command -v openssl >/dev/null 2>&1 && [ -f /etc/ssl/certs/ca-certificates.crt ]; then \
      echo "openssl e ca-certificates já presentes na base"; \
    else \
      apt-get update \
      && apt-get install -y --no-install-recommends openssl ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

# `data/` entra na imagem porque os scripts de release leem dela em tempo de
# execução: `scripts/importar-campeonatos.js` resolve
# `data/campeonatos-2026.json` por caminho relativo ao próprio arquivo, o que
# dentro da imagem é `/app/data/campeonatos-2026.json`. Sem esta linha o
# script existe mas o dado não, e a importação morre com ENOENT no deploy —
# foi exatamente o que aconteceu: o diretório nasceu depois da última edição
# deste arquivo, e como as cópias são enumeradas uma a uma, faltar aqui é
# silencioso até alguém rodar o script. Ao acrescentar um diretório de nível
# superior que o runtime precise, acrescente também a cópia.
COPY data ./data

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
