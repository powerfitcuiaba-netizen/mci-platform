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
| Suíte completa (171 testes) e ESLint | ✅ executado |
| Barreira de configuração de produção | ✅ executado (15 testes) |
| `/health` e `/ready` respondendo em processo real | ✅ executado |
| Encerramento ordenado em SIGTERM | ✅ executado |
| **`docker build` da imagem** | ❌ **NUNCA EXECUTADO** — sem daemon Docker no ambiente onde o Dockerfile foi escrito |
| **Deploy em host real** | ❌ **NUNCA EXECUTADO** — depende de destino e credenciais que não me cabem |

O `Dockerfile` é uma proposta revisável, não um artefato validado. Trate o
primeiro `docker build` como parte do trabalho de deploy.

---

## 1. Antes de tudo: os dois riscos que precisam de decisão

### 1.1 RLS não está ligado no caminho da requisição

As políticas de RLS **existem, estão aplicadas e são testadas** — os testes
conectam como `mci_app` (papel `NOBYPASSRLS`) e verificam que o banco recusa
leitura e escrita indevidas. Isso é fato verificado.

Mas a API conecta como **dono do schema** (`DATABASE_URL`), e o dono do schema
não é submetido às políticas. O helper que define o ator da transação
(`src/config/rlsSession.js`, `withUserContext`) está implementado e testado,
mas **nenhum service o utiliza hoje**.

Consequência prática: **a autorização em produção é feita pelo RBAC da
aplicação; o RLS é uma segunda camada provada, porém inativa no runtime.**

⚠️ **Não tente ligar o RLS apenas trocando `DATABASE_URL` para `mci_app`.** Sem
`withUserContext` envolvendo cada consulta, `current_setting('mci.user_id')`
fica vazio, as políticas negam tudo e a aplicação para de funcionar por
completo. Ligar o RLS de verdade exige passar as consultas dos services por
`withUserContext` — é trabalho de desenvolvimento, não de configuração, e deve
ser decidido e planejado, não improvisado durante um deploy.

### 1.2 Armazenamento de arquivos

`STORAGE_DRIVER=local` grava no disco do próprio contêiner. Sem volume
persistente, **todo upload — documento de atleta, foto, mídia de mensagem —
desaparece no primeiro redeploy**, e a perda só aparece quando alguém vai
buscar o arquivo.

O servidor **se recusa a subir** nessa combinação. Para prosseguir é preciso
uma escolha explícita:

- configurar um provedor de objetos, ou
- montar volume persistente de verdade e assumir o risco com
  `ALLOW_LOCAL_STORAGE=true`.

Não existe caminho silencioso entre as duas.

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
| `STORAGE_DRIVER` | se `local`, exige `ALLOW_LOCAL_STORAGE=true` |

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
Bodybuilding** e **Fitmodel**), as classes de referência, os critérios de
avaliação por categoria, as comunidades iniciais e a regra de apuração
`Padrão MCI`.

> ⚠️ A regra `Padrão MCI` é **ponto de partida de desenvolvimento, não regra
> homologada**. Antes de qualquer prova oficial, ver
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
- [ ] Decisão de armazenamento tomada (§1.2) — provedor de objetos ou volume persistente
- [ ] `readinessProbe` em `/ready`, `livenessProbe` em `/health`
- [ ] TLS terminando antes da API; `trust proxy` já ligado em produção
- [ ] Backup do PostgreSQL configurado e **restauração testada**
- [ ] Risco de RLS em runtime (§1.1) lido e aceito conscientemente
- [ ] [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md) ratificado antes de apurar prova oficial
