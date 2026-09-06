# FASE 0 — Auditoria do repositório

Executada em 2026-09-06 sobre `claude/mci-platform-muscle-contest-o6haz9`
(`a7d9a91`), antes de qualquer alteração.

## Ambiente verificado

| Item | Resultado |
| --- | --- |
| `git status` | árvore limpa |
| Branches | `main`, `claude/mci-platform-muscle-contest-o6haz9` |
| Node | v22.22.2 / npm 10.9.7 |
| Stack backend | Express 5 + Prisma 6 + SQLite + Zod + JWT |
| Stack frontend | React 19 + Vite + Vitest |
| Migrations | 6 aplicadas com sucesso |
| Suíte existente | 11 arquivos, 207 testes, **todos passando** (305 s) |
| Lint dedicado | não existe (CI usa `node --check` como verificação de sintaxe) |
| Typecheck | não existe (projeto em JavaScript, sem TypeScript) |
| Build backend | não aplicável (sem etapa de bundling) |
| Segredos versionados | nenhum encontrado |
| Mocks mascarando backend | nenhum — `vi.mock` aparece só em testes de frontend |
| `TODO` / `FIXME` | nenhum (CI já bloqueia) |
| PostgreSQL | **disponível** localmente (16.13); iniciado e usado nesta execução |
| Docker | indisponível (não foi necessário) |
| Supabase | apenas `VITE_SUPABASE_URL` no ambiente, sem chave — não utilizado |

## Classificação

### BLOCKER — camada financeira presente

O repositório continha um módulo financeiro completo, proibido pela regra
fundamental do escopo:

- modelos `Order`, `OrderItem`, `Payment`, `PaymentEvent`, `Coupon`,
  `CouponRedemption`, `Refund`;
- campos monetários `entryFeeCents`, `amountCents`, `subtotalCents`,
  `discountCents`, `totalCents`, `unitPriceCents`, `currency`;
- serviços `orderService`, `paymentService`, `couponService`, `refundService`,
  provider de pagamento e webhook de provedor;
- utilitários `money.js`, `pricing.js`, `financialStates.js`;
- variáveis `PAYMENT_PROVIDER`, `PAYMENT_WEBHOOK_SECRET`,
  `ALLOW_SANDBOX_PAYMENTS`, `ORDER_EXPIRATION_MINUTES`;
- suítes `fase5-financeiro` e `e2e-financeiro`.

Ação: remoção integral.

### RED — domínio modelado como head-to-head

`Match(participantA, participantB)`, `Result(scoreA, scoreB, winner)` e
`Standing(wins, losses, draws, scored, conceded)` modelam confronto direto —
expressamente vedado para fisiculturismo. Nenhuma noção de categoria, divisão,
classe, bateria, painel de juízes ou colocação existia.

Ação: substituição pelo domínio competitivo correto.

### RED — núcleos ausentes

Atleta com CPF como identidade central, filiação, pesagem, credenciamento,
ordem de palco, motor de julgamento, resultados versionados, ranking,
temporadas, Atletas PRO, importação MuscleWar, rede social, messenger,
comunidades, marcas, patrocinadores esportivos, multi-tenancy, RBAC granular
e RLS: nenhum existia.

### YELLOW — pontos a preservar e endurecer

- Autenticação JWT, hash de senha com bcrypt, validação de ambiente na
  partida, rate limit, CORS explícito, `helmet`: aproveitados.
- `AuditLog`, `Notification`, `Document` + storage local: aproveitados e
  estendidos.
- SQLite como datasource: trocado por PostgreSQL, exigência do próprio
  validador de produção do projeto e pré-requisito para RLS real.
- Suíte de testes lenta (305 s) por custo de bcrypt: reduzido o número de
  rounds em ambiente de teste.

### GREEN

Higiene do repositório: sem segredos, sem `.env` versionado, sem marcadores de
trabalho inacabado, CI já com verificação de sintaxe e de segredos.
