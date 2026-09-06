# Homologação esportiva — o que o comitê técnico precisa ratificar

**Situação: PARCIALMENTE HOMOLOGADO.** A regra de pontuação, o bônus Overall e
a hierarquia de desempate foram definidos pelo organizador na fase 11.1 e estão
implementados. As decisões de *apuração* (método, descarte, desempate dentro da
classe) e a determinação do campeão Overall seguem pendentes.

Este documento separa, sem ambiguidade, o que é **REGRA HOMOLOGADA** do que é
**PENDING HOMOLOGATION**. Nada pendente é apresentado como oficial.

Cada decisão está acompanhada da demonstração do seu efeito concreto no pódio,
em `tests/homologacao-tabulacao.test.mjs`. Os casos são executáveis: rodam com
`npx vitest run tests/homologacao-tabulacao.test.mjs`, usam painéis completos
(todo juiz classifica toda a classe, como numa prova real) e mostram, com
números, quem ganha o título sob cada opção. Ratificar é ler esses casos e
apontar qual comportamento é o do regulamento.

---

# PARTE I — REGRA HOMOLOGADA (fase 11.1)

Definida pelo organizador e implementada. Conferível em
`tests/pontuacao-oficial.test.mjs` (aritmética) e `tests/ranking-oficial.test.mjs`
(comportamento na plataforma).

## Pontuação por colocação

| Colocação | Pontos |
|---|---|
| 1º | **5** |
| 2º | **4** |
| 3º | **3** |
| 4º | **2** |
| 5º | **1** |

Somente de 1º a 5º pontuam pela tabela padrão.

> A tabela é **dado**, não constante de código: vive em `RankingPointsRule`, por
> temporada. Uma temporada nova já nasce com estes valores, e a tabela oficial
> definitiva (PDF/planilha) os substitui por configuração, sem alterar programa.

## Overall

**Campeão Overall = +10 pontos**, **somados** aos pontos da colocação — não os
substituem.

```
Atleta em 1º lugar             →  5 pontos
   e também campeã Overall     → +10 pontos
                                 ──────────
                          TOTAL   15 pontos
```

Se o campeão Overall vier de outra colocação, o bônus acompanha essa colocação:
2º lugar + Overall = 4 + 10 = **14**.

## Equipes

**A mesma tabela e o mesmo desempate.** Sem peso, multiplicador ou bônus
próprio de equipe. A pontuação da equipe é a soma dos pontos dos seus atletas, e
cada parcela continua apontando para o resultado que a originou.

## Classes e elegibilidade ao Super Overall *(fase 11.2)*

Dentro de cada categoria/divisão existem as classes **Estreante**, **Novice**,
**Open** e **Master**. O operador acrescenta, edita e desativa classes pelo
catálogo da organização (`/classes-catalog`), sem alteração no motor.

**Todas as classes pontuam no campeonato**, pela mesma tabela acima. A
distinção é outra:

| Classe | Pontua no campeonato | Alimenta o Super Overall anual |
|---|---|---|
| Estreante | ✅ | ❌ |
| Novice | ✅ | ❌ |
| **Open** | ✅ | **✅** |
| Master | ✅ | ❌ |

> São duas perguntas diferentes, e o modelo as separa: `points` responde
> "pontuou no evento"; `superOverallEligible` responde "conta para o Super
> Overall". A marca é **atributo da classe**, nunca o código `OPEN` comparado
> dentro do motor — é o que permite criar uma classe nova sem tocar em programa.
> A elegibilidade é **gravada em cada lançamento**, para que mudar a
> configuração de uma classe não reescreva a história de um campeonato encerrado.

## Desempate — hierarquia oficial

Aplicada nesta ordem exata; o primeiro critério que separar encerra a questão:

1. Mais títulos **Overall**
2. Mais **1º** lugares
3. Mais **2º** lugares
4. Mais **3º** lugares
5. **`TIE_UNRESOLVED`**

> **Revisão da fase 11.2:** a cadeia parava no 5º lugar e passou a parar no 3º,
> por decisão do organizador. Os contadores de 4º e 5º continuam mantidos —
> essas colocações pontuam e a conta precisa seguir conferível —, mas **não
> participam do desempate**.

## Origem dos pontos: a colocação, não um número digitado

O operador informa o **resultado oficial** (colocação, classe, e se houve
Overall); o sistema aplica a regra. Uma coluna de pontos no arquivo de
importação **não substitui** a tabela quando há colocação — só é usada quando a
linha não traz colocação alguma, caso em que não há regra a aplicar.

```
OPERADOR → IMPORTAÇÃO → CATEGORIA → DIVISÃO/CLASSE → ATLETA/EQUIPE
         → COLOCAÇÃO → PONTOS (regra) → OVERALL, SE INFORMADO
         → RANKING → FILTRO DE ELEGIBILIDADE → SUPER OVERALL ANUAL
```

Esgotada a hierarquia, o empate **não é quebrado**. Nada de id, nome, data,
ordem de inserção ou alfabética: os empatados ficam **sem colocação**, sinalizados
como `tieUnresolved`, e a decisão volta para quem tem competência de tomá-la.

### Exemplo numérico — cinco atletas

| Atleta | Colocação | Pontos da colocação | Bônus Overall | Total |
|---|---|---|---|---|
| A | 1º | 5 | +10 | **15** |
| B | 1º (outra classe) | 5 | 0 | **5** |
| C | 2º | 4 | 0 | **4** |
| D | 3º | 3 | 0 | **3** |
| E | 5º | 1 | 0 | **1** |

### Exemplo numérico — desempate por Overall

Duas atletas terminam a temporada com **15 pontos**:

| | Total | Overall | 1º | Resultado |
|---|---|---|---|---|
| **A** | 15 | **1** | 1 | **1ª** — o Overall é consultado primeiro |
| **B** | 15 | 0 | **3** | 2ª — mais primeiros lugares não supera um Overall |

B tem o triplo de primeiros lugares e perde assim mesmo, porque a ordem dos
critérios *é* a regra.

### Exemplo numérico — equipe

| Equipe | Atleta | Colocação | Pontos |
|---|---|---|---|
| **Alfa** | ALFA1 | 1º + Overall | 5 + 10 = 15 |
| **Alfa** | ALFA2 | 3º | 3 |
| | | **Total Alfa** | **18** |
| **Beta** | BETA1 | 2º | 4 |
| **Beta** | BETA2 | 4º | 2 |
| | | **Total Beta** | **6** |

---

# PARTE II — PENDING HOMOLOGATION

Não implementado por ausência de regra, e **não presumido**.

## P1. Como se determina o campeão Overall

✅ **RESOLVIDO na fase 11.2 — por definição, e não por implementação.** O
organizador estabeleceu que **quem é o campeão Overall é dado informado** pelo
operador ou pela importação, e que o sistema **não deve tentar descobri-lo
sozinho** até existir regra específica de apuração.

É exatamente o que está implementado: o título é registrado
(`POST /events/:id/overall`) ou vem marcado na importação (coluna `overall`),
sempre com autor e data em auditoria. A pontuação (+10) é regra homologada; a
determinação continua sendo fato declarado.

**Ainda pendente:** se e quando houver uma regra de *apuração* do Overall, ela
entra neste mesmo ponto sem alterar o resto do motor.

## P2. Quais resultados de atleta são "elegíveis" para a equipe

Sem regra de descarte, de teto de atletas pontuando ou de mínimo por equipe,
**todos** os resultados pontuados do atleta contam para a equipe. Qualquer corte
seria presunção.

## P3. Desempate além do 3º lugar

A hierarquia oficial vai até o número de terceiros lugares. Persistindo o
empate, **nenhum critério adicional é inventado**: os empatados ficam como
`TIE_UNRESOLVED` até que uma regra oficial seja definida.

## P4. Qual entidade representa "empresa" como competidora

O organizador estabeleceu que a mesma tabela de pontos se aplica a **atletas,
equipes e empresas**. Atletas e equipes estão implementados — `Team` já existia
e o atleta já se vincula a ela.

**Para empresas falta a definição de qual entidade é essa.** O sistema tem
`Brand` (marca), `Sponsor` (patrocinador), `Gym` (academia) e `Coach`, e o
atleta se vincula a academia e a treinador — mas nenhuma delas é declaradamente
"a empresa que o atleta representa em competição". Escolher uma seria presumir.

**Falta também o campo no arquivo de importação**: o adapter passou a reconhecer
`overall` e `equipe`, mas não há coluna de empresa porque não há entidade de
destino.

## P5. Pontuação do 6º lugar em diante

A tabela homologada vai até o 5º. Colocações a partir do 6º recebem **zero**, e
não um valor extrapolado.

## P6. Decisões de apuração dentro da classe

Método, descarte da maior/menor colocação, painel mínimo para o descarte e
ordem dos desempates *dentro da classe* seguem pendentes — são a Parte III
abaixo, e não se confundem com o desempate de **ranking** homologado na Parte I.

---

# PARTE III — DECISÕES DE APURAÇÃO AINDA PENDENTES

Estas são as decisões de como se apura **dentro de uma classe** — distintas do
desempate de **ranking**, homologado na Parte I.

## O que já é fato, não decisão

Isto está implementado e testado, e não depende de ratificação:

| Fato | Onde se verifica |
|---|---|
| Apuração determinística: mesma entrada e mesma regra produzem sempre o mesmo resultado | `checksum` cobre votos **e** configuração |
| A ordem em que os votos chegam do banco não altera o resultado | os votos são ordenados antes do hash |
| Nenhum empate é resolvido por id, ordem de cadastro, timestamp ou nome | `TIE_UNRESOLVED` |
| A regra aplicada volta junto com o resultado e fica gravada | `Result` + `ResultVersion` |
| Toda mudança de estado de um resultado gera nova versão com quem, quando e por quê | `ResultVersion` |
| O countback e a colocação bruta de cada atleta ficam registrados | permite refazer a conta à mão |

O ponto de partida do sistema é o mais conservador possível: **sem descarte e
sem nenhum critério de desempate**. Não é uma recomendação técnica disfarçada
de padrão — é a recusa a decidir no lugar de quem tem competência. Sob esse
padrão, um empate simplesmente não produz campeão: ele volta para a organização
resolver, com registro.

---

## DECISÃO A — Descarte da maior e da menor colocação

**Pergunta:** o regulamento do Muscle Contest descarta a melhor e a pior
colocação que um atleta recebeu antes de somar?

**Estado atual:** desligado (`dropHighLow = false`).

**Por que importa — o caso demonstrado.** Classe de 5 atletas, painel de 7
juízes:

- **ANA** é consistente: os 7 juízes a colocam em 2º. Soma 14.
- **BRUNA** é polarizadora: 4 juízes a colocam em 1º, dois em 3º e um em 5º.
  Soma 15.

| | Soma considerada | Campeã |
|---|---|---|
| **Sem descarte** | ANA 14 · BRUNA 15 | **ANA** |
| **Com descarte** | ANA 10 · BRUNA 9 | **BRUNA** |

A mesma prova, com os mesmos votos dos mesmos juízes, entrega **dois títulos
diferentes**. Não existe resposta técnica para qual está certo — é regulamento.

> Demonstrado em `homologação: DECISÃO 1 — descarte da maior e da menor colocação`.

---

## DECISÃO B — Tamanho mínimo de painel para o descarte valer

**Pergunta:** a partir de quantos juízes o descarte se aplica?

**Estado atual:** 7 (`dropHighLowMinJudges = 7`), valor que **não tem respaldo
normativo** — é um número de partida que precisa ser confirmado ou trocado.

**Por que importa.** Com o mesmo painel de 7 juízes do caso anterior:

- mínimo configurado em **7** → o descarte entra → campeã **BRUNA**
- mínimo configurado em **9** → painel pequeno demais, descarte não entra → campeã **ANA**

O limiar é, por si só, um decisor de título. Descartar dois votos de um painel
de 3 concentra a prova em um único juiz; onde exatamente fica essa fronteira é
decisão de regulamento, e o código apenas a obedece.

> Demonstrado em `homologação: DECISÃO 2 — painel mínimo para o descarte valer`.

---

## DECISÃO C — Critérios de desempate e a ORDEM entre eles

**Pergunta:** quais critérios de desempate o regulamento prevê, e em que ordem
são aplicados?

**Estado atual:** o seed cria uma regra chamada `Padrão MCI` com
`tieBreakers: [COUNT_BACK]`. **É um ponto de partida para desenvolvimento, não
uma regra homologada.**

**Critérios implementados** (três; qualquer outro precisa ser implementado
antes de poder ser configurado — o motor ignora nome de critério que não
existe, em vez de improvisar):

| Critério | O que faz |
|---|---|
| `HEAD_JUDGE_PLACING` | Vence quem o juiz-chefe colocou melhor |
| `COUNT_BACK` | Vence quem tem mais colocações melhores (mais 1ºs; empatando, mais 2ºs; e assim por diante) |
| `SUM_WITHOUT_DROP` | Vence quem tem a menor soma **antes** do descarte |

**Por que a ordem importa — o caso demonstrado.** Classe de 3 atletas, 3
juízes. PAULA e QUEZIA empatam em 5 pontos:

- **PAULA:** 1º, 1º, 3º — duas vitórias e uma queda
- **QUEZIA:** 2º, 2º, 1º — regularidade e uma vitória

| Configuração | Campeã |
|---|---|
| Nenhum critério | **ninguém** — `TIE_UNRESOLVED` |
| `[COUNT_BACK]` | **PAULA** (dois primeiros lugares) |
| `[HEAD_JUDGE_PLACING]`, juiz 3 como chefe | **QUEZIA** (o chefe a colocou em 1º) |
| `[HEAD_JUDGE_PLACING, COUNT_BACK]` | **QUEZIA** |
| `[COUNT_BACK, HEAD_JUDGE_PLACING]` | **PAULA** |

Trocar apenas a **ordem** dos mesmos dois critérios troca a campeã. A lista
precisa ser ratificada como sequência, não como conjunto.

**Comportamento a confirmar junto:** quando um critério configurado não se
aplica — `HEAD_JUDGE_PLACING` sem juiz-chefe declarado, por exemplo — o motor
**mantém o empate** em vez de pular para o critério seguinte ou escolher um
chefe. O comitê precisa confirmar que essa é a conduta desejada.

> Demonstrado em `homologação: DECISÃO 3 — empate e ordem dos critérios de desempate`.

---

## DECISÃO D — Empate que nenhum critério resolve

**Pergunta:** qual é o procedimento oficial quando os critérios configurados
não resolvem o empate?

**Estado atual:** os atletas empatados saem com `status = TIE_UNRESOLVED` e
**sem colocação**. O resultado não é publicável nesse estado sem decisão
humana, e a decisão fica registrada em `ResultVersion` com autor e motivo.

O que o sistema garante:

- ninguém recebe título por critério arbitrário;
- o empate **não vaza para baixo** — no caso de 3 atletas acima, RAISSA recebe
  o 3º lugar, não o 2º: a indefinição no topo não a promove;
- a apuração informa explicitamente que há empate não resolvido
  (`hasUnresolvedTie`).

O que **falta** e é do comitê: o procedimento. Reavaliação em nova chamada?
Decisão do juiz-chefe em ata? Pose-down? O sistema registra o desfecho que lhe
informarem; ele não pode escolher qual desfecho é legítimo.

---

## DECISÃO E — Método de apuração

**Pergunta:** `RELATIVE_PLACEMENT_SUM` — soma das colocações dadas pelos
juízes, menor soma vence — é o método do regulamento?

**Estado atual:** é o único método implementado. Se o comitê definir outro
(escore absoluto por critério, sistema de rodadas com corte, ranking por
maioria), ele precisa ser **implementado e testado** antes de existir como
opção. O motor não aceita nome de método inexistente: cai no padrão em vez de
apurar com regra imaginária.

Observação importante sobre os **critérios de avaliação** (Massa muscular,
Simetria, Condição, Apresentação…): eles existem no sistema, por categoria, e
servem à ficha do juiz. **A apuração oficial usa a colocação, não a soma desses
critérios.** Se o regulamento previr o contrário, isso é a Decisão 5 e exige
implementação.

---

## DECISÃO F — Catálogo oficial de categorias e classes

**Estado atual, carregado pelo seed** — 11 categorias, com
`WOMEN'S BODYBUILDING` e `FITMODEL` entre as obrigatórias:

Men's Bodybuilding · Men's Physique · Classic Physique · 212 Bodybuilding ·
Women's Bodybuilding · Women's Physique · Wellness · Bikini · Fitness ·
Figure · Fitmodel

Classes de referência: `JUNIOR`, `NOVICE`, `OPEN`, `MASTER`.

**A ratificar:** os recortes por idade e peso de cada classe, e quais
categorias admitem quais classes. Hoje a estrutura é extensível — cada evento
cria suas divisões e classes — e o catálogo é **dado, não código**: uma
categoria nova entra por uma linha no seed ou por `POST /categories`, sem
alteração de lógica. Nenhum limite de idade ou faixa de peso foi presumido pelo
sistema, porque presumir seria inventar regra esportiva.

---

## DECISÃO G — Pontuação de ranking

✅ **HOMOLOGADA na fase 11.1.** Ver Parte I. A estrutura já existia
(`RankingSeason`, `RankingPoint` com unicidade por `[seasonId, athleteId, resultId]`,
que impede pontuação dobrada); o que faltava era a tabela, e ela agora existe
como dado da temporada.

## Como ratificar

1. Rodar os casos e ler os números:
   `npx vitest run tests/homologacao-tabulacao.test.mjs`
2. Para cada decisão acima, o comitê registra a opção do regulamento.
3. As opções viram um `ScoringRuleSet` nomeado — por exemplo
   `Regulamento CBMC 2026` — e o evento passa a apontar para ele.
4. A partir daí, todo resultado apurado carrega o checksum daquela regra: uma
   reapuração sob regra diferente é detectável, porque a assinatura cobre a
   configuração e não só os votos.

As decisões da Parte I estão homologadas e implementadas. As da Parte III —
apuração dentro da classe — continuam pendentes, e enquanto elas não existirem
formalmente a plataforma pode ser usada em **teste e ensaio**, não em prova
oficial. Não é limitação técnica: é que uma
apuração só é legítima quando a regra que ela aplicou foi decidida por quem
tem competência para decidi-la.
