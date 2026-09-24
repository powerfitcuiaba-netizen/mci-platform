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

As migrations são *forward-only*: o baseline do domínio, as políticas de RLS e
a evolução do domínio esportivo desde então.

### 3.3 Provisionar a conta de serviço das federações — AUTOMÁTICO NO DEPLOY

**O pipeline já faz isto.** `render.yaml` executa, antes de a nova versão
receber tráfego:

```
preDeployCommand: npx prisma migrate deploy && node scripts/provisionar-contas-de-servico.js
```

A ordem é obrigatória: primeiro a ESTRUTURA, depois o DADO que a estrutura não
cria. E o gancho é `preDeployCommand` porque ele roda **depois** de o banco
estar migrado e **antes** de o autocadastro novo ficar disponível — se falhar,
o Render não promove a versão, a antiga continua no ar, e ninguém fica com
autocadastro quebrado.

Configure uma vez, no painel do Render, a variável `PROVISIONAR_ADMIN_EMAIL`
(declarada com `sync: false`) com o e-mail de um ADMIN ou SUPER_ADMIN
existente. A auditoria registra `SERVICE_ACCOUNT_PROVISIONED` em nome dele.

Para rodar à mão — plano sem `preDeployCommand`, ou conferência avulsa:

```bash
# Confere, sem escrever nada:
PROVISIONAR_ADMIN_EMAIL='admin@dominio' node scripts/provisionar-contas-de-servico.js --conferir

# Aplica:
PROVISIONAR_ADMIN_EMAIL='admin@dominio' node scripts/provisionar-contas-de-servico.js
```

**Não é opcional, e migration nenhuma faz isto por você.** A conta de serviço
da federação nasce junto com a organização (`organizationService.create`). As
federações que já existiam foram criadas antes desta fase, e a migration que
acrescentou as colunas não cria linha nenhuma — migration altera ESTRUTURA, e a
conta de serviço é DADO.

### 3.4 A entidade de filiação oficial — `MCI_NPC_ORGANIZATION_ID`

O **mesmo** `preDeployCommand` garante também a entidade de filiação oficial do
Campeonato Brasileiro Muscle Contest:

| Campo | Valor |
|---|---|
| `name` | `NPC - National Physique Committe` |
| `code` | `NPC` |
| `kind` | `ENTITY` |
| `active` | `true` |

e deixa `Organization.selfRegistrationOpen = true` **apenas** na organização
configurada.

Configure no painel do Render, uma vez, a variável `MCI_NPC_ORGANIZATION_ID`
(declarada com `sync: false`) com o **id** da organização oficial.

#### O defeito que isto corrige

Na tela "Solicitar perfil de atleta" o campo **Entidade de filiação** aparecia
vazio, com *"Nenhuma entidade de filiação ativa está disponível para a sua
conta."* — e sem entidade o atleta não conclui o autocadastro.

Não era a tela e não era RLS: `Affiliation` e `Organization` não têm política
nenhuma (`relrowsecurity = false` nas duas, medido em `pg_class`). Era **dado
que nunca foi provisionado**:

- `selfRegistrationOpen` nasce `false` e era ligado em **exatamente um lugar**
  do código — `POST /organizations/:id/self-registration`, clique manual;
- **nada** no repositório criava uma `Affiliation`, fora aquele endpoint e
  `scripts/qa/dataset.mjs`, que é QA. `importar-campeonatos.js`, que carregou os
  47 campeonatos, nunca toca a tabela.

Ou seja: a entidade oficial existia apenas como clique manual. Não sobrevivia a
um ambiente novo, não era reproduzível, e não havia como conferi-la sem abrir o
banco.

#### Responsabilidade única de cada variável

| Variável | Responde |
|---|---|
| `PROVISIONAR_ADMIN_EMAIL` | **quem** autoriza — a auditoria grava o nome dele |
| `MCI_NPC_ORGANIZATION_ID` | **qual** organização é a oficial |

Uma **não** serve para descobrir a outra. Derivar a organização do vínculo de
quem autoriza o deploy faria a federação oficial mudar quando trocasse o
administrador.

A organização **nunca** é descoberta: nem por nome aproximado, nem pela primeira
que o banco devolver, nem por nada vindo do frontend.

#### O que acontece em cada estado

| Estado | Comportamento | Saída |
|---|---|---|
| variável ausente | a entidade **não é verificada**, e o log diz isso; o deploy segue | `0` |
| organização inexistente | falha explícita; **nenhuma outra é escolhida** | `1` |
| organização inativa | falha explícita | `1` |
| entidade ausente | cria, ativa, abre o autocadastro | `0` |
| entidade inativa, ou com nome/tipo fora | normaliza **só** o que divergir | `0` |
| entidade já correta | **não escreve nada**, nem auditoria | `0` |
| conflito de entidade | **PARA**, nada é alterado, e reporta os vínculos de cada candidata | `1` |

Falhar é o comportamento certo nos casos de `1`: o Render não promove a versão,
a antiga continua no ar, e ninguém fica com o autocadastro quebrado.

#### Diagnóstico, somente leitura

```bash
MCI_NPC_ORGANIZATION_ID='<id>' node scripts/provisionar-contas-de-servico.js --conferir
```

`--conferir` **não exige** `PROVISIONAR_ADMIN_EMAIL`: ele não escreve, e pedir
credencial para *olhar* é o que faz um diagnóstico não ser usado. Ele imprime
`organizationId`, `organizationName`, `organizationActive`,
`selfRegistrationOpen`, `affiliationId`, `affiliationName`, `affiliationCode`,
`affiliationKind`, `affiliationActive` e a quantidade de vínculos — atletas,
inscrições, solicitações, lançamentos e identidades externas.

Saídas: `0` nada a fazer · `2` há pendência · `1` conflito ou configuração
inválida.

#### O que o provisionamento nunca faz

Não apaga filiação, não apaga histórico, e **não renomeia `code`** — que é
chave de reconhecimento da importação MuscleWar: trocá-lo desligaria a
conciliação por matrícula para tudo que já está no ledger. Em conflito ele para
e reporta; quem decide é a federação, com o histórico na mão.

Sem este passo, `POST /athlete-requests` responde **503
`SERVICE_ACCOUNT_MISSING` para todas as federações existentes**: o autocadastro
não conclui, e o sintoma só aparece quando o primeiro atleta tenta se cadastrar.

O e-mail do administrador é exigido porque provisionar é ato administrativo e
ato administrativo tem dono — a auditoria grava quem autorizou. Sem ator, a
política `auditoria_escrita` recusa o INSERT, o PostgreSQL aborta a transação, e
o provisionamento volta atrás **em silêncio**. Medido; ver §16.2 da auditoria.

É **idempotente**: rode a cada deploy, sem precisar lembrar quais federações já
foram atendidas. Só faz INSERT.

Códigos de saída — **nunca a contagem**, que como byte daria 0 em 256
pendências e o deploy leria "nada a fazer" justamente no pior caso:

| Código | Significado |
|---|---|
| 0 | nada a fazer, ou provisionamento concluído |
| 1 | erro: variável ausente, usuário inexistente, sem permissão, falha |
| 2 | `--conferir` encontrou federações pendentes |

Exige `prisma generate` antes (já é o passo 3.1): o script filtra organizações
pela relação `contaDeServico`, que não existe num cliente Prisma desatualizado.

A variável só é lida **quando há federação sem conta**. Instalação nova (zero
federações) e deploy seguinte (tudo provisionado) saem com 0 sem consultá-la —
pedir autorização para não fazer nada derrubaria o deploy por burocracia.
Quando há trabalho de verdade e a variável falta, o script falha alto e o
deploy para, que é o comportamento certo.

Medido contra bancos reais, os três cenários de deploy:

| Cenário | Resultado |
|---|---|
| Instalação nova, sem federação nem admin | "nada a fazer", exit 0 |
| Federações existentes, **sem** a variável | falha explícita, exit 1 — deploy para |
| Federações existentes, **com** a variável | 3 provisionadas, exit 0 |
| Deploy seguinte, sem a variável | "nada a fazer", exit 0 |
| `preDeployCommand` literal, ponta a ponta | 0 → 3 contas, exit 0 |

Resultado final em todos: **1 federação = 1 conta + 1 membresia**. Ver §17.3 e
§18 da auditoria.

#### Preflight obrigatório em base que já tem dado

A migration `20260921120000_matricula_identifica_um_atleta` cria um índice
único e **aborta inteira** se a base já contiver dois cadastros com a mesma
matrícula na mesma filiação. Abortar é o comportamento correto — mas descobrir
isso no meio da janela de deploy não é. Em base que já tem atleta cadastrado,
rode o diagnóstico **antes**:

```bash
psql "<conexao>" -v ON_ERROR_STOP=1 -f scripts/preflight-matricula.sql
```

O arquivo é somente leitura: não tem `INSERT`, `UPDATE`, `DELETE` nem DDL.

**Rode como `mci_backup` ou como o administrador do banco — nunca como o papel
da aplicação.** `Athlete` está sob `FORCE ROW LEVEL SECURITY`: lido pelo papel
da aplicação sem contexto de usuário, o diagnóstico devolveria zero linhas, e
"0 duplicidades" seria uma resposta falsa indistinguível da verdadeira. Por
isso a PARTE 0 do arquivo emite um veredito explícito sobre a própria leitura.
Se ele disser `LEITURA NAO CONFIAVEL` ou `LEITURA PARCIAL`, **pare**: o resto
da saída não significa nada.

Com a leitura confiável, `pares_duplicados = 0` pré-valida a migration para
essa condição. Qualquer número maior é decisão humana — a PARTE 2 lista quem
está envolvido, com o histórico de cada cadastro (pontos válidos, resultados
importados e oficiais, títulos Overall, inscrições, vínculos de equipe) para
que alguém decida qual cadastro é o da pessoa. O diagnóstico não escolhe
proprietário, não apaga atleta e não altera matrícula. E não mostra CPF: a
coluna `tem_cpf_cadastrado` diz apenas **se** existe identidade cadastrada.

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

### 3.5 Criar o primeiro administrador

Sem este passo **a instalação fica inacessível**: o cadastro aberto recusa papel
privilegiado, de propósito, então ninguém consegue administrar nada até que o
primeiro administrador exista.

```bash
ADMIN_PASSWORD='<senha forte>' node scripts/criar-admin.js "Nome Completo" pessoa@dominio
```

Ou, para não deixar a senha nem em variável de ambiente:

```bash
node scripts/criar-admin.js "Nome Completo" pessoa@dominio
# a senha é lida da entrada padrão
```

> **A senha não é aceita como argumento de linha de comando.** Argumento aparece
> em `ps` para qualquer usuário da máquina e fica no histórico do shell; o
> script recusa e manda usar variável de ambiente ou entrada padrão.

O script **só cria o primeiro** administrador. Com um já existente, ele recusa e
manda usar a administração de contas — que registra quem concedeu o papel. Se o
email já tiver conta comum, ela é **promovida**, sem duplicar cadastro. O
bootstrap fica registrado na auditoria como `ADMIN_BOOTSTRAP`.

Coberto por `tests/bootstrap-admin.test.mjs`, que vai até o fim: cria, entra,
lista contas e cria uma federação.

### 3.6 Subir a API

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

## 6. Imagem Docker

```bash
docker build -t mci-platform:$(git rev-parse --short HEAD) .

# Rede que bloqueia os repositórios Debian, ou base preparada pela organização:
docker build --build-arg BASE_IMAGE=registry.interna/node:22-bookworm -t mci-platform:... .
```

Decisões embutidas no `Dockerfile`, todas comentadas nele:

- base Debian slim em vez de Alpine — evita trocar o engine do Prisma para musl
  no primeiro deploy;
- `ARG BASE_IMAGE` — o projeto já foi construído em dois ambientes que bloqueiam
  os repositórios Debian; poder apontar para um espelho é a diferença entre
  construir e não construir;
- a camada de pacotes (`openssl`, `ca-certificates`) vem **antes** do `npm ci`:
  a imagem slim não traz nenhum dos dois, e sem `ca-certificates` nenhuma
  conexão HTTPS se completa — nem ao registro do npm;
- `npm ci` completo mantido na imagem final, de propósito: o CLI do Prisma
  precisa estar disponível para `migrate deploy` como passo de release.
  Instalá-lo à parte já produziu **neste projeto** divergência de versão entre
  CLI e client — bug real, não hipotético;
- `USER node` — o processo não roda como root;
- `CMD ["node", "server.js"]`, sem `npm start`: o npm viraria PID 1, engoliria o
  SIGTERM e o encerramento ordenado nunca rodaria;
- `HEALTHCHECK` aponta para `/health` (liveness). O `/ready` é do orquestrador.

### O que foi verificado com a imagem construída (fase 12.4)

A imagem **foi construída e executada**. Contra um PostgreSQL real, em
`NODE_ENV=production`:

| Verificação | Resultado |
|---|---|
| Build completo (`npm ci`, `prisma generate`, cópias, usuário, HEALTHCHECK, CMD) | passou |
| Processo dentro do contêiner | uid 1000 (`node`), não root |
| `/health` | 200 |
| `/ready` | 200 com `database`, `storage` e `rls` verdadeiros |
| Login e ranking público | 200 |
| Partida sem configuração completa | **recusa** e lista o que falta |
| Partida com `JWT_SECRET` curto | **recusa** |
| Partida contra papel SUPERUSUÁRIO | **recusa**: o RLS não teria efeito |
| `HEALTHCHECK` da imagem | chega a `healthy`, código 0 |
| `docker stop` (SIGTERM) | encerramento ordenado, **código 0** em 69 ms |
| `prisma migrate deploy` a partir da imagem | 73 tabelas, 21 com FORCE RLS |
| CLI e client do Prisma na imagem | mesma versão (6.19.3) |

**Ressalva honesta:** o ambiente de verificação bloqueia todos os espelhos
Debian testados, então a camada `apt-get` **não** chegou a executar — o build
usou `--build-arg BASE_IMAGE=node:22-bookworm`, base que já traz os pacotes, e
a camada seguiu pelo ramo que a dispensa. O `apt-get` em si continua sem prova
de execução. Trate o primeiro build do deploy como parte do deploy.

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

## 7.9. Vulnerabilidades conhecidas das dependências

`npm audit` do backend fica em **zero**. Chegou a acusar três achados de
severidade alta, todos a mesma raiz: `deepmerge-ts` abaixo de 8.0.0
(exaustão de pilha ao mesclar grafo recursivo — [GHSA-ggr8-5vv4-36mx]),
alcançado por `prisma` → `@prisma/config`.

O que foi verificado antes de decidir:

* **Atualizar o Prisma não resolve.** A versão mais recente publicada
  (7.10.0) ainda fixa `deepmerge-ts@7.1.5`.
* **A única correção que o npm oferece é um *downgrade*** para `prisma@6.12.0`,
  marcado como semver-major. Voltar versão de ORM para calar um aviso é
  troca ruim.
* **`npm audit fix --force` está proibido neste projeto** — ele aplicaria
  exatamente esse downgrade sem que ninguém o tivesse decidido.

A correção adotada é um `overrides` no `package.json` fixando
`deepmerge-ts@^8.0.2`, e ela **foi exercitada**, não apenas declarada: com o
override aplicado, `npm ci` instala limpo, `prisma validate`, `prisma
generate`, `prisma migrate deploy` e `prisma migrate status` funcionam, e a
suíte inteira passa. Se um Prisma futuro passar a depender de `deepmerge-ts@8`
por conta própria, o override vira inócuo e pode ser removido — confira com
`npm ls deepmerge-ts`.

[GHSA-ggr8-5vv4-36mx]: https://github.com/advisories/GHSA-ggr8-5vv4-36mx

---

## 7.95. Prontidão de produção — o que foi medido

Implantação completa do zero, com a **imagem**, contra PostgreSQL real
(fase 12.8/12.9).

### Do banco vazio ao sistema no ar

| Etapa | Medido |
|---|---|
| Provisionar o banco | 132 ms |
| `prisma migrate deploy` **a partir da imagem** | 2 013 ms |
| `node prisma/seed.js` (catálogo oficial) | 442 ms |
| `provision-app-role.sql` | 60 ms |
| Primeiro administrador (`scripts/criar-admin.js`, da imagem) | 1 053 ms |
| Contêiner de pé até `/ready 200` | 845 ms |
| **Total, do nada ao pronto** | **4 545 ms** |

Em seguida, o teste de fumaça pelo caminho da federação — login, organização,
temporada, tabela de pontos, equipe, três atletas, evento, categoria/divisão/
classe, inscrições, resultado externo recebido e publicado, Overall declarado,
ranking recalculado — até o **ranking público lido sem token**: 20 verificações,
**nenhuma falha**, em **951 ms**. A campeã Overall saiu com `5 + 10 = 15`.

> Números de um host só, com base pequena. Servem para provar que o caminho
> funciona inteiro e que cada passo tem medida; **não** são promessa de
> desempenho em produção.

### Comportamento sob operação

| Verificação | Resultado |
|---|---|
| Reinício do contêiner | ranking **idêntico** antes e depois (mesmo SHA-256) |
| Banco cai **depois** da partida | `/health` segue **200**; `/ready` vai a **503** com `database:false`; o contêiner **não morre** |
| Banco volta | `/ready` volta a **200 sozinho**, com **zero** reinícios |
| Banco inalcançável **na partida** | o processo **não abre a porta** e sai com código 1 — ver abaixo |
| `docker stop` com requisições em voo | **nenhuma** requisição cortada no meio; saída com código **0** |
| Limitador de taxa | ativo: 8 tentativas de login e então `429` com `Retry-After` |

**Por que a partida falha rápido em vez de subir "não pronta":** a conferência
de RLS acontece antes do `listen`. Abrir a porta sem ter confirmado que o RLS
tem efeito nesta conexão seria aceitar servir dado restrito se o banco
respondesse depois com um papel errado. O orquestrador reinicia com backoff, e
a falha aparece no log com o motivo. Depois de no ar, a lógica se inverte — o
que se quer é continuar vivo e sair do balanceador, e é isso que `/ready` faz.

### Achados de prontidão registrados

**1. As ferramentas de backup NÃO estão na imagem da aplicação.**
`scripts/backup.sh` e `scripts/restore.sh` são copiados para a imagem (junto
com `criar-admin.js`, que roda de lá mesmo), mas `pg_dump`, `psql` e
`pg_restore` **não** estão — conferido dentro da imagem. É proposital: a
imagem serve a API, não administra o banco, e não deve carregar a credencial
`BYPASSRLS` do papel de backup.

O backup pertence a um **job separado** com o cliente do PostgreSQL instalado
(a imagem oficial `postgres:16` serve). Os dois scripts agora conferem as
ferramentas antes de qualquer coisa e param com a instrução, em vez de morrer
com `command not found` no meio da madrugada.

**2. O limitador de taxa é por processo.** O estado vive em memória, então com
N réplicas o teto efetivo vira N × o configurado. Já documentado no código e
no README; repetido aqui porque é decisão de topologia: com mais de uma
réplica, use o limitador da borda (ingress, WAF, CDN) ou um contador
compartilhado.

**3. O frontend não é servido por este processo.** `src/app.js` não serve
arquivo estático. O bundle do Vite vai para host estático ou CDN, e a origem
dele precisa estar em `CORS_ORIGINS`.

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
- [ ] Imagem construída **neste ambiente de deploy** — a camada `apt-get` só se
      prova com acesso aos repositórios Debian (§6)
- [ ] `npm audit` em zero, com o `overrides` de `deepmerge-ts` ainda necessário
      (§7.9) — conferir com `npm ls deepmerge-ts`
- [ ] TLS terminando antes da API; `trust proxy` já ligado em produção
- [ ] Papel de backup provisionado (`scripts/provision-backup-role.sql`) — sob `FORCE RLS` o dono do schema **não** consegue rodar `pg_dump`
- [ ] `scripts/backup.sh` agendado, com destino **fora do servidor do banco**
- [ ] **Backup do storage** configurado — versionamento/replicação do bucket, ou cópia do `STORAGE_DIR`. O dump do banco **não** protege arquivo algum
- [ ] Restauração ensaiada de ponta a ponta, com a conferência de [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) §7
- [ ] `RTO` e `RPO` medidos **no ambiente de produção** — os números do ensaio local não valem como promessa
- [ ] `FORCE ROW LEVEL SECURITY` confirmado nas 21 tabelas (§1.1)
- [ ] **`current_setting('is_superuser')` = `off` na conexão da aplicação (§1.2)** — superusuário anula o RLS inteiro
- [ ] [`HOMOLOGACAO-ESPORTIVA.md`](HOMOLOGACAO-ESPORTIVA.md) ratificado antes de apurar prova oficial
