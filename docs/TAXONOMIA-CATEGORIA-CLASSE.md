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
do texto já gravado em `ExternalResult.className`.

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
