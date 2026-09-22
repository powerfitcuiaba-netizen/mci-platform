# Taxonomia: categoria, classe, resultado, colocação e pontuação

> Estado desta fase: **implementada e medida localmente e em CI.**
> **PRODUÇÃO — AINDA NÃO ALTERADA.** Nenhuma migration foi aplicada na base da
> federação, e os 191 resultados históricos do Ipiranga não foram tocados.

## O problema

`"Women's Physique - Masters 35+"` é **uma categoria** (Women's Physique) com
**uma classe dentro dela** (Masters 35+). Nunca uma categoria nova chamada
`WOMENS_PHYSIQUE_MASTERS_35`, e nunca "Geral".

O adaptador de importação sempre separou as três partes corretamente — isso foi
medido, não suposto:

| texto da origem | categoria | divisão | rótulo |
|---|---|---|---|
| `Women's Physique - Masters 35+` | `WOMENS_PHYSIQUE` | `Masters` | `35+` |
| `Men's Bodybuilding - Open Light Heavyweight` | `MENS_BODYBUILDING` | `Open` | `Light Heavyweight` |
| `Women's Bikini - Open Class A` | `BIKINI` | `Open` | `A` |
| `Men's Classic Physique - True Novice` | `CLASSIC_PHYSIQUE` | `True Novice` | — |

E a importação é **incapaz** de criar categoria: ela usa `findUnique` sobre
`Category` e devolve `CONFLICT: Categoria desconhecida no MCI` quando o código
não existe. Os dois únicos caminhos de escrita em `Category` são a rota
administrativa `POST /categories` e o seed do catálogo oficial.

**O que faltava era onde guardar a classe resolvida.** `RankingPoint.classId`
aponta para `CompetitionClass`, que existe por divisão **de um evento do MCI**.
Resultado histórico importado não tem evento do MCI: a coluna nascia nula e
nunca deixava de ser. Consequência medida — o recorte `/ranking/by?classId=`
jamais devolveu uma linha importada, e o ranking principal não tinha filtro de
classe nenhum.

## O modelo

```
Category  (global, código único, catálogo oficial do MCI)
    │
    └── ClassCatalog  (da ORGANIZAÇÃO)
             ├── categoryId NULO      → classe genérica: ESTREANTE, NOVICE,
             │                          OPEN, MASTER. São divisões, valem em
             │                          qualquer categoria.
             └── categoryId PREENCHIDO → "Masters 35+" de Women's Physique,
                                        que não é a de Bikini.
    │
    └── RankingPoint.catalogClassId  →  ClassCatalog
             e RankingPoint.classId  →  CompetitionClass  (inalterado)
    │
    └── PublicRankingEntry.catalogClassId  (projeção pública, repovoada pelo recompute)
```

`classId` **não mudou de significado**: continua sendo a classe do evento
julgado no MCI. As duas colunas convivem porque respondem a perguntas
diferentes.

### Duas representações da classe, e nenhuma substitui a outra

| coluna | exemplo | para quê |
|---|---|---|
| `displayName` | `Masters 35+` | o texto **como a origem escreveu**. É o que a tela mostra. |
| `code` | `MASTERS_35` | identidade técnica. É por ele que a classe é reencontrada. |

`MASTERS_35` nunca aparece numa tela pública, e `Masters 35+` nunca é usado como
chave. O `code` é derivado por `normalizarCodigoDeClasse`: maiúsculas, sem
acento, tudo que não for letra ou dígito vira separador. Nome longo demais
recebe sufixo determinístico de hash — cortar em silêncio faria duas classes
diferentes virarem a mesma, que é a duplicata que a resolução existe para
impedir.

## A resolução da classe

`resolverClasseDoCatalogo`, em `src/utils/classeDoCatalogo.js`:

1. a classe **daquela categoria** — `(organização, categoria, código)`;
2. na ausência dela, a **genérica** — `(organização, NULL, código)`;
3. na ausência das duas, **cria** a específica.

A específica ganha da genérica **sempre**. É idempotente por construção: a
segunda chamada encontra o que a primeira criou.

No caminho do **evento julgado no MCI** a resolução roda com `criar: false` — ali
a classe já existe como `CompetitionClass`, e criar uma gêmea encheria o
catálogo que o operador governa de linhas que ele não pediu.

`superOverallEligible` **nasce falso e não é inferido**. A regra homologada — só
a Open alimenta o Super Overall — continua sendo resolvida pela **divisão**
contra o catálogo, exatamente onde já estava. É por isso que esta fase não
moveu um ponto sequer.

## A unicidade são duas regras, e elas são SQL escrito à mão

O índice antigo `UNIQUE (organizationId, code)` impediria a mesma organização de
ter `OPEN` de Women's Physique e `OPEN` de Men's Physique. Ele saiu — sem perder
uma linha.

O substituto **não pode** ser um `UNIQUE` simples sobre as três colunas. Medido
em PostgreSQL 16.13: `NULL` é distinto de `NULL` num índice único, então
`(NPC, NULL, 'OPEN')` entra **duas vezes** sem violar nada.

| estratégia | as 3 combinações exigidas | duplicata genérica |
|---|---|---|
| `UNIQUE(org,cat,code)` | aceita | **aceita — 2 linhas** |
| `UNIQUE … NULLS NOT DISTINCT` | aceita | recusa |
| **dois índices parciais** | aceita | recusa, e o erro nomeia a regra |

Escolhidos os **dois índices parciais**: valem em qualquer versão do PostgreSQL
e a violação diz `ClassCatalog_generica` ou `ClassCatalog_especifica` em vez de
um nome só para os dois casos.

```sql
CREATE UNIQUE INDEX "ClassCatalog_generica"
  ON "ClassCatalog" ("organizationId", "code")               WHERE "categoryId" IS NULL;
CREATE UNIQUE INDEX "ClassCatalog_especifica"
  ON "ClassCatalog" ("organizationId", "categoryId", "code") WHERE "categoryId" IS NOT NULL;
```

**Prisma não expressa índice parcial.** Por isso a unicidade não está declarada
em `schema.prisma` e vive na migration `20260922120000`. Índice que só existe no
SQL some sem aviso no primeiro `db push` — foi assim que esta base já perdeu a
coluna `maxHeightCm`. `tests/taxonomia-de-classe.test.mjs` confere que os dois
existem **no banco**.

## A migration é não destrutiva

Nenhum `DROP TABLE`, nenhum `TRUNCATE`, nenhum `DELETE`. Todas as colunas novas
são anuláveis e nascem nulas. As quatro classes genéricas de cada organização
ficam com `categoryId` nulo — que é o significado que elas já tinham. **Nenhuma
linha é reescrita.** Todo comando usa `IF EXISTS` / `IF NOT EXISTS`.

## O filtro

```
Temporada  →  Categoria  →  Classe
```

`GET /api/v1/ranking/classes?categoryId=…` devolve as classes **daquela
categoria mais as genéricas**, que valem em todas. A lista é dado da
organização: nenhuma tela a traz escrita no código, e há teste que reprova se
alguém escrever um código de classe ou de categoria em `publicPages.jsx`.

O seletor de classe fica **desabilitado** — e não escondido — enquanto não há
categoria: esconder faria a terceira etapa do filtro aparecer e sumir, e quem
não a viu não descobre que ela existe. Trocar de categoria zera a classe.

`categoryId` + `catalogClassId` incoerentes devolvem **422
`CLASS_CATEGORY_MISMATCH`**, e não uma lista vazia que a tela leria como
"ninguém pontuou". Classe de outra organização devolve **404**.

## Um defeito pré-existente encontrado no caminho

`athleteRankingBy` agrupava por `competitorKey` e relia por `athleteId`. Para
quem tem cadastro dava certo por coincidência — `competitorKey` **é** o
`athleteId` nesse caso. Para o competidor **sem cadastro**, que é todo o
histórico importado, a chave é `X:<identidade externa>` e `get(null)` devolvia
`undefined`: o recorte respondia 500 em cima justamente das linhas que ele
existe para mostrar. Corrigido e preso por teste.

## Os 191 do Ipiranga

`scripts/backfill-classe-do-catalogo.js` reconstitui `catalogClassId` a partir
do que já está gravado no `ExternalResult` daquele lançamento.

**A categoria vem de `ExternalResult.categoryCode`, e não do lançamento.**
Medido na base real da federação: os 191 estão com `RankingPoint.categoryId`
**nulo**. A primeira versão do script lia essa coluna — e teria resolvido as
191 linhas como classe **genérica** da organização. "Masters 35+" de Bikini e
"Masters 35+" de Men's Physique virariam a **mesma** classe, somando
participações de categorias diferentes sob um rótulo que não é de nenhuma das
duas.

O `Category.id` resolvido serve para uma coisa só: encontrar a classe certa no
catálogo da organização. Ele **não** é escrito em `RankingPoint.categoryId` —
reconstituir aquela coluna é outra decisão, com outro alcance.

O que não dá para resolver **fica pendente e aparece no relatório**, em vez de
cair na genérica: código de categoria fora do catálogo oficial vira
`CONFLITOS DE CATEGORIA`, e origem sem código de categoria é listada à parte.
Resolver qualquer um dos dois como genérico seria inventar.

- **Sem `--aplicar` nada é escrito.** A execução padrão é diagnóstico e imprime
  a quantidade exata que seria alterada, por categoria e por classe.
- Não cria `ExternalResult`. Não cria `RankingPoint`. Não altera `placing`,
  `points`, `superOverallPoints`, `eventId`, `seasonId`, `organizationId` nem
  `categoryId`. A única coluna escrita é `catalogClassId`, e só onde é nula.
- Idempotente: rodar duas vezes não encontra mais nada para fazer.

`scripts/diagnostico-classe.sql` responde, **somente lendo**, as oito perguntas
de diagnóstico. `tests/diagnostico-classe.test.mjs` confere linha a linha que
ele não contém escrita, não abre transação e não seleciona CPF, telefone,
e-mail nem data de nascimento.

> Rodando como `mci_app` sob `FORCE ROW LEVEL SECURITY` e sem contexto de ator,
> as tabelas do ledger devolvem **zero linha**. Zero ali significa "esta conexão
> não enxerga", e **não** "não existe". A PARTE 0 do diagnóstico existe para que
> quem lê a saída saiba em qual dos dois casos está.

## O relatório por categoria e classe

Ele NÃO é impresso pela suíte: relatório em log passa igual com o número certo
e com o errado, e ninguém lê a saída de um teste verde. O teste **confere** —
cada par (categoria, classe) tem linhas, as quantidades somam 191, e a soma de
pontos de cada grupo é exatamente a tabela homologada aplicada às colocações
daquele grupo.

Quem imprime o relatório é `scripts/backfill-classe-do-catalogo.js`, em modo
diagnóstico (sem `--aplicar`), onde ele serve para decidir.

## Mutation testing

`npm run qa:mutantes` estraga o código de propósito, uma mudança por vez, e
roda a suíte da taxonomia contra cada versão estragada. **10 de 10 mutantes
mortos, zero sobreviventes:**

| mutação | resultado |
|---|---|
| remover `catalogClassId` do lançamento importado | morto |
| ignorar a categoria ao gravar o lançamento | morto |
| zerar os pontos do lançamento importado | morto |
| resolver sempre a classe genérica, nunca a da categoria | morto |
| criar a classe toda vez, em vez de reusar a existente | morto |
| aceitar classe de outra organização no recorte | morto |
| aceitar o cruzamento categoria/classe incoerente | morto |
| ignorar o filtro de classe no recorte | morto |
| ignorar a categoria no recorte por classe | morto |
| não carregar `catalogClassId` para a projeção pública | morto |

Os dois últimos só morrem por causa de assertivas de CONTAGEM: recortar
Open Middleweight devolve **12** de 36, e a classe genérica NOVICE devolve
**10** em Wellness contra **12** em Classic Physique. Sem esses números, um
filtro ignorado passaria despercebido — a lista continuaria plausível.

## O catálogo oficial de categorias não existia em produção

O backfill rodou em modo diagnóstico na base real da federação e devolveu **191
de 191 em conflito de categoria** — os oito códigos do Ipiranga, todos
recusados:

```
BIKINI 34 · CLASSIC_PHYSIQUE 36 · FIGURE 6 · FITMODEL 12
MENS_BODYBUILDING 36 · MENS_PHYSIQUE 44 · WELLNESS 20 · WOMENS_PHYSIQUE 3
```

Não era divergência de mapeamento: os oito códigos que o adaptador produz são
exatamente os que `prisma/seed.js` declara. Não era invisibilidade por RLS:
`Category` não tem RLS — não há bloco `Policies` em `\d "Category"`.

A causa é de provisionamento, e está em `render.yaml`:

```yaml
preDeployCommand: npx prisma migrate deploy
```

O deploy roda **migrate deploy** e nada mais. As categorias oficiais existiam
só em `prisma/seed.js`, e o seed nunca rodou em produção. `Category` nasceu
vazia lá e continuou vazia.

### Por que ninguém percebeu na importação dos 191

A guarda que recusa categoria desconhecida existia, estava escrita e tinha
teste. Ela ficava **depois da resolução do atleta**, e a base de atletas
também estava vazia — que é o caminho normal do MCI, histórico oficial
carregado antes de existir cadastro. Toda linha saía como `MATCH_PENDING`
antes de alcançar a guarda.

O resultado foi a combinação que ninguém tinha testado junta: catálogo vazio
**mais** base de atletas vazia. A importação respondeu "191 aplicados, 0
conflitos", `findUnique` por código devolveu `null` nas 191, e `categoryId`
nasceu nulo em todas — de onde saiu o "Geral" na tela.

### A correção é dupla, uma em cada metade

**Código.** A conferência de categoria subiu para antes da resolução do
atleta, em `analisarLinha`. Conferir a categoria não depende de saber de quem
é o resultado: a categoria é do RESULTADO, não da pessoa. As recusas passam a
devolver `athleteId: null`, que é a consequência honesta — naquele ponto ainda
não se sabe quem é.

**Provisionamento.** O catálogo virou migration —
`20260922210000_catalogo_oficial_de_categorias` —, que é o caminho que o
deploy já percorre. `INSERT ... ON CONFLICT ("code") DO NOTHING` com ids
fixos: não apaga, não reescreve, não toca `RankingPoint`, e rodar de novo não
duplica. O seed continua existindo e continua criando o mesmo catálogo; um
teste compara as duas listas e reprova se elas se separarem.

Promover o seed inteiro a passo de deploy foi descartado: ele também cria
critérios, comunidades e regra padrão, e o alcance da mudança ficaria muito
maior do que o problema. O catálogo de categorias é pré-requisito de domínio
— é schema de negócio, não dado de exemplo.

### O que a suíte mede

`tests/catalogo-oficial-de-categorias.test.mjs` — nove testes:

| teste | o que prova |
|---|---|
| as onze categorias oficiais existem | o catálogo provisionado tem os oito do Ipiranga |
| a migration e o seed não divergem | as duas listas são uma só |
| é idempotente | reaplicar a migration não duplica nem reescreve |
| categoria desconhecida vira CONFLITO com base de atletas vazia | a guarda alcança a linha sem atleta |
| CATÁLOGO VAZIO recusa o arquivo inteiro | a reprodução exata do defeito: `conflicts: 2`, `applicable: 0`, apply 422 `NOTHING_TO_APPLY` |
| com o catálogo provisionado, as mesmas linhas entram com categoria | nenhum ponto sem categoria, `athleteId` nulo, classe específica |
| linha sem classe E sem categoria é CONFLITO | o ramo do código AUSENTE, que o mutation testing mostrou descoberto |
| cada um dos oito códigos do Ipiranga resolve sozinho | os oito, um a um |
| a categoria é global, a CLASSE é da organização | o isolamento continua de pé |

E `scripts/qa/mutantes-catalogo.mjs` (`npm run qa:mutantes:catalogo`) estraga a
correção de propósito, uma mudança por vez. O mutante que mais importa é o
primeiro — `a guarda volta a ficar depois da resolução do atleta` —, que não
inventa defeito nenhum: recoloca o que a base real tinha.

## A categoria do lançamento histórico

Com o catálogo provisionado e a classe reconstituída, sobrou a última coluna
que a importação contra catálogo vazio deixou em branco:
`RankingPoint.categoryId`, nula nos 191 do Ipiranga.

`scripts/backfill-categoria-do-lancamento.js` a reconstitui. O caminho é um
só, e é exato:

```
ExternalResult.categoryCode  ->  Category.code  ->  Category.id
```

Não se usa o nome da classe para descobrir a categoria. Não há fallback
genérico, não se cria categoria, não se infere e não se aproxima texto. Se o
código não estiver no catálogo oficial, a linha é conflito — não categoria
nova.

### A auditoria vem antes, e a aplicação recusa se ela não fechar

Sem `--aplicar` nada é escrito. A execução padrão imprime total analisado,
resolvidos, não resolvidos, conflitos, categorias encontradas e a quantidade
por categoria.

Com `--aplicar`, **uma única linha não resolvida interrompe a escrita
inteira** — inclusive as linhas que resolveram. Não é conservadorismo
decorativo: gravar só a parte que resolveu deixaria a base em dois estados, e
o operador teria de descobrir a mão quais ficaram para trás.

Três coisas fazem uma linha não resolver: a origem não declarou código; o
código não existe no catálogo oficial; ou duas linhas de catálogo respondem
pelo mesmo código (a unicidade do banco é sobre o texto exato, então dois
registros que só diferem em caixa passariam por ela — e aí a correspondência
deixa de ser "exatamente uma").

### O que ele não toca

A única coluna escrita é `categoryId`, e só onde ela está nula. O teste
compara o **retrato completo** do lançamento antes e depois — todos os campos,
não uma lista que eu lembrasse de escrever — e exige que só `categoryId`
mude. Pontuação, colocação, elegibilidade ao Super Overall, `catalogClassId`,
vínculos de equipe e empresa, filiação e invalidação saem idênticos.

É idempotente: o filtro é `categoryId: null`, repetido no `where` da escrita.
A segunda execução não encontra mais nada.

### O que a suíte mede

`tests/backfill-categoria.test.mjs` — onze testes, contra o script **como
processo**, porque é o script que vai rodar contra produção:

| teste | o que prova |
|---|---|
| a auditoria relata e não escreve | os números, e o estado intocado |
| preenche 6/6 pelo código do arquivo | a categoria gravada é a que a origem declarou, linha a linha |
| a mesma classe em categorias diferentes | "Masters 35+" de Bikini e de Men's Physique vão para categorias distintas |
| o retrato sai idêntico, menos `categoryId` | nada mais foi tocado |
| `catalogClassId` preservado, classes intactas | a correção anterior não é desfeita |
| nada criado ou removido | categoria, atleta, lançamento e `ExternalResult` nas mesmas contagens |
| idempotência | a segunda execução encontra zero |
| não sobrescreve categoria já resolvida | história anterior não é reescrita |
| código fora do catálogo | conflito, `--aplicar` recusa, **nem as linhas boas** são escritas |
| origem sem código | não resolvido, `--aplicar` recusa |
| `--temporada` | a temporada vizinha fica como estava |

E `scripts/qa/mutantes-categoria.mjs` (`npm run qa:mutantes:categoria`)
estraga o script de propósito, uma mudança por vez.
