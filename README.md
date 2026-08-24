# MCI Campeonatos

API backend para gerenciamento de campeonatos, participantes, partidas, resultados e classificação.

## Tecnologias

- Node.js 18+
- Express 5
- Prisma 6
- SQLite para desenvolvimento local
- Zod, Vitest e Supertest

## Instalação

```bash
npm install
copy .env.example .env
npm run prisma:generate
npm run prisma:migrate
```

O arquivo `.env` usa SQLite por padrão:

```env
DATABASE_URL="file:./dev.db"
PORT=3000
NODE_ENV=development
```

O banco fica em `prisma/dev.db` e não é versionado. A configuração usa `DATABASE_URL`; para PostgreSQL, altere o provider do datasource em `prisma/schema.prisma` para `postgresql`, use uma URL PostgreSQL e execute uma migration própria para esse banco.

## Execução e testes

```bash
npm start
npm run dev
npm test
```

`npm run dev` usa o watch nativo do Node. Os testes executam migrations e limpam somente `prisma/test.db`, mantendo o banco de desenvolvimento (`prisma/dev.db`) intacto.

## Estrutura

```text
src/
  app.js
  config/
  controllers/
  middlewares/
  repositories/
  routes/
  services/
  utils/
prisma/
  schema.prisma
  migrations/
tests/
```

As rotas não acessam Prisma diretamente: controllers chamam services, e services usam repositories.

## Endpoints principais

Todos os endpoints de negócio usam o prefixo `/api/v1`.

| Método | Endpoint | Finalidade |
| --- | --- | --- |
| GET | `/` | Health check textual existente |
| GET/POST | `/api/v1/campeonatos` | Listar ou criar campeonatos |
| GET/PUT/PATCH/DELETE | `/api/v1/campeonatos/:id` | Consultar, atualizar ou excluir campeonato |
| GET/POST | `/api/v1/participantes` | Listar ou criar participantes |
| GET/PUT/PATCH/DELETE | `/api/v1/participantes/:id` | Operações sobre participante |
| GET/POST | `/api/v1/equipes` | Listar ou criar equipes |
| GET/PUT/PATCH/DELETE | `/api/v1/equipes/:id` | Operações sobre equipe |
| GET/POST | `/api/v1/campeonatos/:id/participantes` | Consultar ou realizar inscrição |
| GET/POST | `/api/v1/partidas` | Listar ou criar partidas |
| GET/PUT/PATCH | `/api/v1/partidas/:id` | Consultar ou atualizar partida |
| GET/POST/PATCH | `/api/v1/partidas/:id/resultado` | Consultar, registrar ou atualizar resultado |
| GET | `/api/v1/campeonatos/:id/classificacao` | Consultar classificação |

Exemplo de criação:

```bash
curl -X POST http://localhost:3000/api/v1/campeonatos -H "Content-Type: application/json" -d "{\"name\":\"Copa MCI\",\"status\":\"ACTIVE\"}"
```

Respostas de erro seguem o formato:

```json
{"error":{"code":"RESOURCE_NOT_FOUND","message":"Campeonato não encontrado"}}
```

## Modelo de dados

- `Tournament`: campeonato e seu ciclo de vida.
- `Participant`: participante ou equipe, diferenciados por `type`.
- `Enrollment`: relação única entre campeonato e participante.
- `Match`: partida entre dois participantes inscritos.
- `Result`: placar e vencedor, com um resultado por partida.
- `Standing`: classificação materializada e recalculada após cada resultado.

## Regra atual de classificação

A classificação é recalculada a partir de todos os resultados do campeonato. Vitória vale 3 pontos, empate vale 1 ponto para cada participante e derrota vale 0. A ordenação usa, nesta ordem: pontos, vitórias, pontos marcados e menor pontuação sofrida. A regra está isolada em `standingService` para permitir ajustes futuros.

Erros de entrada retornam `400` com `error.code = VALIDATION_ERROR` e uma lista `error.details`. Recursos ausentes retornam `404`, duplicidades retornam `409` e violações semânticas retornam `422`.