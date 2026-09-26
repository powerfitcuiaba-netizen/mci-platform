# Relatório técnico — Módulo Treinadores & Equipes

Branch `claude/mci-platform-muscle-contest-o6haz9`. Nada foi enviado ao repositório
remoto, nada foi aplicado em produção, nenhum registro real foi alterado.

Regra deste relatório: **PASS**, **FAIL**, **NOT TESTED** ou **GO COM RESSALVAS**.
Não há "provavelmente", "deve funcionar" nem "parece seguro".

---

## 1. Escopo executado

Implementação integral do módulo no backend e no frontend: modelo de dados, RBAC com
delegação central, RLS, serviços, rotas, telas em três idiomas, suítes de teste,
mutation testing e documentação. As cinco decisões aprovadas (R-01 a R-05) estão
implementadas e medidas; o bloqueio de §8.3 está implementado **como bloqueio**.

## 2. Estado do repositório

| | |
| --- | --- |
| Branch | `claude/mci-platform-muscle-contest-o6haz9` |
| HEAD ao iniciar | `13b8bc8` (T4) |
| Commits criados | nenhum — aguardando autorização |
| Push | **não executado** |
| Migrations em produção | **não aplicadas** |
| Arquivos novos | 11 |
| Arquivos alterados | 25 |

## 3. Matriz de rastreabilidade — decisão → código → teste

| Decisão | Implementação | Medição | Veredito |
| --- | --- | --- | --- |
| R-01 elegibilidade temporal | `rankingService` (`vinculoDaEpoca`), `membershipService.vinculoNaData`, `coachRankingService.divergencias` | `tests/r01-equipe-da-epoca.test.mjs` (6) | **PASS** |
| R-02 delegação central | `CentralAuthorization`, `centralAuthorizationService`, `effectivePermissions` | `tests/permissoes-delegacao.test.mjs` (15), `tests/vinculo-equipe.test.mjs` (28) | **PASS** |
| R-03 aprovação central | `coaches.approve`, `coachService.TRANSICOES` | `tests/modulo-treinadores-equipes.test.mjs` (24) | **PASS** |
| R-04 identidade global × atuação local | `Coach` sem `organizationId`, `CoachOrganization`, `coaches.authorize_org` | idem | **PASS** |
| R-05 minimização de dado | `SELECT_ATLETA_ESPORTIVO`, políticas de `CoachDocument` | idem + `frontend/src/pages/treinadores.test.jsx` (15) | **PASS** |
| §8.3 bloqueio da fórmula | `coachRankingService.FORMULA_HOMOLOGADA = false` | idem, nos dois lados | **PASS** |

## 4. Bloqueios reais encontrados, e o que foi feito com cada um

| # | Bloqueio | Desfecho |
| --- | --- | --- |
| B1 | Não existia mecanismo de delegação: autorização vinha só de `User.role` e `OrganizationMember.role`, sem concessão, prazo ou revogação. | Criada `CentralAuthorization`. **Resolvido.** |
| B2 | A delegação não chegava à autorização: o ator era carregado **fora** do contexto de RLS, e `CentralAuthorization` tem RLS. | `loadUserFromHeader` passou a rodar dentro de `withUserContext`. **Resolvido.** |
| B3 | O treinador não é `OrganizationMember`: `assertCan` recusava todo ato dele. | `assertPodeAtuarNaOrganizacao`, que aceita as duas vias de tenant. **Resolvido.** |
| B4 | O banco não conhecia o treinador: painel dele vinha **vazio**. | Migration `20260926040000`, com predicado de três condições. **Resolvido.** |
| B5 | A confirmação do atleta não conseguia gravar o vínculo (42501). | `vinculo_escrita` partido em INSERT/UPDATE/DELETE; INSERT aceita o próprio atleta. **Resolvido.** |
| B6 | A federação não conseguia autorizar treinador (42501). | `coach_org_escrita`/`_alteracao` aceitam `mci_operator_of(organizationId)`. **Resolvido.** |
| B7 | A busca por matrícula do treinador **não deixava rastro**. | `auditoria_escrita` reconhece o treinador autorizado. **Resolvido.** |
| B8 | A fórmula do ranking de treinadores não está homologada. | **NÃO resolvido, por decisão**: bloqueio implementado. |

## 5. Defeitos pré-existentes achados no caminho

1. **`AppError` descartava `details`.** Construtor com três parâmetros; `errorHandler`
   já copiava `err.details`; 16 chamadas em 9 serviços já o passavam. Nada chegava ao
   cliente. Corrigido. **PASS** (medido em `permissoes-delegacao`).
2. **`atleta_leitura` dava ao visitante anônimo mais acesso que a um treinador
   autenticado.** Consequência do ramo `mci_current_user_id() IS NULL`, que é público
   por desenho. Registrado, e é o que torna a cláusula nova do treinador uma
   correção de assimetria e não um aumento de exposição.
3. **A migration do módulo não era idempotente.** Um `CREATE POLICY` sem
   `DROP ... IF EXISTS` abortava a reexecução e **tudo depois dele** deixava de ser
   aplicado — a falha apareceu longe da causa, como "a busca do treinador não deixa
   rastro". Corrigido; as duas migrations são reexecutáveis.

## 6. Modelo de dados

Três enums, quatro tabelas, colunas em `Coach` e `Team`, três `CHECK` de coerência.
Tudo **aditivo**: nada removido, renomeado ou reescrito. Detalhe em
`docs/MODULO-TREINADORES-EQUIPES.md` §4.

Duas unicidades são do banco, não de `SELECT` anterior — o idioma antifraude que o
projeto já usava em `AthleteTeamMembership.activeAthleteId`:

- `TeamMembershipRequest.pendingAthleteId` → **um pedido pendente por atleta**;
- `CentralAuthorization.activeKey` → **uma concessão viva** por usuário, permissão e
  escopo.

**PASS** — as duas medidas sob concorrência real (`Promise.all` de dois pedidos: um
201, um 409, e uma linha pendente no banco).

## 7. Migrations

| Migration | Natureza | Aplicada |
| --- | --- | --- |
| `20260926020000_modulo_treinadores_equipes` | aditiva: enums, tabelas, colunas, CHECK, políticas das tabelas novas | **local apenas** |
| `20260926040000_treinador_como_ator_de_rls` | aditiva em política: 5 correções medidas | **local apenas** |

Ambas registradas em `tests/empacotamento-importador.test.mjs`, com a justificativa
escrita. `prisma migrate deploy` sem drift; cliente regenerado. **PASS**.

Em produção não foram aplicadas. O `preDeployCommand` do Render roda
`npx prisma migrate deploy`, então o próximo deploy autorizado as aplicará junto com
as de T2 e T4 que ainda aguardam.

## 8. RBAC

Sete permissões novas: `coaches.approve`, `coaches.authorize_org`,
`coaches.read_own`, `teams.read_own`, `athletes.lookup_affiliation`,
`teams.request_membership`, `central.grant`.

Duas listas novas e o que elas fecham:

- `PERMISSOES_CENTRAIS_DELEGADAS = ['athletes.transfer']` — a única coisa delegável.
  Sem lista branca, a tabela viraria uma segunda matriz RBAC, invisível para
  `tests/matriz-de-autorizacao.mjs`.
- `PERMISSOES_NAO_DELEGAVEIS = ['central.grant']` — para que a cadeia termine em
  `SUPER_ADMIN`. Conferida **duas** vezes: na escrita e na leitura, porque uma linha
  gravada por fora da rota não pode virar poder.

**Restrição de comportamento existente, aprovada em R-02:** `EVENT_DIRECTOR` e
`ADMIN` perderam `athletes.transfer`. **PASS**, com teste medindo a recusa do diretor
e a preservação do dado.

## 9. RLS

| Tabela | Antes | Depois |
| --- | --- | --- |
| `CoachDocument` | — | RLS + FORCE, leitura só da mesa central |
| `CoachOrganization` | — | RLS + FORCE, escrita do operador da própria federação |
| `TeamMembershipRequest` | — | RLS + FORCE, quatro atores legítimos |
| `CentralAuthorization` | — | RLS + FORCE, escrita da plataforma, leitura + delegado |
| `Athlete` | leitura: anônimo, dono, membro | **+ treinador autorizado na federação** |
| `AthleteTeamMembership` | leitura: operador, dono; escrita `FOR ALL` operador | **+ treinador da equipe**; escrita partida em três, INSERT aceita o próprio atleta |
| `AuditLog` | escrita: ator + relação com a org | **+ treinador autorizado** |

Tabelas com RLS forçada: **30 → 34**. **PASS** (`tests/rls-runtime.test.mjs`).

Sem `USING (true)`, sem `BYPASSRLS`, sem `SECURITY DEFINER`, sem política global para
`anon`, sem remoção de `FORCE`. Nenhum dos limites absolutos foi tocado.

## 10. Recursão de política — o risco que foi evitado por desenho

A implementação óbvia de "o treinador lê o atleta dele" seria um predicado percorrendo
`AthleteTeamMembership`. Isso produz recursão **real**: `vinculo_leitura` chama
`mci_atleta_do_usuario`, que lê `Athlete`; se `atleta_leitura` passasse a ler
`AthleteTeamMembership`, o PostgreSQL aborta com *infinite recursion detected in policy
for relation*.

Os helpers novos leem apenas `Team`, `Coach` e `CoachOrganization` — nenhuma delas lê
`Athlete` nem `AthleteTeamMembership`. **PASS**, e está escrito na migration.

## 11. Serviços

| Arquivo | Linhas | Responsabilidade |
| --- | --- | --- |
| `coachService.js` | ~600 | cadastro, análise central, autorização por federação, equipes, atletas, documentos |
| `membershipRequestService.js` | ~400 | busca por matrícula, pedido, confirmação, recusa, cancelamento, decisão administrativa |
| `centralAuthorizationService.js` | ~230 | conceder, revogar, listar delegações |
| `coachRankingService.js` | ~200 | elegibilidade, projeção, conferência de R-01, **recusa** de classificação |

Extensões: `membershipService` (`vincularPorConfirmacao`,
`vincularPorDecisaoAdministrativa`, `vinculoNaData`), `partnerService`
(`createTeam` com treinador, `setTeamCoach`), `rankingService` (equipe da época).

## 12. A titularidade mora junto da escrita

`vincularPorConfirmacao` confere `athlete.userId === actor.id` **dentro** da função
que grava, não no serviço que a chama. Um parâmetro "já autorizei" é a forma clássica
de perder essa barreira na próxima chamada que alguém escrever. **PASS** — o mutante
TE-M6 mede exatamente isso.

## 13. APIs

20 rotas novas, todas com linha declarada na matriz de autorização. Uma rota
**removida** (`GET /coaches/ranking`, apelido) para não criar exceção na auditoria de
superfície. Lista completa em `docs/MODULO-TREINADORES-EQUIPES.md` §6.

## 14. Interface

`frontend/src/pages/treinadores.jsx` — três telas:

- **Painel do treinador**: formulário de autocadastro para quem não tem cadastro;
  situação cadastral, federações autorizadas, equipes, atletas, convites enviados e o
  cartão de ranking em homologação para quem tem.
- **Minha equipe** (atleta): convites pendentes, com a **consequência dita antes do
  botão** — vínculo exclusivo, e sair dele depende de decisão central.
- **Treinadores** (administração): fila de análise com as cinco decisões, autorização
  por federação e o painel de delegação central.

Navegação: `minha-equipe` e `treinador` no menu principal, `admin/treinadores` no
administrativo. O item do treinador **não** tem permissão declarada de propósito: uma
conta que ainda não é treinadora precisa justamente do caminho para se tornar uma.

**A tela nunca reescreve a recusa do servidor.** Quando a API explica o que fazer, é
essa frase que a pessoa lê. **PASS**, medido.

## 15. Internacionalização

118 chaves novas em `ptBR`, `en` e `es`. Conjuntos de chaves idênticos:
**1564 = 1564 = 1564**. Nenhum texto novo escrito direto no JSX — a trava de cobertura
de idioma reprovaria. **PASS** (`src/lib/idiomaCobertura.test.js`,
`src/lib/idioma.test.jsx`, 21 testes).

## 16. Notificações

Oito tipos novos. Nenhum dos 16 anteriores cobria estes fluxos: não havia aprovação
cadastral de treinador, nem pedido dirigido ao atleta, nem concessão de delegação.
Tipo genérico deixaria a tela sem saber para onde levar a pessoa. **PASS**.

## 17. Auditoria

21 ações novas, uma por **decisão**. `MEMBERSHIP_REQUEST_ADMIN_APPROVE` é separada de
`MEMBERSHIP_REQUEST_CONFIRM` porque a primeira substitui a vontade do atleta.
**PASS** — a suíte confere a trilha da aprovação central, da busca por matrícula e da
decisão administrativa.

## 18. LGPD e minimização

Projeção explícita, CPF em tabela separada e intocada, documento fora do painel do
treinador e de quem o enviou, `storageKey` fora da resposta. **PASS** — e o teste de
frontend confere no **texto renderizado**, não no objeto da API: nenhuma menção a CPF
ou documento na tela do treinador.

## 19. Antienumeração

Três contenções simultâneas na busca por matrícula, e resposta indistinguível entre
"não existe" e "é de outra federação". **PASS** (`docs/MODULO-TREINADORES-EQUIPES.md` §7).

## 20. Concorrência

| Cenário | Resultado |
| --- | --- |
| Dois pedidos simultâneos para o mesmo atleta | 1× 201, 1× 409, **uma** linha pendente |
| Confirmação de vínculo em atleta já vinculado | 409 com o nome da equipe atual |
| Segunda concessão viva idêntica | 409 `GRANT_ALREADY_ACTIVE`; revogar reabre a vaga |

**PASS**. Em todos os três a garantia é do índice único, não de um `SELECT` anterior.

## 21. Atomicidade

A confirmação fecha o pedido e cria o vínculo na **mesma** transação — e a requisição
inteira já é uma transação só (`asyncHandler` + o proxy de `config/prisma.js`), então a
atomicidade é do desenho. Sem ela, uma falha no meio deixaria pedido confirmado sem
vínculo, ou vínculo com `pendingAthleteId` ainda travando pedidos futuros. **PASS**.

## 22. Elegibilidade de ranking (R-01)

O caminho da importação já cumpria R-01. O **interno** não: lia `Athlete.teamId`, o
vínculo corrente. Corrigido, com uma divergência deliberada em relação ao importador:
aqui **não** há recurso ao vínculo ativo quando não existe vínculo na data, porque a
alternativa honesta é nenhuma equipe — e cair no ativo faria a equipe que chegou depois
receber o ponto, que é a retroatividade que R-01 proíbe.

Essa divergência foi **encontrada por teste**: a primeira versão copiava a cadeia do
importador inteira e reprovou no caso "vínculo que só nasce depois do evento".

**Alcance:** vale para lançamentos **novos**. `recomputarEm` preserva o `teamId`
gravado — medido. Nenhum lançamento existente foi alterado. **PASS**.

## 23. Ranking de treinadores (§8.3)

**Bloqueio implementado como bloqueio.** 409 com o motivo, projeção sem total e sem
posição, elegibilidade por contagem. `FORMULA_HOMOLOGADA` é o único ponto a mudar
quando a homologação sair. **PASS** — e o mutante TE-M10 prova que ligar a constante
reprova a suíte.

## 24. Suítes de teste

| Suíte | Testes | Veredito |
| --- | --- | --- |
| `tests/modulo-treinadores-equipes.test.mjs` | 24 | **PASS** |
| `tests/permissoes-delegacao.test.mjs` | 15 | **PASS** |
| `tests/r01-equipe-da-epoca.test.mjs` | 6 | **PASS** |
| `tests/vinculo-equipe.test.mjs` (estendida) | 28 | **PASS** |
| `tests/gate-autorizacao-por-rota.test.mjs` (estendida) | 11 | **PASS** |
| `frontend/src/pages/treinadores.test.jsx` | 15 | **PASS** |

## 25. Gates pinados que precisaram ser atualizados — e como

| Gate | Mudança | Por quê |
| --- | --- | --- |
| Matriz de autorização | 118 → 138 rotas | 20 rotas novas, cada uma declarada |
| Escopo de plataforma | 2 → 11 rotas, **+ asserção de justificativa escrita** | a exclusão do cross-tenant não pode ser barata |
| RLS forçada | 30 → 34 tabelas | as quatro tabelas novas |
| Lista de migrations | +2 | com a natureza aditiva escrita |
| Auditoria de rotas | 1 rota **removida** | melhor que uma exceção bem explicada |

Nenhum gate foi afrouxado. O de escopo de plataforma ficou **mais** exigente.

## 26. Mutation testing

`npm run qa:mutantes:treinadores` — 14 mutantes de código, 2 de política.

| # | Mutante | Veredito | |
| --- | --- | --- | --- |
| TE-M1 | `coaches.approve` vira permissão do diretor de evento | **MORREU** | 1 teste |
| TE-M2 | a máquina de estados aceita qualquer transição | **MORREU** | 2 testes |
| TE-M3 | a equipe aceita treinador sem autorização na federação | **MORREU** | 1 teste |
| TE-M4 | a projeção esportiva do atleta vira `include` genérico | **MORREU** | 1 teste |
| TE-M5 | a trava de um pedido pendente sai do banco | **MORREU** | 1 teste |
| TE-M6 | a confirmação dispensa a titularidade da conta | **MORREU** | 1 teste |
| TE-M7 | a autoconcessão de delegação é permitida | **MORREU** | 1 teste |
| TE-M8 | a lista branca é ignorada na ESCRITA | **MORREU** | 1 teste |
| TE-M12 | a lista branca é ignorada na LEITURA | **MORREU** | 1 teste |
| TE-M9 | a delegação expirada volta a valer | **MORREU** | 1 teste |
| TE-M10 | a classificação de treinadores passa a existir | **MORREU** | 2 testes |
| TE-M11 | a equipe do ponto volta a sair do cadastro corrente | **MORREU** | 3 testes |
| TE-M13 | o recurso ao espelho desaparece — base antiga perde a equipe | **MORREU** | 9 testes |
| TE-M14 | o espelho passa a valer TAMBÉM com histórico — a retroatividade de volta | **MORREU** | 2 testes |
| TE-P1 | `CentralAuthorization` volta a ser legível por qualquer sessão | **MORREU** | 1 teste |
| TE-P2 | a "simetria" que deixaria o atleta encerrar o próprio vínculo | **SOBREVIVEU** (equivalente declarado) | — |

**15 morreram, 1 equivalente declarado, 16/16 conforme a expectativa.** Controle antes
(as 6 suítes passam sem mutante) e controle depois (as 6 voltam a passar **e** as
políticas do banco conferem com o que o repositório declara). Exit 0.

### Os quatro mutantes que a primeira execução deixou vivos, e o que cada um custou

A primeira bateria teve **três sobreviventes** e um **defeito no próprio script**.
Nenhum deles era ruído:

1. **TE-M4 sobreviveu** porque a asserção de R-05 procurava a ausência de `cpf` — e
   `cpf` não mora em `Athlete`, mora em `AthleteIdentity`. O `include` genérico não
   traria CPF, mas traria `birthDate`, `phone`, `email`, `photoKey`. A correção foi
   **fixar o conjunto de chaves** da projeção, e não procurar campo proibido.
2. **TE-M6 sobreviveu** porque a titularidade é conferida duas vezes — na rota e na
   função que grava — e o teste só passava pela rota. Defesa em profundidade é boa, mas
   barreira que nenhum teste alcança é barreira que a próxima refatoração remove. A
   correção foi um teste que chama `vincularPorConfirmacao` **direto**, com um ator que
   VÊ o atleta (o diretor) para chegar até a conferência em vez de parar num 404.
3. **TE-P1 sobreviveu** porque nenhum teste media a POLÍTICA de `CentralAuthorization`
   — toda leitura pela API já filtrava por permissão ou por `userId`. A correção foi um
   teste que consulta a tabela dentro do contexto de RLS de um terceiro.
4. **E o script deixou o banco mais fraco do que encontrou.** A restauração reaplicava
   só a migration `20260926040000`; `central_leitura` nasce na `20260926020000`, que não
   é reexecutável. Resultado: depois da bateria, a política continuava `USING (true)` no
   banco — e o controle-depois **passou**, porque nenhum teste media aquela política,
   que era exatamente a lacuna que TE-P1 reportava. Corrigido em três frentes: cada
   mutante de política carrega a sua própria restauração, o gate ganhou **conferência do
   texto das políticas** contra o esperado, e o banco foi restaurado à mão na hora.

### O achado tardio de R-01, e por que ele não afrouxa a regra

A regressão completa reprovou **9 testes de `ranking-oficial`** — todos de pontuação de
equipe e de empresa. Causa: a fixture `eventoPontuado` grava `Athlete.teamId` direto,
sem criar linha de `AthleteTeamMembership`, e antes desta fase era esse espelho que a
projeção lia. O mesmo estado existe em base ANTIGA: `athleteService.create` só passou a
criar o vínculo junto numa fase posterior.

A correção distingue **três** respostas onde antes havia duas:

| Situação | Resposta |
| --- | --- |
| Sem histórico de vínculo nenhum | o espelho `Athlete.teamId` — não há fato temporal a contradizer |
| Com histórico, e um vínculo valia na data | esse vínculo |
| Com histórico, e nenhum valia na data | **nenhuma equipe** — resposta definitiva, o espelho não é consultado |

A terceira linha é o que mantém R-01 de pé, e ela é medida por **TE-M14**: transformar
o `null` da terceira linha em recurso ao espelho reprova 2 testes. Qualquer
transferência, desvínculo ou vínculo posterior CRIA histórico, então a
retroatividade que R-01 proíbe continua impossível — ela depende justamente de haver
vínculo novo, e vínculo novo é histórico.

## 27. Regressão completa

| Suíte | Arquivos | Testes | Veredito |
| --- | --- | --- | --- |
| Backend (`npx vitest run`) | 128 passaram, 1 pulado | **2138 passaram**, 15 pulados, **0 falharam** | **PASS** (exit 0) |
| Frontend (`frontend/`) | 60 passaram | **666 passaram**, 0 falharam | **PASS** (exit 0) |

Execução **sequencial e isolada**. Vale registrar por que: duas execuções anteriores
deram falhas que não eram reais — eu rodava suítes pontuais enquanto a regressão
completa corria contra o MESMO banco, e o `TRUNCATE` do `limparBanco` de uma
entrava em deadlock com a escrita da outra (40P01). O diagnóstico só ficou honesto
quando nada mais tocava o banco.

## 28. Lint e i18n

`npm run lint` (eslint, backend + frontend): **PASS**, zero achados. O projeto não usa
TypeScript, então não há `typecheck`; o lint é o gate equivalente.

## 29. O que NÃO foi feito, e por quê

| Item | Situação |
| --- | --- |
| Fórmula do ranking de treinadores | **bloqueada** — §8.3 |
| Push, PR, merge, release, deploy | **não executados** — sem autorização |
| Migration em produção | **não aplicada** — sem autorização |
| QA visual em Chromium nas larguras | **NOT TESTED** — ver §30 |
| Teste de carga | **NOT TESTED** — invasivo, e sem autorização em produção |
| Verificação em produção | **impossível** neste ambiente: o proxy de saída recusa CONNECT para `*.onrender.com` (403) |

## 30. Ressalvas

1. **Responsividade e acessibilidade das telas novas: NOT TESTED em navegador.** As
   telas reusam o design system e os componentes que a suíte visual já cobre
   (`PageHead`, `Modal`, `.table`, `.card`, `.form-grid`), e os testes de unidade
   passam — mas *unidade não prova que a tela CABE*. O script
   `scripts/qa/responsividade.mjs` mede overflow e alvo de toque em 15 larguras num
   Chromium real; estender o roteiro dele para o fluxo do treinador (autocadastro →
   aprovação → autorização → equipe → convite → confirmação) é trabalho de QA visual
   próprio, e não foi executado. **Recomendação: executar antes de publicar.**
2. **A delegação central só é efetiva para quem a RLS já reconhece.** Conceder
   `athletes.transfer` a uma conta sem papel de administrador de plataforma ou de
   operador da federação produz **404**, não 200 — a interseção das duas camadas falha
   fechada, que é o sentido certo do erro, mas é comportamento que quem opera precisa
   conhecer. Está medido, documentado e registrado aqui.
3. **`GET /coaches/me/athletes` faz duas consultas** (equipes, depois vínculos). Em
   volume de equipe real isso é irrelevante; num treinador com centenas de equipes
   valeria uma única consulta com `join`. Não foi otimizado por falta de caso real.
4. **A checagem de restauração do script de mutação é por backup de arquivo**, e não
   pela comparação com `HEAD` que os outros scripts usam (`scripts/qa/lib/restauracao.mjs`).
   O motivo é que os arquivos do módulo estão **não commitados**: a comparação com
   `HEAD` reprovaria sempre. Depois do commit, vale trocar.
5. **Nada foi verificado em produção.** Ver §29.
