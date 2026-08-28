# MCI Campeonatos

Plataforma de gestão de campeonatos: eventos, participantes, equipes, inscrições, partidas, resultados e classificação, com os módulos operacionais de arbitragem, credenciamento, comunicação e relatórios.

O repositório contém a API em `src/` e a interface React/Vite em `frontend/`.

## Referências visuais

As referências oficiais ficam permanentemente em `design/referencias/` (48 imagens). Elas definem a linguagem MCI aplicada na interface: superfícies near-black, vermelho MCI para ação e seleção, azul para informação, estados semânticos, navegação lateral operacional, cards densos e composição mobile própria. Essas imagens não devem ser alteradas, movidas ou renomeadas.

## Tecnologias

- Node.js 22+ (o `jsdom` da suíte de interface exige `^22.22.2 || ^24.15.0`; validado em Node 24)
- Express 5
- Prisma 6 com PostgreSQL 16
- Zod para validação
- JWT (`jsonwebtoken`) e `bcryptjs`
- Vitest e Supertest
- React 19 + Vite no frontend

## Requisitos

- **Node.js 24.15 ou superior** — é o piso real, não uma preferência: o `jsdom`
  usado pela suíte de interface declara `engines: ^24.15.0`. O backend sozinho
  roda em 20, mas o repositório é construído e validado como um só, e a CI usa
  Node 24. O requisito está declarado em `frontend/package.json`, então o npm
  avisa antes de a suíte falhar com um erro obscuro de engine.
- npm
- **Docker** — o banco é PostgreSQL, e o `docker compose` é como você o sobe sem
  instalar nada no sistema. Um PostgreSQL 16 instalado localmente também serve;
  o que não serve mais é rodar sem banco algum.

## Dependências

### Versões declaradas, nunca `latest`

Toda dependência é declarada com faixa `^` sobre uma versão explícita. `latest`
não aparece em lugar nenhum: ele resolve para o que existir no dia da
instalação, e um major novo entraria sem ninguém pedir. Com `^`, uma correção de
segurança em patch continua chegando, mas a troca de major exige decisão humana.

O que garante build reproduzível é o par manifesto + lockfile, e a CI usa
`npm ci` — que instala exatamente o que o lockfile fixa e ignora as faixas.
`npm install` fica para quando se quer mudar dependência de propósito.

### O que vai para produção

`vite` e `@vitejs/plugin-react` são ferramenta de build: rodam para produzir o
bundle, não são enviados ao navegador. Ficam em `devDependencies`. Uma instalação
de produção (`npm ci --omit=dev`) do frontend baixa **4 pacotes** — `react`,
`react-dom`, `lucide-react` e a dependência interna do React — em vez dos 45 que
o empacotador arrastava junto quando estava classificado como dependência de
runtime.

### Vulnerabilidades conhecidas e por que não foram "corrigidas"

`npm audit` no backend reporta **4 severidade alta**, todas no mesmo ramo:

    prisma (CLI) → @prisma/config → deepmerge-ts
                                  → effect

O que o `npm audit fix --force` propõe é **rebaixar** o Prisma de 6.16.0 para
6.12.0. Isso não foi aplicado, por duas razões verificadas:

1. **Não alcançam o runtime.** `@prisma/client` — a biblioteca que a API usa —
   tem zero dependências e declara `prisma` apenas como peer *opcional*. Ao
   subir a aplicação, 372 módulos são carregados e nenhum deles é
   `@prisma/config`, `deepmerge-ts`, `effect` ou o próprio CLI. O ramo
   vulnerável só executa em `prisma generate` e `prisma migrate`, na máquina de
   quem constrói ou faz deploy — nunca ao atender uma requisição.
2. **O remédio é pior.** Rebaixar só o CLI deixaria cliente 6.16 e CLI 6.12
   divergentes; rebaixar os dois é mexer na camada de dados de uma plataforma
   recém-validada, para fechar um caminho que não está aberto.

A decisão certa é acompanhar o Prisma e subir quando 6.17+ trouxer o
`@prisma/config` corrigido. Registrado como pendência, não como correção.

**No frontend, `npm audit` reporta zero vulnerabilidades.**

## Instalação

Backend, a partir da raiz:

```bash
npm install
copy .env.example .env          # as credenciais já apontam para o compose
npm run db:up                   # sobe o PostgreSQL e cria mci e mci_test
npm run prisma:generate
npm run db:migrate              # aplica as migrations
```

Frontend:

```bash
cd frontend
copy .env.example .env
npm install
```

## Variáveis de ambiente

Raiz (`.env`):

| Variável | Finalidade | Padrão |
| --- | --- | --- |
| `DATABASE_URL` | Banco do Prisma (PostgreSQL) | `postgresql://mci:mci@localhost:5432/mci?schema=public` |
| `PORT` | Porta da API | `3000` |
| `NODE_ENV` | Ambiente de execução | `development` |
| `FRONTEND_URL` | Origem liberada no CORS | `http://localhost:5173` |
| `JWT_SECRET` | Segredo de assinatura do token | — (obrigatório em produção) |
| `CORS_ORIGINS` | Origens liberadas, separadas por vírgula | `http://localhost:5173` |
| `STORAGE_DRIVER` | Provedor de armazenamento | `local` |
| `STORAGE_DIR` | Raiz do armazenamento de arquivos | `uploads/` (fora do versionamento) |
| `UPLOAD_MAX_BYTES` | Teto de tamanho por arquivo | `10485760` (10 MB) |
| `PAYMENT_PROVIDER` | Provedor de pagamento | `sandbox` (desenvolvimento) |
| `PAYMENT_WEBHOOK_SECRET` | Segredo do HMAC do webhook | — (obrigatório em produção) |
| `ALLOW_SANDBOX_PAYMENTS` | Permite o provedor de desenvolvimento em produção | `false` |
| `ORDER_EXPIRATION_MINUTES` | Prazo para pagar antes de o pedido expirar | `60` |
| `RATE_LIMIT_ENABLED` | Liga o limitador de requisições | ligado só em produção |
| `LOG_LEVEL` | `silent`/`error`/`warn`/`info`/`debug` | por ambiente |

`frontend/.env`:

| Variável | Finalidade | Padrão |
| --- | --- | --- |
| `VITE_API_URL` | Endereço da API | `http://localhost:3000/api/v1` |

O `JWT_SECRET` tem um valor de desenvolvimento embutido como último recurso. Defina um segredo próprio antes de qualquer uso real.

## Execução local

O banco precisa estar de pé — `npm run db:up` deixa o PostgreSQL rodando em
segundo plano e só é necessário uma vez.

Em um terminal, a API:

```bash
npm start        # produção
npm run dev      # watch nativo do Node
```

Em outro, a interface:

```bash
cd frontend
npm run dev      # http://localhost:5173
```

## Banco e Prisma

O banco de desenvolvimento é o PostgreSQL que o `docker compose` sobe: dados no
volume `postgres-data`, nada no repositório. `npm run db:up` liga, e
`docker compose down` desliga sem apagar — para apagar de verdade é
`docker compose down -v`.

```bash
npx prisma validate        # valida o schema
npx prisma migrate status  # estado das migrations
npx prisma generate        # regenera o client
npx prisma migrate deploy  # aplica migrations pendentes
```

Migrations existentes não devem ser apagadas. `migrate deploy` aplica o que
falta e nunca cria nada — é o comando de produção e de CI. `migrate dev`, que
gera migration nova a partir do schema, é de desenvolvimento e pode recriar o
banco: não aponte para produção.

## Autenticação e perfis

Autenticação por JWT, com senha protegida por `bcryptjs`. O `passwordHash` nunca é retornado em nenhuma superfície.

- `POST /api/v1/auth/register` — cria usuário e devolve token.
- `POST /api/v1/auth/login` — autentica e devolve token.
- `GET /api/v1/auth/me` — usuário da sessão atual.

Perfis: `ADMIN`, `ORGANIZER`, `JUDGE`, `COACH`, `ATHLETE`, `PUBLIC`.

### Regras de posse

A autorização nunca usa identificador vindo do corpo da requisição. O ator é sempre `req.user`, carregado a partir do token.

- `ADMIN` tem override administrativo.
- `ORGANIZER` opera apenas os campeonatos que criou.
- `JUDGE` só lança ou edita resultado em campeonato onde possui `JudgeAssignment`.
- `COACH` administra apenas participantes cujo `coachId` é o seu. No cadastro o vínculo é imposto pelo servidor: um `coachId` enviado no corpo é ignorado.
- `ATHLETE` consulta a própria situação de inscrição e não opera a de terceiros.
- Leituras abertas (`/campeonatos`, `/participantes`, `/equipes`, `/partidas`) omitem identificadores de posse — `createdById`, `userId`, `coachId` — quando o chamador não está autenticado.
- A superfície pública `/public/*` é somente leitura e não expõe email, perfil, operador nem identificadores internos. Só aparece na vitrine quem tem inscrição confirmada: participante sem competição não é exposto, para que a área aberta não vire um índice do cadastro interno.
- `/dashboard/summary` devolve uma composição diferente por perfil. Quem decide o conteúdo é o servidor, a partir de `req.user.role`; a interface apenas escolhe a apresentação correspondente.

## Estado dos módulos

| Módulo | Estado | Observação |
| --- | --- | --- |
| Eventos / campeonatos | REAL | CRUD, filtros, detalhe, inscrições |
| Participantes e equipes | REAL | CRUD com posse por criador e por técnico |
| Inscrições | REAL | Cancelamento por transição de estado, com reinscrição |
| Partidas | REAL | Sem exclusão: cancelamento por status |
| Resultados | REAL | Validação, recálculo da classificação |
| Classificação | REAL | Materializada, recalculada a cada resultado |
| Judge Center | REAL | Agenda por designação, lançamento de resultado |
| Check-in | REAL | Estado derivado da inscrição, operador e horário |
| Coach Center | REAL | Elenco, competições, agenda, isolamento entre técnicos |
| Backstage | REAL | Consolidação com alertas operacionais |
| MCI TV | REAL | Superfície pública somente leitura |
| Notificações | REAL | Emissão em inscrição, check-in, partida e resultado |
| Relatórios | REAL | JSON consolidado e visualização |
| Dashboard | REAL | Composição própria por perfil: global, operação, arbitragem, elenco ou carreira |
| Organizer Center | REAL | Consolida os módulos de operação do organizador num ponto único |
| Vitrine pública | REAL | Competições, atletas e equipes acessíveis sem login |
| Pedidos e checkout | REAL | Valor calculado no servidor, cupom, idempotência, expiração |
| Pagamentos | REAL | Provedor abstraído, webhook assinado e idempotente. **Sem gateway real integrado** |
| Cupons | REAL | Percentual ou valor fixo, validade, limite total e por usuário |
| Reembolsos | REAL | Só sobre pedido pago, reverte inscrição e devolve o cupom |
| Patrocínios | REAL | Contrato por evento, separado do fluxo de inscrição |
| Documentos | REAL | Upload e download reais, com tipo, tamanho e nome validados |
| Athlete Center | REAL | Carreira do atleta, isolada por conta |
| Admin Center | REAL | Contas, retrato global e trilha de auditoria |
| Perfil | REAL | Edição dos próprios dados e troca segura de senha |
| Auditoria | REAL | Registro de ações administrativas, sem dado sensível |

## Endpoints

Prefixo `/api/v1`.

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| GET | `/` | Health check textual |
| POST | `/auth/register` · `/auth/login` | Criar conta · autenticar |
| GET | `/auth/me` | Usuário da sessão |
| GET | `/dashboard/summary` | Painel do perfil autenticado (composição distinta por papel) |
| GET/PATCH | `/profile` | Consultar ou editar os próprios dados |
| POST | `/profile/password` | Trocar a própria senha |
| GET | `/athlete/overview` | Carreira do atleta autenticado |
| GET | `/admin/overview` · `/admin/users` · `/admin/users/:id` | Administração global |
| PATCH | `/admin/users/:id` | Alterar perfil ou situação de uma conta |
| GET | `/audit` | Trilha de auditoria (somente ADMIN) |
| GET/POST | `/campeonatos` | Listar ou criar campeonatos |
| GET/PUT/PATCH/DELETE | `/campeonatos/:id` | Operações sobre campeonato |
| GET/POST | `/campeonatos/:id/participantes` | Consultar ou realizar inscrição |
| GET | `/campeonatos/:id/classificacao` | Consultar classificação |
| GET/POST | `/participantes` · `/equipes` | Listar ou criar |
| GET/PUT/PATCH/DELETE | `/participantes/:id` · `/equipes/:id` | Operações sobre o registro |
| GET/POST | `/partidas` | Listar ou criar partidas |
| GET/PUT/PATCH | `/partidas/:id` | Consultar ou atualizar partida |
| GET/POST/PATCH | `/partidas/:id/resultado` | Consultar, registrar ou atualizar resultado |
| GET | `/judge/matches` | Partidas dos campeonatos designados ao juiz |
| GET/POST | `/judge/assignments` | Consultar ou criar designação |
| GET | `/checkin/tournaments/:id` | Inscritos com situação de check-in |
| GET/POST | `/checkin/enrollments/:id` | Situação · registrar check-in |
| PATCH | `/checkin/enrollments/:id/cancel` | Cancelar check-in |
| PATCH | `/inscricoes/:id/cancel` | Cancelar inscrição (transição de estado) |
| GET | `/notifications` | Caixa do usuário com contador de não lidas |
| PATCH | `/notifications/:id/read` | Marcar como lida |
| POST | `/notifications/read-all` | Marcar todas como lidas |
| GET/POST | `/documents` | Listar ou registrar documento por metadados |
| POST | `/documents/upload` | Enviar documento com arquivo (multipart) |
| GET | `/documents/:id/download` | Baixar o arquivo do documento |
| GET/DELETE | `/documents/:id` | Consultar ou excluir documento |
| GET | `/coach/overview` · `/coach/teams` · `/coach/athletes` | Visão do técnico |
| PATCH | `/coach/participants/:id/team` | Mover atleta entre equipes do próprio elenco |
| GET | `/backstage/overview` | Operação consolidada com alertas |
| GET | `/reports/tournaments` · `/reports/tournaments/:id` | Índice e relatório do campeonato |
| GET/POST | `/orders` | Listar pedidos do escopo · criar pedido |
| GET | `/orders/:id` | Consultar pedido com itens, pagamentos e reembolsos |
| PATCH | `/orders/:id/cancel` | Cancelar pedido pendente |
| GET/POST | `/orders/:id/payments` | Histórico de tentativas · abrir cobrança |
| POST | `/orders/:id/refunds` | Reembolsar pedido pago (ADMIN ou dono do evento) |
| GET | `/refunds` | Reembolsos do escopo do usuário |
| GET/POST | `/coupons` | Listar ou criar cupom |
| PATCH | `/coupons/:id/active` | Ativar ou desativar cupom |
| POST | `/coupons/preview` | Calcular o desconto antes de fechar o pedido |
| GET/POST | `/sponsors` · `/sponsorships` | Patrocinadores e contratos por evento |
| POST | `/webhooks/payments/:provider` | Notificação do provedor — pública, protegida por assinatura |
| GET | `/public/summary` · `/public/tournaments` · `/public/tournaments/:id` · `/public/live` | MCI TV, sem autenticação |
| GET | `/public/athletes` · `/public/athletes/:id` | Vitrine pública de atletas |
| GET | `/public/teams` · `/public/teams/:id` | Vitrine pública de equipes |

Exemplo:

```bash
curl -X POST http://localhost:3000/api/v1/campeonatos -H "Content-Type: application/json" -H "Authorization: Bearer SEU_TOKEN" -d "{\"name\":\"Copa MCI\",\"status\":\"ACTIVE\"}"
```

Erros seguem o formato:

```json
{"error":{"code":"RESOURCE_NOT_FOUND","message":"Campeonato não encontrado"}}
```

Entradas inválidas retornam `400` com `error.code = VALIDATION_ERROR` e uma lista `error.details`. Falta de credencial retorna `401`, falta de permissão `403`, recurso ausente `404`, duplicidade `409` e violação semântica `422`.

## Modelo de dados

- `User`: conta de acesso e perfil.
- `Tournament`: campeonato e seu ciclo de vida; `createdById` define a posse.
- `Participant`: participante ou equipe (`type`). `coachId` vincula ao técnico, `teamId` compõe o elenco de uma equipe, `userId` liga a uma conta.
- `Enrollment`: relação única entre campeonato e participante. `status` (`CONFIRMED`/`CANCELLED`) permite baixa sem perder o histórico.
- `Match`: partida entre dois participantes inscritos.
- `Result`: placar e vencedor, um por partida.
- `Standing`: classificação materializada, recalculada após cada resultado.
- `JudgeAssignment`: designação que autoriza o juiz a operar o campeonato.
- `CheckIn`: presença por inscrição, com operador e horário. Sem registro, a inscrição é `PENDING`.
- `Notification`: caixa por usuário.
- `Document`: documento vinculado a um campeonato. `storageKey` aponta para o arquivo no armazenamento; quando ausente, o registro é apenas uma referência.
- `AuditLog`: trilha de ações administrativas, com ator, entidade e metadados sanitizados.

## Regra de classificação

Vitória vale 3 pontos, empate 1 para cada participante e derrota 0. A ordenação usa, nesta ordem: pontos, vitórias, pontos marcados e menor pontuação sofrida. A regra está isolada em `standingService` para permitir ajustes.

## Financeiro

### Dinheiro é inteiro

Todo valor monetário é um `Int` em centavos. Ponto flutuante não representa
0,10 + 0,20 exatamente, e erro de arredondamento em cobrança não é detalhe
estético: é diferença de caixa. `src/utils/money.js` recusa float, negativo e
valor acima do teto; percentual arredonda **para baixo**, de modo que o desconto
nunca supere o anunciado, e nunca ultrapassa o subtotal.

### O preço nunca vem do cliente

O corpo de `POST /orders` aceita **apenas** `tournamentId`, `participantId`,
`couponCode` e `idempotencyKey`. O schema é estrito e **não possui campo** para
`totalCents`, `subtotalCents`, `discountCents` ou `unitPriceCents` — tentar
enviá-los devolve `400` e nenhum pedido é criado. O valor sai de
`Tournament.entryFeeCents`, lido no servidor no momento do pedido.

A regra vale também para `POST /coupons/preview`, que só recebe `code` e
`tournamentId`: o subtotal sobre o qual o desconto incide é lido do campeonato,
pelo mesmo cálculo que o pedido usa (`src/utils/pricing.js`). Assim a prévia
mostra exatamente o que a cobrança vai fazer — e uma tela não consegue exibir
desconto que o servidor não honraria.

### Estados

Transições permitidas são declaradas em `src/utils/financialStates.js`. O que não
está no mapa é recusado com `422`.

| Entidade | Estados |
| --- | --- |
| Pedido | `PENDING` · `PAID` · `CANCELLED` · `EXPIRED` · `REFUNDED` |
| Pagamento | `PENDING` · `PROCESSING` · `AUTHORIZED` · `PAID` · `FAILED` · `CANCELLED` · `REFUNDED` |
| Reembolso | `PENDING` · `PROCESSING` · `COMPLETED` · `FAILED` |

Um pedido pendente não vira reembolsado sem passar por pago.

### Idempotência

Pedido e pagamento aceitam `Idempotency-Key` no cabeçalho (ou no corpo). A chave
é única no banco: reenviar a mesma intenção devolve o registro já criado em vez
de gerar um segundo. Chave usada por outro usuário devolve `409`.

### Webhook

`POST /api/v1/webhooks/payments/:provider` é público — quem chama é o provedor —
e se protege por três camadas:

1. **Assinatura** HMAC-SHA256 sobre o corpo cru, comparada em tempo constante.
   Assinatura ausente ou inválida devolve `401` e não altera nada.
2. **Idempotência** pela unicidade de `(provedor, id externo)` em `PaymentEvent`.
   A segunda entrega da mesma notificação é descartada sem reprocessar.
3. **Ordem**: estado terminal não é revisitado por notificação atrasada, e valor
   divergente do cobrado devolve `422` e registra `PAYMENT_AMOUNT_MISMATCH`.

### Cupons e concorrência

O consumo usa comparação-e-troca sobre o contador recém-lido: duas requisições
simultâneas disputam a mesma linha e apenas uma escreve, de modo que o limite não
é ultrapassado. Cancelar ou reembolsar um pedido devolve a unidade ao estoque.

### Provedor de pagamento

O domínio não importa gateway nenhum: fala com o contrato `PaymentProvider`
(`createCharge`, `refundCharge`, `verifySignature`, `parseWebhook`). Um gateway
real implementa esse contrato, registra-se e passa a ser selecionado por
`PAYMENT_PROVIDER`.

**O provedor incluído é de desenvolvimento.** Não move dinheiro, não fala com
banco algum e **se recusa a operar em produção** sem `ALLOW_SANDBOX_PAYMENTS=true`
assumido de propósito. Nenhum gateway real está integrado.

### Patrocínio

Receita de contrato entre evento e marca. Não passa por pedido, cupom ou
pagamento de inscrição — misturar os dois tornaria o relatório de vendas
indefensável. Aparece separado em `financeiro.receitaPatrocinioCents`.

## Armazenamento de arquivos

Documentos com arquivo são gravados em `uploads/` (ou no caminho de `STORAGE_DIR`), fora do versionamento. Nada vindo do cliente compõe o caminho em disco: a chave é gerada pelo servidor a partir do campeonato e de um UUID, e o caminho resolvido é conferido contra a raiz antes de qualquer operação. O nome original é guardado apenas como metadado, para exibição e para o cabeçalho de download.

O envio é `multipart/form-data`, lido por `busboy` com teto de tamanho aplicado pelo próprio parser. A autorização é resolvida antes da gravação, de modo que uma requisição negada não deixa resíduo em disco. Tipos aceitos: PDF, PNG, JPEG, WebP, texto e CSV.

O download exige o mesmo direito de leitura do registro e passa pelo servidor — não há URL pública para o arquivo.

## Produção

### Configuração validada na partida

`src/config/environment.js` centraliza a configuração e é verificada antes de a porta abrir. Em produção o processo **se recusa a subir** se encontrar:

- `JWT_SECRET` ausente, com menos de 32 caracteres ou ainda no valor de desenvolvimento;
- `DATABASE_URL` ausente ou apontando para SQLite;
- CORS sem origem explícita, ou com curinga;
- provedor de pagamento de desenvolvimento sem `ALLOW_SANDBOX_PAYMENTS=true` assumido de propósito;
- `PAYMENT_WEBHOOK_SECRET` ainda no valor de exemplo.

Falhar no deploy é preferível a servir tráfego real com segredo que qualquer um adivinha.

### O banco é PostgreSQL, em todos os ambientes

Desenvolvimento, teste e produção usam o mesmo motor. Isso não é preciosismo: a
diferença mais cara de descobrir é a que só aparece em produção, e SQLite e
PostgreSQL divergem justamente onde dói — sensibilidade a maiúsculas no `LIKE`,
tipos de data, comportamento sob concorrência.

O `docker compose up -d postgres` sobe um PostgreSQL 16 local com as credenciais
que o `.env.example` já traz, e cria também o banco `mci_test` para que a suíte
não escreva no banco de desenvolvimento.

As seis migrations SQLite da fase anterior **não foram apagadas**: estão em
`prisma/legado-sqlite/migrations/`, como registro. Elas não rodam em PostgreSQL,
e o dialeto de uma não se converte na outra por edição — a linha de migração do
PostgreSQL foi gerada do mesmo schema, num arquivo só, e é a que vale daqui em
diante. Se você não precisa do histórico, pode remover a pasta.

### Health e prontidão

| Rota | Responde |
| --- | --- |
| `GET /health` | O processo está vivo. Não toca em dependência — um orquestrador não deve reiniciar o contêiner por lentidão do banco. |
| `GET /ready` | Banco, armazenamento e configuração respondem. É esta sonda que decide se a instância recebe tráfego. |

Nenhuma das duas devolve segredo, URL de banco ou caminho de disco: informam o **tipo** da dependência e o estado, nunca o endereço.

### Segurança

- **Helmet** e `x-powered-by` desligado.
- **CORS** por lista explícita de origens; sem curinga em produção.
- **Rate limiting** em memória, ligado por padrão em produção: 10 tentativas por 15 min em login, registro e troca de senha; 30/min em upload; 120/min no webhook; 180/min na superfície pública; teto global de 600/min.
- **Erros** nunca devolvem stack trace ao cliente; o rastro vai para o log estruturado.
- **Logs** em JSON com redação obrigatória de senha, token, segredo, CVV e número de cartão, em qualquer profundidade.
- **Encerramento ordenado**: `SIGTERM`/`SIGINT` param de aceitar conexões, deixam as em curso terminarem e fecham o banco.

**Limitação assumida:** o limitador guarda estado no processo. Com mais de uma instância, cada uma conta as próprias tentativas — a proteção real nesse cenário exige contador compartilhado (Redis) ou o limitador da borda (CDN/proxy).

### Armazenamento

`storageService` é uma fachada sobre um contrato `StorageProvider`. Hoje só o provedor `local` está registrado; um provedor de nuvem implementa a mesma superfície (`saveBuffer`, `saveStream`, `createReadStream`, `exists`, `remove`, `stat`, `healthCheck`), registra-se com `storageService.registerProvider` e passa a ser selecionável por `STORAGE_DRIVER` — sem que nenhum service de negócio mude.

### Backup

**Não existe backup automático configurado neste repositório.** O que está documentado é a estratégia a executar na infraestrutura escolhida:

- **Banco** — `pg_dump` diário com retenção de 30 dias e um teste de restauração mensal. Backup que nunca foi restaurado não é backup, é esperança.
- **Storage** — replicação do bucket ou sincronização diária do diretório, com versionamento de objeto ligado.
- **Segredos** — guardados no cofre do provedor, nunca em backup de banco ou de código.

### CI

`.github/workflows/ci.yml` roda em todo push e PR: instala, valida o schema, gera o client, confere a sintaxe de todo `src/`, aplica migrations, executa a suíte do backend, testa e builda o frontend, e confere higiene do repositório (nenhum segredo real, nenhum `.env`, nenhum `console.log`/`TODO` esquecido).

**A pipeline não faz deploy.** Publicação é decisão manual.

### Deploy

A plataforma inteira cabe numa imagem: o `Dockerfile` constrói a interface,
instala a API e serve as duas na mesma origem, o que dispensa CORS em produção
e reduz o deploy a um container mais um banco.

```bash
docker compose up --build        # plataforma completa em http://localhost:3000
docker compose up -d postgres    # só o banco, para desenvolver com o Vite
```

O que a imagem assume:

- **Migrations no arranque.** O comando é `prisma migrate deploy && node server.js`.
  `deploy` só aplica o que falta e nunca gera migration nova, então é seguro
  rodar a cada partida, inclusive com várias réplicas subindo ao mesmo tempo.
- **Documentos num volume.** `/app/uploads` é ponto de montagem. Sem volume, tudo
  o que foi anexado desaparece no próximo deploy — a imagem é descartável.
- **Nunca como root.** O processo roda como o usuário `node`.
- **`tini` como PID 1**, para que o `SIGTERM` do `docker stop` chegue ao Node e o
  encerramento ordenado que o `server.js` implementa realmente aconteça.
- **`HEALTHCHECK` em `/health`**, que responde sem tocar no banco. Prontidão para
  receber tráfego é outra pergunta, e quem responde é `/ready`.

Nada aqui publica automaticamente, altera DNS ou usa credencial real. Antes de
um deploy de verdade:

1. Definir as variáveis do `.env.example` no cofre do provedor — o
   `docker-compose.yml` traz valores de desenvolvimento e é versionado, então
   **não** serve como fonte de segredo.
2. Apontar `DATABASE_URL` para o PostgreSQL gerenciado do provedor.
3. Subir com `NODE_ENV=production` — a validação de partida barra configuração
   incompleta, e o servidor se recusa a subir em vez de servir inseguro.
4. Apontar as sondas do orquestrador para `/health` (liveness) e `/ready`
   (readiness).

## Testes

Backend, a partir da raiz:

```bash
npm test
```

O escopo é declarado em `vitest.config.mjs` (`tests/**/*.test.mjs`), com execução serial e banco próprio (`prisma/test.db`). O banco de desenvolvimento não é tocado. Diretórios de ferramentas do ambiente (`.agents/`, `.claude/`) são explicitamente excluídos da coleta.

São 11 suítes, 207 casos:

| Suíte | Casos | Cobre |
| --- | --- | --- |
| `api.test.mjs` | 5 | núcleo do domínio |
| `auth.test.mjs` | 3 | autenticação e controle de acesso |
| `fase3.test.mjs` | 1 | fumaça dos módulos operacionais |
| `fase3-operacional.test.mjs` | 32 | módulos operacionais em profundidade |
| `fase4-operacional.test.mjs` | 29 | Athlete Center, Admin Center, perfil, documentos |
| `fase4-fechamento.test.mjs` | 16 | vitrine pública, Organizer Center, painéis por perfil |
| `fase5-financeiro.test.mjs` | 37 | pedido, cupom, pagamento, webhook, reembolso, patrocínio |
| `fase6-producao.test.mjs` | 25 | configuração, health, rate limiting, log, storage |
| `seguranca.test.mjs` | 20 | matriz de acesso cruzado entre perfis |
| `e2e-fluxo-operacional.test.mjs` | 20 | ciclo esportivo completo, banco real, sem mocks |
| `e2e-financeiro.test.mjs` | 19 | ciclo financeiro completo, banco real, sem mocks |

Frontend:

```bash
cd frontend
npm test -- --run
```

## Build

```bash
cd frontend
npm run build     # gera dist/
npm run preview   # serve o build
```

## Estrutura

```text
src/
  app.js              Express, CORS, Helmet, rotas, 404, error handler
  config/prisma.js    Instância única do Prisma Client
  routes/             Definição de rotas, middlewares de auth e validação
  controllers/        Adaptam requisição/resposta, sem regra de negócio
  services/           Regra de negócio, autorização e posse
  repositories/       Único ponto de acesso ao Prisma
  middlewares/        auth, validate, errorHandler
  utils/              schemas, auth, roles, errors, visibility, ownership,
                      money, pricing, financialStates, logger, asyncHandler
prisma/
  schema.prisma
  migrations/
tests/
frontend/
  src/
    App.jsx           Shell, rotas por hash e telas
    AuthContext.jsx   Sessão, login, registro, logout
    services/api.js   Cliente único da API, token e header Authorization
    styles.css        Design System MCI
design/referencias/   Referências visuais oficiais
```

O fluxo é `routes → controllers → services → repositories → Prisma`. Rotas não contêm regra de negócio e controllers não acessam o Prisma quando existe service.

## Limitações conhecidas

- **Nenhum gateway de pagamento real está integrado.** O provedor incluído é de
  desenvolvimento e não opera em produção. Ligar um gateway exige implementar o
  contrato `PaymentProvider` e configurar credenciais.
- **Armazenamento é local.** Os arquivos ficam no disco da aplicação. A migração para storage externo (com abstração `StorageProvider`) está prevista para a fase de infraestrutura.
- **Não há antivírus nem inspeção de conteúdo no upload.** A validação é de tipo declarado, tamanho e nome; o conteúdo em si não é analisado.
- **Partidas não podem ser excluídas.** O encerramento acontece por status (`CANCELLED`), não por exclusão.
- **Não há transferência de posse de campeonato.** Um evento criado por um `ADMIN` permanece com ele; não existe endpoint para passar a posse a um `ORGANIZER`.
- **A migração para PostgreSQL foi validada na CI, não em produção.** As 207 suítes rodam contra um PostgreSQL 16 real a cada push, e a imagem Docker sobe e responde às sondas no mesmo pipeline. Nenhum deploy em servidor real foi executado a partir deste repositório.
