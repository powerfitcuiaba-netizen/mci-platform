# Deploy — MCI Platform

Runbook de colocação em produção. Escrito para ser executado por um operador
com acesso ao ambiente; **nenhuma credencial aparece aqui, e nenhuma deve ser
pedida por chat.** Todos os segredos vêm do gerenciador de segredos ou das
variáveis de ambiente do host.

## Estado de verificação deste documento

Honestidade sobre o que foi e o que não foi executado:

| Item | Estado |
|---|---|
| Migrations aplicadas em PostgreSQL real | ✅ executado (local e CI) |
| Políticas de RLS aplicadas e testadas contra o papel `mci_app` | ✅ executado (12 testes) |
| **RLS aplicado ao caminho real da requisição** | ✅ executado (15 testes: caso do dono, superusuário, concorrência) |
| Suíte completa (186 testes) e ESLint | ✅ executado |
| Barreira de configuração de produção | ✅ executado (15 testes) |
| `/health` e `/ready` respondendo em processo real | ✅ executado |
| Encerramento ordenado em SIGTERM | ✅ executado |
| Provedor de objetos (assinatura e contrato completo) | ✅ executado (10 testes, contra servidor que valida a assinatura) |
| **`docker build` da imagem** | ❌ **NUNCA EXECUTADO** — sem daemon Docker no ambiente onde o Dockerfile foi escrito |
| **Deploy em host real** | ❌ **NUNCA EXECUTADO** — depende de destino e credenciais que não me cabem |

O `Dockerfile` é uma proposta revisável, não um artefato validado. Trate o
primeiro `docker build` como parte do trabalho de deploy.

---

## 1. Antes de tudo: os dois riscos que precisam de decisão

### 1.1 RLS aplicado no caminho da requisição

**Resolvido na fase 10.2.** Antes, as políticas existiam e eram testadas, mas
não protegiam nada em execução: a aplicação conecta como dono das tabelas, e o
PostgreSQL isenta o dono das políticas salvo `FORCE ROW LEVEL SECURITY`, que
não estava aplicado. Na prática, a política negava e o dono lia assim mesmo.

Hoje a cadeia é real e verificável:

```
HTTP → autenticação (req.user) → asyncHandler → withUserContext
     → SET LOCAL mci.user_id (mesma transação) → Prisma → política → dado
```

- `FORCE ROW LEVEL SECURITY` nas 21 tabelas protegidas: o dono também é
  filtrado.
- O ator vem sempre de `req.user`, preenchido a partir do token. Nunca do
  corpo, da query ou de parâmetro de rota.
- O contexto é definido com `SET LOCAL` dentro da transação da requisição, na
  mesma conexão da consulta — o que o torna imune à troca de conexão do pool.
- Requisição sem token não abre transação e roda anônima: as políticas liberam
  só o que é público por definição.
- `tests/rls-runtime.test.mjs` cobre isso com 14 testes, incluindo o caso do
  dono, concorrência entre atores e ausência de contexto residual.

**O RLS é barreira de LINHA, não de coluna.** Onde a política libera a linha,
libera todas as colunas dela. Isso tem duas consequências, e elas foram
tratadas de formas diferentes:

- **CPF: resolvido no banco.** O número não mora mais em `Athlete` — cuja
  política precisa liberar leitura anônima para a superfície pública funcionar
  — e sim em `AthleteIdentity`, tabela própria com política que exige operador
  da organização ou o próprio atleta. Um `SELECT` sem projeção, feito por
  engano numa rota pública, não traz CPF porque a linha não vem. Coberto por
  `tests/rls.test.mjs`, que consulta o banco direto como `mci_app`.
- **Texto de publicação alheia: continua com o service.** A política de UPDATE
  de `Post` precisa ser permissiva o bastante para os contadores de curtida e
  comentário, que outros usuários incrementam; quem impede a edição de conteúdo
  de terceiro é a checagem de autoria no service, com teste. Restringir por
  coluna no banco exigiria `GRANT` de coluna, que só tem efeito conectando como
  `mci_app` (§1.4).

### 1.2 A conexão da aplicação NÃO pode ser superusuário

✅ **Verificado pelo próprio processo desde a fase 10.3.** A aplicação inspeciona
a conexão na partida (`src/config/rlsGuard.js`): papel superusuário ou tabela
com RLS sem `FORCE` **abortam a subida em produção** e reprovam `/ready` com
503. Deixou de depender de o operador conferir — o item de checklist abaixo é
confirmação, não a barreira.

⚠️ **Superusuário do PostgreSQL ignora RLS incondicionalmente.** Não importa
política, `FORCE` ou contexto: para um superusuário nada disso existe. Um banco
provisionado com o papel da aplicação como superusuário deixa toda a proteção
sem efeito — em silêncio, sem erro, sem nada no log.

Isso não é teórico: aconteceu na própria pipeline. A imagem oficial do
PostgreSQL cria o `POSTGRES_USER` como superusuário, então a CI rodava contra
um banco em que a barreira não existia, enquanto a máquina local — com papel
comum — a exercitava de verdade. A suíte passava aqui e falhava lá, e o motivo
era esse.

Confira antes de subir:

```sql
SELECT current_user, current_setting('is_superuser');   -- precisa dar 'off'
```

`tests/rls-runtime.test.mjs` reprova a suíte inteira se a conexão for
superusuária, para que o cenário não volte despercebido.

### 1.3 Armazenamento de arquivos

Duas opções, e a escolha precisa ser explícita — o servidor recusa subir sem
ela.

**Recomendado: provedor de objetos.** `STORAGE_DRIVER=s3` com `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY`. Nenhuma tem padrão, e
faltando qualquer uma o processo aborta dizendo qual. Serve S3, MinIO,
Cloudflare R2, DigitalOcean Spaces e Backblaze B2 — todos falam o mesmo
protocolo; `S3_FORCE_PATH_STYLE=false` troca para virtual-hosted, que é o
padrão do S3 moderno.

A assinatura é SigV4 implementada na casa (`src/services/storage/awsSignature.js`),
sem o SDK da AWS: são quatro verbos HTTP, e o SDK acrescentaria dezenas de
megabytes à imagem para assinar quatro requisições. A implementação é conferida
contra o vetor oficial da suíte de testes da AWS, e o provedor é exercitado
contra um servidor que valida a assinatura e responde 403 a quem assina errado
(`tests/armazenamento-objetos.test.mjs`).

**Alternativa: disco local.** `STORAGE_DRIVER=local` grava no disco do próprio
contêiner. Sem volume persistente, **todo upload — documento de atleta, foto,
mídia de mensagem — desaparece no primeiro redeploy**, e a perda só aparece
quando alguém vai buscar o arquivo. Por isso exige `ALLOW_LOCAL_STORAGE=true`:
é assunção explícita de risco, e só faz sentido com volume persistente de
verdade montado.

Não existe caminho silencioso entre as duas.

### 1.4 Conectar como `mci_app` (opcional, mais restritivo)

A aplicação conecta hoje como dono do schema, e o `FORCE` é o que garante o
RLS. Apontar `DATABASE_URL` para `mci_app` é seguro **agora** — antes da fase
10.2 isso derrubaria a aplicação inteira, porque nada definia o contexto — e
acrescenta duas camadas: o papel não é dono, e passa a respeitar `GRANT` de
coluna. Antes de trocar, rode a suíte apontando para ele.

---

## 2. Variáveis de ambiente

O processo valida a configuração na partida e **aborta listando tudo o que está
errado de uma vez** (`src/config/environment.js`). Falhar no deploy é melhor do
que servir tráfego real com segredo de desenvolvimento.

### Obrigatórias em produção

| Variável | Regra aplicada na partida |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | precisa existir e apontar para **PostgreSQL** — o RLS depende dele |
| `JWT_SECRET` | 32+ caracteres e **não pode ser** valor de exemplo da lista de placeholders |
| `CORS_ORIGINS` (ou `FRONTEND_URL`) | explícito; **curinga `*` é recusado** |
| `BCRYPT_ROUNDS` | ≥ 10 |
| `STORAGE_DRIVER` | se `local`, exige `ALLOW_LOCAL_STORAGE=true`; se `s3`, exige as quatro variáveis do provedor |

Gerar o segredo:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Opcionais com padrão

`PORT` (3000) · `JWT_EXPIRES_IN` (12h) · `DEFAULT_TIMEZONE`
(America/Sao_Paulo) · `STORAGE_DIR` · `UPLOAD_MAX_BYTES` (10 MB) ·
`MEDIA_MAX_BYTES` (50 MB) · `STORY_TTL_HOURS` (24) · `RATE_LIMIT_ENABLED`
(ligado em produção) · `LOG_LEVEL` (info)

Referência completa e comentada: `.env.example`.

> Em produção o `server.js` **não lê arquivo `.env`** — apenas o ambiente. É
> deliberado: um `.env` esquecido no servidor sobrescreveria silenciosamente a
> configuração real do deploy.

**Nenhuma variável financeira existe nesta plataforma.** Se alguma aparecer na
configuração, é erro de escopo, não funcionalidade.

---

## 3. Ordem do primeiro deploy

Os passos 2 e 3 são executados **uma vez por banco**. Os demais se repetem a
cada release.

### 3.1 Provisionar o PostgreSQL

Criar banco e o usuário dono do schema (o das migrations). PostgreSQL 16 é a
versão em que a suíte roda; o requisito real é suporte a RLS.

### 3.2 Aplicar as migrations

```bash
npx prisma migrate deploy
npx prisma migrate status   # precisa dizer que nada ficou pendente
```

Duas migrations: o baseline do domínio e as políticas de RLS.

### 3.3 Provisionar o papel de aplicação

Exige um usuário com `CREATEROLE` — **não** o usuário das migrations. A
separação é deliberada: o usuário que aplica migration não deve poder criar
papéis.

```bash
psql -h "$PGHOST" -U "$PG_ADMIN" -d "$PGDATABASE" \
  -v senha="'$MCI_APP_PASSWORD'" -f scripts/provision-app-role.sql
```

A senha vem do ambiente. Ela **não** está no arquivo e não deve ser digitada em
histórico de shell.

Cria `mci_app` como `LOGIN NOBYPASSRLS` — é o papel para o qual as políticas
são obrigatórias, e é com ele que a suíte prova que o RLS funciona.

### 3.4 Popular o catálogo oficial

```bash
node prisma/seed.js
```

Carrega as 11 categorias oficiais (incluindo as obrigatórias **Women's
Bodybuilding** e **Fitmodel**), as classes de referência (`ESTREANTE`,
`NOVICE`, `OPEN`, `MASTER`), os critérios de avaliação por categoria e as
comunidades iniciais.

> Os critérios de avaliação são **referência para o atleta**, não ficha de
> julgamento: o julgamento esportivo é externo ao MCI. A regra de apuração
> `Padrão MCI`, que este passo criava, saiu na fase 11.5 junto com o motor de
> julgamento interno. Ver
> [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md).

O seed é idempotente (`upsert`): reexecutar não duplica nem destrói dados.

### 3.5 Subir a API

```bash
node server.js
```

Se a configuração estiver incompleta, o processo escreve os problemas em stderr
e sai com código 1 **antes** de abrir a porta.

---

## 4. Releases seguintes

```bash
npm ci
npx prisma generate
npx prisma migrate deploy
# reiniciar o processo
```

O `server.js` trata `SIGTERM` e `SIGINT`: para de aceitar conexões novas, deixa
as em curso terminarem, desconecta o Prisma e só então sai (com corte em 10s).
Envie **SIGTERM**, não SIGKILL.

---

## 5. Sondas

Ficam fora do prefixo versionado: quem as consulta é o orquestrador, não o
cliente da API.

| Rota | Uso | Comportamento |
|---|---|---|
| `GET /health` | *liveness* | responde sem tocar no banco |
| `GET /ready` | *readiness* | verifica PostgreSQL e storage; **503** quando algo está fora |

Ligue o `readinessProbe` em `/ready` e o `livenessProbe` em `/health`. Trocar
os dois faz o orquestrador reiniciar o contêiner sempre que o banco oscilar —
justamente quando reiniciar não ajuda.

---

## 6. Imagem Docker (NÃO CONSTRUÍDA)

```bash
docker build -t mci-platform:$(git rev-parse --short HEAD) .
```

Decisões embutidas no `Dockerfile`, todas comentadas nele:

- base Debian slim em vez de Alpine — evita trocar o engine do Prisma para musl
  no primeiro deploy;
- `npm ci` completo mantido na imagem final, de propósito: o CLI do Prisma
  precisa estar disponível para `migrate deploy` como passo de release.
  Instalá-lo à parte já produziu **neste projeto** divergência de versão entre
  CLI e client — bug real, não hipotético;
- `USER node` — o processo não roda como root;
- `CMD ["node", "server.js"]`, sem `npm start`: o npm viraria PID 1, engoliria o
  SIGTERM e o encerramento ordenado nunca rodaria;
- `HEALTHCHECK` aponta para `/health` (liveness). O `/ready` é do orquestrador.

O comando do `HEALTHCHECK` **foi verificado** contra um servidor real (sai 0
quando saudável). O **build da imagem não foi**.

---

## 7. Frontend

Bundle estático do Vite. A API **não** serve arquivo estático (`src/app.js` não
tem middleware de estáticos): o frontend vai para host estático ou CDN.

```bash
cd frontend
npm ci
npm run build     # gera frontend/dist
```

A origem onde o frontend for publicado precisa constar em `CORS_ORIGINS` da
API, ou o navegador bloqueia as chamadas.

---

## 8. Rollback

1. **Código:** reimplantar o release anterior.
2. **Banco:** as migrations são *forward-only*. Não existe `migrate down`
   automático, e isso é deliberado — rollback automático de schema com dados de
   competição em produção destrói dado real. Reversão de schema exige migration
   nova, escrita para o caso.
3. **Resultados:** não precisam de rollback de banco. Toda mudança de estado de
   um resultado gera `ResultVersion` com autor, momento e motivo; reverter uma
   publicação é ato de domínio registrado, não `UPDATE` manual.

---

## 9. Checklist final

- [ ] `migrate status` sem migration pendente
- [ ] `mci_app` provisionado e senha no gerenciador de segredos
- [ ] `JWT_SECRET` com 32+ caracteres, gerado aleatoriamente, **fora do repositório**
- [ ] `CORS_ORIGINS` com as origens reais, sem curinga
- [ ] `BCRYPT_ROUNDS` ≥ 10
- [ ] Decisão de armazenamento tomada (§1.3) — `STORAGE_DRIVER=s3` com as quatro variáveis, ou volume persistente com `ALLOW_LOCAL_STORAGE=true`
- [ ] `readinessProbe` em `/ready`, `livenessProbe` em `/health`
- [ ] TLS terminando antes da API; `trust proxy` já ligado em produção
- [ ] Backup do PostgreSQL configurado e **restauração testada**
- [ ] `FORCE ROW LEVEL SECURITY` confirmado nas 21 tabelas (§1.1)
- [ ] **`current_setting('is_superuser')` = `off` na conexão da aplicação (§1.2)** — superusuário anula o RLS inteiro
- [ ] [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md) ratificado antes de apurar prova oficial
