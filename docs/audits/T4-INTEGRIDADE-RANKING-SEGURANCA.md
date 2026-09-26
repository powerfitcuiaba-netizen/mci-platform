# T4 — Integridade do ranking, transações e hardening de RLS

Fase autorizada em escopo fechado: investigar, reproduzir, corrigir e testar **S4**,
**S5** e **S6**, em ambiente local isolado, sem tocar em produção.

## 1. Estado inicial

| | |
| --- | --- |
| Repositório | `powerfitcuiaba-netizen/mci-platform` (público) |
| Branch | `claude/mci-platform-muscle-contest-o6haz9` |
| SHA inicial | `a45e77cd26fd405e9fdc0adc036e5fd3d40390c7` |
| Remoto no início | idêntico ao local — `0 / 0` |
| Árvore no início | limpa |
| Trabalho concorrente | nenhum |
| CI anterior | **#341 verde** nos três jobs, neste SHA exato |

Relatórios anteriores lidos: `docs/engineering/ROUTE-AUTHORIZATION-MATRIX.md` (T1, T2 e
F2), `tests/matriz-de-autorizacao.mjs` e as suítes `gate-autorizacao-por-rota`,
`f1-f3-autorizacao-coerente`, `f2-governanca-do-catalogo-global`.

## 2. SHA final local

Não há commit: a fase termina com as alterações **no disco**, aguardando autorização
expressa. `git status` no fim da fase lista exatamente oito caminhos, enumerados na
seção 9.

---

## 3. A descoberta que reorganizou as três investigações

Antes de qualquer diagnóstico, um fato de arquitetura que **muda o significado** de S4 e
S5, e que eu só encontrei porque medi em vez de aceitar o relatório anterior:

**`src/utils/asyncHandler.js` envolve TODO handler autenticado numa única transação
interativa**, aberta por `withUserContext`. E `src/config/prisma.js` é um **Proxy**: onde
existe contexto de requisição, todo `$transaction` e todo `$executeRaw` é redirecionado
para essa transação, em vez de abrir outra.

Consequências, todas verificadas:

- a trava do importador (`prisma.$executeRaw` com `pg_advisory_xact_lock`) **está em
  transação** e vale até o commit da requisição;
- os `prisma.$transaction` por item, dentro do laço de aplicação, **não são transações
  separadas**: são a mesma transação da requisição;
- `adotarLedger`, cujas escritas parecem soltas no código, **executa dentro da transação
  da requisição**.

### Uma correção na minha própria leitura, registrada

Medi primeiro em psql que `pg_advisory_xact_lock` em **autocommit** é solto na instrução
seguinte:

```
SELECT pg_advisory_xact_lock(hashtext('musclewar:apply:TESTE'));
SELECT count(*) FROM pg_locks WHERE locktype='advisory';   ->  0

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('musclewar:apply:TESTE'));
SELECT count(*) FROM pg_locks WHERE locktype='advisory';   ->  1
COMMIT;
SELECT count(*) FROM pg_locks WHERE locktype='advisory';   ->  0
```

Com isso concluí que a trava do importador era **decorativa**. **Estava errado.** O fato
sobre o PostgreSQL é correto; a conclusão sobre a aplicação não era, porque a aplicação
nunca executa aquela linha em autocommit. O defeito do S4 é outro — é a **chave**.

---

## 4. Diagnóstico de S4 — chaves de lock

### 4.1 Matriz medida das operações concorrentes

| Operação | Chave de lock | Escopo | Transação | Serializa contra a temporada? |
| --- | --- | --- | --- | --- |
| `aplicarLote` (importador) | `musclewar:apply:<importId>` | lote | da requisição | **NÃO** |
| `recompute_` (motor, chamado pelo importador e pela rota) | **nenhuma** | — | própria/da requisição | **NÃO** |
| `adjustRankingPoint` → `comTemporadaTravada` | `ranking:temporada:<seasonId>` | temporada | própria/da requisição | sim |
| correção de lançamento (`rankingService:1097`) | `ranking:temporada:<seasonId>` | temporada | própria/da requisição | sim |
| invalidação em lote (`rankingService:3035`) | `ranking:temporada:<seasonId>` × N | temporadas | própria/da requisição | sim |
| Overall do evento (`rankingService:1280`) | `overall:evento:<eventId>` | evento | própria/da requisição | parcial |

**O recurso disputado é a TEMPORADA**, e não o lote nem o lançamento:
`recomputarEm` lê `RankingPoint` da temporada inteira e `republicarProjecao` faz
`deleteMany({ seasonId })` seguido de `createMany(...)` — reescreve a projeção pública
inteira daquela temporada.

Duas operações divergiam da chave desse recurso: o importador, que usava a chave do
**lote**, e `recompute_`, que **não usava chave nenhuma**. Como chaves diferentes não
serializam nada, um recompute e uma correção da mesma temporada chegavam juntos ao
`deleteMany` + `createMany`.

### 4.2 Causa-raiz do dano

`PublicRankingEntry.id` é **`ponto.id`** — determinístico, por decisão documentada em
`republicarProjecao` ("o id do lançamento é o id da projeção"). Não existe outra
unicidade na tabela além da chave primária. Então a segunda execução concorrente insere
**exatamente os mesmos ids** que a primeira acabou de gravar e colide na chave primária.

### 4.3 Reprodução — medida, contra o código sem correção

Suíte: `tests/t4-concorrencia-do-ranking.test.mjs`. Sincronização por **barreira de
promessa** sobre uma trava real, não por `sleep` nem por ordem presumida.

| Cenário | Medido ANTES da correção |
| --- | --- |
| Chave canônica presa, `POST /seasons/:id/recompute` concorrente | **CONCLUIU** — ignorou a trava |
| Chave canônica presa, `POST /musclewar/imports/:id/apply` concorrente | **CONCLUIU** — escreveu no ledger sem a chave |
| Seis recomputes simultâneos da mesma temporada | **1×200 e 5×409** |
| Conferência estática: o importador cita a chave da temporada | **NÃO** |

O sintoma **não é 5xx, é 409** — a colisão sobe mapeada como conflito. Isso importa
duas vezes: um recálculo legítimo do operador falha por conflito; e no caminho do
importador o mesmo conflito aborta a transação da requisição, ou seja **o lote inteiro
volta atrás depois de já ter escrito**.

Registro de método: a primeira versão desta suíte só reprovava `status >= 500` e por
isso ficou **verde contra o código defeituoso**. O critério passou a ser "toda operação
legítima responde 200".

### 4.4 Correção

Uma chave canônica para o recurso compartilhado, usando o mecanismo que **já existia** —
`travarTemporada` — em vez de criar abstração nova:

1. `recompute_` passa a pedir `travarTemporada(tx, seasonId)`.
2. `aplicarLote` passa a pedir `ranking.travarTemporada(prisma, lote.seasonId)`, além da
   trava do lote. Ordem sempre **lote → temporada**; a correção pede só a da temporada,
   então não há ciclo de espera.
3. `travarTemporada` passou a ser exportada, para que exista **um lugar só** onde a
   string da chave é escrita.
4. As temporadas da invalidação em lote passaram a ser **ordenadas** (`.sort()`): duas
   invalidações tocando as mesmas duas temporadas em ordens opostas travariam cada uma
   uma chave e esperariam a outra. Ordem total remove o ciclo por construção.

**Isolamento preservado:** temporadas diferentes continuam correndo em paralelo, e há
teste para isso. Nada foi serializado globalmente.

### 4.5 Depois da correção

`tests/t4-concorrencia-do-ranking.test.mjs` — **8 de 8**, incluindo: o recompute espera
a chave presa e conclui quando ela sai; a aplicação do lote espera; seis recomputes
simultâneos respondem `[200,200,200,200,200,200]`; a projeção tem uma linha por
lançamento, sem duplicata nem falta; a soma da projeção continua igual à do ledger.

---

## 5. Diagnóstico de S5 — atomicidade de `adotarLedger`

### 5.1 A operação, mapeada

`muscleWarService.adotarLedger` (linha 960). Três portas de entrada, todas por rota:
`linkItem` (`POST /musclewar/items/:itemId/link`), `vincularPendentesDoAtleta` (fluxo de
aprovação de cadastro) e `adotarIdentidadeExterna`
(`POST /athletes/:id/imported-history/:externalAthleteId/link`).

| # | Escrita | Tabela |
| --- | --- | --- |
| 1 | `updateMany` compare-and-set que reivindica a identidade | `ExternalAthlete` |
| 2 | leitura de temporadas e ids (antes das escritas seguintes) | `RankingPoint` |
| 3 | `updateMany` dá dono ao resultado externo | `ExternalResult` |
| 4 | `updateMany` dá dono ao **lançamento** | `RankingPoint` |
| 5 | `audit.record` | `AuditLog` |
| 6 | `recompute_` por temporada tocada | `RankingPoint`, `PublicRankingEntry` |

**São quatro escritas e N recálculos — o relatório anterior contou três.** A contagem
corrigida está registrada.

### 5.2 Veredito: **S5 NÃO REPRODUZ**

Nenhuma dessas etapas abre transação, e lidas isoladamente formam uma operação de
negócio partida em pedaços. Mas, pelo `asyncHandler`, **já estão todas na mesma
transação** — a da requisição.

Isso não foi aceito como argumento: foi submetido a teste com falha injetada.

### 5.3 Testes de falha — `tests/t4-atomicidade-da-adocao.test.mjs`

A injeção é **real, pelo banco**: um gatilho de QA em `PublicRankingEntry` faz o INSERT
da projeção falhar. `republicarProjecao` é a última coisa de `recomputarEm`, e
`recompute_` é a última etapa de `adotarLedger` — então a falha acontece **depois** de a
identidade ter sido reivindicada, o resultado externo ter recebido dono e o **lançamento
ter sido escrito**. O gatilho tem prefixo `qa_`, é criado e removido pelo próprio
arquivo, em banco descartável.

| Cenário | Medido |
| --- | --- |
| Controle do mecanismo: o gatilho derruba o recálculo, e removê-lo o restaura | PASS |
| Falha no recálculo → identidade **não** reivindicada | PASS |
| Falha no recálculo → `ExternalResult` **sem** dono | PASS |
| Falha no recálculo → **ledger sem dono** (`RankingPoint.athleteId` nulo) | PASS |
| Falha no recálculo → **nenhuma** linha de auditoria | PASS |
| Retentativa depois do rollback conclui e audita | PASS |
| Projeção coerente com o ledger depois da adoção, e soma preservada | PASS |
| Repetir a adoção não duplica lançamento nem pontuação | PASS |
| Duas adoções simultâneas: um dono, um lançamento, nenhum 5xx | PASS |

**7 de 7.** A operação é atômica, e agora existe teste permanente que falha no dia em
que alguém tirar uma rota do `asyncHandler` ou abrir uma escrita fora do contexto.

### 5.4 Três mecanismos de injeção descartados, registrados para ninguém repetir

1. **`vi.spyOn` no serviço de ranking.** Sonda mediu `recompute_ chamado: 0` com a
   adoção respondendo **200**: o objeto que o teste importa por `import ... from` de um
   módulo CJS **não é** o que o serviço carregou por `require`. O spy mutava uma cópia, e
   o teste dava falso negativo silencioso.
2. **Plantar linha de projeção com o id do lançamento em outra temporada**, para colidir
   na chave primária. Não serve: `PublicRankingEntry.id` é chave primária **global**, o
   id não pode existir duas vezes, e o INSERT da fixture falhava antes de a armadilha
   existir.
3. **Prender a chave canônica e deixar a requisição estourar o prazo.** Funciona em
   teoria e envenena a suíte na prática: a própria fixture aplica um lote, que depois do
   T4 também pede essa chave, então os testes seguintes travavam atrás do cadeado.

### 5.5 O que NÃO foi feito, e por quê

Não envolvi `adotarLedger` num `prisma.$transaction`. **Já está em transação**, e o
Proxy devolveria a chamada para a transação em curso: seria um `$transaction`
decorativo, criando a impressão de garantia nova onde só há a antiga. O teste que prova
a garantia vale mais, e é o que foi entregue.

Também não foi criada arquitetura de outbox. Auditoria e notificação são efeitos que
hoje vivem na mesma transação; discutir outbox exige escopo aprovado e está registrado
como recomendação (seção 13).

---

## 6. Diagnóstico de S6 — as quatro políticas com `WITH CHECK = true`

`USING` decide quais linhas o ator **alcança**. `WITH CHECK` decide como a linha **nova**
pode ficar. Com `WITH CHECK (true)`, quem alcança uma linha pode reescrevê-la em
qualquer coisa — inclusive numa linha que jamais poderia ter alcançado. E em política
`FOR ALL` o INSERT é governado **só** pelo `WITH CHECK`: ali, `true` significa inserção
sem restrição alguma.

### 6.1 Inventário e análise individual

| Tabela | Política | Operação | Risco reproduzido | Regra adotada |
| --- | --- | --- | --- | --- |
| `Comment` | `comentario_alteracao` | UPDATE | autor reescreve `authorId` para outro perfil — comentário forjado em nome de terceiro | espelho do `USING` (moderação, autor do comentário, autor da publicação) |
| `Conversation` | `conversa_atualizacao` | UPDATE | participante reescreve `participantIds`, entrega a conversa a estranhos e se apaga dela | ator continua **rastreável**: participante **ou** ex-participante |
| `ConversationMember` | `membro_participante` | ALL (inclui INSERT) | qualquer autenticado insere participação em **qualquer** conversa — entra sozinho em conversa privada alheia | a conversa tem de ser uma **da qual o ator participa** |
| `Notification` | `notificacao_do_dono` | ALL (inclui INSERT) | dono reatribui a própria notificação para outra conta, plantando aviso na caixa de terceiro | UPDATE/SELECT/DELETE fechados ao dono; INSERT amplo, **declarado** em política separada |

**Espelhar o `USING` só serve em UMA das quatro.** Nas outras três quebraria fluxo
legítimo ou não fecharia o ataque — medido no código, não suposto:

- **`Conversation`**: `messengerService.sair` grava, numa só instrução,
  `participantIds: restantes` (sem o ator) e `formerParticipantIds: push(ator)`. Um
  `WITH CHECK` exigindo `ator = ANY(participantIds)` **bloquearia sair da conversa**. O
  comentário do próprio serviço registra que ele contava com a política avaliar a linha
  antiga.
- **`ConversationMember`**: o `USING` tem `"profileId" = mci_current_profile_id()` como
  primeira alternativa. Espelhado, **inserir a si mesmo em conversa alheia continuaria
  passando** — exatamente o ataque. Por isso o `WITH CHECK` exige a conversa, não o
  perfil. Verificado que os dois fluxos que escrevem ali seguem funcionando:
  `createConversation` grava a `Conversation` **com** `participantIds` antes de inserir
  os membros, e `addMembers` é executado por quem já participa.
- **`Notification`**: `notificationService` faz `notification.createMany` com os
  `userIds` de **outras** pessoas — é o que avisar alguém significa. `WITH CHECK
  ("userId" = mci_current_user_id())` desligaria a notificação da plataforma inteira.

### 6.2 A única escrita ampla que permanece, com justificativa

`Notification.notificacao_entrega` — `FOR INSERT WITH CHECK (true)`.

Não existe predicado de **linha** que expresse "o sistema pode avisar quem for
pertinente" sem reimplementar em SQL a autorização que o serviço já faz. Ela fica
**isolada numa política de INSERT** — e não escondida num `true` colado numa política
`FOR ALL`, onde ninguém percebe que também governava o UPDATE.

Controles compensatórios, e o que cobrem de verdade:

- `notificationService` é o único escritor da tabela (medido: nenhum outro serviço chama
  `notification.create`);
- título e mensagem são literais do serviço, não texto escolhido por quem dispara;
- a leitura continua fechada ao dono pelo `USING` — ninguém enxerga notificação alheia;
- a partir desta migration, **ninguém move uma notificação de dono**.

**Risco remanescente declarado:** uma rota futura que aceite `userIds` e texto do
cliente transformaria isso em canal de mensagem forjada. A barreira para esse caso é de
aplicação, não de RLS.

### 6.3 Testes — `tests/t4-rls-with-check.test.mjs`

**17 de 17.** Cada caso escreve **direto na tabela**, com o ator definido pelo mesmo
helper que a aplicação usa, e exige que a recusa venha do PostgreSQL (42501) — um 403 da
rota provaria apenas que o serviço recusou primeiro. Cada recusa vem com **controle
positivo** ao lado, para que "o banco recusou" não possa ser "o banco recusa tudo".

Cobertura: autor edita o próprio comentário (positivo) · autor não reatribui autoria ·
autor da publicação continua apagando comentário alheio (**o F1 do T2 não regrediu**) ·
participante sai da conversa pelo caminho real (positivo) · participante não entrega a
conversa e desaparece · participante renomeia a conversa (positivo) · criação de conversa
grava os membros (positivo) · terceiro não se insere em conversa alheia · quem participa
acrescenta membro (positivo) · notificação chega ao dono escrita por outra pessoa
(positivo, a entrega ampla é desenho) · dono marca como lida (positivo) · dono não
transfere a notificação · a rota de listagem segue funcionando · sobra exatamente **uma**
política com `with_check = true`, e é a declarada · as quatro corrigidas têm
`WITH CHECK` próprio · nenhuma tabela perdeu RLS nem FORCE.

### 6.4 Um teste meu que estava errado, e o achado que ele produziu

Eu afirmei que mover o próprio comentário para outra publicação seria recusado. **Medido:
passa** — e está certo que passe: Bruno continua sendo o autor depois da gravação, então
a linha nova satisfaz a política.

E não é escalada: `comentario_criacao` exige apenas `authorId = ator`, **sem dizer nada
sobre a publicação**. Bruno já podia criar comentário em qualquer publicação no nível do
banco; mover não lhe dá poder novo. O teste passou a medir a propriedade real, com prova
de equivalência ao lado.

**Lacuna remanescente registrada, fora do escopo do S6:** nem a política de INSERT nem a
de UPDATE de `Comment` restringem `postId`. Fechá-la exige um predicado de visibilidade
de `Post` nas duas, é decisão própria e não se resolve trocando `WITH CHECK true`.

---

## 7. Revisão cruzada — regressões

| Suíte | Resultado |
| --- | --- |
| T1 — `gate-autorizacao-por-rota` | **10/10** |
| T2 — `f1-f3-autorizacao-coerente` | **17/17** |
| F2 — `f2-governanca-do-catalogo-global` | **21/21** |
| Controle de mudança — `empacotamento-importador` | **9/9** |
| **Total do bloco de revisão cruzada** | **57/57** |

Verificado especificamente: autorização por rota; F1 e F3; governança do catálogo
global; `categories.manage` e `coaches.link_account`; isolamento entre organizações;
importação de resultados; ledger oficial; recomputação; Overall e títulos; resultados
históricos; auditoria e rastreabilidade.

**Nenhuma das 49 tabelas sem RLS foi alterada.** Nenhuma fórmula de pontuação foi tocada.

---

## 8. Resultados dos gates

| Gate | Comando | Resultado |
| --- | --- | --- |
| Lint | `npm run lint` | **exit 0** |
| Build do frontend | `npm run build` (em `frontend/`) | **exit 0** |
| Suíte S4 | `npx vitest run tests/t4-concorrencia-do-ranking.test.mjs` | **8 passed** |
| Suíte S5 | `npx vitest run tests/t4-atomicidade-da-adocao.test.mjs` | **7 passed** |
| Suíte S6 | `npx vitest run tests/t4-rls-with-check.test.mjs` | **17 passed** |
| T1 + T2 + F2 + empacotamento | `npx vitest run <4 arquivos>` | **57 passed** |
| Migration em banco limpo | `npx prisma migrate deploy` | **exit 0** |
| Gate da superfície pública | `npx vitest run tests/gate-superficie-publica.test.mjs` | **23 passed** |
| Regressão completa | `npm test` | **exit 0** — ver 8.1 |
| Mutation testing | `node scripts/qa/mutantes-t4.mjs` | **exit 0** — ver 8.2 |

Não há `typecheck` neste projeto: é JavaScript com ESLint, sem TypeScript. `npm run
lint` é o gate equivalente, como registrado desde o T2.

O código de saída foi capturado **do próprio comando de teste**, isolado, e não de um
`grep` ou `tail` posterior.

### 8.1 Regressão completa

```
NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 \
DATABASE_URL="postgresql://mci:***@127.0.0.1:5432/mci_test?schema=public" npm test

Test Files  125 passed | 1 skipped (126)
     Tests  2083 passed | 15 skipped (2098)
SUITE_EXIT=0
```

| | |
| --- | --- |
| Arquivos de teste | 126 — **125 aprovados, 1 ignorado** |
| Testes | 2.098 — **2.083 aprovados, 15 ignorados**, 0 falhas |
| Código de saída | **0**, capturado do próprio `npm test` |

Os 15 ignorados são condicionais de ambiente, os mesmos de sempre, e o job de
backend da CI tem oito etapas dedicadas a conferir que nenhuma das suítes
sensíveis foi pulada. O arquivo ignorado é o condicional de ambiente já
existente.

Delta em relação ao SHA inicial: **2.083 − 2.051 = 32**, exatamente os testes
novos desta fase (8 do S4, 7 do S5, 17 do S6).

#### A falha que a primeira execução pegou, e o que ela era

A primeira regressão desta fase fechou com **1 falha**:
`tests/gate-superficie-publica.test.mjs` → *"as cláusulas incondicionais que
EXISTEM são as de sempre, e não crescem"*.

Não era defeito: era o **controle de mudança do próprio repositório** cobrando
registro. Aquele teste fixa a lista EXATA de políticas com cláusula
incondicional, e falha nos dois sentidos de propósito — uma a mais exige decisão
consciente, uma a menos obriga a contar por que saiu.

**A lista encolheu de sete para quatro:**

| Saiu | Por quê |
| --- | --- |
| `Comment.comentario_alteracao` | ganhou `WITH CHECK` espelhando o `USING` |
| `Conversation.conversa_atualizacao` | ganhou "o ator continua rastreável" |
| `ConversationMember.membro_participante` | ganhou "a conversa é uma da qual o ator participa" |
| `Notification.notificacao_do_dono` | ganhou `"userId" = mci_current_user_id()` |

| Entrou | Por quê |
| --- | --- |
| `Notification.notificacao_entrega` | escrita ampla por desenho, isolada num `FOR INSERT`, justificada na seção 6.2 |

Permanecem as três de `qual = true`, que são tabelas de referência lidas pela
superfície pública: catálogo de classes, empresas e títulos Overall. A história
completa de cada saída está escrita no comentário do próprio teste, como ele
exige.

#### Um segundo achado do caminho

O `restaurar` do script de mutação reexecuta a migration, e isso revelou que a
quinta política — `notificacao_entrega` — era a **única da migration sem
`DROP POLICY IF EXISTS`** antes do `CREATE`. As outras quatro tinham. Corrigida
a assimetria; o registro local foi reconciliado no banco de QA descartável e
`npx prisma migrate status` responde "Database schema is up to date!", sem drift.

### 8.2 Mutation testing

`node scripts/qa/mutantes-t4.mjs` — **exit 0**.

| # | Mutante | Veredito | |
| --- | --- | --- | --- |
| T4-M1 | `recompute_` perde a trava da temporada — o S4 original | **MORREU** | 6 testes |
| T4-M4 | as temporadas do ajuste em lote deixam de ser ordenadas | **EQUIVALENTE** | declarado |
| T4-M5 | `Comment` volta a `WITH CHECK (true)` | **MORREU** | 3 testes |
| T4-M6 | `Conversation` volta a `WITH CHECK (true)` | **MORREU** | 2 testes |
| T4-M7 | `ConversationMember` volta a `WITH CHECK (true)` | **MORREU** | 3 testes |
| T4-M8 | `Notification` volta a `WITH CHECK (true)` na política do dono | **MORREU** | 2 testes |
| T4-M9 | `ConversationMember` recebe o **espelho ingênuo** do `USING` | **MORREU** | 1 teste |

**6 mortos, 1 equivalente declarado, 7/7 conforme a expectativa**, com controle
antes (as três suítes verdes sem mutante) e controle depois (a restauração
devolve o verde — sem isso, "MORREU" poderia ser arquivo corrompido em vez de
garantia medida).

**T4-M9 é o mutante mais importante da fase.** Ele aplica a correção que
*parece* certa — espelhar o `USING` — e que não fecha o auto-ingresso em
conversa alheia, porque a primeira alternativa do `USING` é satisfeita por quem
insere a si mesmo. Se ele sobrevivesse, o teste do ataque não estaria medindo
nada.

**T4-M4 é equivalente, e está declarado como tal.** O deadlock que a ordenação
remove exige duas invalidações em lote tocando as mesmas duas temporadas em
ordens opostas, no mesmo instante. Nenhum teste monta esse cenário, e montá-lo
de forma determinística exigiria instrumentar o serviço. A ordenação é correção
**por construção** — ordem total de aquisição — e não por medição. Forçar uma
morte ali seria inventar cobertura.

#### O mutation testing corrigiu a MINHA correção

Na primeira execução, dois mutantes sobreviveram: **T4-M2** (o importador perde
a trava da temporada) e **T4-M3** (a trava do importador volta a ser só a do
lote). Investiguei em vez de forçar a morte, e não era lacuna de teste — era
**linha desnecessária no meu próprio código**.

A primeira versão da correção pedia `travarTemporada` no início de
`aplicarLote`. Isso é redundante: `asyncHandler` abre **uma** transação por
requisição, então os `rankingPoint.create` do laço são invisíveis para outras
transações até o commit, e o commit só acontece depois do `recompute_` no fim da
função — que **espera** a chave. A requisição não consegue publicar nada no
ledger sem antes atravessar a chave canônica.

E a trava era pior que inócua: seguraria a chave da temporada durante a
importação **inteira** — a FASE 13.6 mediu lotes de 100.000 linhas — bloqueando
toda correção daquela temporada sem fechar janela alguma. É exatamente o
"serializar sem necessidade" que o escopo desta fase proíbe.

A linha saiu do serviço, o `export` de `travarTemporada` saiu com ela, e os dois
mutantes saíram do arquivo — com o motivo escrito lá. **T4-M1 passou a matar 6
testes em vez de 3**, porque a garantia ficou concentrada num lugar só. A
conferência estática da suíte do S4, que exigia a chave no importador, também
foi corrigida: ela media a coisa errada.

---

## 9. Arquivos modificados

| Arquivo | Natureza |
| --- | --- |
| `src/services/rankingService.js` | `recompute_` passa a pedir a chave canônica; `travarTemporada` exportada; temporadas do ajuste em lote ordenadas |
| `src/services/muscleWarService.js` | `aplicarLote` passa a pedir a chave canônica da temporada, além da do lote |
| `prisma/migrations/20260925230000_t4_with_check_coerente/migration.sql` | **única alteração estrutural** — substitui 4 políticas, acrescenta 1 |
| `tests/t4-concorrencia-do-ranking.test.mjs` | 8 testes de concorrência (S4) |
| `tests/t4-atomicidade-da-adocao.test.mjs` | 7 testes de falha e rollback (S5) |
| `tests/t4-rls-with-check.test.mjs` | 17 testes de autorização no banco (S6) |
| `scripts/qa/mutantes-t4.mjs` | 9 mutantes: 4 de código, 5 de política |
| `tests/empacotamento-importador.test.mjs` | migration registrada no controle de mudança |
| `tests/gate-superficie-publica.test.mjs` | lista de cláusulas incondicionais: de 7 para 4, com a história de cada saída |
| `docs/audits/T4-INTEGRIDADE-RANKING-SEGURANCA.md` | este relatório |

## 10. Migrations criadas

`prisma/migrations/20260925230000_t4_with_check_coerente/migration.sql`.

**Aditiva.** Substitui quatro políticas e acrescenta uma quinta. Não cria, altera nem
apaga coluna, tabela, índice ou dado. Nenhum RLS é desligado, nenhuma política é
afrouxada. Aplicada **somente no banco de QA local**, e registrada na lista de controle
de mudança de `tests/empacotamento-importador.test.mjs` com a justificativa que o próprio
teste exige.

**Atenção operacional:** o `preDeployCommand` do Render já roda `npx prisma migrate
deploy`. Esta migration **e a do T2** serão aplicadas automaticamente no próximo deploy.
Isso não é decisão minha.

---

## 11. Limitações e riscos remanescentes

- **Produção não foi tocada e não foi verificada.** Todas as medições são do banco de QA
  local. Nada aqui autoriza afirmar que produção está correta.
- **O `Comment.postId` não é restringido pela RLS**, nem no INSERT nem no UPDATE (seção
  6.4). Não é escalada, é lacuna simétrica, e fechá-la é decisão própria.
- **`Notification` INSERT permanece amplo**, com justificativa e controles
  compensatórios (seção 6.2). O risco de uma rota futura aceitar `userIds` e texto do
  cliente é real e é de aplicação.
- **`overall:evento:<eventId>` continua sendo uma chave distinta** da temporada. Não foi
  unificada porque o recurso é outro — o título de um evento — e a unificação
  serializaria eventos da mesma temporada sem necessidade. Nenhum dano foi reproduzido
  nela; fica registrado como não investigado a fundo.
- **O deadlock por ordem de aquisição foi fechado por construção, não por medição** (ver
  T4-M4 na seção 8.2). Montar o cenário determinístico exigiria instrumentar o serviço.
- **A trava do importador depende do contexto de requisição.** Fora de requisição —
  script chamando o serviço direto — não há transação e a trava não valeria. A aplicação
  de lote só acontece por rota, e isso está escrito no comentário do código.
- **Não afirmo que o sistema está seguro nem pronto para produção.** Os testes locais
  passaram; isso é o que foi medido, e é tudo o que foi medido.

## 12. Pendências das 49 tabelas sem RLS

Continuam sem `relrowsecurity` e sem `relforcerowsecurity` — entre elas `Event`,
`Registration`, `CheckIn`, `WeighIn`, `Credential`, `StageBatch`, `Category`,
`CompetitionClass`, `Team`, `Coach`, `Gym`, `RankingSeason`, `Affiliation`,
`Organization`, `OrganizationMember`, `User`.

**Nenhuma foi alterada nesta fase**, conforme determinado. Nenhuma delas foi necessária
para reproduzir S4, S5 ou S6.

Registro de medição lateral: `PublicRankingEntry` **tem** RLS de escrita — descoberto
porque a fixture do S5 tomou 42501 ao tentar inserir sem ator. A barreira está
funcionando.

## 13. Recomendações para a próxima fase

1. **Decidir sobre `Comment.postId`**: acrescentar predicado de visibilidade de `Post`
   às políticas de INSERT e UPDATE, ou declarar que a decisão é do serviço.
2. **Detecção de notificação forjada**: se alguma rota vier a aceitar destinatário e
   texto do cliente, a barreira precisa ser de aplicação, com auditoria.
3. **RLS nas tabelas do núcleo esportivo** (`Event`, `Registration`, `RankingSeason`,
   `Affiliation`), por ordem de sensibilidade — é a maior superfície aberta que resta.
4. **Investigar `overall:evento:<eventId>`** com o mesmo método usado aqui: reproduzir
   antes de mexer.
5. **Outbox para efeitos externos**, se e quando notificação por e-mail ou WhatsApp
   entrar — hoje não há efeito externo irreversível dentro das transações.

## 14. Decisões que precisam da sua autorização

1. **Commit e push desta fase.** Nada foi commitado.
2. **Aplicar as migrations em produção** — a do T2 e a do T4. O próximo deploy as aplica
   automaticamente pelo `preDeployCommand`.
3. **Fechar ou declarar a lacuna do `Comment.postId`.**
4. **Manter ou reduzir o INSERT amplo de `Notification`**, com a justificativa da seção
   6.2 na mesa.
5. **Ampliar RLS às 49 tabelas** — escopo, ordem e fases.
