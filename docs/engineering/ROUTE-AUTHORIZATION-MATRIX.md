# T1 — Gate exaustivo de autorização por rota

Fase de hardening. **Nenhum código de produção foi alterado.** O que existe aqui é
uma rede de teste e dois achados que ela produziu.

## O que o gate é

| Arquivo | Papel |
| --- | --- |
| `tests/matriz-de-autorizacao.mjs` | a matriz: **uma linha por rota mutante autenticada**, com corpo válido e expectativa declarada |
| `tests/gate-autorizacao-por-rota.test.mjs` | o gate: 13 casos, incluindo a conferência de que a matriz e a superfície do Express são o mesmo conjunto |
| `scripts/qa/mutantes-autorizacao.mjs` | a bateria M1–M6, que prova que o gate falha quando a autorização é removida |

Rodar:

```bash
NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 \
  DATABASE_URL="postgresql://mci:…@127.0.0.1:5432/mci_test?schema=public" \
  npx vitest run tests/gate-autorizacao-por-rota.test.mjs

node scripts/qa/mutantes-autorizacao.mjs
```

O gate entra na CI sem configuração: vive em `tests/` e `npm test` roda o diretório.

## A superfície, medida

| | |
| --- | --- |
| Rotas registradas no Express | **219** |
| Mutantes (POST/PATCH/PUT/DELETE) | **120** |
| Mutantes com `requireAuth` | **118** |
| Mutantes deliberadamente públicas | **2** (`POST /auth/register`, `POST /auth/login`) |
| Linhas na matriz | **118** — o gate exige igualdade de conjuntos |

Distribuição das expectativas: **78 PERMISSAO**, **31 SOCIAL**, **9 AUTOSSERVICO**.

## Por que a matriz é uma lista, e não uma heurística

A ordem dos middlewares é `requireAuth` → (`perm`) → `validate` → controller. Das
118 rotas, só 18 têm `perm()`; nas outras 100 quem recusa é o `assertCan` dentro do
serviço, contra a organização **do recurso**, lida do banco. Esse desenho é o certo
— um middleware não sabe, pela URL, de quem é o evento. O que ele não tem é rede:
uma função que esqueça a chamada responde 200, e `tests/rotas.test.mjs`, que varre
toda a superfície, só exige ausência de 5xx.

E o corpo importa. Onde a autorização está no serviço, o Zod roda **antes** dela: um
corpo inválido responde 400, e um teste que aceitasse 400 como "recusou" estaria
medindo o Zod. Por isso **400 é falha do gate, nunca aprovação** — se um schema
mudar, isto aparece como vermelho.

## Os atores

| Ator | Papel | Para que serve |
| --- | --- | --- |
| `admin` | `SUPER_ADMIN` | constrói a fixture inteira pelas rotas HTTP — **é a prova positiva** |
| `atletaA` | `ATHLETE`, membro de A | autenticado e SEM permissão: o caso de 403 |
| `atletaB` | `ATHLETE`, membro de B | outra federação, sem permissão nenhuma |
| `operadorB` | `EVENT_DIRECTOR` em B | **tem** a permissão, na federação errada: é o ator que isola o tenant |
| `dono` | conta vinculada a um atleta | o limite de auto-serviço |

`operadorB` entrou porque o mutante M3 sobreviveu sem ele: `atletaB` era recusado por
duas razões ao mesmo tempo, e o teste não distinguia tenant de permissão.

## O que o gate afirma

1. **Conjuntos iguais** — rota mutante sem linha na matriz quebra o build; linha órfã também.
2. **401** — as 118 recusam requisição sem token. 400 não serve: significaria que o Zod respondeu antes da autenticação.
3. **403** — as 78 de permissão recusam `atletaA`.
4. **Nenhuma recusa por 400** — teste próprio, para o corpo da matriz não apodrecer.
5. **Cross-tenant** — `operadorB` e `atletaB` recusados em todas as 78 (menos as de escopo de plataforma).
6. **Limite de dono** — 12 rotas com alvo alheio declarado: o recurso de outro é recusado mesmo com o id na mão.
7. **Justificativa obrigatória** — toda exceção de auto-serviço/social carrega `motivo` com texto, e o gate reprova se faltar.
8. **Positivos** — 16 asserções de sucesso na construção da fixture.

## Exceções, e por que nenhuma é bypass

### Auto-serviço (9)
`PATCH /profile`, `POST /profile/password`, `POST /athlete-requests`,
`POST /athlete-requests/:id/cancel`, `POST|DELETE /athlete-requests/:id/photo`,
`POST /me/notices/:id/read`, `POST /notifications/:id/read`, `POST /notifications/read-all`.

Todas operam sobre `actor.id` ou sobre um recurso cuja chave inclui o ator. Exigir
permissão administrativa fecharia a função. Onde existe recurso identificável por id,
a matriz declara `alheio` e o gate prova a recusa.

### Social e mensageria (31)
Publicar, comentar, curtir, salvar, compartilhar, seguir, bloquear, story, denúncia,
conversa, mensagem, reação, entrar/sair de comunidade. O limite é dono ou
participante, e a barreira é a RLS das tabelas sociais. Oito delas declaram `alheio`.

### Escopo de plataforma (2)
`POST /categories` e `POST /coaches`. Conferido no schema: **`Category` e `Coach` não
têm coluna `organizationId`**. Não existe "categoria de outra federação" para
alcançar, então o caso cross-tenant não se aplica — a guarda é a permissão. Ver F2.

### Recusa por não divulgação (declarada linha a linha)
Onze rotas aceitam 404 além de 403, cada uma com a política medida no comentário:
resultado não publicado, lançamento de ranking, lote de importação, documento de
atleta e vínculo de equipe são invisíveis para quem não opera a federação, e 404 é a
resposta honesta — não é acesso.

## Mutation testing

| # | Mutante | Veredito | |
| --- | --- | --- | --- |
| M1 | remove o `assertCan` de `DELETE /events/:id` | **MORREU** | 3 testes |
| M2 | amplia a permissão de `POST /events/:id/credentials` para uma da base | **MORREU** | 1 teste |
| M3 | neutraliza o tenant em `assertOrganization` | **EQUIVALENTE** | declarado |
| M4 | `requirePermission` libera qualquer ator | **EQUIVALENTE** | declarado |
| M5 | `assertPermission` deixa de recusar | **MORREU** | 2 testes |
| M6 | `PATCH /admin/users/:id` perde o `requireAuth` | **MORREU** | 5 testes |

**6/6 conforme a expectativa.** Os dois equivalentes não são lacuna, e forçar uma
morte neles seria inventar cobertura:

- **M3** — `assertCan` confere duas vezes, e `assertPermission(user, perm, organizationId)`
  já é escopada por organização, porque `can()` soma o papel global com os papéis
  **naquela** organização. O tenant só seria a única barreira onde o `assertCan` usa
  permissão da base autenticada; as três ocorrências
  (`membershipService:211`, `rankingService:2168` e `:2486`) estão em rotas **GET**,
  fora do escopo mutante do T1. É a lacuna a fechar na fase de leitura.
- **M4** — defesa em profundidade, medido: com o middleware desligado,
  `PATCH /admin/users/:id` continua respondendo 403, porque `adminService.js:98`
  chama `assertPermission` por conta própria.

## Achados reais — nenhum corrigido

### F1 · `DELETE /social/comments/:id` responde 500 para todo ator autorizado

- **Rota / serviço:** `DELETE /api/v1/social/comments/:id` → `socialService.js:567`
- **Gravidade:** P1 funcional. **Não** é falha de autorização: a autorização está correta (`socialService.js:563` deixa passar autor do comentário, autor da publicação e moderação).
- **Reprodução:** autor apaga o próprio comentário → 500. Autor da publicação apaga comentário alheio na publicação dele → 500. Medido duas vezes, determinístico.
- **Causa-raiz, isolada em psql:**
  ```
  UPDATE "Comment" SET "content"   = 'x'   WHERE id = …  -> UPDATE 1
  UPDATE "Comment" SET "deletedAt" = now() WHERE id = …  -> ERROR 42501
  ```
  com `mci.user_id` do autor definido. Sem ator: `UPDATE 0`. Com e sem `RETURNING`: idem.
  A política de leitura `comentario_leitura` é `deletedAt IS NULL AND EXISTS(post)` —
  **sem a ramificação de autor que `Post` tem**. O soft delete grava exatamente a
  linha que a política proíbe.
- **Alcance:** também `POST /social/reports/:id/resolve` com `removeContent: true` e alvo `COMMENT` (`socialService.js:762`), que usa `updateMany` e sofre a mesma recusa.
- **Não afetados, medidos:** `DELETE /social/posts/:id` e `DELETE /messenger/messages/:id` passam — `post_leitura` e `post_alteracao` incluem `authorId = mci_current_profile_id()`, e `Message` não tem política sobre `deletedAt`.
- **Correção recomendada:** migration aditiva espelhando `post_leitura` em `comentario_leitura` — `mci_is_moderator() OR authorId = mci_current_profile_id() OR (deletedAt IS NULL AND EXISTS(...))`.
- **Teste que detectou:** o caso "o recurso de OUTRO dono é recusado" do gate.
- **Testes a criar depois da correção:** remoção pelo autor do comentário; remoção pelo autor da publicação; remoção por moderação com `removeContent`; e a recusa 403 para terceiro sem relação.
- **Pinado:** `tests/gate-autorizacao-por-rota.test.mjs`, caso `F1: … responde 500`. Ele falha no dia da correção, forçando remover a exceção.

### F3 · `PATCH /athletes/:id` pelo próprio atleta responde 500

- **Rota / serviço:** `PATCH /api/v1/athletes/:id` → `athleteService.js:276`
- **Gravidade:** P1 funcional, com efeito de produto: o atleta não consegue editar o cadastro dele.
- **Causa-raiz:** as duas camadas se contradizem. O serviço tem ramificação explícita para o dono (`ehODono`), que remove os campos do operador e salva o resto. A política diz o contrário:
  ```
  atleta_alteracao  UPDATE
    USING      ("userId" = mci_current_user_id() OR mci_member_of(org))
    WITH CHECK (mci_operator_of(org))
  ```
  O dono **vê** a linha para alterar e **não pode** gravá-la → PostgreSQL 42501 → 500.
- **Consequência para o T1:** a garantia "os campos restritos são ignorados para o dono" **não é verificável** enquanto a rota não responde. É o primeiro teste a escrever depois da correção.
- **Correção recomendada:** decidir qual camada está certa. Se o dono deve editar o próprio perfil, o `WITH CHECK` precisa aceitar `"userId" = mci_current_user_id()`; se não deve, a ramificação `ehODono` do serviço é que sai. É decisão de produto, não de implementação.
- **Pinado:** caso `DEFEITO F3: o dono editando o PRÓPRIO atleta recebe 500`.

### F2 · Catálogos globais graváveis por operador de qualquer federação

- **Rotas:** `POST /categories` (`categories.manage`), `POST /coaches` (`coaches.manage`)
- **Gravidade:** P2 de governança. Não é defeito de código: é consequência do modelo.
- **Evidência:** `Category` e `Coach` não têm `organizationId` no schema. `EVENT_DIRECTOR` tem as duas permissões. Medido: `operadorB`, diretor da federação B, cria categoria e treinador com 201.
- **Risco:** o catálogo oficial de categorias do campeonato é estado mutável compartilhado entre federações — uma delas pode criar categoria que aparece para todas.
- **Correção recomendada:** decisão sua. Tecnicamente: restringir essas duas permissões a papéis de plataforma, ou dar escopo de organização às tabelas.
- **Declarado:** `escopoDePlataforma: true` na matriz, com o motivo.

## O que o T1 NÃO cobre

- **Rotas GET.** O escopo é mutante. E é justamente ali que o tenant é a única barreira (ver M3).
- **A garantia de campos restritos do dono**, bloqueada por F3.
- **RLS, concorrência do ledger, `with_check`, performance, UX** — fases próprias, fora deste escopo por instrução.

---

# T2 — Correção controlada de F1 e F3

Fase seguinte ao T1, autorizada em escopo fechado: corrigir **F1** e **F3**, criar
testes de regressão do comportamento correto, e não tocar em F2, S4, S5, S6 nem RLS
das demais tabelas. Aplicada **somente em QA local**. Sem deploy, sem push, sem
produção.

## O que mudou, e só isso

| Arquivo | Natureza |
| --- | --- |
| `prisma/migrations/20260925070000_f1_f3_autorizacao_coerente/migration.sql` | **única alteração estrutural** — substitui duas políticas, aditiva, nada removido |
| `tests/f1-f3-autorizacao-coerente.test.mjs` | 17 testes do comportamento correto |
| `scripts/qa/mutantes-f1-f3.mjs` | 4 mutantes que revertem as políticas |
| `tests/matriz-de-autorizacao.mjs` | remove a exceção `defeitoConhecido: 'F1'`; corrige o alvo alheio de comentário |
| `tests/gate-autorizacao-por-rota.test.mjs` | remove os dois testes que afirmavam o 500; acrescenta o comentário de fato alheio à fixture |
| `package.json` | alias `qa:mutantes:f1f3` |

**Nenhum arquivo de `src/` foi tocado.** As duas correções são de política de linha:
a lógica de autorização da aplicação já estava certa nos dois casos.

## F1 — exclusão lógica de comentário

`comentario_leitura` passou a reconhecer os **três** atores que
`socialService.deleteComment:563` autoriza:

```sql
mci_is_moderator()
OR "authorId" = mci_current_profile_id()
OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId"
                                    AND p."authorId" = mci_current_profile_id())
OR ("deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId"))
```

A terceira ramificação **não estava na primeira tentativa** e foi o teste que a
exigiu: com apenas moderação e autor do comentário, o autor da publicação apagando
comentário alheio na casa dele continuava recebendo 42501. Corrigido e medido.

Não vaza comentário apagado: quem lista filtra `deletedAt: null`
(`socialService.js:541`), quem apaga confere (linha 560) e quem responde recusa pai
apagado (linha 506). Há teste que percorre os quatro perfis e exige invisibilidade.

## F3 — o atleta editando o próprio cadastro

`atleta_alteracao` ganhou o dono no `WITH CHECK`:

```sql
USING      ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
WITH CHECK (mci_operator_of("organizationId") OR "userId" = mci_current_user_id())
```

Isso é mais do que permissão: `"userId" = mci_current_user_id()` é avaliado na
**linha nova**, então o dono não consegue reatribuir o atleta para outra conta — há
teste que tenta e exige a recusa. É justamente o campo cujo vínculo acidental
originou a operação anterior.

**Nenhum trigger foi criado.** A proteção por COLUNA (filiação, matrícula, número de
atleta, treinador, academia, situação) continua sendo do serviço, via
`camposRestritos` — RLS é row-level e não compara coluna a coluna. A opção de um
trigger `BEFORE UPDATE` foi considerada e recusada nesta fase: ela introduziria um
novo caminho de 42501 não mapeado, ou seja, um novo 500, e mapear `42501` no
`errorHandler` está fora do escopo autorizado. Fica registrado como endurecimento
possível, com esse custo declarado.

## Resultados medidos

| Gate | Resultado |
| --- | --- |
| `tests/f1-f3-autorizacao-coerente.test.mjs` | **17/17** |
| Gate T1 (`gate-autorizacao-por-rota`) | **10/10** |
| Mutação das políticas (`qa:mutantes:f1f3`) | **4/4 mortos**, com controle antes e depois |
| Mutação do T1 (`qa:mutantes:autorizacao`) | **6/6 conforme** — sem alteração |
| Lint | **PASS** |
| Build do frontend | **PASS** |

### O que os 4 mutantes provam

| # | Reverte | Vereditos |
| --- | --- | --- |
| F1-M1 | `comentario_leitura` ao estado do defeito | MORREU — 8 testes |
| F1-M2 | tira só a ramificação do autor da publicação | MORREU — 1 teste |
| F3-M1 | `atleta_alteracao` ao `WITH CHECK` só de operador | MORREU — 5 testes |
| F3-M2 | abre o `WITH CHECK` para qualquer membro | MORREU — 5 testes |

F1-M2 é o mais informativo: ele reproduz exatamente o erro que eu cometi na primeira
versão da migration, e um único teste o pega.

## Três coisas que eu presumi errado, e que a medição corrigiu

1. **`teamId` no `PATCH /athletes/:id`** — presumi que fosse campo restrito
   silenciosamente descartado. É `z.never()` no schema, com mensagem: a rota recusa
   com 400 e manda usar `POST /athletes/:id/team`. Virou teste próprio.
2. **CPF na resposta ao dono** — escrevi um teste exigindo ausência de CPF e ele
   reprovou. A regra declarada é `visibility.js:81`:
   `ehODono || podeVerCpfIntegral ? formatCpf : maskCpf`. O dono ver o **próprio**
   documento é deliberado, e é anterior a esta fase. O teste passou a medir a regra
   real, com controle: terceiro membro da organização sem
   `athletes.read_sensitive` não recebe CPF inteiro.
3. **O alvo "alheio" de `DELETE /social/comments/:id` no gate do T1 estava errado** —
   eu apontava para um comentário na publicação do próprio ator, que ele TEM direito
   de apagar. O 500 do defeito mascarava o meu erro: o teste lia a falha como
   recusa. Corrigido com um comentário de outro autor em publicação de outro autor.

## Riscos remanescentes e limitações

- **Produção não foi tocada e não foi verificada.** A migration existe apenas em QA
  local. Aplicá-la em produção é `npx prisma migrate deploy`, que já é o
  `preDeployCommand`, e continua pendente de autorização sua.
- **A proteção de coluna é da aplicação**, não do banco (ver acima).
- **Exclusão de comentário pelo autor não é auditada** — a arquitetura existente não
  audita ato social ordinário; só a moderação grava `CONTENT_MODERATION`. Não
  acrescentei auditoria para não mudar comportamento além da correção. O teste afirma
  o que existe.
- **F2 foi fechado na fase seguinte.** Ver a seção F2 no fim deste documento.
- **S4, S5, S6 e a RLS das outras 49 tabelas** seguem abertos, como determinado.
- **Não há typecheck** neste projeto: é JavaScript com ESLint, sem TypeScript. O item
  "typecheck" do pedido não tem correspondente — `npm run lint` é o gate equivalente.

---

# F2 — Governança do catálogo global

Fase seguinte ao T2, autorizada em escopo fechado: fechar o achado **F2**, sem tocar
em S4, S5, S6 nem na RLS das outras tabelas. Aplicada **somente em QA local**. Sem
deploy, sem push para produção, sem alteração em dado real.

## A gravidade estava subestimada, e a medição corrigiu isso

O T1 classificou F2 como **P2 de governança**, com o risco descrito como "uma
federação pode criar categoria que aparece para todas". Esta fase percorreu o
caminho inteiro e mediu um alcance maior: não é a lista, é **a guarda do
importador**.

`muscleWarService.js:406` recusa a linha cuja categoria não está no catálogo, com o
motivo `Categoria desconhecida no MCI`. A guarda pergunta ao catálogo — e quem
escreve no catálogo escolhe a resposta.

Cadeia medida ponta a ponta, pelo caminho HTTP real, contra o código **sem**
correção:

| Passo | Medido |
| --- | --- |
| O mesmo lote, ANTES | `conflicts: 1` — "Categoria desconhecida no MCI: …" |
| `POST /categories` como `EVENT_DIRECTOR` | **201** |
| O mesmo lote, DEPOIS | `conflicts: 0`, `recognized: 1` |
| `POST …/apply` | **200**, `applied: 1` |
| Ledger oficial | **1 `RankingPoint`**, 5 pontos, 1º lugar, `categoryId` = a categoria inventada |
| Sobrevive ao `limparBanco` | **SIM** |

Ou seja: o diretor de evento de qualquer federação conseguia **colocar ponto no
ledger oficial sob um recorte que a Muscle Contest nunca homologou**. Isso é **P1**,
não P2. A reclassificação é da medição, não de opinião.

A persistência também foi medida de um jeito que não estava no plano: a primeira
versão da suíte usava um código de categoria fixo e recebeu **409** na segunda
execução. `Category` não está em `TABELAS` de `helpers.mjs` — o catálogo é
pré-requisito de domínio e não é truncado entre testes. Ao limpar o banco de QA,
`DELETE 7`: sete categorias plantadas pelas execuções de medição tinham sobrevivido a
todo `limparBanco`. **A poluição do catálogo não é transitória.**

## A decisão não é simétrica, e cada metade tem a medição que a sustenta

A auditoria ofereceu duas opções técnicas — restringir as permissões a papéis de
plataforma, ou dar escopo de organização às tabelas. Nenhuma das duas serve para as
duas tabelas, porque `Category` e `Coach` são globais por motivos **opostos**.

### `Category` — global porque é OFICIAL

- São **onze** categorias, provisionadas por
  `20260922210000_catalogo_oficial_de_categorias`, fixadas por
  `tests/catalogo-oficial-de-categorias.test.mjs`, anunciadas ao público como "onze
  categorias oficiais".
- Dar `organizationId` a `Category` fragmentaria o catálogo **nacional** por
  federação. Isso seria inventar estrutura esportiva, e está fora do que posso
  decidir.
- O próprio código já dizia a resposta: `eventService.js:250` — *"O catálogo é
  global: gerenciá-lo não é permissão de um tenant."* A matriz de permissões
  contradizia o comentário ao lado da guarda.

**Decisão:** `categories.manage` sai de `EVENT_DIRECTOR`. Passa a ser de plataforma
— `SUPER_ADMIN` e `ADMIN`, por construção da matriz. É o mesmo desenho que
`results.override` já tinha, pelo mesmo motivo, e com o teste equivalente ao que já
existia para ele em `tests/unidade-dominio.test.mjs`.

### `Coach` — global porque um técnico atende várias federações

- Está escrito em `partnerService.js` e é anterior a esta fase. Aqui a lista
  compartilhada **não é defeito, é o modelo.**
- Medido: **nenhuma** política e **nenhum** serviço deriva autorização de `Coach` —
  zero helper `mci_` e zero policy citam coach. O vínculo não dá poder a ninguém.
- Medido: `prisma.coach.create` existe em **um único lugar**, alcançável só por
  `POST /coaches`. Nenhum fluxo de autocadastro cria `Coach`.
- O que **era** defeito é uma coisa só: `Coach.userId` é **UNIQUE**. Quem ocupa o
  vínculo de uma conta impede todos os outros — inclusive a federação do próprio
  técnico. Num cadastro global, esse bloqueio atravessa federações.

**Decisão:** `coaches.manage` **fica** com o diretor do evento — a capacidade de
cadastrar técnico não foi retirada de ninguém. O que saiu é amarrar o cadastro a uma
conta: nasce a permissão `coaches.link_account`, que só papéis de plataforma têm.

## O que mudou, e só isso

| Arquivo | Natureza |
| --- | --- |
| `src/utils/permissions.js` | `categories.manage` sai de `EVENT_DIRECTOR`; nasce `coaches.link_account` |
| `src/services/partnerService.js` | `createCoach` confere `coaches.link_account` quando há `userId` |
| `frontend/src/pages/adminPlatform.jsx` | o botão "Nova categoria" só aparece para quem pode usá-lo |
| `tests/f2-governanca-do-catalogo-global.test.mjs` | 21 testes do comportamento correto |
| `scripts/qa/mutantes-f2.mjs` | 5 mutantes que revertem a decisão |
| `tests/matriz-de-autorizacao.mjs` | comentários: F2 deixou de ser achado aberto |
| `package.json` | alias `qa:mutantes:f2` |

**Nenhuma migration. Nenhuma alteração de schema. Nenhuma política de RLS tocada.**
A correção é de matriz de permissões e de uma conferência no serviço — o modelo de
dados ficou exatamente como estava.

### A ordem das duas conferências em `createCoach` é decisão de segurança

A conferência de `coaches.link_account` vem **antes** da busca do usuário. Consultar
primeiro e recusar depois transformaria a rota em oráculo de existência de conta:
404 para id que não existe, 403 para id que existe — e qualquer diretor de federação
enumeraria contas da plataforma uma por uma, sem nunca conseguir criar nada. Há um
teste só para isso, e é o único que mata o mutante F2-M4.

### O frontend não é autoridade, e continua não sendo

O menu `admin/configuracoes` é liberado no espelho do frontend por `users.read`, que
o diretor do evento **tem** — ele chega à tela para **ler** o catálogo, e é certo que
chegue. Sem a conferência, veria um botão que só responderia 403 depois do clique.
O espelho `frontend/src/lib/permissoes.js` **não precisou mudar**: ele nunca
concedeu `categories.manage` a papel de federação, então `podeCom(...)` já responde
`false` para todos eles e `true` só para `SUPER_ADMIN`/`ADMIN`, que têm `'*'`.

## Mutation testing

| # | Mutante | Veredito | |
| --- | --- | --- | --- |
| F2-M1 | `categories.manage` volta para `EVENT_DIRECTOR` | **MORREU** | 5 testes |
| F2-M2 | a conferência de `coaches.link_account` desaparece | **MORREU** | 4 testes |
| F2-M3 | `coaches.link_account` é concedida ao diretor | **MORREU** | 4 testes |
| F2-M4 | a conferência do vínculo vai para depois da busca — volta o oráculo | **MORREU** | 1 teste |
| F2-M5 | `coaches.link_account` sai da lista mestra | **MORREU** | 5 testes |

**5/5 mortos, 5/5 conforme a expectativa**, com controle antes (a suíte passa sem
mutante) e controle depois (a restauração devolve o verde — sem isso, "MORREU"
poderia ser arquivo corrompido em vez de garantia medida). Nenhum equivalente
declarado nesta fase.

## O que esta fase NÃO fez

- **Não fechou a leitura.** Categoria e técnico continuam visíveis para todos, que é
  o desenho. Há teste de prova negativa para isso: se alguém der escopo de
  organização ao técnico, ele falha e a decisão volta à mesa.
- **Não tocou em `athletes.update`.** Atribuir a um atleta um técnico já cadastrado
  continua sendo do operador da federação — não foi nem podia ser afetado.
- **Não criou fluxo de solicitação de vínculo.** A mensagem do 403 orienta o
  operador a cadastrar o técnico sem vínculo e pedir o vínculo à plataforma. Se você
  quiser que a federação faça isso sozinha, é feature nova e outra autorização.
- **Não mexeu em S4, S5, S6 nem na RLS das outras 49 tabelas.**

## Consequência operacional a registrar

Depois desta fase, **cadastrar categoria no catálogo oficial exige administrador da
plataforma**. Se a intenção for que uma federação possa propor recorte novo, isso
precisa de desenho próprio (proposta + homologação), não de devolver a permissão —
devolver a permissão é exatamente o mutante F2-M1.

Nenhum fluxo de produto fechou: a tela de criação de categoria já vivia no painel da
plataforma (`adminPlatform.jsx`), e `POST /coaches` **não tem nenhuma tela que o
chame** — medido em todo `frontend/src/`.
