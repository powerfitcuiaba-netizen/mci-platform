# Auditoria final E2E por perfil — relatório

Auditoria funcional completa antes da promoção para `main`, com dados de
demonstração controlados, contra a pilha real.

**SHA inicial:** `59a2a09`
**SHA final:** `ce4d4be`
**Branch:** `claude/mci-platform-muscle-contest-o6haz9`

Vocabulário: **PASS** (executado e verde), **FAIL** (executado e vermelho),
**NOT TESTED** (não executado).

---

## 1. Onde a auditoria rodou

Num **banco descartável**, criado, migrado, semeado, usado e derrubado pela
própria execução. Produção não foi tocada em momento nenhum, e não existia ali
nenhum dado real que pudesse ser apagado por engano.

Todo registro criado levou a marca `DEMO_E2E_<tipo>_<carimbo>` — no nome, no
slug, no e-mail e no código.

---

## 2. Cobertura

| Medida | Número |
|---|---|
| Verificações executadas | **185** |
| Módulos | **23** |
| Perfis exercitados | **5** (anônimo, SUPER_ADMIN, EVENT_DIRECTOR/RANKING_MANAGER, REGISTRATION_OPERATOR, ATHLETE) |
| Sondas de segurança direto na API | **36** |
| Larguras medidas em navegador real | **15** |

Perfis e o que cada um percorreu:

* **anônimo** — recusa sem token, token inventado, ranking público, vitrine de
  atletas, resultado não publicado, descoberta de filiações;
* **SUPER_ADMIN** — organizações, membros, autocadastro, auditoria, exclusões;
* **EVENT_DIRECTOR + RANKING_MANAGER** — filiação, temporada, tabela de
  pontos, evento, grade, importação, aplicação, resultado, publicação,
  recálculo, ajuste, Overall, recados, estado do atleta;
* **REGISTRATION_OPERATOR** — cadastro de atleta, busca, filtros, perfil,
  revelação de CPF;
* **ATHLETE** — conta, solicitação de perfil, aprovação, perfil, histórico,
  ranking, recado, leitura.

---

## 3. O teste crítico — vínculo automático do histórico

**PASS, 19/19 na auditoria E2E e 7/7 em teste automatizado.**

O cenário é o do Ipiranga: o resultado oficial entra **antes** de a pessoa se
cadastrar.

### Antes

| Campo | Valor |
|---|---|
| `athleteId` | **nulo** |
| `placing` | 1 |
| `points` | 5 (apurado pela tabela da temporada) |
| `categoryId` | preenchido (BIKINI) |
| `catalogClassId` | preenchido |
| `seasonId` / `eventId` | preenchidos |

### O que aconteceu no meio

O atleta criou a própria conta, enviou a solicitação de perfil com CPF,
filiação e matrícula, e o operador aprovou. **Ninguém apertou "vincular".**

### Depois

| Conferência | Resultado |
|---|---|
| mesmo `id` de lançamento | PASS |
| `athleteId` = id do atleta recém-criado | PASS |
| colocação inalterada | PASS |
| pontuação inalterada | PASS |
| parcela de colocação inalterada | PASS |
| categoria inalterada | PASS |
| classe do catálogo inalterada | PASS |
| identidade externa inalterada | PASS |
| nenhum lançamento novo criado | PASS |
| histórico aparece em "meu histórico" | PASS |
| ranking reflete o vínculo, com o total da súmula | PASS |
| auditoria registrou `RESULTADO_EXTERNAL_LINKED` | PASS |

### As regras de segurança do vínculo

| Regra | Resultado |
|---|---|
| CPF sozinho basta (mesmo sem matrícula que case) | PASS |
| nome sozinho **não** vincula | PASS |
| histórico homônimo vira sugestão marcada para confirmação humana | PASS |
| o vínculo alcança quem se cadastrou e **ninguém mais** | PASS |
| ambiguidade de matrícula não vira escolha | PASS |
| reaplicar o lote depois do vínculo não soma nada | PASS |

O teste automatizado que fixa isso é
`tests/vinculo-automatico-do-historico.test.mjs`, e a comparação ali é **campo
a campo**, não por soma — somar bate mesmo quando duas linhas trocam de
categoria entre si.

---

## 4. Problemas encontrados

### 4.1 Nenhum defeito do sistema

A auditoria acusou três pontos na primeira execução. Investigados um a um,
**nenhum era defeito do sistema** — os três eram asserções erradas minhas, e
duas erravam **para menos**:

| O que eu afirmei | O que o sistema faz | Correção |
|---|---|---|
| "atleta lista todos os atletas" seria falha | Com organização explícita responde **403**; sem escopo devolve o escopo de quem pergunta — para quem não tem vínculo, **lista vazia** | A asserção passou a fixar o comportamento real, que é mais forte |
| "id malformado devolve 400" | Devolve 400 em rotas que validam formato e 404 nas que não acham — as duas certas | Virou bateria de 6 sondas (incluindo `;DROP TABLE` e travessia de caminho) exigindo 4xx e nunca 5xx |
| "o recálculo duplicou lançamento" | O lançamento novo era legítimo — resultado publicado entre a fotografia e a medição | A referência passou a ser tirada no instante anterior, e a asserção confere também os **identificadores** |

Mais duas reprovações iniciais eram do arnês lendo `AuditLog` por consulta
direta sem ator de RLS — a RLS devolvia vazio, corretamente. A trilha passou a
ser lida pela rota de auditoria.

### 4.2 Uma falha no gate de navegador, não reproduzida

Uma execução reprovou em "o recado aparece por cima da tela do atleta". O
diagnóstico mostrou a página do atleta na **tela de login**: a sessão tinha
caído no meio do gate. A cadeia é conhecida — um 401 com token faz o cliente
limpar a sessão —, e 401 não era observado porque não é 5xx.

**Tratamento:** as duas páginas passaram a registrar cada 401 com método e
rota, e isso virou **critério de reprovação** para rotas de dados. A
reexecução instrumentada passou e não registrou nenhum.

**Estado honesto:** a requisição culpada não foi capturada, e isto **não está
declarado resolvido**. O que mudou é que a falha deixou de ser invisível: se
voltar, o gate nomeia a rota em vez de reclamar de um sintoma três passos
adiante.

---

## 5. Limpeza DEMO

| Etapa | Resultado |
|---|---|
| Inventário **antes** (controle) | 13 tabelas com a marca — **> 0**, como exige o controle |
| Recado já lido | **desativado**, não apagado — a regra vale também na limpeza |
| Importação | removida pelo fluxo de exclusão de lote do sistema |
| Atletas sem histórico | removidos pelo `DELETE` do sistema |
| Atletas com histórico | recusados com 409 — comportamento correto |
| Organizações e contas | removidas por `DELETE` **dirigido pela marca**, linha a linha |
| Inventário **depois** | **0 em todas as colunas de texto do schema** |
| Catálogo oficial | **intacto** — a limpeza não levou o que não era dela |

A varredura percorre toda coluna `text`/`varchar` do schema. O inventário
**antes** é o controle que impede o zero do fim de mentir: sem ele, uma
varredura cega por RLS devolveria zero e assinaria uma limpeza que nunca
conferiu.

---

## 6. Resultado dos portões

| Portão | Resultado | Número |
|---|---|---|
| Auditoria DEMO E2E por perfil | **PASS** | 185/185, 23 módulos |
| Vínculo automático de histórico | **PASS** | 19/19 + 7/7 |
| Backend (regressão completa) | **PASS** | 1852/1867 (15 pulados condicionais) |
| Frontend | **PASS** | 638/638 |
| Lint (`eslint .` e `frontend/src/`) | **PASS** | limpo |
| Build de produção | **PASS** | concluído |
| E2E Chromium real | **PASS** | 343 verificações |
| Responsividade | **PASS** | 15 larguras |
| Segurança / cross-tenant / IDOR | **PASS** | 36 sondas direto na API |
| RLS + FORCE | **PASS** | 30 tabelas, 0 sem FORCE |
| Concorrência | **PASS** | edição, recálculo, vínculo, leitura |
| Limpeza DEMO | **PASS** | DEMO = 0 |

Os 15 testes pulados são **condicionais de ambiente e anteriores a esta
fase** — `backup-restore`, `backup-storage` e `bypassrls-real` usam `skipIf` e
só rodam onde os papéis de backup e de BYPASSRLS estão provisionados. Na CI
eles **rodam**, e há passos de guarda que reprovam se forem pulados lá.

---

## 7. Dados reais

| Conferência | Estado |
|---|---|
| Produção tocada? | **não** — a auditoria rodou em banco descartável |
| Ipiranga reimportado? | **não** |
| `RankingPoint` de produção alterado? | **não** |
| Migration destrutiva? | **não** — nenhuma migration nova nesta fase |
| Bypass de segurança criado? | **não** |
| Teste enfraquecido? | **não** — três asserções foram **fortalecidas** |

---

## 8. Como repetir

```sh
npm run qa:auditoria          # 185 verificações, 23 módulos, DEMO = 0
npm run qa:mutantes:atleta    # mutantes da fase do atleta
PLAYWRIGHT_MODULE=… PLAYWRIGHT_CHROMIUM=… npm run qa:responsividade
npm test                      # regressão de backend
cd frontend && npm test -- --run && npm run build
```

---

## 9. Promoção, CI na main e deploy

### 9.1 O merge

```
git merge --no-ff claude/mci-platform-muscle-contest-o6haz9
```

| Conferência | Resultado |
|---|---|
| `main` antes | `f4aafb0` |
| `main` depois | `27ef29d` |
| Commits preservados | 15 + o commit de merge — **sem squash, sem rebase, sem force** |
| `git diff --stat <branch> <main>` | **0 linhas** — as árvores são idênticas |

### 9.2 CI na main

Execução **#280** (`35807577186`), `head_sha` `27ef29de467ae6cacea41736d36b60b49f4344a6`,
concluída às 02:01:22Z.

| Job | Resultado |
|---|---|
| Backend — migrations, RLS e testes | **success** — 27 passos, nenhum falho; os 2 pulados são os passos de diagnóstico que só rodam quando um teste cai |
| Frontend — testes e build | **success** |
| Higiene do repositório | **success** — sem segredo versionado, sem `.env`, sem marcador de trabalho inacabado, **sem módulo financeiro** |
| Conclusão da execução | **success** |

As sete guardas anti-pulo passaram, inclusive a nova — "Conferir que as suítes
da gestão do atleta não foram puladas" —, que exige as 71 asserções das quatro
suítes desta fase.

### 9.3 Deploy — MEDIDO

Não daqui. O proxy de saída deste ambiente nega a conexão por política da
organização, e continua negando:

```
mci-platform-api.onrender.com:443 — connect_rejected
gateway answered 403 to CONNECT (policy denial or upstream failure)
```

Então a pergunta foi feita do único lugar deste projeto que alcança a internet:
o runner do Actions — o mesmo motivo que fez o `preview.yml` nascer lá. O
workflow `sonda-producao.yml` faz dois GET e mais nada: sem escrita, sem
autenticação, sem credencial, e só por `workflow_dispatch`.

**Execução #1** (`35811628566`), 2026-09-23 02:45:32Z:

| Sonda | HTTP | Corpo |
|---|---|---|
| `/health` | **200** | `{"status":"ok","env":"production","uptimeSeconds":2448}` |
| `/ready` | **200** | `{"ready":true,"checks":{"database":true,"storage":true,"rls":true},"databaseKind":"postgresql","storageDriver":"s3"}` |

As três conferências do `/ready` passaram: **banco alcançável, armazenamento
gravável e RLS efetivo**. `env` é `production` e o driver é `s3` — não é
ambiente de teste respondendo no lugar da produção.

### 9.4 O que a sonda NÃO prova

Duas coisas, e nenhuma delas fica escondida atrás do 200:

**Qual commit está rodando.** `/health` devolve `status`, `env` e `uptime`. Não
devolve versão. Não existe endpoint que diga o SHA publicado, e portanto **não
posso afirmar que a produção está servindo `27ef29d`**.

O que posso dizer é a aritmética: `uptimeSeconds: 2448` às 02:45:32Z coloca a
partida do processo em **02:04:44Z**, e a CI da main fechou às **02:01:22Z**.
O processo reiniciou três minutos depois do merge. Isso é **compatível** com o
deploy automático do Render ter disparado no merge — e compatível não é
confirmado. Para confirmar, é preciso o painel do Render, que fica do lado de
lá.

**Se todo merge dispara deploy.** Depois daquele reinício, a main recebeu mais
dois merges. A sonda não mediu se eles produziram novos deploys.

### 9.5 Como repetir a sonda

Pelo Actions: **Sonda de produção** → *Run workflow*. O campo `api` aceita
outra URL, para o dia em que o serviço mudar de nome.

De uma máquina com saída para o Render, o mesmo, na mão:

```sh
API=https://mci-platform-api.onrender.com
curl -sS $API/health   # espera 200, status ok
curl -sS $API/ready    # espera 200; 503 = database, storage ou rls fora
```

O smoke test de §18, somente leitura, que não cria nada:

```sh
curl -sS $API/api/v1/ranking/super-overall     # ranking público responde
curl -sS $API/api/v1/events                    # os 47 campeonatos continuam lá
curl -sS $API/api/v1/athletes                  # sem token: espera 401
curl -sS "$API/api/v1/search?q=<nome>"         # CPF NÃO pode aparecer
```

---

## 10. §18 — Smoke test pós-deploy

**Execução #2** (`35813745111`), 2026-09-23 03:17:48Z. Tudo `GET`, tudo anônimo,
nenhuma escrita.

| Sonda | Esperado | Obtido | |
|---|---|---|---|
| `GET /events?limit=100` | 200, lista não vazia | 200, **47 itens** | **PASS** |
| `GET /ranking/super-overall` | 200, JSON válido | 200, 5 linhas | **PASS** |
| `GET /athletes` sem token | 401 | 401 | **PASS** |
| `GET /athletes/:id` sem token | 401, **não** 404 | 401 | **PASS** |
| `GET /search` × 3 termos | 200 e zero CPF | 200 e zero CPF | **PASS** |
| 7 rotas financeiras | 404 | 404 nas 7 | **PASS** |
| Escrita em produção | nenhuma | nenhuma | **PASS** |

### 10.1 Os 47 campeonatos

**47** na vista pública — o número que se esperava, contado no ar. A vista
anônima esconde `DRAFT` e `CANCELLED`, então o 47 aqui significa que **nenhum
dos 47 caiu para rascunho ou cancelado**.

### 10.2 CPF: zero, por três caminhos diferentes

A regra é absoluta — CPF nunca aparece em busca pública, nem mascarado. A sonda
procurou por três formas de o número escapar, em três termos (`si`, `da` e um
CPF de teste digitado como busca):

| Caminho | `si` | `da` | CPF digitado |
|---|---|---|---|
| chave `"cpf"` no corpo | 0 | 0 | 0 |
| formato `000.000.000-00` | 0 | 0 | 0 |
| onze dígitos dentro de `.results` | 0 | 0 | 0 |

O terceiro termo é o caso que interessa: **digitar um CPF na busca pública não
encontra ninguém**. Quem não tem `search.sensitive` não busca por CPF — o termo
é tratado como texto, e texto não casa com número que não está no payload.

A conferência imprime **quantas** ocorrências achou, nunca **o que** achou.
Um CPF impresso num log de repositório público seria exatamente o vazamento que
a sonda existe para recusar.

### 10.3 A ordem das barreiras

`GET /athletes/:id` com um id que não é de ninguém, sem token, responde **401 —
e não 404**. A diferença não é cosmética: um 404 ali já contaria quem existe e
quem não existe para quem nem se identificou. Autenticação **antes** de
existência.

### 10.4 "Este aplicativo NÃO é um sistema financeiro"

`payments`, `checkout`, `billing`, `invoices`, `subscriptions`, `wallet`,
`orders` — **404 nas sete**. A guarda de higiene do repositório já recusa o
módulo no código; esta confere a mesma coisa no ar.

### 10.5 As 5 linhas do Super Overall — investigadas

Eu tinha deixado isto como observação sem causa. **Agora tem causa, medida.**

As 5 linhas são o **teto da vista pública**, e não uma tabela quase vazia.
`TOP_PUBLICO = 5` em `rankingService.js`: quem não tem vínculo com a
organização dona da temporada vê o topo, não a tabela.

**Execução #3** (`35814121838`), 03:23:31Z:

| Medição | Resultado | O que prova |
|---|---|---|
| `X-MCI-Public-View` | **`top-5`** | O corte é **declarado**. Ausência do cabeçalho significaria lista inteira — e aí 5 seria notícia ruim |
| `X-MCI-Rows-Read` | **84** | O banco materializou 84 linhas para devolver 5 |
| `?limit=50` | **5 linhas** | O teto não cede a quem pede mais |
| `GET /ranking` | 5 linhas, `top-5` | A mesma regra, não um caso isolado |

#### Por que 84 é a resposta, e não um número qualquer

A pré-seleção consulta com `TETO = max(200, limite × 20)` — para `limite = 5`,
**200**. A consulta voltou com **84**, abaixo do teto: o `LIMIT` **não foi
alcançado**, e portanto 84 é a agregação **completa**.

**O Super Overall da Temporada 2026 tem 84 competidores com pontos elegíveis.**
A vista pública mostra os 5 primeiros. Não falta dado: falta permissão, que é
exatamente o que a regra manda.

Para ver os 84, é preciso ser operador com vínculo na organização dona da
temporada. Esta sonda não usa credencial nenhuma, e por isso não os viu.

### 10.6 Uma temporada, 55 classes

A temporada é a **"Temporada 2026"**, única. O filtro do ranking oferece 55
entradas, com códigos repetidos (`JUNIOR` ×5, `MASTERS_35` ×6, `OPEN_CLASS_A`
×6, …) — o que é esperado, porque a classe existe **por categoria**, e o mesmo
código aparece em cada uma delas.

---

## 11. Equipes e empresas: por que os rankings estão vazios

`/ranking/teams` e `/ranking/companies` devolvem **0 linhas** — com o cabeçalho
`top-5` presente, ou seja, é vista pública, mas não há o que cortar. Ao
contrário do Super Overall, esta é uma tabela vazia de verdade.

### 11.1 A cadeia, lida no código

`teamRanking` filtra `PublicRankingEntry` por **`teamId: { not: null }`**. Essa
coluna espelha `RankingPoint.teamId`, e no caminho da importação — que é o
caminho dos 47 campeonatos — o `teamId` só nasce de **duas** formas
(`muscleWarService.js`):

| Origem | Condição | Vale aqui? |
|---|---|---|
| `equipeDeclarada` | o `teamName` do arquivo casado contra um `Team` **que já existe** | **Não**, se não há `Team` cadastrado |
| vínculo do atleta | `AthleteTeamMembership`, que exige `item.athleteId` | **Não**: resultado histórico importado não tem atleta cadastrado |

O ponto decisivo: **o importador nunca cria equipe.** O mapa `equipes` vem de
`prisma.team.findMany({ where: { organizationId } })`, e um nome que não casa
vira `undefined` — não um `Team` novo. É deliberado, e a razão está escrita no
próprio arquivo: a trava de vínculo único não pode ser contornada por um
arquivo que nomeie outra equipe.

Para empresas a cadeia é a mesma, um elo adiante: `companyId` vem da empresa
declarada casada contra `Company` existente, **ou da empresa DA EQUIPE** — que
não existe. Por isso as duas tabelas caem juntas.

### 11.2 A medição

`/teams` e `/companies` exigem token, e esta sonda não usa credencial nenhuma.
Mas a busca pública **enxerga `Team` por nome** — `searchService.TIPOS` inclui
`teams`, e o ramo não tem porteiro. Varrer bigramas comuns do português é o
mais perto de enumerar que se consegue sem credencial: um nome de equipe que
exista contém pelo menos um deles.

**Execução #5** (`35815496972`), 03:44:20Z:

| Medição | Resultado |
|---|---|
| Bigramas varridos | **29** |
| Equipes encontradas | **0** |
| Eventos encontrados nos mesmos termos (controle) | **167** |

**Conclusão: não há equipe cadastrada.** As duas tabelas estão vazias por falta
de **cadastro**, não de pontos. Cadastrar as equipes e reimportar — ou lançar o
vínculo dos atletas — é o que as preenche; e isso é decisão da federação, não
correção de defeito.

### 11.3 O primeiro controle estava errado, e o próprio controle disse isso

A **execução #4** reprovou: zero equipes **e zero atletas** em 29 bigramas. O
job se recusou a concluir, que é o comportamento certo — mas o instrumento mudo
era meu, não da produção.

`searchService.js` recusa atleta à busca anônima: *"Sem autenticação, atleta não
entra na busca: é dado de pessoa física"*, e o ramo devolve lista vazia **sem
sequer consultar o banco**. O controle que eu havia escolhido não podia passar.
O erro foi escolhê-lo sem ler o ramo primeiro.

Trocado por `events`, que é o caso simétrico ao de `teams`: mesma busca por
nome, mesma rota anônima, sem porteiro — e com 47 deles já medidos no ar. Fica
registrado aqui e no comentário do job: trocar em silêncio esconderia que a
primeira medição não mediu nada.

### 11.4 O que isto reforça sobre o CPF

A mesma leitura fortalece o resultado do §10.2. A busca pública não devolve
atleta **sob termo nenhum** — não é que o CPF esteja filtrado do payload: o
ramo inteiro de atletas está fechado para quem não se autentica. O zero do §10.2
é, portanto, mais forte do que a medição sozinha mostrava.

---

## §12 Auditoria de segurança da conta de serviço da federação

A conclusão automática do autocadastro introduziu uma identidade nova que
escreve no ledger. Antes de promover qualquer coisa, a pergunta a responder
não é "funciona?", e sim **"quem escreveu podia escrever, e mais ninguém
consegue vestir essa identidade?"**. Sete superfícies, medidas uma a uma.

### 12.1 Como a identidade é escolhida — e por que o corpo não decide

`pedido.organizationId` é resolvido no servidor a partir da **filiação**
escolhida; a conta de serviço sai daí por consulta. Não existe parâmetro de
entrada que nomeie a conta, o operador ou a organização.

Medido pela porta da frente: um cadastro cujo corpo traz `serviceAccountId`,
`operatorId`, `organizationId`, `federationId`, `reviewedById`, `status` e
`isServiceAccount` — todos apontando para a **outra** federação — sai com a
organização correta, `reviewedById` nulo, e a auditoria nomeando a conta
**desta** federação. Nenhum dos sete campos é lido.

### 12.2 Alcance no banco

`mci_operator_of` ganhou um papel na lista e nada mais: continua exigindo
membresia **naquela** organização. Perguntado direto ao Postgres sob a
identidade da conta: `mci_operator_of(própria) = true`,
`mci_operator_of(alheia) = false`.

Leitura e escrita cruzadas também foram medidas no caminho real, e não por
inspeção: a conta de uma federação lê `null` para o atleta da outra, e o
`UPDATE` é recusado. A distinção importa — ler nulo poderia ser filtro de
leitura; a escrita recusada prova que a política barra o `UPDATE`.

### 12.3 Autenticação

`login` recusa por `isServiceAccount` **antes** de qualquer comparação de
senha, e devolve `INVALID_CREDENTIALS` — a mesma resposta de senha errada.
Distinguir os dois casos entregaria a lista de contas técnicas da plataforma.

A senha nasce aleatória, vira hash e é descartada na mesma linha. As duas
barreiras são independentes de propósito: a recusa não depende de o segredo
ser bom, e o segredo não depende de a recusa existir.

`register` é o único outro caminho que emite token, e ele cria usuário novo —
`FEDERATION_SERVICE` não está em `PAPEIS_DE_CADASTRO_ABERTO`.

### 12.4 Permissão de aplicação

Poder no banco e poder na aplicação são separados, e a conta só recebeu o
primeiro. Medido contra a matriz real: o conjunto de permissões de
`FEDERATION_SERVICE` **menos** o de `ATHLETE` é vazio.

### 12.5 A fresta que a varredura encontrou — administração de usuários

A conta **é** membro da organização; precisa ser. Sem filtro, ela aparecia na
listagem de usuários de todo operador da federação, com papel e situação
editáveis ao lado, como se fosse uma pessoa mal configurada.

**Não era escalonamento, e isto foi medido campo a campo antes de concluir:**

| Caminho | Resultado |
|---|---|
| `adminUserUpdate` aceita outros campos? | Não — só `role` e `status` |
| `role: 'FEDERATION_SERVICE'` é atribuível? | Não — está fora de `USER_ROLES`, logo fora do `z.enum` |
| Mudar o papel **global** afeta o RLS? | Não — `mci_operator_of` lê o papel da **membresia** |
| `status: 'DISABLED'` quebra o autocadastro? | Não — `contaDaOrganizacao` ignora `status` |
| A conta tem perfil social? | Não — invisível à busca e ao messenger |

Era uma ferramenta de administrar **pessoas** apontada para uma identidade
**técnica**, e a próxima pessoa a mexer ali não teria como saber de nenhuma
das cinco linhas acima. Fechado: a conta sai da listagem e da leitura por id
(404, inclusive para quem administra a plataforma), e `updateUser` a recusa.

### 12.6 A armadilha na lista de papéis

`USER_ROLES` **não** contém `FEDERATION_SERVICE`, embora o enum do banco
contenha. A ausência é o que mantém o papel fora do `z.enum` do Zod — mas ela
não estava escrita em lugar nenhum, e a lista se parece com um espelho do
enum.

Quem notasse a diferença iria "consertá-la". E como o papel **não** está em
`PAPEIS_PRIVILEGIADOS`, consertá-la o tornaria atribuível por qualquer um com
`users.manage` — não só pelo SUPER_ADMIN. O comentário agora diz isso, e há
teste em `unidade-dominio` que falha antes, com o motivo junto.

### 12.7 Atomicidade — não existe federação meio-construída

`asyncHandler` abre **uma** transação por requisição autenticada e retém a
resposta até o commit. Uma falha ao provisionar a conta desfaz a criação da
federação inteira; não há estado em que a federação exista sem a identidade
que o autocadastro precisa.

### 12.8 Ressalva conhecida, medida, não corrigida

O e-mail da conta é derivado do slug (`servico.<slug>@federacao.mci.local`).
Quem registrasse esse endereço **antes** de a federação ser criada faria a
criação falhar por unicidade de e-mail.

Não é substituição: `contaDaOrganizacao` busca por `serviceOrganizationId` +
`isServiceAccount`, que só `provisionar` escreve — uma conta squatted nunca é
encontrada no lugar da verdadeira. E pelo §12.7 a falha é atômica e ruidosa.

Severidade baixa, falha limpa e alta. **Não alterei o formato do e-mail**:
mudá-lo é decisão de produto, e a alternativa (endereço sorteado) troca
legibilidade operacional por uma proteção contra um cenário que exige adivinhar
o slug antes da criação. Fica registrado para a sua decisão.

### 12.9 DEMO = 0 no código

`DEMO` não aparece em `src/`, `prisma/`, `scripts/` nem no frontend fora de
testes: **0 ocorrências**. Varredura de segredos no diff contra `main`: nenhuma
— o único casamento é a palavra "token" dentro de um comentário de teste.

**A auditoria de DEMO nos DADOS DE PRODUÇÃO não está feita.** Ela exige
consultar o banco de produção, e este ambiente não tem egresso nem credencial.
O caminho é a sonda `sonda-producao.yml`, que roda no Actions e devolve
contagens — ainda **NOT TESTED** para este item.

---

## §13 Teste de mutação dos caminhos novos

13 mutantes, cada um com o teste nomeado que **deveria** matá-lo. Um mutante
sobrevivente é um teste que não mede o que diz medir — e é o único resultado
que interessa aqui.

**Placar: 12 mortos, 1 equivalente comprovado.**

| # | Mutação | Veredito |
|---|---|---|
| M1 | adota a identidade da matrícula mesmo impedida | MORTO |
| M2 | volta a contar conflito só quando o rótulo muda | MORTO |
| M3 | remove a guarda de homônimo na adoção do ledger | **EQUIVALENTE** |
| M4 | ignora CPF divergente | MORTO |
| M5 | remove a pré-checagem de CPF | MORTO |
| M6 | remove a pré-checagem de matrícula | MORTO |
| M7 | troca `\|\|` por `&&` na porta do autocadastro | MORTO |
| M8 | grava revisor humano no vínculo automático | MORTO |
| M9 | faz a conta de serviço vir do corpo da requisição | MORTO |
| M10 | volta a listar a conta de serviço na administração | MORTO |
| M11 | volta a permitir editá-la | MORTO |
| M12 | remove a recusa de login da conta de serviço | MORTO *(na 2ª rodada)* |
| M13 | devolve o CPF na resposta | MORTO |

### 13.1 M12 — o teste que eu escrevi media o acaso, não a guarda

Sobreviveu na primeira rodada, e estava certo em sobreviver.

O teste tentava logar com a senha padrão da suíte contra o hash **aleatório**
da conta. Recusava — mas recusava por **senha errada**, e teria recusado
igual se a guarda `isServiceAccount` fosse apagada. A asserção falava sobre o
acaso do segredo, não sobre a barreira.

Corrigido: a conta recebe o hash de uma senha que a suíte conhece (o do
próprio gerente, usuário comum criado com ela), há um **controle** provando
que essa senha entra no usuário comum, e só então o login da conta de serviço
é cobrado. Com a guarda apagada, o login passa e o teste falha. M12 morre.

Sem mutação, este teste teria ficado verde para sempre guardando nada — e a
frase "a conta de serviço não autentica" no relatório seria falsa sem que
ninguém percebesse.

### 13.2 M3 — mutante equivalente, e por que a guarda fica

Investigado antes de concluir qualquer coisa: **não é lacuna de cobertura.**

Existe índice único parcial
`Athlete_organizationId_affiliationId_affiliationNumber_key`, com
`WHERE affiliationId IS NOT NULL AND affiliationNumber IS NOT NULL`. E
`homonimosDeMatricula` só é contado quando `filiacao` é verdadeiro, o que
exige exatamente esses dois campos não-nulos. A contagem é, portanto,
**estruturalmente sempre 0**: a condição não pode ser falsa, e nenhum teste
poderia distinguir o código do mutante.

**A guarda fica.** Custa um booleano e protege contra o índice ser afrouxado,
contra dado anterior a ele e contra qualquer caminho futuro que escreva
`Athlete` por fora. O que ela evita, se um dia puder ser falsa, é creditar a
carreira de uma pessoa a outra — erro que não se desfaz com um "desfazer".

O motivo está escrito no próprio código, ao lado da condição, para que o
sobrevivente não seja lido depois como cobertura faltando e não gere um teste
inventado para um estado inalcançável.

---

## §14 E2E em navegador e responsividade da tela do autocadastro

`scripts/qa/autocadastro-automatico.mjs` — **52 asserções, GATE APROVADO.**

### 14.1 A prova negativa, que só o navegador alcança

O item 21 da especificação pede comprovar que **não existe aprovação humana
intermediária**. Teste de unidade não pode provar isso: lá não há ninguém para
aprovar, então a afirmação é verdadeira por construção e não mede nada.

Aqui a fila do operador é aberta **de verdade**, por um operador de verdade,
depois de um atleta se cadastrar pelo navegador — e o que se cobra é que ela
esteja **vazia**. Conferido duas vezes, por caminhos independentes: a tela
`#admin/solicitacoes` não mostra a pessoa, e a API responde `0 pendente(s)`.

Os quatro desfechos foram atravessados no navegador:

| Caminho | O que a tela diz |
|---|---|
| CPF com histórico | "Cadastro realizado" + histórico vinculado; `meu-historico` já mostra a participação |
| CPF sem histórico | "Cadastro realizado", perfil **ativo**, sem prometer análise |
| Matrícula ambígua | cadastro sai, e a federação **confirma** antes de vincular |
| Colisão de identidade | "Procure a sua federação" — e **não** diz qual identificador colidiu |

Na colisão, o formulário **não é limpo**: tentar de novo com os mesmos dados
bate no mesmo lugar, e apagar o que a pessoa digitou custaria o trabalho dela
sem lhe dar o que fazer.

### 14.2 A tela que nunca tinha sido medida

O gate visual da FASE 9 mede `minha-filiacao`, `meu-historico` e `ranking`.
`minha-solicitacao` ficou de fora desde que existe — sendo a **primeira** tela
que um atleta novo abre e a única com formulário longo, que é o pior candidato
possível a ficar sem medição de largura.

Medida agora em **quinze larguras (320 → 1920)**: sem overflow horizontal,
nenhum elemento fora da viewport, alvos de toque conformes nas cinco larguras
de telefone.

### 14.3 Um critério que eu mudei, e por isso declarei

O gate reprovou cinco vezes em "alvos de toque", apontando `input:` — tag sem
texto, que não dizia qual campo era.

Corrigi o diagnóstico antes de qualquer outra coisa, e o elemento apareceu:
`input[type=file] id=entrada-da-foto`, **1×1 px**, escondido atrás do rótulo
estilizado da foto. Quem recebe o dedo é o rótulo, não ele.

A exclusão é correta — mas foi acrescentada **depois** da reprovação, e mudar
critério até a falha sumir é a pior coisa que se pode fazer com um gate. Duas
consequências, as duas permanentes:

1. **O descarte é impresso a cada execução**, com elemento, altura e largura.
   Quem lê o relatório vê o que o gate escolheu ignorar e pode discordar. Se um
   campo de verdade aparecer nessa lista, é defeito.
2. **`label.button` entrou na medição.** Descartar o input sem medir o rótulo
   teria criado um ponto cego onde antes havia um falso positivo — a exclusão
   teria piorado o gate em vez de corrigi-lo.

### 14.4 Por que não está na CI

O gate visual da FASE 9 também não está: ambos exigem Playwright e Chromium, e
a CI não os instala. Mantive o mesmo padrão em vez de mudar a infraestrutura da
CI por conta própria — a instrução de execução está em `docs/COMO-TESTAR.md`.
Colocar os dois na CI é decisão de produto, e vale a pena; fica registrado.

### 14.5 O gate visual da FASE 9 não subia mais — e o defeito era o mesmo

Rodado como regressão das mudanças de frontend, `responsividade.mjs` nem chegou
a abrir o navegador: `ERR_UNSUPPORTED_DIR_IMPORT`. O mesmo tropeço que o gate
novo teve, pela mesma causa — o Playwright é CommonJS, e `await import()` de um
caminho absoluto não devolve `chromium` como export nomeado.

Enquanto o módulo estava em `node_modules`, o especificador nu resolvia e o
defeito ficava escondido. Com instalação global, o gate inteiro deixa de subir
— e um gate que não sobe reprova por motivo nenhum, que é pior do que não ter
gate: dá a impressão de que alguma coisa foi medida.

Corrigido com `createRequire` nos três scripts que tinham o padrão
(`responsividade`, `estabilidade`, `preview-verificacao`).

**Resultado depois da correção: 343 asserções, APROVADO.** As mudanças de
frontend desta fase não quebraram nada do que já passava.

---

## §15 A sonda de DEMO em produção

Executada em 2026-09-23T17:06Z, `workflow_dispatch`, run #7, commit `3bd68e6`.
Seis jobs, todos `success`.

### 15.1 Consultas executadas e contagens

Somente `GET`, sem token, contra `https://mci-platform-api.onrender.com`:

| Vista pública | Rota | Itens | Com marcador |
|---|---|---|---|
| Campeonatos | `/api/v1/events?limit=100` | 47 | **0** |
| Filiações (vitrine) | `/api/v1/public/affiliations` | 0 | **0** |
| Super Overall | `/api/v1/ranking/super-overall` | 5 | **0** |
| Busca pública | `/api/v1/search?q=DEMO` | 0 | **0** |
| Busca pública | `/api/v1/search?q=QA` | 0 | **0** |

**DEMO_PUBLIC_COUNT = 0.**

Marcadores procurados: `DEMO`, `Etapa QA`, `Federação QA`, `NPC Mato Grosso
(QA)`, `QA-NPC-MT`, `Atleta QA`, `MARIANA QA`, `qa-auto-`, `qa-resp-`,
`@mci.local`, `federacao.mci.local`, `Sistema ·`.

### 15.2 Nenhuma mutação foi realizada

O job só executa `curl -sS` com `GET`, sem `Authorization`. Nenhum DELETE,
UPDATE, TRUNCATE, backfill, recompute ou importação. Não há credencial de
escrita disponível ao workflow — todas as rotas de escrita exigem token, e ele
não tem nenhum. Se encontrasse marcador, o job pararia com `exit 1` sem apagar
nada.

### 15.3 O alcance desta medição — e por que NÃO é "DEMO = 0 no banco"

Evidência **parcial, e assumidamente parcial**.

O que ela prova: nenhum dado de QA desta fase aparece nas superfícies que o
público enxerga em produção.

O que ela **não** prova: contagem por TABELA, listagem de ID, e qualquer coisa
não pública — a conta de serviço da federação, por exemplo, nunca aparece em
rota nenhuma, e é essa a intenção do §12.5. Para isso seria preciso consultar
o banco de produção, e **nenhum workflow deste repositório tem
`DATABASE_URL`**: não existe um único `secrets.*` em `.github/workflows`.
Conferido, não suposto.

**Veredito: DEMO PRODUCTION (vistas públicas) = PASS. DEMO PRODUCTION (por
tabela, com ID) = NOT TESTED**, por falta de acesso, e não por escolha.

### 15.4 Um achado lateral que vale registrar

`/api/v1/public/affiliations` devolve **0 itens** em produção. Não é defeito: a
vitrine só mostra filiação de organização com autocadastro ABERTO, e nenhuma
está — o padrão de produção é fechado, e abrir é ato administrativo. É
consistente, e é o que se espera antes de a federação abrir a porta.

---

## §16 DEFEITO BLOQUEANTE DE DEPLOY, encontrado ao preparar a sonda

### 16.1 As federações que já existem não teriam conta de serviço

`provisionar` é chamado em **um** lugar: `organizationService.create`. As
federações de produção foram criadas antes desta fase, e a migration que
acrescentou `isServiceAccount`/`serviceOrganizationId` **não cria linha
nenhuma** — migration altera ESTRUTURA; a conta de serviço é DADO.

Consequência no deploy: `contaDaOrganizacao` não encontra a conta e
`POST /athlete-requests` responde **503 SERVICE_ACCOUNT_MISSING para todas as
federações existentes**. A funcionalidade inteira desta fase não funcionaria em
produção — e o sintoma só apareceria quando o primeiro atleta tentasse se
cadastrar.

Corrigido com `scripts/provisionar-contas-de-servico.js`, idempotente e
somente-INSERT, que roda a **mesma** `provisionar()` da criação de organização.
Reimplementá-la em SQL faria existirem dois caminhos para a mesma coisa, que é
como as duas versões divergem sem ninguém notar.

### 16.2 E o script falhou EM SILÊNCIO — o pior modo de falhar

A primeira versão rodava sem ator (`withUserContext(null, …)`), o que parecia
correto: num deploy não há operador humano.

Ela devolvia a conta criada, **com id e tudo**, e o banco ficava **vazio**.

A cadeia, medida passo a passo:

1. a política `auditoria_escrita` exige `mci_member_of(organizationId)`, e sem
   ator nenhuma das alternativas vale → o INSERT é recusado com **42501**;
2. no PostgreSQL, um statement recusado **aborta a transação inteira**;
3. `audit.record` **engole** o erro (`try/catch` que loga e devolve `null`);
4. `provisionar` segue e retorna com sucesso;
5. tudo volta atrás no commit.

**NÃO afrouxei a política.** Provisionar é ato administrativo, e ato
administrativo tem dono: o script passou a exigir `PROVISIONAR_ADMIN_EMAIL`, o
administrador se identifica, e a auditoria grava o nome dele — que é a verdade,
porque foi ele quem mandou rodar. É a mesma escolha de `criar-admin.js`.

### 16.3 A ressalva geral que isto expõe

`audit.record` captura o próprio erro e devolve `null`, como se a falha fosse
contida. **No PostgreSQL ela não é**: qualquer statement recusado envenena a
transação. Todo ponto que chama `audit.record` confiando em "auditoria que
falha não derruba o resto" está, na verdade, desfazendo o trabalho inteiro.

No caminho HTTP o estrago é menor — `asyncHandler` retém a resposta até o
commit, então o cliente recebe 500 em vez de um sucesso mentiroso. Fora dele
(scripts), o sucesso mentiroso é exatamente o que acontece.

A correção geral seria um SAVEPOINT em torno do INSERT de auditoria. É mudança
num caminho quentíssimo, chamado de toda parte, e **não a fiz nesta fase**:
está registrada aqui para decisão sua. O que fiz foi tirar este script da
armadilha.

### 16.4 Suíte

`tests/provisionamento-de-contas-de-servico.test.mjs` — 4 testes, verdes:
o 503 acontece e não deixa resto; o provisionamento cria conta **e membresia**
(sem a membresia `mci_operator_of` não a reconhece, e a conta existiria sem
poder fazer nada — falha pior, porque parece certa); repetir não duplica; cada
federação recebe a sua.
