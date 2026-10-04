# Homologação funcional da consolidação por filiação + matrícula

> **Regra em prova.** Mesma filiação + mesma matrícula = mesmo atleta, qualquer
> que seja a grafia do nome. Mesma matrícula + filiação diferente = atletas
> diferentes. Nome igual + matrícula diferente = atletas diferentes.

Esta fase não aceita teste automatizado como prova de homologação. Ela pede a
consolidação **acontecendo na tela**. O que está aqui foi obtido operando a
aplicação real pela interface, com captura de tela em cada passo.

---

## 0. O que foi usado, e o que NÃO foi

| | |
|---|---|
| Aplicação | a real: API em `server.js`, **build de produção** do frontend |
| Banco | PostgreSQL local, descartável, migrado por `prisma migrate deploy` |
| Papel da aplicação | `mci_owner` — **NOSUPERUSER, NOBYPASSRLS**, igual ao da CI |
| RLS | **34 tabelas com RLS e 34 com FORCE**, medido no banco em execução |
| Limite de tentativas | **ativo** (`RATE_LIMIT_ENABLED=true`) — e ele me barrou de verdade |
| Escrita da correção | **um clique em Salvar** no modal de edição do cadastro |
| SQL manual | **nenhum** |
| Script de correção | **nenhum** |
| Backfill | **nenhum** |
| Dado de produção | **nenhum tocado** |

**O cadastro é fictício.** Não é o Lucas real de produção — ver §9.

---

## 1. O cenário, semeado pela API real

Importado e aplicado um lote com **cinco linhas**, antes de existir cadastro:

| id | nome na fonte | filiação | matrícula | classe | col. | pts | Overall |
|---|---|---|---|---|---|---|---|
| `HOM-2932-A` | Lucas Lima | HOM-MT | 2932 | OPEN | 2º | 80 | — |
| `HOM-2932-B` | Lucas de Lima | HOM-MT | 2932 | OPEN | 1º | 100 | **sim** |
| `HOM-2932-C` | LÚCAS GOUVÊIA LIMA | HOM-MT | 2932 | MASTER | 3º | 60 | — |
| `HOM-SEM-MAT` | Lucas Lima | HOM-MT | **(ausente)** | OPEN | 1º | 100 | — |
| `HOM-SP-2932` | Lucas Lima | **HOM-SP** | 2932 | OPEN | 1º | 100 | — |

Depois: cadastro **"Lucas Gouveia Lima" SEM filiação** — o estado que quebrava — e
um cadastro de controle **"Lucas Lima" com matrícula 9999**.

---

## 2. ANTES — o defeito, na tela

Perfil (`#/admin/atletas/:id`), texto capturado:

```
Lucas Gouveia Lima
***.200.001-** · Sem entidade de filiação
Filiação —   Matrícula —   Campeonatos 0   Pontos acumulados 0
```

Histórico importado: **0 identidades vinculadas, 0 resultados, 0 sugestões.**

> **Achado que é mais forte do que "faltava um clique":** a lista de sugestões
> veio **vazia**. A identidade `AFF:HOM-MT:2932` guarda o nome da PRIMEIRA linha
> do arquivo ("Lucas Lima"), que não casa com o nome do cadastro ("Lucas Gouveia
> Lima"), e a sugestão por nome exige esse casamento. Ou seja: neste cenário o
> operador **não tinha nem o clique** — não havia nada para clicar.

Ranking da temporada, **três competidores, todos "Lucas Lima"**:

| competidor | pontos | etapas | `athleteId` |
|---|---|---|---|
| `X:…mb00jk7` | **250** | 3 | `null` |
| `X:…mg00jm7` | 100 | 1 | `null` |
| `X:…mj00jo7` | 100 | 1 | `null` |

---

## 3. A CORREÇÃO — pelo modal da própria tela

Botão **Editar cadastro** → **Entidade de filiação** = Federação Mato-grossense
de Homologação, **Matrícula** = `2932` → **Salvar**.

Nenhum script. Nenhum SQL. Nenhuma rota administrativa que não exista no fluxo
normal do operador.

---

## 4. DEPOIS — a mesma tela, recarregada

```
Lucas Gouveia Lima
***.200.001-** · Federação Mato-grossense de Homologação · Matrícula 2932
Filiação Federação Mato-grossense de Homologação
Matrícula 2932
Campeonatos 0   Pontos acumulados 250
```

| Medida | ANTES | DEPOIS |
|---|---|---|
| filiação no cadastro | — | HOM-MT |
| matrícula no cadastro | — | **2932** |
| identidades vinculadas | 0 | **1** |
| resultados vinculados | 0 | **3** |
| eventos | — | Campeonato Centro-Oeste, Campeonato Nacional, Copa Pantanal |
| lançamentos de pontos | 0 | **3** |
| pontos acumulados | 0 | **250** |
| sugestões pendentes | 0 | 0 |

### O ledger, lançamento a lançamento

| id | col. | colocação | bônus Overall | ajuste | total | Super Overall | campeão |
|---|---|---|---|---|---|---|---|
| `…my00js7` | 2º | 80 | 0 | 0 | 80 | 80 | não |
| `…nf00jw7` | 1º | 100 | **10** | 0 | **110** | 110 | **sim** |
| `…nu00k07` | 3º | 60 | 0 | 0 | 60 | 0 | não |
| **soma** | | **240** | **10** | **0** | **250** | **190** | **1** |

**A conta, explicada:**

- **240** = 80 + 100 + 60 — os pontos de colocação da tabela da temporada;
- **+10** = bônus de Overall do 1º lugar marcado `overall=sim`;
- **= 250** — o número que a tela mostra;
- **Super Overall 190** = 110 (OPEN 1º + bônus) + 80 (OPEN 2º). O **60 do MASTER
  fica fora**, porque a classe não é absoluta — a regra do Super Overall só conta
  classe elegível. **Não foi recalculada nenhuma regra esportiva.**

**Pontos novos criados: 0.** Os três lançamentos já existiam sob a identidade
externa; o vínculo trocou o ponteiro. `adotarLedger` preenche `athleteId` e não
cria `RankingPoint`.

### A conta de duplicata fecha

| | |
|---|---|
| linhas importadas no lote | 5 |
| competidores no ranking | **3** |
| soma de etapas no ranking | **5** |
| lançamentos do Lucas | **3** |

5 linhas → 5 etapas distribuídas em 3 competidores. **Zero duplicata**, contado.

---

## 5. Ranking consolidado, na tela

Tabela do ranking, temporada do cenário, lida do DOM:

```
#   ATLETA                              CATEGORIA           UF   ETAPAS  OVERALL  PONTOS
1   LG Lucas Gouveia Lima Sem equipe    Men's Bodybuilding  MT   3       1        250
    LL Lucas Lima Sem equipe            Men's Bodybuilding  —    1       —        100
    LL Lucas Lima Sem equipe            Men's Bodybuilding  —    1       —        100
```

**Uma única linha** para filiação + 2932, com o **nome canônico do cadastro**. As
outras duas são a linha **sem matrícula** e a da **outra federação** — e elas
continuam separadas **de propósito**.

Vitrine pública do atleta: `TEMPORADAS NO RANKING 1`, `PONTOS SOMADOS 250`,
`Ranking 1 · Men's Bodybuilding · 3 participação(ões)`.

---

## 6. Os testes positivos e negativos

| Teste | Resultado medido |
|---|---|
| **nova inscrição** com 2932 e nome **"LUCAS G. LIMA"** | reconheceu o cadastro: 4 lançamentos, **330 pt** (250 + 80), 1 identidade, 4 resultados, ranking segue com 3 competidores, **nenhum `athlete_id` novo** |
| **nome igual, matrícula 9999** | 0 identidades, 0 resultados — **não levou nada** |
| **mesma matrícula, filiação HOM-SP** | segue sem dono, 100 pt, separada |
| **linha sem matrícula** | segue sem dono, 100 pt, separada |
| **reeditar o MESMO par** | 200, **mesmos 3 ids**, 250 pt antes e depois — **idempotente** |
| **atleta completamente novo** | cadastro 201, lote aplicado, 1 lançamento, 100 pt, entra no ranking, **não foi associado ao Lucas** |

---

## 7. Auditoria

Lida pela tela `#/admin/auditoria` e pela rota `/audit`. **145 registros**, e os
desta operação:

| ação | entidade | metadata |
|---|---|---|
| `ATHLETE_UPDATE` | `Athlete` | `fields: ["affiliationId","affiliationNumber"]` |
| `RESULTADO_EXTERNAL_LINKED` | `MuscleWarImportItem` ×3 | `matchedBy: AFFILIATION_NUMBER`, `motivo: AUTO_LINK_AFFILIATION_NUMBER`, `affiliationNumber: 2932`, `externalResultId`, `nomeDiverge` |
| `RESULTADO_EXTERNAL_LINKED` | `ExternalAthlete` | `athleteId`, `affiliationId`, `affiliationNumber: 2932`, `lancamentos: 3` |

Ator em cada linha: `QA DEMO Administracao`, `SUPER_ADMIN`,
`operador.homolog@mci.local`, com data e hora. **Identidade adotada e chave que
decidiu estão registradas.** `nomeDiverge: true` nas duas grafias diferentes e
`false` na terceira — o sistema anotou a divergência **sem deixá-la decidir**.

---

## 8. Persistência

Cofre do navegador **limpo** (`localStorage` e `sessionStorage`), **sessão nova**,
perfil reaberto. A tela voltou com:

```
Federação Mato-grossense de Homologação · Matrícula 2932
Pontos acumulados 250
```

A consolidação **não é estado de tela**.

---

## 9. O que esta homologação NÃO prova

1. **Não é o Lucas real de produção.** Este ambiente não alcança o banco de
   produção, e a `DATABASE_URL` é segredo que não se pede nem se aceita por chat.
   As três primeiras linhas da matriz — *Lucas 2932 localizado*, *filiação
   correta*, *matrícula correta* — **continuam sem evidência real** e estão
   marcadas como tal.
2. **O cross-tenant desta sessão é estrutural, não empírico.** Aqui foi medido
   que o papel da aplicação é NOSUPERUSER/NOBYPASSRLS e que há FORCE RLS em 34
   tabelas. A tentativa de leitura entre organizações está provada na suíte
   automatizada, não repetida nesta sessão de navegador.

---

## 10. Achado separado, NÃO corrigido nesta fase

**Identidade externa sem dono não tem fila própria de conferência.** Ela aparece
como linha do ranking sem cadastro — visível, mas misturada. Para a linha **sem
matrícula** o sistema também não oferece sugestão quando o nome da fonte difere
do nome do cadastro, que é o caso medido aqui.

Isso é **conservador e correto** — nome não pode decidir —, mas significa que a
conferência humana depende de alguém olhar o ranking e notar. Registrado como
achado, **sem correção nesta fase**, conforme a regra de não ampliar o escopo.

---

## 11. Como reproduzir

```
# 1. a pilha real, local e descartável
DEMO_PASSWORD='escolha uma com 12+ caracteres' \
DEMO_DATABASE_URL='postgresql://mci_owner:...@127.0.0.1:5432/mci_homolog?schema=public' \
node scripts/qa/ambiente.mjs --host 127.0.0.1

# 2. o diagnóstico, somente leitura, quando houver acesso ao banco real
node scripts/diagnostico-identidade-do-atleta.js --matricula 2932 --ator <userId>
```

---

## 12. Status

**STATUS = PENDENTE.**

23 das 26 linhas da matriz fecharam com evidência real. As 3 que faltam exigem o
banco de produção, e **ausência de evidência não vira PASS**.
