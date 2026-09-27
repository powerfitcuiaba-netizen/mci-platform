# Relatório de correções — achados A-01 a A-12 da auditoria independente

**Módulo:** Treinadores & Equipes (MCI PLATFORM — Campeonato Brasileiro Muscle Contest International)
**Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**Commits desta etapa:** `bd27578`, `540b109`, `374a317`
**Base:** `f626f8b` (fim da FASE 2 da correção de auditoria de autenticação)
**Data:** 2026-09-27

> **Nada foi publicado.** Não houve `push`, PR, merge, deploy, migração em banco de
> produção, seed, reset, truncate ou alteração de dado real. Todo o trabalho está em
> commits locais nesta branch, aguardando autorização expressa de Helder Falcão.

---

## 0. Como ler este relatório

Cada achado tem cinco seções fixas:

| Seção | O que responde |
| --- | --- |
| **O que estava errado** | o defeito, com o código exato |
| **Por que importa** | a consequência no domínio, não na abstração |
| **O que foi feito** | a correção, e o que ela deliberadamente NÃO faz |
| **Como está medido** | os testes, e o mutante que os valida |
| **Resultado** | PASS / FAIL / NOT TESTED / REPORTADO |

Vocabulário de resultado, sem meio-termo:

* **PASS** — corrigido e medido por teste que reprova se a correção for desfeita.
* **FAIL** — tentado e não resolvido.
* **NOT TESTED** — corrigido sem teste automatizado, e a razão está escrita.
* **REPORTADO** — a correção completa depende de decisão que não é técnica. O que
  deu para fazer foi feito; o resíduo está nomeado, com as opções e o custo de cada uma.

---

## 1. Quadro de resultados

| # | Achado | Gravidade avaliada | Resultado |
| --- | --- | --- | --- |
| A-01 | Rotas de ranking do treinador exigiam apenas sessão | **Alta** — leitura de cadastro de terceiro, com ids enumeráveis | **PASS** |
| A-02 | Delegação central aceitava escopo e prazo nulos | **Alta** — poder de R-02 global e perpétuo por omissão de campo | **PASS** |
| A-03 | `atleta_leitura` libera atleta de toda a federação ao treinador | **Média** — mais larga que R-05, sem exposição além da pública | **REPORTADO** (estreitamento parcial aplicado) |
| A-04 | `vinculo_criacao` sem predicado de `teamId` | **Média** — folga de política sem caminho de aplicação hoje | **PASS** |
| A-05 | `UPDATE "Coach" SET status='APPROVED'` sem `WHERE` | **Alta** — aprovação em massa por migration, contra R-03 | **PASS** (publicação bloqueada até decisão) |
| A-06 | Transação do cadastro com prazo padrão de 5s | **Baixa** — recusa de cadastro legítimo sob latência | **PASS** |
| A-07 | Gate visual apagava evidência commitada | **Média** — o gate destruía a prova que existe para produzir | **PASS** |
| A-08 | Credencial de desenvolvimento literal em 17 arquivos | **Baixa** — não é segredo de publicação; faltava o controle | **PASS** |
| A-09 | `POST /profile/password` sem trilha | **Alta** — troca de senha indistinguível de nenhuma troca | **PASS** (tentativa recusada: **REPORTADO**) |
| A-10 | 429 decidido antes do serviço, sem trilha | **Média** — rajada contida e invisível | **PASS** |
| A-11 | Tela administrativa transformava 403 em lista vazia | **Média** — pendência sem resposta por recusa silenciosa | **PASS** |
| A-12 | Recomputo reescrevia atribuição histórica em silêncio | **Média** — R-01 correto, rastro ausente | **PASS** |
| **A-13** | **`GET /coaches` publicava a linha inteira de `Coach`** — achado NOVO, desta etapa | **Alta** — motivo de recusa, contato e estado da análise para qualquer conta autenticada | **PASS** |

Nenhum achado foi fechado com mecanismo proibido. Não há `USING (true)`, `BYPASSRLS`,
`SECURITY DEFINER` privilegiado, política global para `anon`, remoção de
`FORCE ROW LEVEL SECURITY`, teste desativado, cobertura reduzida ou dado real alterado.

---

## 2. A-01 — autorização nas rotas de ranking do treinador

### O que estava errado

`GET /coaches/:id/ranking/eligibility` e `GET /coaches/:id/ranking/projection`
declaravam apenas `requireAuth` (`src/routes/index.js`). No serviço,
`elegibilidade` conferia somente `if (!actor) throw 401` e `projecao` **não conferia
nada**. O controller passava `req.params.id` direto.

Resultado: qualquer conta autenticada — inclusive um atleta recém-cadastrado pelo
autocadastro aberto — lia o `status` do cadastro de qualquer treinador e a lista
nominal das equipes dele.

### Por que importa

Os ids não são secretos: `GET /coaches` é o catálogo do módulo. Ter o catálogo e uma
rota que responde por id é ter a varredura completa. O `status` do cadastro é dado de
análise cadastral (R-03), e a lista de equipes diz quem responde por quem.

### O que foi feito

`assertPodeConsultar(coachId, actor)` em `src/services/coachRankingService.js`,
chamada como primeira linha das duas funções. Três atores, e nenhum a mais:

1. **o dono do cadastro** — conferido pelo `userId` DO BANCO
   (`coach.findFirst({ where: { id, userId: actor.id } })`), nunca por um id vindo da URL;
2. **a mesa central** (`coaches.approve`), que analisa o cadastro — R-03;
3. **a homologação** (`ranking.manage`), audiência declarada da conferência de R-01.

A recusa é **404, e não 403**, idêntica à de id inexistente. Um 403 responderia
"este treinador existe, mas não é seu", que é exatamente o oráculo de que a
enumeração precisa.

Não há cláusula de federação: nenhuma tela pede, e permissão que nenhuma tela usa é
superfície sem dono.

### Como está medido

`tests/hardening-auditoria-treinadores.test.mjs`, bloco A-01 — 6 casos: conta alheia
recebe 404 nas duas rotas e o 404 é byte a byte igual ao de id inexistente; o corpo da
recusa não carrega `status`, nome de equipe nem nome do treinador; o dono continua
lendo; a mesa central lê qualquer um; sem sessão é 401 e não 404; a guarda roda ANTES
da leitura do cadastro, então nem o `status` de um `PENDING` escapa.

**Mutante:** remover as duas chamadas da guarda → **3 testes reprovam**.

### Resultado

**PASS.**

---

## 3. A-02 — escopo e prazo obrigatórios na delegação central

### O que estava errado

Em `effectivePermissions` (`src/utils/permissions.js`):

```js
if (concessao.expiresAt && new Date(concessao.expiresAt) <= agora) continue;
if (concessao.organizationId && organizationId && concessao.organizationId !== organizationId) continue;
if (concessao.organizationId && !organizationId) continue;
```

`organizationId` nulo valia em **todas** as federações; `expiresAt` nulo valia **para
sempre**. E os dois campos eram opcionais no schema Zod e no serviço — omitir era o
caminho mais curto.

### Por que importa

`athletes.transfer` é a permissão de R-02: transferir e desvincular alteram atribuição
de pontos. R-02 pede "permissão específica, **escopo definido** e auditoria". Uma
concessão sem escopo é justamente a que não tem escopo definido — e o estado padrão do
formulário não pode ser o poder máximo.

### O que foi feito

Três conferências, em três camadas:

1. **schema Zod** (`src/utils/schemas.js`): `organizationId: id` e `expiresAt: dataIso`
   passaram a ser obrigatórios;
2. **serviço** (`centralAuthorizationService.conceder`): 422 `ORGANIZATION_REQUIRED` e
   422 `EXPIRES_AT_REQUIRED`, para a chamada que não vem de requisição HTTP;
3. **leitura** (`effectivePermissions`) — e é esta que decide: a linha sem escopo ou sem
   prazo é **ignorada**. A política `central_concessao` autoriza o administrador de
   plataforma a inserir qualquer linha, e script, migration e mão humana no banco não
   passam pelo serviço.

**Nenhum registro real é alterado, revogado ou apagado.** A linha antiga permanece e
apenas deixa de conceder. Duas consequências foram tratadas:

* `scripts/diagnostico-delegacoes-inertes.js` — **somente leitura**, sem imprimir
  DATABASE_URL nem e-mail: conta e lista as concessões vivas que perdem efeito, separa
  as que perdem por falta de escopo das que perdem por falta de prazo, e sai com código 1
  quando há decisão humana pendente antes do deploy;
* a tela de delegação marca essas linhas como **inertes** em vez de escondê-las.

### Como está medido

* `tests/permissoes-delegacao.test.mjs` — função pura: concessão sem prazo é inerte;
  concessão sem escopo é inerte em toda federação, com e sem escopo na pergunta;
  concessão com escopo e prazo vale; concessão de uma federação não vale na outra;
  expiração conferida na hora. Mais duas recusas pela rota.
* `tests/hardening-auditoria-treinadores.test.mjs`, bloco A-02 — **o caso que importa**:
  a concessão é gravada DIRETO na tabela, como um script faria, e a transferência real
  (`POST /athletes/:id/team/transfer`) é recusada com 403; o vínculo não muda; e a linha
  **continua no banco, não revogada**. Mais: concessão vencida, concessão de outra
  federação, concessão correta (que autoriza — a correção não quebrou o caminho legítimo),
  revogação que tira o poder na requisição seguinte, e as duas recusas do serviço chamado
  por dentro.

**Mutantes:** devolver o escopo global → **2 reprovam**; devolver o prazo infinito →
**2 reprovam**.

### Resultado

**PASS.**

---

## 4. A-03 — leitura de atleta pelo treinador

### O que estava errado

`atleta_leitura` (migration `20260926040000`) tinha a cláusula
`mci_treinador_autorizado_de("organizationId")`: o treinador aprovado e autorizado numa
federação lia linha de `Athlete` de **toda** aquela federação. R-05 diz que o treinador
vê dado esportivo, de filiação e de resultado **dos atletas vinculados a ele**.

### Por que importa — e o que a medição mudou no desenho

Três fatos foram medidos **antes** de escolher a correção, e cada um muda o tamanho do
achado:

1. **A primeira cláusula da MESMA política é `mci_current_user_id() IS NULL`.** Visitante
   anônimo lê toda linha de `Athlete` — a vitrine pública do atleta, o ranking público e
   a busca pública dependem disso. Logo o conjunto que o treinador autorizado lê é
   **subconjunto** do que qualquer requisição sem sessão já lê. Antes da cláusula de
   treinador, ele lia **menos** que um anônimo, o que era o defeito original.
2. **O que R-05 protege não está em `Athlete`.** CPF vive em `AthleteIdentity`, documento
   em `AthleteDocument`, cada um com RLS própria. Medido: leitura direta de
   `AthleteIdentity` no contexto do treinador devolve **zero linhas**.
3. **Nesta arquitetura, a privacidade de `Athlete` é da PROJEÇÃO.** As duas projeções que
   o treinador alcança — `SELECT_ATLETA_ESPORTIVO` e `SELECT_LOCALIZACAO` — são listas
   explícitas, sem `cpf`, sem telefone, sem nascimento, sem documento. A RLS é o **piso**.

### O que foi feito

Migration `20260927020000_leitura_de_atleta_pelo_treinador`: a cláusula passa a exigir,
além de cadastro aprovado (R-03) e autorização viva na federação (R-04), que o treinador
seja **responsável por alguma equipe naquela federação**
(`mci_treinador_com_equipe_em(org_id)`).

É o estreitamento que não custa função nenhuma: treinador sem equipe na federação não
tem a quem listar (não há vínculo) e não tem para onde convidar — o pedido de vínculo
exige equipe própria (`autorizarSolicitacao`). Ele lia a federação inteira sem uso
legítimo para a leitura.

Efeito prático imediato em três situações reais: treinador recém-autorizado sem equipe;
treinador que teve a última equipe passada a outro responsável; treinador autorizado numa
federação onde nunca atuou.

### O que NÃO foi feito, e por quê

Estreitar até "somente os atletas efetivamente vinculados"
(`mci_treinador_da_equipe("teamId")` sozinho) **quebra dois fluxos medidos do módulo, e
já quebrou uma vez**: com esse predicado, `POST /team-membership-requests` responde 404
`ATHLETE_NOT_FOUND` e `POST /athletes/lookup-affiliation` responde sempre `found: false`,
porque para **convidar** alguém é preciso enxergá-lo **antes** de ele estar na equipe. A
listagem de pedidos pendentes da equipe perderia o nome do convidado pelo mesmo motivo.

As saídas conhecidas são duas, e nenhuma pode ser tomada por conta própria:

**(i) Propósito declarado na transação.** Um `SET LOCAL` de intenção, conferido pela
política, de modo que só a busca por matrícula e a criação do pedido leiam além do
vínculo. Não é contorno de RLS — não há `SECURITY DEFINER`, `BYPASSRLS` nem
`USING (true)`. **Custo:** espalha uma marca de intenção por três serviços
(`localizarAtleta`, `solicitar`, `listarDaEquipe`), e **esquecer a marca produz lista
vazia silenciosa** — que é o defeito exato que este módulo já teve e que levou meses
para ser notado.

**(ii) Mudar como o atleta é descoberto para convite** — consentimento, diretório de
opt-in, convite por código gerado pelo atleta. É **regra de produto**, e este projeto não
inventa regra esportiva nem de cadastro.

Ambas exigem decisão formal de Helder Falcão. Fica reportado, e não decidido aqui.

### Como está medido

`tests/hardening-auditoria-treinadores.test.mjs`, bloco A-03 — 9 casos:

* treinador aprovado e autorizado **sem equipe** não lê atleta nenhum da federação, e a
  busca por matrícula responde `found: false`;
* **com** equipe, leitura e busca voltam — a correção não quebrou o convite;
* treinador da federação A não lê atleta da B, nem com o id na mão;
* **revogar** a autorização apaga a leitura na requisição seguinte, sem job e sem cache;
* **suspender** o cadastro apaga a leitura, mesmo com autorização e equipe intactas;
* **perder a equipe** para outro responsável apaga a leitura;
* o conjunto que o treinador lê é **subconjunto** do que uma requisição sem sessão lê —
  se um dia deixar de ser, este teste reprova;
* CPF e documento estão fora do alcance: `AthleteIdentity` devolve zero, e a projeção do
  painel não contém `cpf`, `documents`, `storageKey`, `birthDate`, `phone`, `email` nem
  `passwordHash`;
* o treinador não lê vínculo de atleta de outra equipe (`vinculo_leitura` segue por equipe).

**Mutante:** devolver `mci_treinador_autorizado_de` → **2 testes reprovam**.

### Resultado

**REPORTADO.** O estreitamento aplicado é real e medido; o resíduo — leitura de federação
para descoberta de convite — depende de decisão formal, com as duas opções e o custo de
cada uma escritos acima e no cabeçalho da migration.

---

## 5. A-04 — o vínculo por confirmação exige o convite daquela equipe

### O que estava errado

```sql
CREATE POLICY vinculo_criacao ON "AthleteTeamMembership" FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = ... AND mci_operator_of(t."organizationId"))
    OR mci_atleta_do_usuario("athleteId")
  );
```

A cláusula do atleta não dizia **nada** sobre `teamId`. O predicado afirmava "o atleta
cria vínculo para si"; não afirmava "para a equipe que o convidou".

### Por que importa

Não era alcançável pela aplicação — `membershipRequestService.confirmar` passa
`pedido.teamId`, e a equipe vem do pedido, nunca do corpo da requisição. **E é
justamente por isso que a correção não é opcional:** a política era mais larga que o
serviço, e a folga estava esperando o próximo endpoint, o próximo script ou a próxima
refatoração que passasse `teamId` de outra fonte. A RLS é o piso, e o piso não pode
depender de o código acima estar escrito com cuidado.

### O que foi feito

Migration `20260927010000_vinculo_exige_pedido_pendente`: a cláusula do atleta passa a
exigir convite **PENDING** daquela equipe para aquele atleta. O estado é verificável
porque `confirmar` cria o vínculo **antes** de fechar o pedido como `CONFIRMED`.

Sem recursão de política: a cadeia `TeamMembershipRequest` → `Athlete` →
`CoachOrganization`/`Coach` não volta a `AthleteTeamMembership`.

A cláusula do operador é reproduzida byte a byte. `vinculo_alteracao` e `vinculo_remocao`
**não são tocadas** — o atleta continua sem encerrar o próprio vínculo, que é o poder
central de R-02.

Defesa em profundidade no serviço: `vincularPorConfirmacao` recusa com 409
`MEMBERSHIP_REQUEST_REQUIRED`. A RLS devolve erro de banco, que não é mensagem para
pessoa. A conferência fica **depois** da titularidade, para não mudar a recusa que as
suítes já mediam.

### Como está medido

Bloco A-04 — 6 casos. O teste da folga grava **direto na tabela**, no contexto de RLS da
conta do atleta, que é o único lugar onde a política é o que decide: INSERT em equipe que
não convidou é recusado; INSERT na equipe do treinador certo sem convite pendente também;
**com** convite pendente o INSERT é aceito, e o convite de uma equipe não abre a porta da
outra; o serviço recusa com 409 e motivo; o caminho legítimo (convite → confirmação →
vínculo) continua inteiro; e o operador da federação continua gravando sem convite.

**Mutantes:** política antiga → **3 reprovam**; conferência do serviço desligada → **1 reprova**.

### Resultado

**PASS.**

---

## 6. A-05 — o cadastro legado de treinador não fica aprovado por migration

### O que estava errado

`prisma/migrations/20260926020000_modulo_treinadores_equipes/migration.sql`:

```sql
ALTER TABLE "Coach" ADD COLUMN "status" "CoachStatus" NOT NULL DEFAULT 'PENDING';
UPDATE "Coach" SET "status" = 'APPROVED';
```

Sem `WHERE`. O comentário da época declara a intenção — "é a escolha conservadora: um
cadastro criado por operador antes deste módulo já passou pelo controle de acesso da
época".

### Por que importa

A intenção é compreensível e a consequência é outra: R-03 diz que quem aprova ou rejeita
cadastro de treinador é a **administração central da MuscleContest**, e aqui quem aprovou
foi uma migration. Ninguém decidiu, ninguém assinou, nada foi para a trilha.

E o efeito é grande: `status = 'APPROVED'` é o primeiro dos predicados que dão ao
treinador leitura de atleta, autorização por federação e poder de pedir vínculo. Aprovar
em massa é **conceder** em massa.

A migration **ainda não rodou em produção** — pendentes são aplicadas no `preDeployCommand`
do próximo deploy.

### O que foi feito

A correção é **aditiva**, migration `20260927030000_status_legado_de_treinador`:

```sql
UPDATE "Coach"
   SET "status" = 'PENDING'
 WHERE "status" = 'APPROVED'
   AND "reviewedById" IS NULL
   AND "reviewedAt" IS NULL;
```

**Por que não editar a migration original.** Duas razões independentes: o histórico do
projeto é preservado por regra, e migration aplicada é registro do que aconteceu, não
rascunho; e o Prisma guarda o checksum de cada migration aplicada — mudar o arquivo faz
`prisma migrate deploy` **parar** em todo banco que já a rodou, inclusive o de
desenvolvimento de quem já rodou a suíte.

**Por que o predicado não pode errar.** `reviewedById` e `reviewedAt` são escritos
**exclusivamente** por `coachService.transicionar`, o único caminho de aprovação,
rejeição, suspensão, reativação e cancelamento, que exige `coaches.approve` e grava a
trilha na mesma operação. O `UPDATE` sem `WHERE` não os toca. Logo o predicado identifica
exatamente a aprovação que nenhuma pessoa deu, e não alcança cadastro aprovado de verdade.

Funciona nos dois estados possíveis do banco de destino: se a migration anterior ainda
não rodou lá, as duas rodam em sequência no mesmo deploy e o estado final é o certo; se
já rodou, esta corrige o estado existente. É **idempotente**.

`scripts/diagnostico-treinadores-legados.js` — **somente leitura**, sem imprimir
DATABASE_URL, e-mail nem telefone: conta quantos voltam a pendente, quais estão **EM USO**
(com equipe, com atleta no catálogo, com autorização de federação) e quais já foram
aprovados por pessoa e portanto não serão tocados. Sai com código 1 quando há decisão
pendente.

### Consequência operacional, declarada

Cadastro legado volta a pendente, e enquanto estiver pendente o treinador não é
reconhecido como ator nem pela aplicação nem pela RLS. Se algum desses cadastros estiver
em uso, **a mesa central precisa aprová-lo pela rota**, com motivo e trilha, como manda
R-03. É por isso que o diagnóstico roda **antes** do deploy: a decisão é humana e informada.

### Como está medido

Bloco A-05 — 5 casos, e o teste do predicado **executa o SQL do arquivo**, não uma cópia:
aprovar pela rota grava revisor e data; o autocadastro nasce `PENDING` sem revisor; o SQL
atinge o aprovado sem revisor e **não toca** o aprovado por pessoa; é idempotente (a
segunda execução não muda nada); e o efeito é o que importa — cadastro devolvido a
pendente não é ator reconhecido pelo banco, mesmo com autorização e equipe intactas.

### Resultado

**PASS**, com **publicação bloqueada**: rodar o diagnóstico em produção e decidir sobre os
cadastros em uso é pré-requisito do deploy, e a decisão é de Helder Falcão.

---

## 7. A-06 — prazo explícito na transação do cadastro

**O que estava errado.** `register` abre `withUserContext(null, ...)` sem opções, e a
transação interativa do Prisma tem prazo **padrão de 5 segundos**.

**Por que importa.** O cadastro atômico faz `User` + `SocialProfile` (até 6 tentativas de
handle, cada uma com SAVEPOINT, RELEASE ou ROLLBACK) + a linha de auditoria + o
`set_config` do contexto: ~10 idas ao banco no caso comum, até ~20 no pior caso de colisão
de handle. Em PostgreSQL local são dezenas de milissegundos; a 30ms de latência de banco
gerenciado, o pior caso se aproxima do limite — e estourar significa P2028 e cadastro
recusado a quem digitou tudo certo.

**O que foi feito.** `PRAZO_DO_CADASTRO = { maxWait: 5000, timeout: 10000 }`. 10s, e não
mais: transação aberta segura uma conexão do pool, e dilatar o prazo é dilatar quanto
tempo uma rajada de cadastros pode prendê-lo. O `bcrypt.hash` já estava fora da transação
e continua fora — é custo de CPU, não de banco.

**Como está medido.** Sem teste dedicado: reproduzir o estouro exigiria injetar latência
de rede no banco, e um teste que dorme 5 segundos para provar um prazo é um teste que a
próxima pessoa desliga. As suítes de autenticação (`autenticacao-fail-closed`,
`auditoria-de-autenticacao`) continuam verdes, o que prova que o prazo explícito não
mudou comportamento.

**Resultado: NOT TESTED** quanto ao estouro em si; **PASS** quanto a não haver regressão.

---

## 8. A-07 — a evidência de QA não é mais apagada

**O que estava errado.** `scripts/qa/visual-treinadores.mjs` abria com
`rmSync(PASTA, { recursive: true, force: true })`, e `PASTA` tem por padrão
`docs/audits/qa-visual-treinadores` — evidência **commitada**, referenciada pelo relatório
de QA visual.

**Por que importa.** Uma execução do gate apagava o registro de todas as anteriores, e uma
execução que morresse no meio deixava a pasta vazia: o gate destruía a prova que existe
para produzir.

**O que foi feito.** Nada é mais apagado. O que substitui a limpeza é a **denúncia da
defasagem**: o resumo (`evidencias.json`) ganhou `arquivosDeRodadaAnterior`, e a saída do
gate **nomeia** os arquivos que esta rodada não reescreveu. Quem revisa vê que aquele PNG
é de outra rodada em vez de recebê-lo apagado.

**Como está medido.** Verificação estática: `rmSync` não aparece mais no arquivo (só
citado em comentário), e o script continua com sintaxe válida. O gate visual completo é
executado na FASE 6 deste trabalho.

**Resultado: PASS.**

---

## 9. A-08 — inspeção de segredos sem expor valor

**O que estava errado.** A credencial do PostgreSQL de desenvolvimento aparece por extenso
em 17 arquivos de ferramental (suíte, scripts de QA, mutação).

**O que isso é, e o que não é.** Não é vazamento de produção: é a senha do banco
**descartável** que a suíte cria e destrói na máquina de quem desenvolve, em `127.0.0.1`, e
ela precisa ser conhecida para o comando ser um comando só. Trocá-la por variável de
ambiente em 17 arquivos não aumentaria segurança nenhuma e tiraria do ar o `npm test` de
quem clona o repositório.

**O que faltava era o controle:** alguma coisa que distinga "credencial local conhecida e
documentada" de "segredo de verdade commitado por engano".

**O que foi feito.** `scripts/inspecionar-segredos.js` varre **todo arquivo versionado**
(`git ls-files`) contra seis formas de segredo — URL de banco com senha, chave privada PEM,
token do GitHub, chave da AWS, chave de API genérica, JWT concreto — e classifica cada
achado contra uma lista de permitidos em que **cada entrada tem a razão escrita**.

**Regra de ouro do arquivo: nenhum valor é impresso.** Nem inteiro, nem parcial, nem em
mensagem de erro. Sai arquivo, linha e a classe do achado. Quem precisa ver o valor abre o
arquivo — e essa pessoa já tem acesso a ele. A DATABASE_URL também não aparece.

**Como está medido.** Execução real: **470 arquivos inspecionados, 34 achados permitidos
com razão escrita, 0 a explicar, saída 0**. Controle positivo: um arquivo versionado com
uma chave da AWS e uma URL de banco remoto com senha é detectado como 2 achados a
explicar, saída 1 — e nenhum dos dois valores aparece na saída.

**Resultado: PASS.**

---

## 10. A-09 — a troca de senha entra na trilha

**O que estava errado.** `changePassword` conferia a senha atual, gravava o hash novo e
retornava `{ success: true }`. Nenhuma linha de auditoria.

**Por que importa.** É um dos eventos mais importantes de uma trilha de segurança: quem
investiga um acesso indevido precisa saber **quando** a senha daquela conta mudou, e uma
troca sem registro é indistinguível de nenhuma troca.

**O que foi feito.** `audit.registrarObrigatorio` com a ação nova `PASSWORD_CHANGE`, depois
da escrita e antes do retorno. **Fail closed sai de graça aqui:** a rota é autenticada,
então a requisição inteira já corre dentro da transação aberta por
`asyncHandler`/`withUserContext`; `registrarObrigatorio` reaproveita essa transação, e se a
trilha não persistir ele levanta 503 e a transação volta atrás — **a senha não muda**. Não
há estado intermediário possível.

A linha não carrega segredo: sem senha, sem senha antiga, sem hash, sem prefixo, sem
comprimento. O IP vai na coluna própria, como já ia no login.

**O que fica de fora, e por quê.** A **tentativa recusada** (senha atual errada) não é
registrada. Não é esquecimento: ela levanta 401, a exceção desfaz a transação da
requisição, e a linha de trilha gravada nela iria embora com o resto. Registrá-la exige
escrever **fora** da transação da requisição — conexão própria, ator nulo, alvo em
`entityId`, como `LOGIN_FAILED` faz na rota aberta de login. É mudança de mecanismo, está
desenhada e **aguarda decisão**; não foi inventada aqui.

**Como está medido.** `tests/hardening-operacional.test.mjs`, bloco A-09 — 3 casos: a troca
grava `PASSWORD_CHANGE` com autor certo e sem nenhum segredo no corpo da linha, e a senha
nova realmente passa a valer; com a trilha indisponível (gatilho no banco que levanta
exceção no INSERT de `AuditLog`) a resposta é 503, a mensagem não entrega o desenho do
banco, e **a senha antiga continua valendo**; senha atual errada continua recusando 401 e
não troca nada.

**Mutante:** remover a chamada da trilha → **2 reprovam**.

**Resultado: PASS** para a troca; **REPORTADO** para a tentativa recusada.

---

## 11. A-10 — o 429 da porta de entrada entra na trilha

**O que estava errado.** O limitador recusa com 429 em middleware, **antes** de qualquer
serviço rodar. A rajada que ele barra não deixava rastro nenhum.

**Por que importa.** É exatamente o caso em que a trilha mais interessa: 200 tentativas de
login barradas pelo teto são o sintoma de ataque, e `LOGIN_FAILED` **não as vê**, porque o
serviço de login nunca é alcançado.

**O que foi feito.** `rateLimit` ganhou `auditar`, e `bater` passou a informar se aquela é
a **primeira** recusa do balde na janela. Três decisões, e cada uma fecha um jeito de a
auditoria virar problema:

1. **uma linha por janela por balde**, na transição para o estado bloqueado. Uma linha por
   requisição barrada deixaria a trilha crescer no ritmo do ataque — a defesa alimentando
   o ataque;
2. **`record` tolerante, e não `registrarObrigatorio`.** É a única exceção deliberada ao
   fail closed desta base, e a razão é a direção da falha: se a trilha estiver
   indisponível, recusar com 503 em vez de 429 não abre nada (os dois barram), mas trocar
   o código da recusa por causa de auditoria confunde cliente legítimo e cria caminho novo
   de erro na porta de entrada. A perda de linha é contabilizada por `estadoDaTrilha` e
   aparece em `GET /audit/integrity`;
3. **nem ator, nem alvo na linha.** `userId` nulo, porque quem esbarra no teto é
   desconhecido — e na rota de login o limitador roda antes de haver sessão. O valor do
   alvo (o e-mail tentado) **não entra**: guardá-lo faria da trilha uma lista de contas
   sondadas.

Ligado **só** no teto de autenticação. Ligar nos tetos de conteúdo, busca ou mensagem
produziria linha para cada pessoa que clicou rápido — ruído em volume, sem sinal de segurança.

**Como está medido.** Bloco A-10 — 2 casos, com o middleware **real** montado num app
mínimo (em teste `RATE_LIMIT_ENABLED` vem desligado de propósito): a terceira requisição
num teto de 2 é recusada com 429 e `Retry-After`, grava **uma** linha
`RATE_LIMIT_BLOCK` com `userId` nulo, entidade `RateLimit`, nome do limitador, escopo e
teto, e **sem o e-mail do alvo** em nenhum lugar; mais 6 bloqueios não geram linha nova; e
o limitador desligado não recusa nem grava (medido por delta).

**Mutantes:** auditar todo bloqueio → **1 reprova**; não auditar nenhum → **1 reprova**.

**Resultado: PASS.**

---

## 12. A-11 — os estados da tela administrativa

**O que estava errado.** As duas listas da mesa central abriam com
`.catch(() => ({ items: [] }))`: a fila de análise de treinador e a lista de delegação
central. Um 403, um 500 e uma fila genuinamente vazia produziam **a mesma tela** — "nada
aqui". E havia um segundo defeito somado: `AsyncSection` com `empty` renderizava a
mensagem genérica de vazio **e** a mensagem própria da tela, uma debaixo da outra.

**Por que importa.** Numa tela de decisão, quem analisa cadastro conclui que não há
pendência quando o que houve foi recusa — e a pendência fica sem resposta.

**O que foi feito.** Os estados passaram a ser **um por vez**: carregando, recusa de
permissão, erro, vazio, conteúdo. `relancar(erro, { negado, generico })` preserva a falha
para o `AsyncSection` e **distingue a recusa de permissão** das outras falhas — são ações
diferentes: uma se resolve com quem concede acesso, a outra com tentar de novo.
`AsyncSection` ganhou a propriedade `vazio`, para que a tela entregue a própria mensagem
de vazio ao **mesmo** ponto de decisão em vez de somá-la à genérica.

**Como está medido.** `frontend/src/pages/treinadores.test.jsx` — 4 casos novos: 403 na
fila mostra recusa e **não** fila vazia, com botão de tentar de novo; 403 na delegação
mostra recusa e não "nenhuma delegação em vigor"; falha que não é recusa mostra a mensagem
do servidor e não a de permissão; fila realmente vazia continua explicando o vazio **uma
vez só** (antes eram dois textos na mesma seção).

**Mutante:** devolver o `.catch` que engolia → **2 reprovam**.

**Resultado: PASS.**

---

## 13. A-12 — a reatribuição de equipe num recomputo deixa rastro

**O que estava errado.** `awardForResult(..., { recompute: true })` apaga as linhas vivas
do resultado e as recria, e a equipe da linha nova é resolvida **outra vez** pela janela
temporal de R-01.

**Por que importa.** Na etapa normal isso dá exatamente o mesmo `teamId`, porque o vínculo
não muda no passado. Mas ele **muda** quando alguém corrige o histórico de vínculo — uma
data de início errada, um desvínculo registrado atrasado — e aí o recomputo reescreve **a
quem aquele ponto pertenceu**, que é atribuição histórica.

**O que foi feito — e o que deliberadamente não foi.** A correção **não** é impedir a
reatribuição: pela regra R-01, a equipe da data oficial é a certa, e congelar o valor
errado seria preservar o erro. A correção é que ela deixe **rastro**: `awardForResult`
fotografa a atribuição anterior, compara depois, e grava a ação própria
`RANKING_TEAM_REATTRIBUTED` com `{ athleteId, de, para }` por linha mudada,
`SÓ` quando algo mudou — recomputo que reproduz a mesma atribuição não gera evento, senão
a trilha ficaria cheia de "nada mudou" e a mudança de verdade se perderia no meio.

Ação própria, e não campo dentro de `RANKING_UPDATE`: quem audita ranking de equipe
precisa achar as reatribuições sem filtrar JSON — a mesma razão que separou
`RANKING_POINT_EDITED` de `RANKING_POINT_VOIDED`.

**A prévia somente leitura** continua sendo `GET /coaches/ranking/divergences`
(`coachRankingService.divergencias`, exige `ranking.manage`): ela responde, **antes** de
qualquer escrita, quais lançamentos têm `teamId` divergente do vínculo da data. É a
simulação que a homologação exige, e ela não altera nada — há teste que prova que não altera.

**Como está medido.** `tests/r01-equipe-da-epoca.test.mjs`, bloco A-12 — 2 casos: correção
do histórico seguida de reprocessamento grava a mudança com `de` e `para` corretos, e a
linha de ponto realmente muda de equipe (o evento não é decorativo); reprocessamento que
reproduz a mesma equipe **não gera evento nenhum**. O teste já existente que prova que
`POST /seasons/:id/recompute` **preserva** a equipe continua verde.

**Mutante:** remover o bloco do evento → **1 reprova**.

**Resultado: PASS.**

---

## 13-bis. A-13 — o catálogo de técnicos publicava a análise cadastral

> **Este achado não estava na auditoria independente.** Foi encontrado durante a revisão da
> guarda de A-01, ao conferir de onde um atacante tira os ids de treinador. Registrá-lo aqui é
> o mínimo: um achado encontrado e não relatado é pior que um achado não encontrado.

### O que estava errado

```js
async function listCoaches(filtros) {
  return prisma.coach.findMany({
    where: filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {},
    include: { _count: { select: { athletes: true } } },   // ← sem `select`
    orderBy: { name: 'asc' },
    take: filtros.limit || 50
  });
}
```

Sem `select`, a consulta devolve a **linha inteira**. A rota é `GET /coaches` com apenas
`requireAuth` — qualquer conta autenticada, inclusive uma criada pelo autocadastro aberto.

### Por que importa

Antes do módulo, `Coach` tinha `id`, `userId`, `name`, `city`, `state` e datas: largo demais,
mas de baixa consequência. A migration `20260926020000` acrescentou colunas — e `findMany` sem
projeção carrega **tudo o que a tabela ganhar depois**. Passaram a sair na listagem:

| Campo | O que ele revela |
| --- | --- |
| `status` | o estado da análise cadastral de cada técnico |
| `rejectionReason` | **o motivo pelo qual alguém NÃO foi aprovado** |
| `suspendedReason` | o motivo de uma suspensão |
| `reviewedById`, `reviewedAt` | quem julgou, e quando |
| `phone`, `email` | contato pessoal |
| `registration`, `bio` | registro profissional e apresentação |
| `userId` | o elo entre o cadastro e uma conta da plataforma |

Motivo de recusa é informação **sobre uma pessoa**, e a análise cadastral é matéria de R-03 —
da administração central, não de quem se cadastrou ontem. É também mais grave que A-01: A-01
exigia ter o id de um treinador; isto vinha em lista, ordenada por nome, com filtro de busca.

### O que foi feito

Projeção explícita, `SELECT_CATALOGO_DE_TECNICOS`: `id`, `name`, `city`, `state` e a contagem
de atletas. É o que a escolha de um técnico ao cadastrar atleta precisa, e nada além.

`status` fica **fora de propósito**: quem precisa dele é a mesa central, que tem rota própria
(`GET /coaches/review`, com `coaches.approve`). Deixá-lo no catálogo transformaria a listagem
em painel de análise para a plataforma inteira.

A projeção explícita é também o que impede a repetição: a próxima coluna que `Coach` ganhar
**não** entra na resposta por acidente. É a mesma razão pela qual `SELECT_ATLETA_ESPORTIVO` e
`SELECT_LOCALIZACAO` são listas, e não `include`.

### Como está medido

Bloco A-13 — 2 casos: com um cadastro **rejeitado com motivo** (o pior caso), uma conta comum
lista o catálogo e a resposta não contém `status`, `rejectionReason`, `suspendedReason`,
`reviewedById`, `reviewedAt`, `registration`, `phone`, `email`, `userId`, `bio` nem o texto do
motivo; e o catálogo continua servindo para escolher um técnico — a projeção é exatamente
`_count`, `city`, `id`, `name`, `state`, conferida como conjunto.

### Resultado

**PASS.**

---

## 14. Decisões que aguardam Helder Falcão

| # | Decisão pendente | Por que não foi tomada aqui |
| --- | --- | --- |
| D-1 | **A-03**: fechar a leitura de federação — propósito declarado na transação, ou mudança na forma de descobrir o atleta para convite | A primeira espalha uma marca de intenção por três serviços e falha em silêncio se esquecida; a segunda é regra de produto. Nenhuma é decisão técnica. |
| D-2 | **A-05**: o que fazer com os cadastros legados que voltam a `PENDING` e estão em uso | Aprovar cadastro é ato da administração central (R-03). O diagnóstico somente leitura precisa rodar em produção primeiro. |
| D-3 | **A-09**: registrar a tentativa recusada de troca de senha | Exige escrever fora da transação da requisição — mudança de mecanismo, com desenho pronto e sem autorização. |
| D-4 | **§8.3**: a fórmula do ranking de treinadores | Continua **não homologada**. Nada neste trabalho a inventa: `FORMULA_HOMOLOGADA = false`, a classificação recusa com 409 e o motivo, e a projeção não produz total nem posição. |

---

## 15. O que este trabalho não tocou

* Nenhum resultado, ponto, classificação ou vínculo real foi alterado, recalculado ou corrigido.
* O cadastro e o histórico de **Lucas Gouveia Lima** não foram lidos, alterados nem desvinculados.
* Nenhuma fórmula de ranking foi criada, mudada ou ponderada.
* Nenhuma política de RLS foi afrouxada, removida ou substituída por versão permissiva.
  As três migrations desta etapa **acrescentam** predicados e **estreitam** cláusulas; a
  única que escreve dado (`20260927030000`) devolve `Coach.status` ao DEFAULT da coluna.
* Nenhum teste foi desativado, marcado como pendente ou afrouxado para passar.
* Nenhum segredo foi impresso, commitado ou pedido.

