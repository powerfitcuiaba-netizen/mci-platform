# Relatório de regressão, estabilidade e desempenho — Treinadores & Equipes

**Branch:** `claude/mci-platform-muscle-contest-o6haz9` · **HEAD:** `173467b`
**Data:** 2026-09-27

> Tudo medido em **ambiente local isolado**: PostgreSQL 16 em `127.0.0.1`, banco descartável,
> dado sintético. **Nada foi executado contra produção.** Máquina da medição: 4 vCPU, 15,7 GiB.

---

## 1. Regressão do backend

`npm test` = `prisma migrate deploy` + `node prisma/seed.js` + `vitest run`.

| Métrica | Resultado |
| --- | --- |
| Arquivos de teste | **132 passaram**, 1 ignorado (133) |
| Testes | **2219 passaram**, 0 reprovaram, 15 ignorados (2234) |
| Duração | 1748,97 s (~29 min) |
| Migrations aplicadas antes da suíte | 44, incluindo as três desta etapa |

Os 15 testes ignorados e o arquivo ignorado são os mesmos de antes destas correções — são
condicionados a recursos que este ambiente não tem, e a CI confere explicitamente que os que
**não podem** ser pulados não foram (backup/restore, BYPASSRLS real, taxonomia e ajuste).
**Nenhum teste foi desativado ou marcado como pendente por este trabalho.**

### 1.0 Uma execução foi descartada, e a razão é minha

Antes desta, houve uma execução que reprovou **14 testes** em três arquivos sem relação alguma
com estas correções — regulamento Overall, carga histórica e RLS do ledger. A causa não foi
defeito: eu rodei uma suíte **em paralelo** com a regressão, no MESMO banco, e o `TRUNCATE` do
`limparBanco()` entrou em deadlock (PostgreSQL 40P01). O erro foi meu, o resultado era inválido,
e ele foi **descartado** em vez de interpretado. A execução registrada acima é limpa: nada
concorrente tocou o banco.

Fica como regra escrita para quem vier depois: **duas suítes deste projeto não podem rodar ao
mesmo tempo contra o mesmo banco.** A limpeza entre casos é `TRUNCATE` de dezenas de tabelas, e
duas delas concorrendo é deadlock garantido, não eventual.

### 1.1 O que a regressão pegou, e por que isso é bom

A execução anterior a estas correções **reprovou em 1 teste**, e o teste certo:
`tests/empacotamento-importador.test.mjs` declara a lista EXATA de migrations do repositório,
com o comentário "esta lista só muda de propósito, com revisão". As três migrations novas
desta etapa não estavam nela.

Esse é o gate funcionando: uma migration nova não entra em silêncio. A lista foi atualizada
com as três, **cada uma com o que muda e o que não muda escrito ao lado** — em particular a
única que escreve dado (`20260927030000`), com o predicado e a razão.

---

## 2. Regressão do frontend

| Métrica | Resultado |
| --- | --- |
| Arquivos de teste | **60 passaram** |
| Testes | **676 passaram**, 0 reprovaram |
| Duração | 58,9 s |
| Build de produção | **PASS** — `vite build` conclui; bundle 871,68 kB (225,04 kB gzip) |

O aviso de chunk acima de 500 kB é anterior a este módulo e continua registrado como dívida
conhecida, não como defeito novo.

### 2.1 Os quatro testes novos de interface

`frontend/src/pages/treinadores.test.jsx` ganhou o bloco de **A-11**: 403 na fila de análise
mostra recusa e não fila vazia; 403 na delegação mostra recusa e não "nenhuma delegação em
vigor"; falha que não é recusa mostra a mensagem do servidor; e fila realmente vazia explica
o vazio **uma vez só** — antes eram dois textos na mesma seção, porque `AsyncSection` somava
o genérico ao próprio da tela.

---

## 3. Lint

`npx eslint .` cobre backend, scripts, testes e `frontend/src`. **PASS, zero problemas.**

Durante esta etapa o lint reprovou uma vez, e com razão: o script de desempenho carregava um
gerador de CPF sintético que ele não usava. Removido — carregar um gerador de CPF num script
que não gera CPF é convite para alguém usá-lo sem pensar.

---

## 4. Migrations

| Verificação | Comando | Resultado |
| --- | --- | --- |
| As 44 migrations aplicam **do zero** | `CREATE DATABASE mci_migracao_zero` + `prisma migrate deploy` | **PASS** |
| Nenhuma pendente depois | `prisma migrate status` | **PASS** — "Database schema is up to date!" |
| O banco da suíte também em dia | `prisma migrate status` | **PASS** |
| A migration que escreve dado é idempotente | executada duas vezes em teste | **PASS** — a segunda não muda nada |

O detalhamento (inventário, ordem, estado intermediário perigoso, roteiro e rollback) está em
`PLANO-MIGRACAO-RENDER-TREINADORES.md`.

---

## 5. QA visual em navegador real — oito larguras

`node scripts/qa/visual-treinadores.mjs` sobe a pilha **completa** (PostgreSQL descartável +
API + build de produção do frontend) e mede num Chromium de verdade.

| Métrica | Resultado |
| --- | --- |
| **PASS** | **218** |
| **FAIL** | **0** |
| **NOT TESTED** | **0** |
| Achados de CONTROLE (dívida anterior ao módulo) | 3 |
| Linhas informativas | 8 |
| Larguras medidas | **360, 390, 430, 768, 1024, 1280, 1440, 1920** |
| Evidência | `docs/audits/qa-visual-treinadores/` (screenshots + `evidencias.json`) |

### 5.1 O que é medido em cada largura

* rolagem lateral do **documento** e elementos estourando a viewport;
* alvo de toque abaixo de 40px nas três larguras de telefone (360, 390, 430);
* erro no console do navegador e requisição de rede falhada;
* **presença do conteúdo esperado** — porque um gate que mede a tela de login por engano
  aprova qualquer coisa.

### 5.2 Os 3 achados de CONTROLE

`select` de 23 px na tela administrativa de atletas, nas três larguras de telefone. É dívida
**anterior** ao módulo, registrada de propósito como CONTROLE e não como FAIL: apagá-la da
medição seria esconder, e classificá-la como defeito do módulo seria falso.

### 5.3 As 8 linhas informativas

Fonte externa do Google Fonts, que o ambiente do gate não alcança (sem rede). Excluída do
cômputo e **registrada**: exclusão silenciosa é o começo de um defeito encoberto.

### 5.4 O gate reprovou na primeira execução — e estava certo

Duas coisas, ambas criadas pela correção de A-02:

1. **o semeador do gate** concedia delegação central sem escopo e sem prazo, que a correção
   passou a recusar. Corrigido: passa os dois, como qualquer cliente real terá de passar;
2. **a recusa de campo obrigatório era ininteligível.** O gate mostrou o que a API devolvia
   para `expiresAt` ausente: `"Invalid input: expected date, received Date"`. A causa é
   `z.coerce.date()` — a coerção roda **antes** da conferência, e `new Date(undefined)` produz
   data inválida, então o campo nunca é reportado como ausente.

   Isso não é cosmético: a recusa de um campo obrigatório é a primeira coisa que quem
   administra a plataforma vai ler, e uma mensagem que fala de tipo interno não diz a ninguém
   o que fazer. `dataIsoObrigatoria` confere o valor **cru** primeiro e só então converte —
   ausente, nulo, vazio ou malformado recebem a mesma instrução, em português, com exemplo.

E um terceiro achado, no próprio instrumento: o relato de evidência defasada (**A-07**)
apontava `evidencias.json` como sendo de rodada anterior, porque o arquivo é escrito **depois**
da comparação. Excluído da conferência, com a razão escrita.

---

## 6. Desempenho medido

`node scripts/qa/desempenho-treinadores.mjs`, 30 amostras por rota (+5 de aquecimento), contra
a pilha no ar. Os orçamentos são **deste gate** e **não são SLA homologado pela MuscleContest**:
existem para que uma regressão de uma ordem de grandeza reprove, não para certificar desempenho.

| Rota | p50 | p95 | máx | Orçamento | Status esperado | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| `POST /auth/login` | 9 ms | 12 ms | 13 ms | 1500 ms | 200 | **PASS** |
| `GET /coaches` (catálogo) | 9 ms | 11 ms | 12 ms | 600 ms | 200 | **PASS** |
| `GET /coaches/me` (conta comum: recusa por permissão) | 7 ms | 8 ms | 13 ms | 600 ms | 403 | **PASS** |
| `GET /coaches/:id/ranking/eligibility` (recusa de terceiro — A-01) | 8 ms | 12 ms | 17 ms | 600 ms | 404 | **PASS** |
| `GET /ranking/coaches` (bloqueio de §8.3) | 1 ms | 2 ms | 2 ms | 400 ms | 409 | **PASS** |
| `GET /health` (raiz) | 1 ms | 1 ms | 2 ms | 300 ms | 200 | **PASS** |
| `GET /coaches/me` (dono do cadastro, papel COACH) | 9 ms | 19 ms | 20 ms | 600 ms | 200 | **PASS** |
| `GET /coaches/me/teams` | 11 ms | 15 ms | 21 ms | 600 ms | 200 | **PASS** |
| **`GET /coaches/me/athletes`** (atravessa os predicados NOVOS de RLS) | **14 ms** | **16 ms** | **18 ms** | 800 ms | 200 | **PASS** |
| `GET /team-membership-requests/me` | 8 ms | 10 ms | 18 ms | 600 ms | 200 | **PASS** |
| `GET /coaches/:id/ranking/projection` (dono, sem temporada) | 9 ms | 12 ms | 14 ms | 800 ms | 422 | **PASS** |
| `GET /coaches/review` (fila da mesa central) | 9 ms | 11 ms | 12 ms | 800 ms | 200 | **PASS** |
| `GET /central-authorizations` | 9 ms | 14 ms | 14 ms | 600 ms | 200 | **PASS** |

**13 de 13 dentro do orçamento, com o status esperado.** Nenhum p95 passou de 19 ms; o máximo
absoluto observado foi 21 ms.

### 6.1 A rota que importava medir

`GET /coaches/me/athletes` é a que atravessa a cláusula nova de RLS: cada linha de `Athlete`
avalia `mci_treinador_com_equipe_em`, que faz um `EXISTS` sobre `CoachOrganization ⋈ Coach ⋈
Team`. Predicado de política é exatamente o custo que não aparece em teste funcional e aparece
no ginásio, com a federação inteira cadastrada. **p50 = 14 ms, p95 = 16 ms** com o conjunto
sintético do ambiente.

**Ressalva honesta e explícita:** o ambiente sintético tem poucas dezenas de atletas. Esta
medição prova que **não há custo patológico** por requisição, e **não** prova comportamento com
10 mil atletas numa federação. A medição em volume real exige base de volume real, que só
existe em produção — e não se mede em produção sem autorização, janela e responsável.

### 6.2 O gate declara o status esperado, e não assume que 4xx é falha

Na primeira versão, o script tratava qualquer `>= 400` como problema — e reprovou em 7 das 10
rotas, **todas respondendo corretamente**: o 409 do bloqueio de §8.3, o 404 da antienumeração
de A-01, o 403 da conta sem permissão. Metade das rotas deste módulo tem a **recusa** como
resposta certa. Um gate que reprova no comportamento correto é um gate que alguém desliga na
semana seguinte, então cada linha passou a declarar o status que espera.

### 6.3 O que NÃO foi medido, nomeado

* **Rotas que exigem promoção de papel** sem passar pelo banco: o script não toca o banco por
  desenho, então as rotas do treinador e da mesa central são medidas com as contas que o
  ambiente já criou, passadas por argumento. Sem elas, saem como **NÃO MEDIDAS** — nomeadas,
  nunca preenchidas com um número que mediria outra coisa.
* **Carga concorrente e volume de produção**: fora de escopo, e a razão está em 6.1.
* **Latência de banco gerenciado**: a medição é com PostgreSQL local. Em banco gerenciado, a
  latência de rede soma por ida e volta — é exatamente o cenário que motivou o prazo explícito
  de transação do cadastro (**A-06**).

---

## 7. Estabilidade

| Verificação | Resultado |
| --- | --- |
| Erro de console do navegador nas telas do módulo | **zero**, nas oito larguras e nos três idiomas |
| Requisição de rede falhada ou 5xx | **zero** (as 8 informativas são a fonte externa do Google Fonts) |
| Recusas de API observadas durante o gate | **nenhuma** inesperada |
| A pilha sobe, semeia, serve e responde em um comando | **PASS** |
| O gate apaga evidência commitada? | **não** — corrigido em A-07, e a defasagem é declarada |

---

## 8. Concorrência — o que já estava medido e continua verde

As correções desta etapa tocaram políticas de RLS e o caminho de escrita do vínculo, então os
testes de disputa importam como regressão:

| Cenário | Resultado |
| --- | --- |
| Duas tentativas simultâneas de vincular o mesmo atleta | só uma passa; a trava é do banco |
| Oito simultâneos disputando o mesmo atleta | o perdedor recebe **409**, nunca 500 |
| Escrita direta tentando dois vínculos ativos | recusada pelo banco |
| Dois pedidos de vínculo simultâneos para o mesmo atleta | só um fica pendente |
| Declaração e invalidação simultâneas de título Overall | serializadas sob a trava da temporada |

---

## 9. Prova negativa — os mutantes desta etapa

Um teste que passa com e sem a correção não mede a correção. Quatorze mutantes aplicados, todos
revertidos, com o verde reconfirmado depois de cada um:

| Mutante | Testes que reprovaram |
| --- | --- |
| A-01 — remover a guarda das duas rotas de ranking | **3** |
| A-01 — devolver `ranking.manage` à guarda (vazamento cross-tenant) | **1** |
| A-02 — escopo nulo volta a valer em todas as federações | **2** |
| A-02 — prazo nulo volta a valer para sempre | **2** |
| A-03 — devolver `mci_treinador_autorizado_de` em `atleta_leitura` | **2** |
| A-04 — política sem predicado de `teamId` | **3** |
| A-04 — conferência do serviço desligada | **1** |
| A-09 — remover a trilha da troca de senha | **2** |
| A-10 — auditar **todo** bloqueio, e não o primeiro da janela | **1** |
| A-10 — não auditar bloqueio nenhum | **1** |
| A-11 — devolver o `.catch` que engolia o 403 | **2** |
| A-12 — remover o evento de reatribuição | **1** |
| A-13 — devolver o `include` sem projeção no catálogo de técnicos | **2** |

### 9.1 A mutação pré-existente do módulo — reexecutada, e ela achou dois problemas

`scripts/qa/mutantes-treinadores.mjs`: 16 mutantes de decisão, com 6 suítes de controle antes
e depois. Resultado final:

| Métrica | Resultado |
| --- | --- |
| Mutantes mortos | **15** |
| Equivalentes declarados | **1** (TE-P2) |
| Conforme a expectativa | **16/16** |
| Controle antes | as 6 suítes passam sem mutante |
| Controle depois | as 6 suítes voltam a passar — restauração íntegra |

**A primeira rodada divergiu em dois, e os dois eram defeitos de verdade.**

**TE-M9 saiu como "NÃO APLICADO".** O mutante mirava
`if (concessao.expiresAt && new Date(...) <= agora) continue;`, linha que a correção de **A-02**
substituiu por duas. O trecho deixou de existir e o mutante deixou de entrar no código — e
mutante que não entra é mutante que **parou de proteger, com cara de resultado**. O alvo foi
atualizado para a linha nova.

**TE-M12 SOBREVIVEU, e a causa foi a própria correção de A-02.** O mutante remove a conferência
da lista branca na **leitura** da concessão. Ele morria porque o teste "permissão REAL mas FORA
da lista branca também não vira poder" usava concessões de `results.publish` e `users.manage`
com `organizationId: null` e `expiresAt: null`. As duas guardas novas de A-02 rodam **antes** da
lista branca, então passaram a matar aquelas linhas primeiro: o teste continuava verde por outro
motivo, e a lista branca ficou **sem prova nenhuma**.

Quatro fixtures do arquivo perderam o poder de isolamento pela mesma razão — a da não
delegabilidade de `central.grant`, a da permissão inexistente na matriz e as duas da lista
branca. Todas passaram a carregar escopo e prazo válidos, para que a única coisa entre cada
fixture e o poder seja a barreira que ela diz medir. Na segunda rodada, **TE-M9 e TE-M12
morreram**.

A lição é geral e ficou escrita no próprio teste: **guarda nova adicionada cedo na cadeia rouba
o poder de isolamento de todo teste que dependia de guarda posterior.** É a diferença entre um
teste que passa e um teste que mede.

### 9.2 TE-P2 — o único equivalente, e por que ele não pode morrer

O mutante devolve `vinculo_escrita` a `FOR ALL`, o que deixaria o atleta encerrar o próprio
vínculo. Nenhuma rota permite isso, então a folga da política **não tem caminho de aplicação por
onde ser observada**. A separação em INSERT/UPDATE/DELETE é barreira de profundidade, documentada
na migration `20260926040000`; medi-la exigiria um teste de SQL cru, que mediria a política e não
o comportamento do produto. Fica declarado em vez de forçado.

### 9.3 A matriz de LEITURA — o gate estrutural que faltava

`tests/matriz-de-autorizacao.mjs` é a lista estrutural do projeto, e tem um limite no próprio
nome: **rota mutante**. As rotas de leitura ficam fora — e os dois achados de autorização desta
etapa foram, os dois, em rotas de leitura (**A-01** e **A-13**). Nenhum gate estrutural teria
pegado nenhum dos dois.

`tests/matriz-de-leitura-treinadores.test.mjs` fecha o buraco: **16 rotas × 11 perfis = 176
células**, mais 4 invariantes. **180 testes, todos passando.**

Os perfis são **estados do domínio**, não papéis: "treinador" são cinco (pendente, aprovado sem
federação, aprovado sem equipe, aprovado com equipe, e de outra federação), porque cada estado
derruba um predicado diferente de R-03, R-04 e da RLS. Cada rota declara quem **deve** conseguir;
para todos os outros o teste exige recusa — 401 sem sessão, 403 ou 404 com sessão. E **o corpo é
conferido em toda célula, inclusive nas de sucesso**: campo proibido não vaza nem para quem tem
direito à rota.

**Prova negativa da própria matriz.** Com os dois defeitos de volta — a guarda de A-01 removida
e o `include` sem projeção de A-13 —, a matriz reprova **28 células**: 10 do catálogo (todos os
perfis autenticados), 16 das duas rotas de ranking, e 2 invariantes. Matriz verde que não mata
mutante não prova nada; esta mata.

## 10. Inventário de suítes executadas

| Suíte | Casos | O que cobre |
| --- | --- | --- |
| `hardening-auditoria-treinadores` | 28 | A-01 a A-05 |
| `hardening-operacional` | 5 | A-09, A-10 |
| `modulo-treinadores-equipes` | 25 | R-03, R-04, R-05, confirmação, busca, §8.3 |
| `vinculo-equipe` | 22 | trava única, transferência, concorrência, IDOR, importação |
| `r01-equipe-da-epoca` | 10 | R-01 temporal, prévia somente leitura, A-12 |
| `permissoes-delegacao` | 17 | R-02 como função pura e pela rota |
| `autenticacao-fail-closed` | 18 | tentativa recusada e fail closed |
| `auditoria-de-autenticacao` | 17 | trilha de LOGIN e USER_REGISTER |
| `gate-autorizacao-por-rota` + `matriz-de-autorizacao` | 125 rotas | expectativa declarada por rota mutante |
| `empacotamento-importador` | 9 | inclui a lista exata de migrations |
| `treinadores.test.jsx` (frontend) | 25 | telas do módulo, incluindo A-11 |
| `matriz-de-leitura-treinadores` | 180 | 16 rotas de LEITURA × 11 perfis, mais 4 invariantes |

---

## 11. Conclusão

| Gate | Resultado |
| --- | --- |
| Regressão do backend | **PASS** — 2219/2219, 132 arquivos |
| Regressão do frontend | **PASS** — 676/676, 60 arquivos |
| Build do frontend | **PASS** |
| Lint | **PASS** |
| Migrations do zero + status | **PASS** |
| QA visual em 8 larguras | **PASS** — 218/0/0 |
| Desempenho | **PASS** — 13/13 no orçamento |
| Mutantes desta etapa | **PASS** — 14/14 mataram |
| Mutação pré-existente do módulo | **PASS** — 15 mortos, 1 equivalente, 16/16 conforme |
