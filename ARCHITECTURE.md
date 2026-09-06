# MCI PLATFORM — Decisões de Arquitetura

Registro das decisões estruturais e do porquê de cada uma. Documento vivo:
decisão revista é decisão reescrita aqui, com a data e o motivo.

---

## ADR-001 — Manter Express + Prisma + PostgreSQL

**Data:** 2026-09-06 · **Status:** aceita

A especificação original indicava Supabase. A plataforma já roda sobre
Express 5 + Prisma 6 + PostgreSQL, com camadas separadas, autenticação JWT,
storage e uma suíte de testes de integração.

Migrar para Supabase significaria reescrever autenticação, storage, os 49
endpoints e a camada de repositórios — semanas de retrabalho antes de qualquer
funcionalidade nova. E o ganho seria pequeno: RLS, políticas e constraints são
**nativos do PostgreSQL**, não features do Supabase. Tudo o que a especificação
pede de segurança de banco é alcançável na stack atual.

**Decisão:** preservar a stack. Implementar RLS diretamente em PostgreSQL.

---

## ADR-002 — O domínio competitivo é julgamento por painel, não confronto direto

**Data:** 2026-09-06 · **Status:** aceita · **Impacto:** alto

O schema herdado modelava competição mata-mata: `Match` com `participantA` /
`participantB` e `scoreA` / `scoreB`, `Standing` com vitórias, derrotas e saldo.
Isso descreve futebol ou e-sports.

Fisiculturismo não é confronto direto. Numa bateria, um painel de juízes ordena
**todos** os atletas da categoria, e a colocação final sai da soma dessas ordens
— quem soma menos, vence. Não existe "placar", não existe "saldo de gols", e o
adversário não é uma pessoa: são todos os outros na mesma classe.

**Decisão:** implementar o domínio real (`JudgingSession`, `JudgingScore`,
`CompetitionResult`, `AthletePlacement`). `Match` / `Result` / `Standing`
permanecem no schema **temporariamente**, porque controllers e testes ainda
dependem deles; a remoção é migration própria, depois que os dependentes
migrarem.

---

## ADR-003 — Estender `Enrollment` em vez de criar `Registration`

**Data:** 2026-09-06 · **Status:** aceita

A inscrição de fisiculturismo não é "atleta no evento": é atleta em **uma
categoria/classe específica** do evento, e o mesmo atleta pode se inscrever em
mais de uma (crossover).

Criar uma tabela `Registration` nova deixaria duas fontes de verdade para
inscrição e quebraria o vínculo financeiro já existente (`OrderItem` →
`Enrollment`), que está correto e testado.

**Decisão:** estender `Enrollment` com `eventCategoryId`, `athleteId` e
`registrationNumber`. Os campos nascem opcionais para não invalidar as linhas
já gravadas; o backfill os torna obrigatórios.

---

## ADR-004 — RBAC por permissão nomeada, não por nível numérico

**Data:** 2026-09-06 · **Status:** aceita

O modelo anterior era hierárquico: `PUBLIC: 0 … ADMIN: 5`. Hierarquia numérica
não consegue expressar a regra mais importante do sistema — **o juiz pontua mas
não pode ver contrato, patrocínio ou valor pago** (seção 35). Em escala linear,
todo poder abaixo do nível do papel passa a valer junto.

**Decisão:** cada papel carrega uma lista explícita de permissões nomeadas
(`judging.score`, `results.publish`, `results.override`…). Papel desconhecido
recebe lista vazia — falha fechado. Os seis papéis antigos continuam válidos e
resolvem para os equivalentes atuais, então nenhum usuário perde acesso.

---

## ADR-005 — Transições privilegiadas na máquina de estados

**Data:** 2026-09-06 · **Status:** aceita

Resultado publicado é histórico oficial. Não pode voltar para revisão porque
alguém clicou — mas também não pode ser absolutamente imutável, porque erro
acontece e correção precisa existir.

**Decisão:** a máquina de estados aceita transições que **exigem uma permissão
nomeada**. `PUBLICADO → EM_REVISAO` exige `results.override`, que hoje apenas
`SUPER_ADMIN` possui, e a operação carrega motivo registrado em auditoria.

---

## ADR-006 — O motor de apuração não inventa regra esportiva

**Data:** 2026-09-06 · **Status:** aceita

Quantas notas se descarta e qual desempate se aplica são decisões da federação,
não do software. Assumir um valor no código seria transformar palpite em regra
oficial.

**Decisão:** o motor implementa o **mecanismo** (soma de colocações, descarte de
extremos, cadeia de desempate) e recebe os parâmetros de `ScoringRule`. O padrão
é zero descarte — deliberadamente neutro.

Consequência mais importante: **empate que a regra configurada não resolve não é
decidido no escuro**. O motor devolve o empate sinalizado, `apuravel: false`, e
a decisão passa a ser do juiz principal, registrada. Nenhum pódio sai de
desempate por ordem de id ou data de inscrição.

---

## ADR-007 — Assinatura de determinismo no resultado

**Data:** 2026-09-06 · **Status:** aceita

**Decisão:** toda apuração gera um SHA-256 canônico das entradas (notas, painel,
regra). Guardado junto do resultado publicado, permite provar depois que um
pódio histórico nasceu exatamente daquelas notas — e detectar se alguma foi
alterada. A serialização é canônica: a mesma bateria descrita em outra ordem
gera a mesma assinatura.
