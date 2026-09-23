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

### 10.5 Uma observação, que não é falha

O Super Overall devolveu **5 linhas**. A sonda não reprova isso — 200 com JSON
válido é o que ela cobra, e foi o que veio. Mas o número é pequeno para 47
campeonatos e **merece o olho de quem conhece o calendário**: só a classe OPEN
alimenta o Super Overall, e a consulta foi feita sem informar temporada. Não
vou atribuir causa a isto sem medir.
