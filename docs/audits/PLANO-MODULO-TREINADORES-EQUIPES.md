# Módulo Treinadores & Equipes — Fase 1: auditoria e plano

**Esta fase é somente leitura.** Nenhuma linha de código, schema, política de RLS ou
dado foi alterada. Nenhuma migration foi criada. Nenhum commit, push, merge ou deploy.

## Como ler este documento

Três marcadores separam o que é verificado do que é opinião, e eles valem em todas as
seções:

| Marcador | Significado |
| --- | --- |
| **MEDIDO** | verificado no código, no schema ou no banco de QA nesta fase, com o arquivo e a linha |
| **PROPOSTA** | desenho meu, ainda não implementado e ainda não aprovado |
| **DECISÃO PENDENTE** | depende da MuscleContest, não de engenharia |

---

# 1. Estado atual do sistema e evidências

| | |
| --- | --- |
| Repositório | `powerfitcuiaba-netizen/mci-platform` (público) |
| Branch | `claude/mci-platform-muscle-contest-o6haz9` |
| SHA | `13b8bc8557581ba3f4524fda82864356e74eb62c` |
| Árvore | limpa · remoto sincronizado `0 / 0` |
| CI | **#342 verde** nos três jobs, neste SHA |
| Trabalho concorrente | nenhum |

Fases anteriores lidas: T1 (autorização por rota), T2 (F1 e F3), F2 (governança do
catálogo global), T4 (concorrência do ranking, atomicidade, RLS `WITH CHECK`).

**MEDIDO — a arquitetura que governa tudo o que segue.** `src/utils/asyncHandler.js`
envolve todo handler autenticado numa **única transação interativa**, e
`src/config/prisma.js` é um Proxy que redireciona todo `$transaction` e `$executeRaw`
para ela. Isso significa que qualquer operação do módulo novo será atômica por
construção, desde que passe por rota — e que travas de transação valem até o commit.

---

# 2. Entidades, tabelas, rotas e serviços existentes

## 2.1 O achado mais importante desta auditoria

**MEDIDO — a Regra 1 do seu desenho ("cada atleta só pode pertencer a uma equipe por
vez") JÁ ESTÁ IMPLEMENTADA, e no banco.**

`AthleteTeamMembership` (`prisma/schema.prisma`):

```
activeAthleteId String? @unique
startedAt       DateTime @default(now())
endedAt         DateTime?
reason          String?
createdById     String?
endedById       String?
```

A coluna `activeAthleteId` carrega o id do atleta **enquanto o vínculo está aberto** e
vira `NULL` quando ele é encerrado. Com o índice único, o PostgreSQL garante **um
vínculo ativo por atleta** — exatamente a exclusividade que você pediu, e sem depender
de verificação anterior à gravação.

O comentário do serviço (`src/services/membershipService.js:13`) já diz por que:

> "Uma checagem em service não bastaria — entre o SELECT e o INSERT cabe a transação do
> outro treinador, e é exatamente esse o caso que a regra precisa impedir."

E a **Regra 3** também já é o desenho homologado, no mesmo arquivo (linha 20):

> "O treinador não transfere sozinho; a transferência exige `athletes.transfer`, que é
> permissão de operador da Muscle Contest."

**Consequência para o plano:** o módulo não deve criar tabela de vínculo nova. Deve
**reusar `AthleteTeamMembership`**.

## 2.2 Tabelas relevantes, com RLS medido

| Tabela | `organizationId` | RLS | FORCE | Observação medida |
| --- | --- | --- | --- | --- |
| `Athlete` | sim | **sim** | **sim** | `coachId`, `teamId`, `gymId`, `affiliationId`, `affiliationNumber`, `userId?` único |
| `AthleteIdentity` | sim | **sim** | **sim** | onde o CPF vive, em tabela própria |
| `AthleteTeamMembership` | não (via `Team`) | **sim** | **sim** | a trava de exclusividade |
| `Company` | sim | **sim** | **sim** | acima da equipe |
| `RankingPoint` | sim | **sim** | **sim** | o ledger oficial; já tem `teamId` e `companyId` |
| `PublicRankingEntry` | sim | **sim** | **sim** | projeção pública, uma linha por lançamento |
| **`Coach`** | **NÃO** | **não** | **não** | `userId` único; sem relação com `Team` |
| **`Team`** | sim | **não** | **não** | `@@unique([organizationId, name])` |
| **`Gym`** | sim | **não** | **não** | |
| **`Affiliation`** | sim | **não** | **não** | `@@unique([organizationId, code])` |
| **`User`** | — | **não** | **não** | |
| **`OrganizationMember`** | sim | **não** | **não** | |

**MEDIDO — `Coach` e `Team`, que serão o coração do módulo, não têm RLS nenhuma.** A
tabela do vínculo tem; as das entidades não. Hoje a barreira é inteiramente de serviço.

## 2.3 `Coach` como ele é hoje

**MEDIDO:**

- **Não tem `organizationId`.** É global por desenho, e o comentário de
  `src/services/partnerService.js` diz o motivo: "um técnico atende atletas de várias".
- **Não tem relação com `Team`.** `Athlete.coachId` e `Athlete.teamId` são independentes.
- `userId` é **UNIQUE** — um técnico se liga a no máximo uma conta, e uma conta a no
  máximo um técnico.
- **Nenhuma política de RLS e nenhum serviço deriva autorização de `Coach`** (medido na
  fase F2: zero helper `mci_` e zero policy citam coach). Ter cadastro de técnico não
  dá poder a ninguém.
- `prisma.coach.create` existe em **um único lugar** (`partnerService.js`), alcançável
  só por `POST /coaches`.
- **Nenhuma tela chama `POST /coaches`** — medido em todo `frontend/src/`.
- Duas permissões, separadas na fase F2: `coaches.manage` (tem `EVENT_DIRECTOR`) e
  `coaches.link_account` (só plataforma).

## 2.4 Rotas que o módulo vai reusar ou tocar

| Rota | Serviço | Autorização medida |
| --- | --- | --- |
| `POST /athletes/:id/team` | `membershipService.linkTeam` | `assertCan(athletes.update, team.organizationId)` |
| `POST /athletes/:id/team/transfer` | `membershipService.transferTeam` | `assertCan(athletes.transfer, ...)` |
| `POST /athletes/:id/team/unlink` | `membershipService` | `assertCan(athletes.transfer, ...)` |
| `GET /athletes/:id/team-history` | `membershipService` | `assertCan(athletes.read, ...)` |
| `POST /coaches` · `GET /coaches` | `partnerService` | `coaches.manage` + `coaches.link_account` |
| `POST /teams` · `GET /teams` | `partnerService` | `teams.manage` |
| `POST /athletes/lookup` | `athleteService.lookup` | `athletes.read_sensitive` |
| `GET /ranking/teams` | `rankingService.teamRanking` | anônima, lê `PublicRankingEntry` |

## 2.5 O padrão de fila de aprovação que já existe

**MEDIDO** — `AthleteProfileRequest` é a máquina de estados do autocadastro:

```
status: PENDING | APPROVED | REJECTED | CANCELLED
reviewedById, reviewedAt, rejectionReason, athleteId?
```

Tela administrativa: `frontend/src/pages/adminSolicitacoes.jsx`. Tela do solicitante:
`minhaSolicitacao.jsx`.

**Consequência:** o cadastro do treinador e a solicitação de vínculo devem espelhar
essa máquina de estados, não inventar outra.

## 2.6 Papéis existentes

**MEDIDO** em `src/utils/permissions.js`:

- `SUPER_ADMIN` e `ADMIN` são **papéis de plataforma** — `isCrossTenant()` devolve
  verdadeiro para os dois, e eles não são limitados por vínculo de organização.
  **Só `SUPER_ADMIN` tem `organizations.manage`.**
- `EVENT_DIRECTOR`, `EVENT_COORDINATOR`, `REGISTRATION_OPERATOR`, `RANKING_MANAGER` e
  outros são papéis **de federação**, concedidos por `OrganizationMember`.
- **`COACH` existe no enum e concede quase nada:** `operacional('registrations.read')` —
  ou seja, a base autenticada mais leitura de inscrições. Não tem
  `athletes.read_sensitive`, não tem `athletes.update`, não tem `athletes.transfer`.
- `FEDERATION_SERVICE` não é atribuível a pessoa, de propósito, e há teste para isso.

**Atenção sobre a sua expressão "SUPERADMIN":** no código o papel é `SUPER_ADMIN`, com
sublinhado. E a regra que você quer — só ele efetiva desvínculos que mexem em pontos —
**hoje é `athletes.transfer`**, que `EVENT_DIRECTOR` também tem. Se a intenção é
restringir a `SUPER_ADMIN`, isso é uma mudança de matriz, não um fato atual. É
**DECISÃO PENDENTE** (§13).

---

# 3. Lacunas comprovadas

| # | Lacuna | Evidência |
| --- | --- | --- |
| L1 | **Não existe cadastro de treinador com aprovação.** `Coach` é uma linha criada por operador, sem documentos, sem análise, sem estado | modelo `Coach` tem 7 colunas e nenhum campo de situação |
| L2 | **Não existe solicitação de vínculo nem confirmação pelo atleta.** `Athlete.coachId` é FK simples, escrita pelo operador | `camposRestritos` em `athleteService.update` inclui `coachId` |
| L3 | **Não existe histórico do vínculo com treinador.** Trocar de treinador sobrescreve `coachId` e a informação anterior desaparece | não há tabela `AthleteCoachMembership`; `AthleteTeamMembership` é só de equipe |
| L4 | **Não existe busca de atleta por número de filiação.** A única busca é `POST /athletes/lookup`, **por CPF**, exigindo `athletes.read_sensitive` e auditada como `ATHLETE_CPF_VIEW` | `src/utils/schemas.js:267` |
| L5 | **`Coach` e `Team` não têm RLS.** A barreira é só de serviço | `pg_class`: `relrowsecurity = false` |
| L6 | **Não existe ranking de treinadores.** `RankingPoint` tem `teamId` e `companyId`, não `coachId` | modelo `RankingPoint` |
| L7 | **O papel `COACH` não tem permissão para operar painel nenhum** | `operacional('registrations.read')` |
| L8 | **Nenhuma tela de treinador existe**, e `POST /coaches` não tem chamador | varredura em `frontend/src/` |
| L9 | **Não há tipo de notificação para pedido de vínculo** | 16 `TYPES` em `notificationService`, nenhum serve |

**O que NÃO é lacuna, e por isso não deve ser reconstruído:** exclusividade de vínculo
(L existe via `activeAthleteId`), histórico de equipe, transferência com autor e motivo,
fila de aprovação, motor de pontuação, projeção pública, auditoria, trava de temporada.

---

# 4. Arquitetura proposta

**PROPOSTA.** Três princípios, cada um derivado de um fato medido:

**P1 — Reusar `AthleteTeamMembership`, não criar tabela de vínculo nova.** A
exclusividade que o módulo exige já está garantida pelo banco ali. Criar uma segunda
tabela criaria uma segunda verdade sobre a mesma pergunta.

**P2 — O vínculo do módulo é atleta → EQUIPE, e o treinador é dono da equipe.** É a
única forma de aproveitar a trava existente. Hoje `Coach` não tem relação com `Team`; a
proposta é acrescentá-la, **sem** mexer em `Athlete.coachId`, que continua sendo o
campo administrativo que já existe.

**P3 — A pontuação do treinador é DERIVADA, nunca materializada.** É o desenho que o
ranking de equipes já usa: `teamRanking` lê `PublicRankingEntry` e soma. O comentário de
`republicarProjecao` explica por que não se materializa agregado — "cada um deles é uma
chance de a pontuação divergir da regra homologada". O treinador segue a mesma regra.

## As três coisas que o seu desenho pede para distinguir, e onde cada uma mora

| Coisa | Onde mora | Natureza |
| --- | --- | --- |
| Resultado oficial do atleta | `RankingPoint` (ledger) | **existe**, intocado |
| Vínculo histórico do atleta com a equipe | `AthleteTeamMembership` (`startedAt`/`endedAt`) | **existe** |
| Pontuação computada para o treinador | projeção derivada, em tempo de consulta | **PROPOSTA** |

---

# 5. Modelo de dados proposto

**PROPOSTA — nenhuma migration foi criada nesta fase.**

## 5.1 Alterações mínimas em tabelas existentes

```
Coach
  + status          CoachStatus @default(PENDING)   -- PENDING|APPROVED|REJECTED|SUSPENDED
  + organizationId  String?                          -- DECISÃO PENDENTE, ver §13.2
  + reviewedById    String?
  + reviewedAt      DateTime?
  + rejectionReason String?

Team
  + coachId  String?   -- o treinador responsável pela equipe
  + @@index([coachId])
```

`Team.coachId` é o que liga as duas metades sem duplicar nada.

## 5.2 Tabelas novas

```
CoachDocument           -- documentação da análise; espelha AthleteDocument
TeamMembershipRequest   -- a solicitação de vínculo, com confirmação do atleta
  status: PENDING | CONFIRMED | REJECTED | CANCELLED | EXPIRED
  requestedById, athleteId, teamId, confirmedAt, rejectedAt, reason
  @@unique([athleteId, teamId, status])  -- não empilha pedido igual
```

**Por que uma tabela de solicitação, e não um campo:** a confirmação do atleta é um ato
com autor e data, e precisa sobreviver à rejeição. É o mesmo raciocínio de
`AthleteProfileRequest`.

## 5.3 RLS que as tabelas novas e as sem RLS precisariam

**PROPOSTA**, e é a parte mais delicada: `Coach` e `Team` **não têm RLS hoje** (L5).
Ligar RLS nelas altera o comportamento de leitura de rotas que já existem, então é
trabalho com risco de regressão e merece fase própria — não deve entrar junto com a
feature.

---

# 6. Matriz de permissões

**MEDIDO** o que existe hoje; **PROPOSTA** as colunas do módulo novo.

| Ação | Hoje | Proposta |
| --- | --- | --- |
| Criar cadastro de treinador | `coaches.manage` (EVENT_DIRECTOR+) | autocadastro do próprio + `coaches.manage` |
| Vincular cadastro de treinador a uma CONTA | `coaches.link_account` (só plataforma) | **inalterado** — é a trava da F2 |
| Aprovar/rejeitar treinador | não existe | `coaches.approve` (**PROPOSTA**) — federação ou plataforma, §13.4 |
| Consultar a própria equipe | não existe | `teams.read_own` (**PROPOSTA**), papel `COACH` |
| Buscar atleta por matrícula | **não existe** | `athletes.lookup_affiliation` (**PROPOSTA**), sem CPF, auditada |
| Solicitar vínculo | não existe | `teams.request_membership` (**PROPOSTA**), papel `COACH` |
| Confirmar vínculo | não existe | autosserviço do atleta — nunca permissão de operador |
| Vincular direto (sem confirmação) | `athletes.update` | **inalterado**, e passa a ser a exceção administrativa |
| Transferir | `athletes.transfer` | §13.1 |
| Desvincular | `athletes.transfer` | §13.1 |
| Consultar pontuação da equipe | `ranking.read` (base autenticada) | **inalterado** |
| Reprocessar ranking | `ranking.manage` | **inalterado** — treinador nunca |

**Nenhuma dessas permissões deve ser concedida ao treinador para escrever pontuação.**
O treinador não tem, e não deve ter, `results.receive`, `results.publish`,
`results.override`, `ranking.manage` nem `musclewar.apply`.

---

# 7. Fluxos de cadastro, aprovação e vínculo

**PROPOSTA.**

**Cadastro do treinador:** conta criada pelo cadastro aberto (papel `COACH` já é
autoatribuível — `PAPEIS_DE_CADASTRO_ABERTO` inclui `COACH`, medido) → cria `Coach`
com `status: PENDING` → envia documentos → análise → `APPROVED`, `REJECTED` ou pedido
de complemento. Espelha `AthleteProfileRequest`.

**Vínculo do atleta, em cinco passos:**

1. Treinador aprovado informa **número de filiação + entidade de filiação**. As duas
   coisas, porque **MEDIDO**: a unicidade é `@@unique([organizationId, affiliationId, affiliationNumber])`
   — o número sozinho não identifica ninguém, e o comentário do schema diz isso: "duas
   federações podem emitir o mesmo número".
2. O sistema devolve **apenas o suficiente para reconhecer**: nome, situação e se já há
   vínculo ativo. **Nunca** CPF, documento, endereço, telefone ou e-mail.
3. Cria `TeamMembershipRequest` em `PENDING` e **notifica o atleta**.
4. O atleta **confirma ou rejeita** na própria conta.
5. Na confirmação, o vínculo entra por `membershipService.linkTeam` — o caminho que já
   existe, com a trava do banco. Se outro treinador chegou primeiro, o índice único
   recusa e a mensagem diz "atleta já possui vínculo ativo" **sem revelar qual equipe**.

**Atleta sem conta:** hoje o autocadastro já concilia histórico pelo número de filiação
(fase de conciliação automática, medida). A **PROPOSTA** é que o pedido fique `PENDING`
aguardando o atleta criar a conta, e o convite **nunca** crie atleta novo — o cadastro
de filiação existente é que manda. Validação administrativa excepcional, com evidência e
auditoria, fica como caminho separado.

---

# 8. Regras de integridade e prevenção de fraude

| Controle | Situação | Como |
| --- | --- | --- |
| Um vínculo ativo por atleta | **JÁ EXISTE** | `activeAthleteId String? @unique` |
| Concorrência entre dois treinadores | **JÁ EXISTE** | índice único + `ERROS_DE_CORRIDA` (P2002, P2034, 40001, 40P01) tratados |
| Atomicidade da operação | **JÁ EXISTE** | `asyncHandler` = uma transação por requisição |
| Histórico imutável do vínculo | **JÁ EXISTE** para equipe | `startedAt`/`endedAt`/`reason`/`createdById`/`endedById` |
| Filiação validada no servidor | **JÁ EXISTE** | o serviço resolve pela chave, nunca por id do cliente |
| Treinador não edita pontos | **JÁ EXISTE** | ledger só por `results.*`, `musclewar.apply`, `ranking.manage` |
| Desvínculo restrito | **JÁ EXISTE** como `athletes.transfer` | §13.1 se for para restringir mais |
| Confirmação pelo atleta | **PROPOSTA** | `TeamMembershipRequest` |
| Anti-enumeração de matrícula | **PROPOSTA** | limite de consultas + auditoria por consulta, como `ATHLETE_CPF_VIEW` já faz |
| Detecção de anomalia | **PROPOSTA** | alerta administrativo, nunca bloqueio automático irreversível |

---

# 9. Integração com o motor oficial de ranking

**MEDIDO — o motor que o módulo deve reusar:**

- `RankingPoint` é o ledger; `PublicRankingEntry` é a projeção, uma linha por lançamento,
  reescrita inteira por `republicarProjecao` (`deleteMany` + `createMany`, `id = ponto.id`).
- `recompute_` serializa pela chave canônica `ranking:temporada:<seasonId>` — **corrigido
  na fase T4**.
- `reconciliarPontuacao` reaplica a tabela oficial; `normalizarBonusOverall` reaplica o
  bônus declarado.
- O ranking de equipes **já é derivado**: `teamRanking` lê a projeção e soma. Não há
  agregado materializado de equipe.
- Regras homologadas: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1, 6º+=0, NS=0; bônus Overall +10, uma
  vez por título, só em Open/Absoluta; só OPEN alimenta o Super Overall.

**PROPOSTA — a pontuação do treinador:**

> Soma dos pontos dos lançamentos dos atletas cuja participação na equipe do treinador
> estava **ativa na data do evento**, aplicando a **mesma** tabela oficial, sem peso,
> multiplicador ou bônus próprio.

Reconstrução auditável: `RankingPoint` (o quê) × `AthleteTeamMembership.startedAt/endedAt`
(quando) = a pontuação, recomputável a qualquer momento sem guardar total nenhum.

**NÃO PROPONHO fórmula nova, e não implementarei critério não aprovado.** O que falta
decidir está em §13.

---

# 10. Telas e experiência de usuário

**MEDIDO — o que existe e pode ser reusado:** `adminSolicitacoes.jsx` (fila de
aprovação), `minhaSolicitacao.jsx` (situação do solicitante), `adminAtleta.jsx` (perfil
administrativo com vínculo de equipe), `minhaCarreira.jsx` (histórico do atleta),
`publicPages.jsx` (ranking público), e o design system em `frontend/src/lib/` com
`permissoes.js` como espelho da matriz do servidor.

**MEDIDO — não existe nenhuma tela de treinador.**

**PROPOSTA:** painel do treinador (visão geral, minha equipe, busca por filiação,
solicitações, resultados, ranking, perfil, suporte); fila administrativa de cadastros e
de solicitações; ranking público de treinadores com perfil público.

**Restrição que vale em todas:** o treinador vê os pontos que compuseram o total da
equipe e **não vê** dado pessoal, documento ou informação de outra equipe. E o espelho
`permissoes.js` **não autoriza nada** — ele só evita oferecer botão que responderia 403.

---

# 11. Plano de implementação em etapas

**PROPOSTA.** Cada etapa termina verde e é revisável isoladamente.

| Etapa | Escopo | Migration? |
| --- | --- | --- |
| **2** | `Coach.status` + documentos + fila de aprovação + permissão `coaches.approve` | sim, aditiva |
| **3** | `Team.coachId` + painel do treinador em leitura | sim, aditiva |
| **4** | Busca por matrícula, com anti-enumeração e auditoria por consulta | não |
| **5** | `TeamMembershipRequest` + confirmação do atleta + notificação | sim, aditiva |
| **6** | Pontuação derivada do treinador + ranking, reusando a projeção | não |
| **7** | RLS em `Coach` e `Team` — **fase própria**, por risco de regressão de leitura | sim |
| **8** | Homologação: concorrência, autorização por rota, RLS, mutation, E2E | não |

A etapa 7 vem depois de propósito: ligar RLS em tabela que hoje não tem altera leitura
de rotas existentes, e misturar isso com feature nova esconderia a causa de qualquer
regressão.

---

# 12. Testes e critérios de aceite

**PROPOSTA**, seguindo o método que as fases T1–T4 já usam neste repositório:

- **Reproduzir antes de corrigir**, sempre.
- **Medir o banco, não só a API**: onde a responsabilidade é da RLS, a recusa tem de vir
  do PostgreSQL (42501) — um 403 de rota prova apenas que o serviço recusou primeiro.
- **Toda recusa com controle positivo ao lado**, para que "recusou" não possa ser "recusa
  tudo".
- **Concorrência com barreira**, nunca `sleep` nem ordem presumida.
- **Mutation testing** com controle antes e depois; mutante equivalente é declarado com
  prova, nunca forçado a morrer.
- **Gate de autorização por rota** (T1) estendido: rota nova do módulo entra na matriz
  ou o build quebra.

Critérios de aceite mínimos: dois treinadores simultâneos → um vínculo; vínculo sem
confirmação do atleta → recusado; desvínculo por treinador → recusado; enumeração de
matrícula → limitada e auditada; nenhum dado pessoal no retorno da busca; pontuação do
treinador reconstruível e igual à soma dos lançamentos elegíveis; resultado histórico
inalterado.

---

# 13. Decisões que dependem da MuscleContest

Nenhuma delas é de engenharia, e nenhuma será implementada sem a sua palavra.

## 13.1 Quem pode desvincular e transferir

**MEDIDO:** hoje é `athletes.transfer`, que `EVENT_DIRECTOR` também tem. Você escreveu
que só o SuperAdmin deveria efetivar desvínculo que altere pontuação. Restringir a
`SUPER_ADMIN` é mudança de matriz e afeta operação de federação que já existe.

## 13.2 `Coach` é global ou da federação?

**MEDIDO:** hoje é global, com o motivo escrito no serviço ("um técnico atende atletas
de várias"). Dar `organizationId` fragmentaria o cadastro. Mas ranking **nacional** de
treinadores com equipes de federações diferentes precisa de regra de escopo.

## 13.3 A elegibilidade temporal dos pontos — **a decisão mais importante**

Você mesmo apontou isso, e concordo. O ledger tem a data do evento; o vínculo tem
`startedAt`/`endedAt`. A pergunta é: **o ponto conta para o treinador que tinha o atleta
na data do evento, ou para o treinador atual?** E o que acontece quando um vínculo é
regularizado com atraso — correção administrativa com recálculo auditado, ou sem efeito
retroativo?

Minha recomendação: **sem retroatividade automática**, exigindo autorização com
auditoria e recálculo reproduzível. Mas a regra é sua.

## 13.4 Quem aprova o cadastro do treinador

Plataforma, federação, ou federação com homologação da plataforma.

## 13.5 A fórmula e os critérios do ranking de treinadores

Anual ou por temporada; todos os eventos ou eventos elegíveis; todos os atletas ou só os
melhores; recortes por federação, estado e categoria; desempate; e o tratamento de
resultado retificado, desclassificação e penalidade.

**Sem essa aprovação eu não codifico cálculo de ranking de treinador.**

## 13.6 Quais campos do atleta o treinador pode ver

Minha recomendação: nome, situação e existência de vínculo — nada mais. CPF, documento,
endereço, telefone e e-mail permanecem fora, e a consulta fica auditada.

---

## Ressalvas finais

- Este documento é **plano**, não implementação. Nada foi construído.
- Os fatos marcados **MEDIDO** foram verificados neste SHA. Os marcados **PROPOSTA** são
  desenho meu e podem estar errados em detalhe que só a implementação revela — foi o que
  aconteceu quatro vezes nas fases T1–T4, e está registrado em cada relatório.
- **Não afirmo que o módulo é seguro ou viável só porque o plano é coerente.** A
  verificação vem por teste, na fase que você autorizar.
- A maior dependência não é técnica: é a **§13.3**. Enquanto a elegibilidade temporal não
  estiver decidida, qualquer ranking de treinador que eu construa é palpite com aparência
  de regra.
