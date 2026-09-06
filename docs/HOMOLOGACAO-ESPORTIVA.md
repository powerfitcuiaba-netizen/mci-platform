# Homologação esportiva — o que o comitê técnico precisa ratificar

**Situação: NÃO HOMOLOGADO.** A plataforma está tecnicamente pronta para
operar uma prova, mas nenhuma prova oficial deve ser apurada por ela antes que
as decisões deste documento sejam ratificadas pelo comitê técnico do
Campeonato Brasileiro Muscle Contest.

Este documento não propõe regulamento. Ele existe porque o motor de apuração é
deliberadamente **configurável**: o código não sabe — e não deve saber — qual é
a regra do Muscle Contest. O que ele faz é obedecer a uma configuração e
registrar qual configuração aplicou. As perguntas abaixo são o que falta para
essa configuração existir com autoridade.

Cada decisão está acompanhada da demonstração do seu efeito concreto no pódio,
em `tests/homologacao-tabulacao.test.mjs`. Os casos são executáveis: rodam com
`npx vitest run tests/homologacao-tabulacao.test.mjs`, usam painéis completos
(todo juiz classifica toda a classe, como numa prova real) e mostram, com
números, quem ganha o título sob cada opção. Ratificar é ler esses casos e
apontar qual comportamento é o do regulamento.

---

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

## DECISÃO 1 — Descarte da maior e da menor colocação

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

## DECISÃO 2 — Tamanho mínimo de painel para o descarte valer

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

## DECISÃO 3 — Critérios de desempate e a ORDEM entre eles

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

## DECISÃO 4 — Empate que nenhum critério resolve

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

## DECISÃO 5 — Método de apuração

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

## DECISÃO 6 — Catálogo oficial de categorias e classes

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

## DECISÃO 7 — Pontuação de ranking

**Pergunta:** quantos pontos de ranking cada colocação vale, e quais eventos
pontuam para qual temporada?

**Estado atual:** a estrutura existe (`RankingSeason`, `RankingPoint`, com
unicidade por `[seasonId, athleteId, resultId]`, que impede pontuação dobrada
para o mesmo resultado). **A tabela de pontos por colocação é configuração e
não foi preenchida com valores oficiais** — nenhum valor foi inventado.

---

## Como ratificar

1. Rodar os casos e ler os números:
   `npx vitest run tests/homologacao-tabulacao.test.mjs`
2. Para cada decisão acima, o comitê registra a opção do regulamento.
3. As opções viram um `ScoringRuleSet` nomeado — por exemplo
   `Regulamento CBMC 2026` — e o evento passa a apontar para ele.
4. A partir daí, todo resultado apurado carrega o checksum daquela regra: uma
   reapuração sob regra diferente é detectável, porque a assinatura cobre a
   configuração e não só os votos.

Enquanto essas decisões não existirem formalmente, a plataforma pode ser usada
em **teste e ensaio**, não em prova oficial. Não é limitação técnica: é que uma
apuração só é legítima quando a regra que ela aplicou foi decidida por quem
tem competência para decidi-la.
