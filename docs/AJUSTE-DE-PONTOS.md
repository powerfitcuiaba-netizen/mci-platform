# Ajuste administrativo de pontuação

> **PRODUÇÃO — AINDA NÃO ALTERADA.** As migrations desta fase não foram
> aplicadas na base da federação.

## O que o ajuste faz, e o que ele não faz

A homologação às vezes corrige a pontuação de uma participação **sem que a
colocação tenha mudado**. Já existia a correção de colocação
(`PATCH /ranking/points/:id`), que recalcula os pontos pelo motor — ferramenta
certa quando o erro está na colocação, inútil quando está no ponto.

`POST /ranking/points/:id/adjust` altera **um número**. Ele não mexe em:

colocação · categoria · classe · evento · temporada · atleta ·
`ExternalResult` · elegibilidade ao Super Overall

E **não declara, não revoga e não inventa Overall**. Medido: ajustar um 1º
lugar para 15 — que é o valor de um primeiro lugar *com* bônus — deixa
`overallBonus` em zero e `isOverallChampion` falso, e nenhum
`EventOverallTitle` nasce.

## A terceira parcela

O ledger sempre manteve o total reconstituível a partir das parcelas — é o que
o torna auditável. Escrever o novo total direto em `points` quebraria a conta e
apagaria a informação de que houve intervenção humana. O ajuste entra como
parcela:

```
points = placementPoints + overallBonus + adjustmentPoints
```

Zero enquanto ninguém ajusta. Explícito quando alguém ajusta. **E preservado
quando a colocação for corrigida depois**: o motor recalcula as duas primeiras
parcelas e conserva esta. Medido — 1º lugar (5) ajustado para 4, depois
corrigido para 2º lugar (4): resultado 4 + 0 + (−1) = **3**.

O total nunca fica negativo, e um não comparecimento não recebe ponto por
ajuste: NS vale zero pela regra homologada, e a resposta é
`422 ADJUST_ON_DID_NOT_SHOW` — "corrija a colocação, não a pontuação".

## Concorrência e duplo clique, no mesmo mecanismo

`expectedPoints` é obrigatório: é o total que o operador **tinha na tela**
quando decidiu. A conferência acontece **sob a trava da temporada**, não antes
dela — conferir fora da trava deixaria passar exatamente a corrida que o
parâmetro existe para pegar.

Se o lançamento mudou desde a leitura, a resposta é
`409 RANKING_POINT_STALE`:

> Os pontos foram alterados por outro operador. Atualize antes de editar novamente.

O duplo clique cai na mesma guarda: medido com dois envios simultâneos —
`200` e `409`, e **um** registro de ajuste.

## Auditoria

Duas trilhas, de propósito:

- `RankingPointAdjustment` — uma linha por intervenção, consultável pelo
  produto (`GET /ranking/points/:id/adjustments`), com `previousPoints`,
  `newPoints`, `reason`, autor e `voidedAt` para invalidar sem apagar.
- `AuditLog` com ação **`RANKING_POINTS_ADJUSTED`** — separada de
  `RANKING_POINT_EDITED` porque aquela é correção de colocação e esta é decisão
  de homologação; confundir as duas apagaria a diferença entre "o dado estava
  errado" e "a comissão decidiu".

O metadado leva `rankingPointId`, `athleteId`, `externalResultId`, `eventId`,
`seasonId`, `categoryId`, `catalogClassId`, `previousPoints`, `newPoints`,
`adjustment` e `reason`. **Não leva CPF, senha, token nem nome de pessoa** — há
teste que reprova se levar.

## Segurança

Autorização por `ranking.manage` **na organização da temporada**, que é a única
que o cliente não escolhe. Medido:

| tentativa | resposta |
|---|---|
| membro da organização sem `ranking.manage` | recusada |
| gerente de **outra** organização | `404` discreto — quem não pode ver não recebe confirmação de que existe |
| anônimo | recusada |
| corpo com `placing`, `categoryId`, `athleteId` de carona | `200`, e **nada disso muda** |

`RankingPointAdjustment` nasceu com RLS **forçada** e política de operador da
organização. **Não há política de DELETE** — ajuste se invalida, não se apaga;
ausência de política é negação, não esquecimento.

## Dois defeitos pré-existentes encontrados nesta fase

**1. `carregarLancamento` quebrava em todo lançamento sem atleta.**
`prisma.athlete.findUnique({ where: { id: null } })` não é uma consulta que
devolve nada: o Prisma a **recusa**, e a recusa subia como `500`. Na prática,
corrigir, invalidar ou restaurar qualquer resultado histórico importado antes
do cadastro era impossível — são exatamente as 191 linhas do Ipiranga.

**2. A tela do operador mostrava linha em branco para o histórico importado.**
`eventRankingPoints` não trazia `externalAthlete`, e o competidor sem cadastro
aparecia como "—". A classe também sumia, porque `competitionClass` é nula sem
evento do MCI. Ambos corrigidos; a classe agora cai no catálogo.

## Sobre os "pontos 0" observados

Não foi possível reproduzir. Medido no código como está: 191 resultados
importados produzem ranking com 5/4/3 e a categoria correta, e a temporada
**nasce com a tabela homologada** (`createSeason` grava
`TABELA_OFICIAL_COLOCACAO`), de modo que "temporada sem tabela de pontos" não
ocorre pelo caminho normal.

O guard foi implementado mesmo assim, para quem chegar por fora do caminho
normal — carga, script, restauração parcial: a prévia avisa
(`summary.seasonWithoutPointsTable`) e o `apply` recusa com
`422 SEASON_WITHOUT_POINTS_TABLE`, porque aplicar gravaria o campeonato inteiro
valendo zero com o resumo anunciando sucesso.

**O que falta para fechar essa questão é uma leitura da produção.**
`scripts/diagnostico-classe.sql` responde, somente lendo, quantos lançamentos
têm categoria, classe, atleta e pontos, e a distribuição por categoria e por
classe. É ele que diz se o que foi observado é dado ou apresentação.
