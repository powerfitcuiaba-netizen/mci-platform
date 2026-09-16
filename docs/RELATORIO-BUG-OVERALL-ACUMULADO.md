# BUG — OVERALL / RANKING ACUMULADO

Encontrado por **teste humano** no ambiente de preview. Reaberto a FASE 13 até
o número exibido ser explicável por uma soma auditável.

---

## Sintoma

Tela `Ranking → Campeonato`:

```
QA · DEMO — Atleta Campeã Overall
Etapas: 2
Pontos: 30
```

Pela regra vigente, 1º lugar vale 5 e o título de Overall vale +10 — a
participação vale 15. Duas etapas e 30 pontos leem-se, naturalmente, como
**15 contado duas vezes**.

## Esperado

O valor que as participações reais produzem, e que a própria tela permita
conferir.

## Origem

Nenhuma das causas está no motor de pontuação. São três, e as três são minhas.

| # | Onde | O quê |
|---|---|---|
| 1 | `scripts/qa/preview-verificacao.mjs` | o arreio de QA homologava um Overall de verdade e **deixava o título lá** |
| 2 | `scripts/qa/demo.mjs` | a mesma atleta vencia a Open das **duas** primeiras etapas |
| 3 | `frontend/src/pages/publicPages.jsx` | a tabela do campeonato não mostrava a coluna **Overall** |

A causa 1 sujou o artefato que ela verificava: o preview foi anunciado com a
narrativa "um Overall homologado", e os dados já não contavam isso. A causa 2
tornava a armadilha inevitável — o roteiro que entreguei manda homologar
(TESTE 6), e o único campeonato sem título era justamente o outro da mesma
atleta. A causa 3 impediu que qualquer um desfizesse o mal-entendido olhando a
tela.

## Evidência

Reproduzida a sequência exata do preview — semeadura, depois verificação — e
lido o ledger em cada ponto.

**Depois da semeadura**, que é o estado documentado:

| Evento | Categoria | Classe | Col. | placementPoints | overallBonus | points |
|---|---|---|---:|---:|---:|---:|
| Etapa Cuiabá | BIKINI | OPEN | 1 | 5 | 10 | 15 |
| Etapa Várzea Grande | BIKINI | OPEN | 1 | 5 | 0 | 5 |

```
linhas de RankingPoint: 2      participações duplicadas: NENHUMA
títulos EventOverallTitle: 1
Ranking: totalPoints=20  eventCount=2  overallWins=1
soma do ledger = 20  →  CONFERE
```

**Depois da verificação automática**, que é o estado que o teste humano abriu:

| Evento | Categoria | Classe | Col. | placementPoints | overallBonus | points |
|---|---|---|---:|---:|---:|---:|
| Etapa Cuiabá | BIKINI | OPEN | 1 | 5 | 10 | 15 |
| Etapa Várzea Grande | BIKINI | OPEN | 1 | 5 | **10** | **15** |

```
linhas de RankingPoint: 2      participações duplicadas: NENHUMA
títulos EventOverallTitle: 2   ← um por evento
Ranking: totalPoints=30  eventCount=2  overallWins=2
soma do ledger = 30  →  CONFERE
```

**De onde vêm os 30**, com os três componentes que a regra oficial permite:

```
  5  colocação (1º na Open de Cuiabá)
 10  título de Overall de Cuiabá
  5  colocação (1º na Open de Várzea Grande)
 10  título de Overall de Várzea Grande
 ──
 30
```

O que foi **descartado com dados**, e não por suposição:

- `15 + 15` por duplicação de participação — não: duas linhas, chaves
  `(evento, resultado, recorte)` distintas;
- `placementPoints` duplicado — não: soma 10, que é 5 + 5;
- `overallBonus` duplicado na mesma linha — não: 10 em cada, uma por título;
- agregação contando o mesmo `RankingPoint` duas vezes — não: o consolidado é
  idêntico à soma do ledger;
- `awardForResult` gerando linhas extras — não: duas linhas para duas
  participações;
- recálculo creditando de novo — não: repontuar três vezes não move o total.

**Overall é por campeonato.** Dois títulos valem dois bônus, e isso é a regra,
não um defeito. O que estava errado era a demonstração prometer um título e
entregar dois, e a tela não permitir perceber a diferença.

## Correção

1. **A verificação desfaz o que declara.** Depois de homologar — e o teste
   continua homologando de verdade —, ela **revoga**, pela via própria,
   registrada em auditoria. Arreio de QA não deixa rastro no artefato.
2. **Cada etapa tem vencedora própria na Open.** Entrou a *Atleta Candidata ao
   Overall*, que vence a 2ª etapa e não tem título: é nela que o roteiro manda
   homologar. A campeã fecha em **19** — 5 + 10 na 1ª, 4 na 2ª. A semeadura
   **confere esse total** antes de se declarar pronta, e reprova se mudar.
3. **A tabela do campeonato ganhou a coluna Overall** e uma legenda com a conta
   por extenso: cada colocação pela tabela oficial, cada título somando +10,
   uma vez por campeonato.

Nada foi alterado no motor de pontuação, nenhum dado foi editado à mão e
nenhum recálculo foi usado para mascarar. O display passou a refletir o que a
fonte de verdade sempre disse.

## Teste que reproduz

`tests/ranking-acumulado-multietapa.test.mjs` — "30 só é possível com DOIS
títulos". Monta duas etapas, declara Overall nas duas e prova que cada bônus
veio do seu título, sem participação repetida. É o cenário do preview, fixado.

## Teste que prova a correção

Mesmo arquivo, sete casos:

| Caso | O que tranca |
|---|---|
| duas etapas, título em uma | 5 + (5+10) = **20**, nunca 30 |
| duas etapas, título nas duas | 30, com um bônus por título |
| consolidado == ledger | para toda atleta, sempre |
| três classes num campeonato | "Etapas" = **1**, não 3 |
| declarar 3× e repontuar 3× | o total não se move |
| prévia de re-homologação | impacto **zero**, e não +10 de novo |
| ordem das operações | declarar antes ou depois dá o mesmo número |

Mais `frontend/src/pages/rankingExplicavel.test.jsx`, três casos, trancando a
coluna, o traço para quem não tem título e a legenda **visível**.

## Mutation

**7 mutantes, 7 mortos.**

```
B1 bônus somado a cada linha do evento          | MORTO
B2 bônus somado duas vezes na portadora         | MORTO
B3 agregação soma o ponto duas vezes            | MORTO
B4 etapas contadas por linha, não por evento    | MORTO
B5 prévia promete +10 que já foi dado           | MORTO
F1 a tela volta a esconder os títulos           | MORTO
F2 a legenda some                               | MORTO
CONTROLE                                        | VERDE
```

Três só morreram depois de eu escrever o teste que faltava. **F2 sobreviveu à
primeira tentativa** porque a consulta por texto encontra elemento escondido
também: a asserção passou a exigir visibilidade, não presença no DOM.

## Regressão

| | |
|---|---|
| Backend | **1228 passam**, 10 pulados, 68 arquivos |
| Interface | **458 passam**, 38 arquivos |
| Build | 523,08 kB (139,60 kB gzip) |
| ESLint | limpo |
| Verificação do preview | **APROVADO** |

Sem regressão em Overall, Ranking, TOP 5 público, Meu Histórico, Minha
Filiação, Matching, multi-tenant e RLS.

## QA visual

Tela do ranking, depois da correção:

```
#   ATLETA                              CATEGORIA  UF  ETAPAS  OVERALL  PONTOS
1   QA · DEMO — Atleta Campeã Overall   Bikini     MT     2       1       19
4   QA · DEMO — Atleta Quinta Colocada  Bikini     MT     3       —       10
5   QA · DEMO — Atleta Empatada A       Bikini     MT     2       —        8
8   QA · DEMO — Atleta Candidata…       Bikini     MT     1       —        5
```

E, abaixo da tabela, a conta por extenso. O 19 se lê na própria tela:
5 + 10 numa etapa, 4 na outra.

## Commit

`9080f9a` — *BUG do teste humano — o 30 era verdadeiro, e mesmo assim era
defeito meu*

## Estado

**PASS.**

O motor de pontuação estava correto e continua sem alteração. Os três defeitos
eram de **arreio de QA**, **dados de demonstração** e **explicabilidade da
tela** — e os três estão corrigidos, com teste e mutação.

### Gate do §17

Para o dataset atual, `Ranking.totalPoints` é **idêntico** à soma dos
`RankingPoint` de toda atleta, e isso virou asserção permanente. O valor
exibido é explicável componente a componente.

### O que o episódio mostrou

A suíte da FASE 13 estava verde e o ambiente fora aprovado — e mesmo assim um
número na tela não se sustentava para quem o leu. O teste automático mediu o
que sabia perguntar; o humano perguntou "de onde vêm esses 30?", que é uma
pergunta que nenhum teste meu fazia. Agora faz.
