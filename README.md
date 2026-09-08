# MCI Platform — Campeonato Brasileiro Muscle Contest

Plataforma esportiva do Campeonato Brasileiro Muscle Contest: gestão de
competição de fisiculturismo e fitness, resultados, ranking,
Atletas PRO, importação de resultados do MuscleWar e a rede social da
comunidade — feed, mensagens e comunidades.

> **Esta plataforma não é um sistema financeiro.** Não há pagamento, cobrança,
> cartão, gateway, PIX, boleto, cupom, reembolso, carteira ou saldo. A ausência
> é requisito de produto, está verificada por teste automatizado
> (`tests/financeiro-ausente.test.mjs`) e é conferida na CI. A inscrição no
> campeonato é um processo esportivo e cadastral. Se existir cobrança em algum
> sistema externo, ela permanece externa.

---

## Sumário

- [Domínio](#domínio)
- [Arquitetura](#arquitetura)
- [Começando](#começando)
- [Banco de dados e RLS](#banco-de-dados-e-rls)
- [Segurança](#segurança)
- [Recepção do resultado oficial](#recepção-do-resultado-oficial)
- [Importação MuscleWar](#importação-musclewar)
- [MCI Social e Messenger](#mci-social-e-messenger)
- [API](#api)
- [Testes](#testes)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Deploy e homologação](#deploy-e-homologação)
- [Decisões e limites conhecidos](#decisões-e-limites-conhecidos)

---

## Domínio

O campeonato **não** é modelado como confronto direto. A estrutura é:

```
EVENTO → CATEGORIA → DIVISÃO → CLASSE → ATLETA
```

A classe é a unidade em que se compete e em que se apura resultado.

> **O julgamento esportivo é realizado externamente.** O MCI recebe os
> resultados e pontuações oficiais e utiliza esses dados para registro,
> auditoria, ranking e Super Overall — a colocação recebida **não é
> recalculada**. Ver
> [`docs/phase-11.4-regulamento-ranking.md`](docs/phase-11.4-regulamento-ranking.md).
>
> O motor de julgamento interno que existia desde a fase 5 (painel de juízes,
> apuração por colocação relativa, descarte de notas) foi **removido na fase
> 11.5**, por decisão do organizador: ele contradizia esta arquitetura. Uma
> trava em `tests/rotas.test.mjs` recusa a volta de qualquer rota de
> julgamento.

### Categorias oficiais

O catálogo é **dado**, não código — novas categorias entram por linha em
`prisma/seed.js` ou pela rota `POST /categories`, sem alteração de lógica:

| Masculinas | Femininas |
| --- | --- |
| Men's Bodybuilding | Women's Bodybuilding |
| Men's Physique | Women's Physique |
| Classic Physique | Wellness |
| 212 Bodybuilding | Bikini |
| | Fitness |
| | Figure |
| | Fitmodel |

Classes homologadas: `ESTREANTE`, `NOVICE`, `OPEN`, `MASTER`. Todas pontuam no
campeonato; **só a OPEN** alimenta o Super Overall anual. O operador cria,
edita, ordena, ativa e desativa classes pelo catálogo da organização, sem
mudança de código.

### Estados do evento

```
DRAFT → PLANNED → REGISTRATIONS_OPEN → REGISTRATIONS_CLOSED
      → IN_OPERATION → IN_JUDGING → RESULTS_IN_REVIEW
      → RESULTS_PUBLISHED → CLOSED
```

Toda transição é declarada em `src/utils/eventStates.js`. O que não está
declarado é recusado com o motivo. Depois de publicado, o resultado não
retrocede por transição de estado: correção é nova versão auditada.

### Empresa, equipe e vínculo único do atleta

Empresas se cadastram e **entram na competição com as suas equipes** — ficam
acima da equipe, e é pela equipe que os pontos dos atletas chegam até elas:

```
EMPRESA (Company) → EQUIPE (Team) → ATLETA (Athlete)
```

Isso é distinto de **patrocínio**: `Sponsor` e `Brand` são relação comercial,
não competitiva — não vinculam atleta nem geram ponto.

**Um atleta tem no máximo um vínculo ativo de equipe.** A trava atravessa as
quatro camadas — tela (`Configurações → Vínculo de equipe`), API, service e
banco —, e a que decide é a última, não a primeira: `AthleteTeamMembership.activeAthleteId` é único enquanto o vínculo
estiver ativo, e fica NULL depois de encerrado — a história acumula sem
enfraquecer a trava. Uma segunda tentativa recebe `409 ATHLETE_ALREADY_LINKED`
com a equipe atual nomeada na mensagem; duas requisições simultâneas produzem
exatamente um vínculo, porque a segunda gravação é impossível, não porque a
aplicação chegou antes.

Vincular um atleta livre (`athletes.update`) e transferi-lo de outra equipe
(`athletes.transfer`) são atos com permissões distintas: **o treinador não
transfere sozinho** — a transferência exige o operador da Muscle Contest, gera
auditoria e preserva o vínculo anterior no histórico
(`GET /athletes/:id/team-history`).

### Atleta e CPF

O CPF é a identidade central do atleta: normalizado para 11 dígitos, validado
por dígito verificador e **único por organização** — é a constraint que impede
o mesmo atleta virar dois perfis. É tratado como dado restrito (ver
[Segurança](#segurança)).

---

## Arquitetura

```
mci-platform/
├── prisma/
│   ├── schema.prisma          domínio completo (PostgreSQL)
│   ├── migrations/            baseline + políticas de RLS
│   └── seed.js                catálogo oficial de categorias e comunidades
├── src/
│   ├── app.js                 montagem do Express
│   ├── config/                ambiente, Prisma, contexto de RLS
│   ├── middlewares/           auth, validação, rate limit, upload
│   ├── routes/index.js        superfície HTTP
│   ├── controllers/index.js   extração de entrada e resposta
│   ├── services/              regra de negócio
│   └── utils/                 CPF, permissões, estados, pontuação, adapter
├── scripts/                   provisionamento e execução da suíte
├── tests/                     unidade, E2E, segurança, RLS, ausência financeira
└── frontend/                  React + Vite
```

**Controllers são finos por decisão**: extraem entrada, chamam o service e
devolvem a resposta. Nenhuma regra de negócio mora neles, de modo que a regra
possa ser testada sem HTTP e não exista uma segunda cópia dela.

---

## Começando

Pré-requisitos: **Node 22+** e **PostgreSQL 16+**. SQLite não serve — o RLS da
plataforma depende do PostgreSQL, e o validador de produção recusa outro banco.

```bash
# 1. dependências
npm install
cd frontend && npm install && cd ..

# 2. ambiente
cp .env.example .env
# ajuste DATABASE_URL e gere um JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# 3. banco
npm run db:migrate
npm run db:seed   # passo explícito: não há gancho de seed automático

# 4. API (porta 3000)
npm run dev

# 5. interface (porta 5173)
cd frontend && npm run dev
```

O primeiro usuário se cadastra pela interface. Papéis privilegiados não são
autoatribuíveis: promova o primeiro administrador direto no banco e faça o
resto pela tela de Configurações.

```sql
UPDATE "User" SET role = 'SUPER_ADMIN' WHERE email = 'voce@exemplo.com';
```

---

## Banco de dados e RLS

### Migrations

| Migration | Conteúdo |
| --- | --- |
| `20260906120000_mci_dominio_esportivo` | domínio completo: organizações, atletas, eventos, inscrições, operação, julgamento, resultados, ranking, MuscleWar, social, messenger, comunidades, auditoria |
| `20260906130000_rls` | funções auxiliares e políticas de Row Level Security |

### Row Level Security

As políticas cobrem mensagens privadas, publicações restritas, stories,
documentos de atleta, o próprio cadastro de atleta (isolamento entre
organizações), resultados não publicados, lotes de importação, auditoria e
notificações.

O ator corrente é lido de `current_setting('mci.user_id')`, definido **por
transação** com `SET LOCAL` — `src/config/rlsSession.js` faz isso. Com pool de
conexões, definir a variável fora da transação a aplicaria a uma conexão
qualquer e poderia vazar para a requisição seguinte. **Sem ator definido, as
políticas negam**: falhar fechado é o comportamento correto.

O papel de aplicação é provisionado uma vez, por um usuário com `CREATEROLE`
(não o usuário das migrations):

```bash
psql -d mci -v senha="'$MCI_APP_PASSWORD'" -f scripts/provision-app-role.sql
```

`tests/rls.test.mjs` conecta como `mci_app` — papel sem `BYPASSRLS` — e
consulta as tabelas **direto**, sem passar pela API. É a única forma de provar
que a barreira é do banco, e não apenas do service. O teste falha alto se o
papel usado tiver `BYPASSRLS`.

---

## Segurança

### RBAC granular

68 permissões nomeadas e 21 papéis, em `src/utils/permissions.js`. Rotas e
services perguntam por **permissão**, nunca por papel:

```js
assertCan(actor, 'results.publish', event.organizationId);
```

A permissão efetiva é a união do papel global (`User.role`) com os papéis do
usuário **naquela organização** (`OrganizationMember.role`). Não existe herança
por nível: um `JUDGE` não é um `ADMIN` pequeno — é outro conjunto. Um juiz
pontua; encerrar sessão, apurar e publicar são permissões distintas.

### Multi-tenancy

`assertCan` confere organização **e** permissão na mesma chamada. Separá-las é
justamente o que produz o furo em que o papel de uma organização autoriza
operar em outra. A barreira existe na rota, no service e no banco.

### Classificação dos dados

| Nível | Exemplos |
| --- | --- |
| Público | nome, nome esportivo, cidade/UF, categoria, títulos, resultados publicados, ranking, conteúdo social público |
| Privado | documentos, mensagens, publicações restritas |
| Restrito | **CPF**, telefone, e-mail pessoal, resultados não publicados |
| Administrativo | auditoria, papéis, importações |

**CPF nunca sai em rota pública nem em resultado de busca** — nem mascarado.
Serve como termo de consulta apenas para quem tem `search.sensitive`, e a
resposta devolve `[CPF]` no eco do termo: repetir o número no payload seria
reintroduzi-lo em log de acesso e histórico logo depois de tê-lo protegido.
Consultar um CPF deixa rastro na auditoria.

### Outras decisões

- Resposta **404** (não 403) para conversa, publicação ou perfil que o usuário
  não pode ver: confirmar a existência já é vazamento.
- Login compara a senha contra um hash descartável mesmo sem usuário, para que
  o tempo de resposta não revele quais e-mails existem.
- Papel privilegiado não é autoatribuível no cadastro aberto; só `SUPER_ADMIN`
  concede. Ninguém altera o próprio papel ou situação.
- Erro nunca carrega stack trace na resposta. O log estruturado redige senha,
  token e segredo por nome de chave, em qualquer profundidade.
- Upload: a chave de armazenamento é sempre gerada pelo servidor; o nome
  original fica só como metadado. Lista fechada de tipos, separada entre
  documento e mídia.

---

## Recepção do resultado oficial

O MCI **não julga**. Não há aqui algoritmo de apuração, ficha de juiz, descarte
de notas, painel nem critério de desempate dentro da classe — a ausência é
deliberada, não uma lacuna.

`POST /classes/:id/result` recebe o resultado já decidido fora:

- **Entrada**: atleta e colocação, mais o estado da linha (`RANKED`,
  `TIE_UNRESOLVED`, `DISQUALIFIED`, `ABSENT`).
- **O que é conferido**: apenas integridade do lançamento — que o atleta está
  inscrito naquela classe e que não vieram duas colocações iguais. Mérito
  esportivo não é conferido, porque conferir mérito é julgar.
- **Checksum**: assinatura do que foi recebido, não prova de apuração. Reenviar
  o mesmo resultado dá o mesmo checksum; trocar uma colocação no caminho, não.
- **Reenvio gera nova versão**, nunca sobrescrita.

Se o resultado chega **empatado**, o empate é gravado como empate e a
publicação fica bloqueada até a comissão decidir, com motivo e autor.
**Nunca se desempata por id, ordem de cadastro, timestamp ou nome** — fazer isso
seria julgar.

### Resultados versionados

Toda mudança de estado do resultado — recebimento, novo recebimento, publicação,
correção — incrementa `Result.version` e grava uma linha em `ResultVersion`
com motivo, autor, momento e o retrato completo das entradas. Nenhuma versão é
sobrescrita. É o que torna a correção de um resultado publicado auditável em
vez de silenciosa.

---

## Importação MuscleWar

O MCI **não replica** o MuscleWar: recebe dele o necessário para reconhecer o
atleta, identificar o recorte de competição e trazer resultado e pontuação para
o histórico e o ranking.

```
ARQUIVO → ADAPTER → ANÁLISE LINHA A LINHA → PRÉ-VISUALIZAÇÃO
                                                  ↓
                              revisão humana das pendências
                                                  ↓
                                            APLICAÇÃO → RANKING
```

- **Adapter** (`src/utils/musclewar/adapter.js`): CSV (detecta separador,
  respeita aspas, entende cabeçalho acentuado e data `dd/mm/aaaa`), JSON e API.
  O contrato definitivo do MuscleWar ainda não existe — **nada aqui inventa
  campos obrigatórios do lado deles**. Um formato diferente é atendido passando
  `fieldMap`, sem tocar no código.
- **Reconhecimento**: CPF é a primeira chave; a filiação confirma o vínculo
  quando informada. Divergência vira `CONFLICT` para revisão, não descarte.
- **A coluna de pontos é o total FINAL, com o bônus de Overall incluído.** Uma
  linha marcada como campeã Overall precisa trazer `15` (5 da colocação + 10 do
  bônus), não `5` — informar só os pontos da colocação produz `CONFLICT`, com a
  conta explícita na mensagem. É deliberado: um número que pode ser derivado de
  colocação, Overall e temporada não é fonte, é afirmação a conferir. É também
  a primeira coisa que trava uma importação real —
  ver [`docs/HOMOLOGACAO-OPERACIONAL.md`](docs/HOMOLOGACAO-OPERACIONAL.md) §3.
- **Atleta não encontrado nunca é criado em silêncio**: vai para
  `MATCH_PENDING` e espera vinculação manual por usuário autorizado.
- **Idempotência**: `ExternalResult(source, externalId)` é único. Reimportar o
  mesmo resultado não gera segunda pontuação — nem entre lotes, nem dentro do
  mesmo arquivo.
- **Pré-visualização** antes de aplicar: total, reconhecidos, pendentes,
  conflitos, duplicados e rejeitados.
- **Auditoria**: quem importou, quem revisou, quem aplicou, com que arquivo,
  quantos entraram e quantos foram ignorados. Histórico de importação não é
  apagado em silêncio.

Cada ponto de ranking carrega a origem (`source = MUSCLEWAR`) e aponta para o
resultado externo que o gerou.

---

## MCI Social e Messenger

**Social**: perfis (atleta, coach, academia, equipe, marca, patrocinador, fã,
imprensa), feed real paginado por cursor, publicações com visibilidade
`PUBLIC` / `FOLLOWERS` / `PRIVATE`, mídia, comentários em thread, curtidas,
compartilhamentos, salvos, seguidores, stories com expiração, bloqueio
simétrico, denúncia e moderação.

A visibilidade é decidida **no servidor**, consultando seguidores e bloqueios.
A interface nunca é a autoridade sobre quem vê o quê.

**Messenger**: conversa individual e em grupo, mídia, resposta, reação,
marcação de lida e contador de não lidas. A chave canônica `directKey` impede
duas conversas 1:1 entre as mesmas pessoas. Quem não participa recebe 404 — em
toda leitura e em toda escrita, e também no banco, pela política de RLS.

**Comunidades**: espaços por categoria, papel e campeonato. Comunidade privada
não aparece na listagem de quem não é membro e não aceita entrada por conta
própria — a entrada é por convite de administrador.

---

## API

Prefixo `/api/v1`. Sondas de infraestrutura ficam fora dele: `GET /health`
(processo de pé) e `GET /ready` (banco alcançável e armazenamento gravável).

| Núcleo | Rotas principais |
| --- | --- |
| Autenticação | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Organizações | `GET|POST /organizations`, `POST /organizations/:id/members` |
| Filiação | `GET|POST /affiliations` |
| Atletas | `GET|POST /athletes`, `POST /athletes/lookup`, `POST /athletes/:id/pro-status` |
| Eventos | `GET|POST /events`, `POST /events/:id/transition`, `POST /events/:id/categories` |
| Inscrições | `GET|POST /events/:id/registrations`, `POST /registrations/:id/cancel` |
| Operação | `POST /registrations/:id/checkin`, `POST /registrations/:id/weighins`, `POST /events/:id/credentials/scan`, `PUT /batches/:id/order` |
| Resultados | `POST /classes/:id/result/calculate`, `.../publish`, `.../override`, `GET .../versions` |
| Ranking | `GET /ranking` (campeonato), `GET /ranking/super-overall` (anual, só Open), `GET /ranking/teams`, `GET /ranking/companies` — os quatro públicos, `GET|POST /seasons`, `PUT /seasons/:id/points-rules` |
| Recortes | `GET /ranking/by?classId=` · `?eventId=` · `?divisionId=` — mesmo motor, exatamente um recorte por consulta |
| Classes e Overall | `GET|POST /classes-catalog`, `GET|POST /events/:id/overall` |
| Empresas e vínculo | `GET|POST /companies`, `POST /athletes/:id/team`, `.../team/transfer`, `.../team/unlink`, `GET /athletes/:id/team-history` |
| MuscleWar | `GET|POST /musclewar/imports`, `POST /musclewar/items/:id/link`, `POST /musclewar/imports/:id/apply` |
| Social | `GET /social/feed`, `POST /social/posts`, `POST /social/posts/:id/like`, `GET /social/profiles/:handle` |
| Messenger | `GET|POST /messenger/conversations`, `GET|POST /messenger/conversations/:id/messages` |
| Comunidades | `GET /communities`, `POST /communities/:slug/join` |
| Busca | `GET /search` |
| Auditoria | `GET /audit` |
| Vitrine | `GET /public/summary`, `/public/events/:slug`, `/public/athletes/:id` |

---

## Testes

```bash
npm test                 # prepara o banco, popula o catálogo e roda a suíte
npm run lint             # ESLint em backend, scripts, testes e frontend
cd frontend && npm test  # interface
```

O ESLint é gate real na CI. A configuração (`eslint.config.js`) mira
**defeito**, não estilo: variável e argumento sem uso, comparação frouxa,
expressão binária constante, laço inalcançável, `console` esquecido em service,
espaço em branco irregular e as regras de hooks do React. Regra que não muda o
comportamento do programa não entra — ruído de linter ensina a ignorar linter.

Não há etapa de typecheck: o projeto é JavaScript puro, sem tipos para checar.
As validações estáticas que a CI executa, e que reprovam o job, são
`node --check` e ESLint.

`npm test` exige PostgreSQL. Aponte `TEST_DATABASE_URL` para um banco de teste
— a suíte trunca tabelas entre arquivos.

| Arquivo | Cobertura |
| --- | --- |
| `unidade-dominio` | CPF, estados do evento, RBAC, adapter MuscleWar |
| `e2e-campeonato` | cadastro → inscrição → check-in → pesagem → credencial → palco → recepção do resultado → ranking → auditoria; empate recebido e correção versionada |
| `e2e-musclewar` | pré-visualização, matching, vinculação manual, aplicação, idempotência, auditoria, permissões |
| `e2e-social-messenger` | feed, interações, visibilidade, bloqueio, conversas, grupos, moderação, comunidades |
| `seguranca` | autenticação, escalada de papel, cross-tenant, proteção do CPF, documento privado de evento, resultado não publicado, transições inválidas |
| `seguranca-social` | os caminhos negativos de Social e Messenger que faltavam: mídia de conversa privada por id, operações de conversa por quem não participa, portas laterais da publicação restrita e fila de denúncias |
| `rls` | políticas executadas como papel sem `BYPASSRLS`, direto no banco |
| `rls-runtime` | o RLS no caminho real da requisição: o dono também é filtrado, contexto por ator, concorrência e ausência de bypass |
| `armazenamento-objetos` | assinatura SigV4 contra o vetor oficial da AWS e o contrato do provedor contra um servidor que recusa assinatura errada |
| `midia` | upload, limites de tamanho, tipos aceitos, entrega com cabeçalho seguro |
| `rotas` | auditoria dos endpoints registrados, percorridos um a um |
| `financeiro-ausente` | schema, banco real, arquivos, rotas e variáveis: nenhum resquício financeiro |
| `producao` | barreira de configuração da partida: segredo, banco, CORS, hash e armazenamento |
| `pontuacao-oficial` | tabela homologada (1º=5…5º=1), bônus Overall +10 e a hierarquia de desempate, com os números abertos |
| `pontuacao-11-3` | as DUAS métricas caso a caso: pontos do campeonato × elegíveis ao Super Overall, por classe e com Overall |
| `regulamento-11-4` | o regulamento inteiro como matriz: 1º ao 10º em todas as classes, os quatro degraus do desempate, a prova de que 4º e 5º não separam, e a mesma regra aplicada a equipes |
| `ranking-oficial` | a regra oficial no caminho real: Overall, equipes, versionamento, idempotência, concorrência e permissão |
| `vinculo-equipe` | vínculo único atleta → equipe: recusa nomeando a equipe atual, corrida entre requisições simultâneas, transferência só pelo operador, histórico e gravação direta no banco, e a importação como porta dos fundos: arquivo com equipe divergente, inclusive datado no passado |

---

## Variáveis de ambiente

Ver `.env.example`. Em produção o processo **se recusa a subir** com
configuração incompleta — falhar no deploy é melhor do que servir tráfego real
com segredo de desenvolvimento:

- `JWT_SECRET` ausente, placeholder ou com menos de 32 caracteres;
- `DATABASE_URL` ausente ou apontando para banco que não seja PostgreSQL;
- `CORS_ORIGINS` ausente ou liberando todas as origens;
- `BCRYPT_ROUNDS` abaixo de 10;
- `STORAGE_DRIVER=local` sem `ALLOW_LOCAL_STORAGE=true` — gravar no disco do
  contêiner sem volume persistente perde todo upload no primeiro redeploy, e a
  perda só aparece quando alguém vai buscar o documento do atleta. A escolha
  precisa ser deliberada, não herdada do padrão de desenvolvimento.

Todos os problemas são relatados de uma vez, não um por deploy.

Não existe variável financeira, e o teste de ausência confere isso.

---

## Deploy e homologação

- **[`docs/DEPLOY.md`](docs/DEPLOY.md)** — runbook: ordem do primeiro deploy,
  provisionamento dos papéis, sondas, rollback e checklist. Declara o que foi
  verificado e o que não foi. Na fase 12.4 a **imagem Docker finalmente foi
  construída e executada**: `/ready` verdadeiro contra PostgreSQL real, processo
  como uid 1000, `HEALTHCHECK` saudável, `docker stop` encerrando com código 0
  pelo caminho ordenado, e as guardas de partida recusando configuração
  incompleta, `JWT_SECRET` curto e papel superusuário. A ressalva que ficou está
  escrita no `Dockerfile`: a camada `apt-get` não chegou a executar, porque o
  ambiente de verificação bloqueia os espelhos Debian.
- **[`docs/HOMOLOGACAO-OPERACIONAL.md`](docs/HOMOLOGACAO-OPERACIONAL.md)** — uma
  temporada inteira executada de ponta a ponta pelo caminho do operador, com a
  API em produção: 86 verificações, nenhuma falha. Registra o que o operador
  **não** faz sozinho (corrigir resultado publicado, criar organização, ler a
  auditoria — todos `403` deliberados) e a armadilha da planilha MuscleWar.
- **[`docs/BACKUP-RESTORE.md`](docs/BACKUP-RESTORE.md)** — backup, restauração e
  recuperação de desastre, com os números de um ensaio **executado**: dump,
  restauração em banco novo e a aplicação subindo contra o banco recuperado.
  Registra em letras grandes que **o backup do banco NÃO protege o storage** —
  no ensaio, o documento restaurado aparecia na listagem e o download devolvia
  `404` até os arquivos serem copiados à parte. Explica também por que o
  backup exige um papel próprio: sob `FORCE ROW LEVEL SECURITY`, o `pg_dump` do
  dono do schema **falha**.
- **[`docs/phase-11.4-regulamento-ranking.md`](docs/phase-11.4-regulamento-ranking.md)**
  — **o regulamento do ranking**, consolidado e sem nada provisório: classes
  Estreante/Novice/Open/Master, pontuação 5/4/3/2/1 e **0 do 6º em diante**,
  Overall +10 como **fato declarado**, **só a OPEN** alimentando o Super Overall
  anual, e o desempate Overall → 1º → 2º → 3º → `TIE_UNRESOLVED` — com 4º e 5º
  pontuando e **não** desempatando. A mesma regra vale para equipes e empresas.
- **[`docs/phase-11.3-ranking-super-overall.md`](docs/phase-11.3-ranking-super-overall.md)**
  — as duas métricas separadas (`points` × `superOverallPoints`), a conferência
  da pontuação importada e a rastreabilidade de cada ponto.
- **[`docs/HOMOLOGACAO-ESPORTIVA.md`](docs/HOMOLOGACAO-ESPORTIVA.md)** — o
  histórico da homologação e o que ainda depende do comitê técnico. As decisões
  de apuração *dentro da classe* saíram da lista na fase 11.5: pertencem a quem
  julga, e o julgamento é externo.

---

## Tabelas que existem e nenhum código usa

Nove das 72 tabelas não são alcançadas por nenhuma linha de código. Estão
listadas aqui de propósito: quem encontrar uma delas no schema merece saber por
que ficou, em vez de deduzir que é esquecimento.

| Tabela | Por que continua |
| --- | --- |
| `JudgePanel`, `PanelJudge`, `JudgingSession`, `JudgingScore`, `JudgingScoreCriterion`, `ScoringRuleSet` | Restos do motor de julgamento removido na fase 11.5. Apagá-las exigiria migration destrutiva, proibida no projeto. Nenhum código as alcança e uma trava em `tests/rotas.test.mjs` recusa a volta das rotas. |
| `CategoryRule` | Saco de chave/valor por classe, sem semântica definida. Dar sentido a ela seria **inventar regra esportiva** — exatamente o que o projeto proíbe. Fica até o organizador dizer o que ela guarda. |
| `CommentLike` | Curtida em comentário: modelada, nunca implementada. Não há rota nem botão, então nada está quebrado. É decisão de produto, não pendência técnica. |

`ScoreCriterion` **não** está nesta lista: os 38 critérios de avaliação por
categoria eram semeados e ignorados até a fase 11.5, e agora chegam em
`GET /categories`. São referência para o atleta — o que a sua categoria
valoriza —, não ficha de julgamento.

---

## Decisões e limites conhecidos

**O MCI não julga, e regras esportivas não são presumidas.** Método de
apuração, descarte e desempate dentro da classe não existem aqui: são do
julgamento externo. A tabela de pontos do ranking é configuração do
organizador — sem tabela cadastrada, nenhum resultado pontua, e a interface
avisa em vez de inventar um valor.

**Conferência de peso é informativa.** A pesagem registra o valor e aponta as
classes fora da faixa; quem reclassifica é a organização, com base no
regulamento.

**RLS é barreira de banco, e vale para a requisição real.** A autorização
primária continua sendo a camada de service, coberta por teste; o banco é a
segunda barreira — e, desde a fase 10.2, uma barreira efetiva. Todo handler
autenticado passa por `withUserContext` (`src/config/rlsSession.js`), que
define o ator com `SET LOCAL` dentro da transação da requisição; as 21 tabelas
protegidas têm `FORCE ROW LEVEL SECURITY`, de modo que nem o dono do schema é
isento. O ator vem sempre do token, nunca do corpo da requisição.

Antes disso a proteção não existia em execução: o PostgreSQL isenta o dono da
tabela das políticas salvo `FORCE`, e a aplicação conecta como dono — a
política negava e o dono lia assim mesmo. `tests/rls-runtime.test.mjs` guarda
justamente esse caso.

O RLS é barreira de **linha**, não de coluna: onde a política libera a linha,
libera todas as colunas dela. Por isso o CPF não mora em `Athlete` — cuja
política precisa liberar leitura anônima para o diretório público, o ranking e
a página pública de evento funcionarem — e sim em `AthleteIdentity`, tabela
própria cuja política exige operador da organização ou o próprio atleta. Um
`SELECT` sem projeção nenhuma, feito por engano numa rota pública, não tem como
trazer CPF: a linha não vem.

A partida também confere se o RLS vale para a conexão em uso
(`src/config/rlsGuard.js`). Papel superusuário ou tabela com RLS sem `FORCE`
derrubam o processo em produção e reprovam `/ready` — a proteção deixou de
depender de quem provisiona o banco acertar.

**Realtime ainda não está ligado.** Mensagens e notificações são carregadas sob
demanda, com paginação por cursor; não há polling em intervalo curto. A troca
por um canal de tempo real é aditiva e não muda o modelo de dados.

**Dependência com aviso em aberto.** `deepmerge-ts@7.1.5` carrega um advisory
de esgotamento de pilha e chega por `@prisma/config`, que a fixa em versão
exata. Nenhum release 6.x do Prisma a atualiza, e forçar a subida por override
mexeria por dentro do CLI de migration — a ferramenta mais crítica do projeto —
para mitigar um caminho que só roda em desenvolvimento, sobre configuração
nossa, sem entrada de terceiros. Fica como risco conhecido: não alcança o
runtime da aplicação nem dado de usuário. Revisar quando o Prisma 7 for
avaliado.

**Stories expiram por consulta.** Um story vencido nunca aparece, porque a
expiração é aplicada na cláusula da busca. Não há rotina de limpeza agendada; o
registro permanece no banco até que uma seja adicionada.
