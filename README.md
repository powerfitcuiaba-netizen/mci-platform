# MCI Campeonatos

Plataforma de gestão de campeonatos: eventos, participantes, equipes, inscrições, partidas, resultados e classificação, com os módulos operacionais de arbitragem, credenciamento, comunicação e relatórios.

O repositório contém a API em `src/` e a interface React/Vite em `frontend/`.

## Referências visuais

As referências oficiais ficam permanentemente em `design/referencias/` (48 imagens). Elas definem a linguagem MCI aplicada na interface: superfícies near-black, vermelho MCI para ação e seleção, azul para informação, estados semânticos, navegação lateral operacional, cards densos e composição mobile própria. Essas imagens não devem ser alteradas, movidas ou renomeadas.

## Tecnologias

- Node.js 18+ (validado em Node 24)
- Express 5
- Prisma 6 com SQLite
- Zod para validação
- JWT (`jsonwebtoken`) e `bcryptjs`
- Vitest e Supertest
- React 19 + Vite no frontend

## Requisitos

- Node.js 18 ou superior
- npm

## Instalação

Backend, a partir da raiz:

```bash
npm install
copy .env.example .env
npm run prisma:generate
npm run prisma:migrate
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
| `DATABASE_URL` | Banco do Prisma | `file:./dev.db` |
| `PORT` | Porta da API | `3000` |
| `NODE_ENV` | Ambiente de execução | `development` |
| `FRONTEND_URL` | Origem liberada no CORS | `http://localhost:5173` |
| `JWT_SECRET` | Segredo de assinatura do token | — (obrigatório em produção) |

`frontend/.env`:

| Variável | Finalidade | Padrão |
| --- | --- | --- |
| `VITE_API_URL` | Endereço da API | `http://localhost:3000/api/v1` |

O `JWT_SECRET` tem um valor de desenvolvimento embutido como último recurso. Defina um segredo próprio antes de qualquer uso real.

## Execução local

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

O banco de desenvolvimento fica em `prisma/dev.db` e não é versionado.

```bash
npx prisma validate        # valida o schema
npx prisma migrate status  # estado das migrations
npx prisma generate        # regenera o client
npx prisma migrate deploy  # aplica migrations pendentes
```

Migrations existentes não devem ser apagadas. Para PostgreSQL, altere o `provider` do datasource em `prisma/schema.prisma`, use uma `DATABASE_URL` PostgreSQL e gere uma migration própria para esse banco.

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
- A superfície pública `/public/*` é somente leitura e não expõe email, perfil, operador nem identificadores internos.

## Estado dos módulos

| Módulo | Estado | Observação |
| --- | --- | --- |
| Eventos / campeonatos | REAL | CRUD, filtros, detalhe, inscrições |
| Participantes e equipes | REAL | CRUD com posse por criador e por técnico |
| Inscrições | REAL | Sem cancelamento: ver limitações |
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
| Dashboard | REAL | Indicadores do escopo do usuário |
| Documentos | **PARCIAL** | Metadados, permissão e validação. **Armazenamento binário ainda não implementado**: não há upload nem download de arquivo. |

## Endpoints

Prefixo `/api/v1`.

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| GET | `/` | Health check textual |
| POST | `/auth/register` · `/auth/login` | Criar conta · autenticar |
| GET | `/auth/me` | Usuário da sessão |
| GET | `/dashboard/summary` | Indicadores operacionais do usuário |
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
| GET | `/notifications` | Caixa do usuário com contador de não lidas |
| PATCH | `/notifications/:id/read` | Marcar como lida |
| POST | `/notifications/read-all` | Marcar todas como lidas |
| GET/POST | `/documents` | Listar ou registrar documento |
| GET/DELETE | `/documents/:id` | Consultar ou excluir documento |
| GET | `/coach/overview` · `/coach/teams` · `/coach/athletes` | Visão do técnico |
| PATCH | `/coach/participants/:id/team` | Mover atleta entre equipes do próprio elenco |
| GET | `/backstage/overview` | Operação consolidada com alertas |
| GET | `/reports/tournaments` · `/reports/tournaments/:id` | Índice e relatório do campeonato |
| GET | `/public/summary` · `/public/tournaments` · `/public/tournaments/:id` · `/public/live` | MCI TV, sem autenticação |

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
- `Enrollment`: relação única entre campeonato e participante.
- `Match`: partida entre dois participantes inscritos.
- `Result`: placar e vencedor, um por partida.
- `Standing`: classificação materializada, recalculada após cada resultado.
- `JudgeAssignment`: designação que autoriza o juiz a operar o campeonato.
- `CheckIn`: presença por inscrição, com operador e horário. Sem registro, a inscrição é `PENDING`.
- `Notification`: caixa por usuário.
- `Document`: documento vinculado a um campeonato (somente metadados).

## Regra de classificação

Vitória vale 3 pontos, empate 1 para cada participante e derrota 0. A ordenação usa, nesta ordem: pontos, vitórias, pontos marcados e menor pontuação sofrida. A regra está isolada em `standingService` para permitir ajustes.

## Testes

Backend, a partir da raiz:

```bash
npm test
```

O escopo é declarado em `vitest.config.mjs` (`tests/**/*.test.mjs`), com execução serial e banco próprio (`prisma/test.db`). O banco de desenvolvimento não é tocado. Diretórios de ferramentas do ambiente (`.agents/`, `.claude/`) são explicitamente excluídos da coleta.

Suítes:

- `tests/api.test.mjs` — núcleo do domínio
- `tests/auth.test.mjs` — autenticação e controle de acesso
- `tests/fase3.test.mjs` — fumaça dos módulos operacionais
- `tests/fase3-operacional.test.mjs` — módulos operacionais em profundidade
- `tests/seguranca.test.mjs` — matriz de acesso cruzado entre perfis
- `tests/e2e-fluxo-operacional.test.mjs` — ciclo completo contra banco real, sem mocks

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
  utils/              schemas, auth, roles, errors, visibility, asyncHandler
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

- **Documentos não armazenam arquivo.** O módulo registra metadados (título, nome do arquivo, tipo, campeonato) com permissão e validação, incluindo bloqueio de travessia de diretório. Upload e download binário ficam para uma fase de armazenamento/infraestrutura.
- **Inscrições não podem ser canceladas pela API.** Existe criação e consulta; a remoção de inscrição não está implementada.
- **Partidas não podem ser excluídas.** O encerramento acontece por status (`CANCELLED`), não por exclusão.
- **Não há transferência de posse de campeonato.** Um evento criado por um `ADMIN` permanece com ele; não existe endpoint para passar a posse a um `ORGANIZER`.
- **SQLite em desenvolvimento.** Adequado para uso local; produção exige migração para um banco servidor.
