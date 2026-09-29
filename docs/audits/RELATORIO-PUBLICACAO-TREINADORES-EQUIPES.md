# Relatório final de publicação — módulo Treinadores & Equipes

Merge `--no-ff` de `bff11b4` para `main`, autorizado expressamente pelo responsável,
executado em 29/09/2026. Este documento é o relatório obrigatório da FASE 5 da
autorização. Cada número aqui foi **lido de uma saída real** — log de workflow, corpo
de resposta HTTP ou objeto do Git. Onde não houve medição, está escrito NÃO OBSERVADO,
e não PASS.

---

## 1. Identificação da publicação

| Campo | Valor |
|---|---|
| SHA de origem (ponta da branch) | `bff11b4e0114d8d428c9b88f3d40d3d0751bb80b` |
| Branch de origem | `claude/mci-platform-muscle-contest-o6haz9` |
| SHA de `main` antes do merge | `4770aad9c9a2a3668106977204c16f10ae1ac35d` |
| SHA do merge | `42a07853da1bf96755a7cc63127a268c98c32dd1` |
| Branch de destino | `main` |
| Pais do merge | `4770aad` + `bff11b4` — os dois preservados |
| Árvore resultante | `bc7b5a1cb2840f747c458bdc311081a0c7f5394d` |
| Árvore de `bff11b4` | `bc7b5a1cb2840f747c458bdc311081a0c7f5394d` — **idêntica** |
| Commits promovidos | 58 |
| Data do commit de merge | 2026-09-29T18:51:59+00:00 |
| Push para `main` | 2026-09-29T18:52:26 UTC |

A igualdade das duas árvores é a prova de que o merge não alterou um byte do que foi
testado: o que a CI 358 aprovou em `bff11b4` é exatamente o que entrou em `main`.
Sem squash, sem rebase, sem force push — histórico preservado.

---

## 2. O deploy no Render — medido de fora

Não tenho acesso ao painel nem à API do Render, e o proxy deste contêiner recusa
`*.onrender.com`. Toda a verificação foi feita por um runner do GitHub, pelo workflow
`sonda-producao.yml`, contra `https://mci-platform-api.onrender.com`. O que segue não
é inferência sobre o painel: é aritmética e comparação sobre respostas HTTP.

### 2.1 O processo reiniciou — e quando

`GET /health` às **19:02:16 UTC** devolveu:

```
{"status":"ok","env":"production","uptimeSeconds":497}
```

`uptimeSeconds` é `process.uptime()`. 19:02:16 − 497 s = **18:53:59 UTC**. A versão que
está servindo subiu **93 segundos depois do push**. PASS.

### 2.2 O código no ar é o novo

Duas sondas, mesma rota, resultados diferentes:

| Sonda | Horário | `GET /ranking/coaches` |
|---|---|---|
| 16 | 18:53:05–18:53:30 UTC | `404 ROUTE_NOT_FOUND` |
| 17 | 19:02:12–19:02:30 UTC | `409 COACH_RANKING_NOT_HOMOLOGATED` |

A versão anterior de `main` não tinha o módulo Treinadores: nenhuma rota `coaches/*`
existia, e o 404 da sonda 16 é literalmente o que o código velho responde. A sonda 16
reprovou por **tempo**, não por defeito — ela correu 35 segundos depois do push, e o
processo novo só subiu aos 93 segundos. A troca de resposta **é** a troca de versão.
PASS.

### 2.3 As dez migrations pendentes foram aplicadas

Produção estava em 37 migrations no diagnóstico D1; a branch traz 47. As dez pendentes,
em ordem:

```
20260925070000_f1_f3_autorizacao_coerente
20260925230000_t4_with_check_coerente
20260926020000_modulo_treinadores_equipes
20260926040000_treinador_como_ator_de_rls
20260927010000_vinculo_exige_pedido_pendente
20260927020000_leitura_de_atleta_pelo_treinador
20260927030000_status_legado_de_treinador
20260927040000_aprovacao_automatica_de_treinador
20260928010000_autorizacao_automatica_na_npc
20260928020000_foto_obrigatoria_do_treinador
```

A prova é indireta, e é conclusiva. `GET /media/coaches/:id/photo` executa
`SELECT "photoKey" FROM "Coach" WHERE id = $1`. A coluna `Coach.photoKey` nasce na
migration **`20260928020000`**, a última das dez. Coluna inexistente levanta um erro que
`src/middlewares/errorHandler.js` **não** mapeia — o mapa só traduz `P2002` para 409 e
`P2025` para 404 — e a resposta sairia **500**. A sonda 17 mediu **HTTP 404**, com zero
ocorrências de `coach-photos/` no corpo.

E como `prisma migrate deploy` aplica em ordem lexicográfica e **aborta na primeira
falha**, a última ter sido aplicada implica que as nove anteriores também foram. PASS.

### 2.4 Banco, armazenamento e RLS

`GET /ready` às 19:02:17 UTC:

```
{"ready":true,"checks":{"database":true,"storage":true,"rls":true},
 "databaseKind":"postgresql","storageDriver":"s3"}
```

O terceiro cheque não é decorativo: `src/config/rlsGuard.js` reprova se a conexão for
superusuário, se o papel tiver ou puder assumir `BYPASSRLS`, ou se existir qualquer
tabela com RLS habilitado **sem** FORCE. Os três vieram limpos. PASS.

### 2.5 A interface

```
https://mci-platform-web.onrender.com → HTTP 200
título: MCI Platform — Campeonato Brasileiro Muscle Contest
```

O job confere o **título**, e não só o código, porque uma SPA devolve 200 em qualquer
caminho. PASS.

---

## 3. CI na `main` — execução 359

SHA `42a0785`. A mesma bateria que aprovou `bff11b4` na execução 358, agora sobre o
commit de merge.

| Job | Estado | Duração |
|---|---|---|
| Higiene do repositório | `success` | 7 s |
| Frontend — testes e build | `success` | 1 min 13 s |
| Backend — migrations, RLS e testes | **ainda em execução** quando este documento foi escrito | — |

O job de higiene confere, e aprovou: nenhum segredo real versionado, nenhum `.env`
versionado, nenhum marcador de trabalho inacabado, **nenhum módulo financeiro no
repositório**.

O job de backend já passou por 17 dos seus passos antes de entrar nos testes: schema do
Prisma validado, ESLint limpo, inspeção de segredos limpa, migrations aplicadas,
**nenhuma migration pendente**, e os papéis de RLS e de backup provisionados. O que
falta é o passo 18, a regressão completa — que na execução 358 levou 21 min 23 s — e os
oito passos que conferem que nenhuma suíte foi pulada.

**Este documento será atualizado com o resultado final da execução 359.** Até lá, o
estado do job de backend é NÃO CONCLUÍDO — e não PASS.

A CI é gate de repositório, não de produção: ela roda depois do push, em paralelo com o
deploy do Render, e não tem poder de barrar a promoção da versão. Quem barra é o
`preDeployCommand`. Por isso o pré-voo em `bff11b4` foi feito **antes** do merge, com a
CI 358 já verde — e é dela que vem a garantia de que este código passa.

---

## 4. Sonda de produção — execução 17

Sete jobs, todos `success`. Placar do §18, copiado do log:

| Sonda | Esperado | Obtido | |
|---|---|---|---|
| `GET /events` | 200, lista não vazia | 200, 47 itens | PASS |
| `GET /ranking/super-overall` | 200, JSON válido | 200, 5 linhas | PASS |
| `GET /athletes` sem token | 401 | 401 | PASS |
| `GET /athletes/:id` sem token | 401 (não 404) | 401 | PASS |
| `GET /search` × 3 termos | 200 e zero CPF | 200 e zero CPF | PASS |
| `GET /ranking/coaches` | 409 COACH_RANKING_NOT_HOMOLOGATED | igual | PASS |
| `GET /media/coaches/:id/photo` com id inexistente | 404 e zero chave | igual | PASS |
| 6 leituras de treinador sem token | 401 em todas | 401 em todas | PASS |
| 7 rotas financeiras | 404 | 404 | PASS |
| Escrita em produção | nenhuma | nenhuma | PASS |

As seis leituras do módulo, uma a uma, todas 401 sem token:
`coaches/me`, `coaches/me/teams`, `coaches/me/athletes`,
`coaches/review?status=PENDING`, `coaches/authorizable`,
`coaches/ranking/divergences`.

As sete rotas financeiras, uma a uma, todas 404:
`payments`, `checkout`, `billing`, `invoices`, `subscriptions`, `wallet`, `orders`.

A sonda faz **apenas GET**. Nenhum POST, PUT, PATCH ou DELETE — e isso não é promessa:
`tests/sonda-producao-coerente.test.mjs` reprova o repositório se um método de escrita
aparecer no workflow. Ele já me pegou uma vez, no commit `bff11b4`.

---

## 5. O que NÃO mudou, e foi conferido

| Invariante | Como foi medido | Resultado |
|---|---|---|
| Acervo de campeonatos | `GET /events` | 47, o mesmo de antes |
| Super Overall | `GET /ranking/super-overall` | 5 linhas, o mesmo teto |
| Entidade de filiação oficial | vitrine pública | 1 entidade, code `NPC`, kind `ENTITY` |
| CPF fora da busca pública | `GET /search` × 3 termos | zero ocorrências |
| Fórmula do ranking de treinadores | `GET /ranking/coaches` | **409, recusada** |
| Camada financeira | 7 rotas | 404 em todas |
| RLS e FORCE RLS | `/ready` → `rls: true` | nenhuma tabela sem FORCE |

**§8.3 continua bloqueado.** `FORMULA_HOMOLOGADA` permanece falso e a classificação de
treinadores recusa com `409 COACH_RANKING_NOT_HOMOLOGATED`. Nenhum ponto oficial foi
inventado, nenhuma regra esportiva foi alterada, nenhuma tabela de pontuação foi tocada.

Nenhum dado histórico foi alterado, apagado, recalculado ou corrigido. O cadastro e o
vínculo de Lucas Gouveia Lima não foram tocados. Nenhum treinador foi aprovado
manualmente. Nenhum `DROP`, `TRUNCATE` ou exclusão de storage foi executado — as dez
migrations contêm 0 `DROP TABLE`, 0 `TRUNCATE`, 0 `DELETE FROM` e 0 `DROP COLUMN`,
conferido antes do merge.

O auto-deploy do Render permaneceu **ligado** o tempo todo, como determinado.

---

## 6. Ressalvas — o que NÃO foi observado

Estas linhas existem porque a alternativa seria afirmar o que não medi.

1. **O log de build do Render: NÃO OBSERVADO.** Não tenho acesso ao painel nem à API do
   Render. Sei que uma versão nova subiu às 18:53:59 UTC e que ela serve o código novo
   com as migrations aplicadas; não vi o log do build.

2. **A saída do `preDeployCommand`: NÃO OBSERVADA.** O comando é
   `npx prisma migrate deploy && node scripts/provisionar-contas-de-servico.js`. A
   primeira metade está provada pela §2.3. A segunda não tem superfície pública que a
   exponha. O pré-voo mediu `orgs_sem_conta_servico = 0` — o script não tinha trabalho a
   fazer —, mas isso é contexto, não medição do resultado dele.

3. **A integridade do backup: NÃO REPORTADA A MIM.** O responsável atestou ter feito o
   dump do banco e baixado os 7 objetos do storage. Não recebi o resultado de uma
   restauração de teste, e portanto este documento **não** afirma que o backup é
   restaurável.

4. **A homologação esportiva da fórmula do ranking de treinadores continua PENDENTE** de
   aprovação formal da MuscleContest. Isso não é uma falha da publicação: é o estado
   correto, e o gate no código o mantém.

---

## 7. Veredito

**GO COM RESSALVAS.**

A publicação foi concluída e verificada de fora: o código novo está servindo, as dez
migrations foram aplicadas, o banco, o armazenamento e o RLS respondem, e as dez
conferências do smoke test de produção passaram — incluindo as quatro que existem para
provar que nada indevido foi exposto.

As ressalvas da §6 são de **observabilidade**, não de defeito: são coisas que não tenho
como medir daqui, e que estão listadas em vez de presumidas.
