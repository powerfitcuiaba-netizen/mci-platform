# Autorização automática na NPC e foto obrigatória do treinador

**Duas decisões do responsável do produto**, registradas aqui porque **alteram
regras de negócio antes homologadas**. Nenhum trecho deste documento é conclusão
técnica minha sobre o que a MuscleContest deve fazer: é o registro do que foi
decidido, do que foi implementado, do que foi medido e do que **não** mudou.

**Branch:** `claude/mci-platform-muscle-contest-o6haz9`
**SHA da homologação:** `62ffcaee4e83c28efa1968c28be91153afb32461`

---

## 1. Decisão A — a NPC é a federação oficial única, e a autorização nela é automática

| | antes | depois |
|---|---|---|
| Cadastro novo de treinador | nasce `APPROVED` (decisão anterior) | **igual** |
| Atuar na **NPC** | exigia `CoachOrganization` concedida pela federação | **automática, no próprio cadastro** |
| Atuar em **qualquer outra** federação | ato da federação (R-04) | **igual — R-04 intacta fora da NPC** |
| Criar a equipe | só o operador da federação (`teams.manage`) | **o treinador cria a dele** (`teams.create_own`) |
| Revogar autorização | ato da federação | **igual, e a automática não a desfaz** |

A segunda metade é a que importa: **aprovar cadastro nunca foi autorizar
atuação**, e continuar assim fora da NPC é o que mantém R-04 de pé. A decisão
tirou a espera de **uma** federação — a oficial —, não de todas.

### Por que isto exigiu uma política nova de RLS, e não um atalho

`CoachOrganization` tem RLS **forçado**. A política de INSERT existente
(`coach_org_escrita`) exige `mci_is_platform_admin() OR
mci_operator_of("organizationId")`. A autorização automática é gravada **dentro da
transação do próprio treinador**, que não é operador de federação nenhuma — o
banco a recusaria.

As três saídas mais curtas estavam fechadas, e cada uma por um motivo:

| saída | por que não |
|---|---|
| `BYPASSRLS` ou `SECURITY DEFINER` privilegiado | escapar do RLS em vez de expressar a regra nele. Proibido neste projeto |
| afrouxar `coach_org_escrita` | daria a **qualquer** treinador a caneta de se autorizar em **qualquer** federação — o contrário exato da decisão |
| gravar por fora, com conta de serviço | esconderia a regra num script e deixaria o banco sem defesa se alguém chamasse a rota direto |

A migration `20260928010000` acrescenta uma política **conjuntiva** que só admite
a linha que a decisão descreve. As cinco condições, todas obrigatórias:

1. `status = 'APPROVED'` — não serve para plantar `PENDING` nem ressuscitar `REVOKED` com outro status;
2. `grantedById IS NULL` **e** `autoGrantedAt IS NOT NULL` — a trilha não ganha um revisor inventado;
3. o treinador é o **da conta que insere**, e o cadastro dele está `APPROVED`;
4. a organização é a **dona da entidade oficial** (`Affiliation` ativa com código `NPC`);
5. a organização está **ativa**.

A condição 4 usa o **mesmo marcador** que
`officialAffiliationService.organizacaoOficial` consulta. Serviço e banco
concordam **por construção**, e não por coincidência — o que impede o pior caso:
a rota achar que autorizou e o banco recusar, ou o contrário.

### Por que ela não desfaz uma revogação

Esse é o risco óbvio de deixar o interessado gravar a própria linha, e a resposta
é estrutural, não de código de aplicação: a política é **só de INSERT**, e
`@@unique([coachId, organizationId])` garante **uma** linha por par. Se a
federação revogou, a linha **existe** — o INSERT bate no índice único e falha, e
**alterar** a linha continua exigindo operador (`coach_org_alteracao`, intocada).
O serviço usa `create` e não `upsert` exatamente por isso.

**Medido:** `tests/autorizacao-automatica-npc.test.mjs`, teste "revogada pela NPC,
a autorização NÃO volta sozinha" — depois da revogação, criar equipe volta a ser
403 e a linha continua `REVOKED`.

### `teams.create_own` — a sexta permissão de COACH, e a única que escreve

Sem ela a decisão ficaria pela metade: o treinador entraria autorizado a atuar e
continuaria esperando a federação criar a equipe. Ela **não** é `teams.manage`
disfarçada — são três amarras conferidas antes de gravar:

- a equipe nasce com o cadastro **desta conta** como responsável. O corpo **não**
  escolhe `coachId`: medido que o campo é **ignorado**, não obedecido;
- a federação tem de ser uma em que ele está **autorizado a atuar**;
- `companyId` não é aceito — empresa acima da equipe **pontua**, e é decisão de federação.

`POST /teams`, a rota do operador, continua exigindo `teams.manage` e recusando o
treinador com **403**. Medido.

### Instalação sem NPC provisionada

O cadastro **conclui**, sem autorização, e a ausência vai para a trilha. Recusar o
cadastro por causa de configuração de infraestrutura puniria a pessoa errada.

---

## 2. Decisão B — foto de perfil obrigatória para concluir o cadastro

### Por que o autocadastro virou `multipart/form-data`

A foto vem na **mesma requisição** que cria o cadastro. Isso não é detalhe de
transporte: com upload em dois passos haveria uma janela entre "cadastro criado" e
"foto enviada", e nessa janela cadastro sem foto **existiria**. Como não há dois
passos, não há janela.

A recusa vem do **serviço**, com a frase decidida pelo produto, escrita numa
constante só e usada nos dois pontos (autocadastro e troca):

> O envio de uma foto de perfil é obrigatório para concluir seu cadastro e
> aparecer no ranking oficial de treinadores.

**Medido nas duas formas de chamar a API:** multipart sem arquivo e corpo JSON
sem arquivo, ambos `422 COACH_PHOTO_REQUIRED` com essa frase, e **nenhum `Coach`
nasce**.

### `arquivoObrigatorio: false` no middleware não afrouxa nada

Ele muda **quem diz a frase**. Teto de bytes, lista fechada de tipos e a
conferência da **assinatura dos bytes** continuam no middleware e continuam
recusando; o que passa adiante é só a **ausência** do arquivo, para que a mensagem
venha de onde a decisão mora. Sem isso o cliente leria "Nenhum arquivo foi
enviado" e a frase combinada nunca sairia.

### Validação de conteúdo, e não de nome

Três camadas, na ordem em que recusam:

| camada | o que julga |
|---|---|
| lista fechada (`ALLOWED_AVATAR`) | o **rótulo** que o cliente mandou |
| `motivoDeRecusaPorAssinatura` | os **bytes** — HTML, SVG com script e executável não atravessam |
| `imagem.normalizar` | **recodifica** para WebP quadrado: o que vai ao armazenamento é produzido aqui |

**Medido:** PHP com nome e tipo de PNG → **415**, nenhum cadastro nasce; PDF idem;
e a foto guardada é `.webp`, não o arquivo que chegou.

### A chave do objeto não vai para o navegador

A projeção devolve `hasPhoto` booleano, e a foto é servida por
`GET /media/coaches/:id/photo`, que recebe **o id** e resolve a chave no servidor
— mesmo desenho de `Athlete.photoKey`. **Medido** que nenhuma resposta contém
`coach-photos/`.

### Trocar depois não custa nada do que já existe

`POST /coaches/me/photo` escreve **uma** coluna. **Medido campo a campo**: status,
data de criação, autorizações e equipes ficam idênticos; só `photoKey` muda. O
arquivo antigo é descartado **depois** de o banco apontar para o novo — órfão é
melhor que foto quebrada.

### Por que a coluna é anulável

Há treinadores cadastrados **antes** desta decisão, e `NOT NULL` recusaria toda
linha deles. A obrigatoriedade vive na rota e no serviço; o cadastro antigo é
avisado no painel e fica fora do ranking **até regularizar**, sem perder vínculo,
resultado, ponto nem histórico.

---

## 3. Decisão C — foto como requisito do ranking oficial, dentro do bloqueio §8.3

O limite que esta decisão encontra é anterior a ela: **a fórmula do ranking de
treinadores não está homologada.** `FORMULA_HOMOLOGADA` é falso e `classificacao`
recusa com `409 COACH_RANKING_NOT_HOMOLOGATED`. Não existe classificação a
filtrar, e inventá-la para poder filtrar seria exatamente o que o bloqueio proíbe.

Então o requisito entra onde **pode** existir sem inventar nada:

| onde | o que passou a existir |
|---|---|
| `elegibilidade` | `apto` e `impedimentos` — a resposta a "este treinador entra no ranking oficial?" |
| `projecao` | o mesmo impedimento viaja, para a tela não exibir base de ranking de quem não entra |
| `classificacao`, quando nascer | `impedimentosDoRanking` é a função única por onde ela vai filtrar |

**E nada é apagado.** Medido com a foto removida: o cadastro segue `APPROVED`, a
equipe segue sendo dele, a autorização segue `APPROVED`, a área segue abrindo, e a
contagem de lançamentos elegíveis continua vindo na resposta — o ponto existe, o
que está barrado é a **entrada**. Enviar a foto devolve `apto: true` sem que mais
nada precise acontecer.

---

## 4. O que foi medido, e onde

| gate | resultado |
|---|---|
| Regressão completa do backend | **140 arquivos · 2514 aprovados · 15 pulados · 0 reprovados** |
| `tests/autorizacao-automatica-npc.test.mjs` | 17/17 |
| `tests/foto-obrigatoria-do-treinador.test.mjs` | 16/16 |
| Frontend | 61 arquivos · 704/704 |
| `npm run lint` | 0 problemas |
| Build do frontend | ok |
| Migrations em banco isolado | 47 aplicadas · 34 tabelas com RLS forçado |
| Arreio de navegador (Chromium real, réplica em modo produção) | 33/33 |
| Vinculação de atleta ponta a ponta | 10/10 |
| Preview QA — verificação do preview e do cadastro | ambas `success` |

### Mutação

`scripts/qa/mutantes-npc-foto.mjs` — 8 mutantes de código e 2 de política, com
controle antes, controle depois e conferência de que a política do banco volta a
ser a do repositório.

**Primeira rodada: 7 morreram, 3 sobreviveram.** Dois sobreviventes eram buracos
reais e ganharam o teste que faltava (a federação oficial escolhida pelo código e
não pela ordem; a condição do dono na política de INSERT, que nenhuma rota tentava
violar). O terceiro era **mutante equivalente** — o Zod descarta o campo antes de
o serviço ver o corpo — e virou mutante composto, que alcança a barreira real.
**Placar final: 10 mutantes, 10 mortos, 0 sobreviventes.** O detalhamento, com a
tentativa de teste que recusava pela política ERRADA, está em
`RELATORIO-MUTACAO-NPC-FOTO.md`.

---

## 5. O que NÃO mudou

- **Regras esportivas e fórmulas de ranking:** nenhuma linha. 1º=5, 2º=4, 3º=3,
  4º=2, 5º=1, 6º+=0, `NS`=0; bônus de Overall +10, uma vez por título, só em
  Open/Absoluta; só OPEN alimenta o Super Overall.
- **§8.3:** o ranking de treinadores continua sem classificação oficial.
- **R-04 fora da NPC:** autorização continua sendo ato da federação.
- **R-03 no que restou dela:** suspender, reativar e encerrar continuam sendo da
  administração central. O treinador nunca muda o próprio estado.
- **R-05:** a lista de atletas do treinador continua sem CPF, sem documento, sem
  telefone e sem nascimento.
- **Cadastros antigos:** nenhum foi aprovado, autorizado, alterado ou apagado
  retroativamente. As duas migrations são aditivas e anuláveis.
- **Produção:** nenhuma migration aplicada, nenhum merge, nenhum deploy, nenhum
  dado real tocado.

---

## 6. Pendências que não são minhas para resolver

1. **Publicação em produção** continua bloqueada pelos critérios do responsável:
   backup verificável com restauração confirmada e os três diagnósticos rodados
   lá.
2. **A fórmula do ranking de treinadores** depende de homologação da
   MuscleContest. Quando vier, o gate da foto já está no lugar por onde a
   classificação nasce.
3. **`design/referencias/`** guarda 48 imagens de WhatsApp (12 MB) commitadas em
   24/08 (`b984bf4`) num repositório **público**. Não é resíduo desta entrega e
   não foi tocado — a decisão é do responsável.
