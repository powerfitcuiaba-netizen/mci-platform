# Fase 11.3 — Pontuação, Super Overall e desempate

Documento técnico da regra implementada. O que está aqui é **REGRA HOMOLOGADA**;
o que não está e segue sem definição está no fim, e não foi presumido.

> Revisto na fase 11.4: as regras de ranking foram ratificadas como oficiais.
> O regulamento consolidado está em `docs/phase-11.4-regulamento-ranking.md`.

A aritmética é conferível sem subir nada, lendo
`tests/pontuacao-11-3.test.mjs`; o comportamento na plataforma real, em
`tests/ranking-oficial.test.mjs`.

---

## As duas métricas

A confusão que esta fase existe para impedir:

| | Pergunta que responde | Quem alimenta |
|---|---|---|
| **`points`** — pontos do Campeonato | "quanto este resultado valeu no Campeonato Brasileiro?" | **todas** as classes |
| **`superOverallPoints`** — elegíveis ao Super Overall | "quanto deste resultado conta para o Super Overall anual?" | **só as classes elegíveis** |

```
se a classe é elegível:   superOverallPoints = points
caso contrário:           superOverallPoints = 0
```

Os dois números ficam **gravados em cada lançamento**, e não deduzidos na
leitura. Mudar a configuração de uma classe depois não reescreve a história de
um campeonato encerrado.

O booleano `superOverallEligible` permanece ao lado: ele é o **fato registrado**
("esta classe era elegível quando o ponto foi atribuído"), e a coluna nova é a
**consequência aritmética** dele. Guardar os dois permite auditar a decisão e o
número separadamente.

## Tabela de pontos

| Colocação | Pontos |
|---|---|
| 1º | **5** |
| 2º | **4** |
| 3º | **3** |
| 4º | **2** |
| 5º | **1** |
| 6º em diante | **0** |

Do 6º em diante é **zero** — não um valor extrapolado da progressão. Colocação
fora da tabela **não é conflito** na importação: é um resultado legítimo que
vale zero.

> A tabela é **dado**, não constante de código: vive em `RankingPointsRule`, por
> temporada. Uma temporada nova nasce com estes valores e a tabela oficial
> definitiva os substitui por configuração, sem alterar programa. Nada de
> pontuação escrita no frontend.

## Overall

**Campeão Overall = +10 pontos**, **somados** aos da colocação.

```
1º lugar                  →   5
   e campeã Overall       → +10
                            ───
                     TOTAL   15
```

O sistema **não determina** quem é o campeão Overall. É **fato declarado** pela
organização (`POST /events/:id/overall`) ou informado na importação (coluna
`overall`), sempre com autor e data em auditoria. A pontuação é regra; a
determinação, não.

O mesmo Overall não é contabilizado duas vezes: o título é único por evento e
recorte, e a linha de ponto é única por `(seasonId, athleteId, resultId)`.

### O bônus não tem elegibilidade própria

O +10 **segue a elegibilidade da participação que o originou**:

| Caso | Campeonato | Super Overall |
|---|---|---|
| OPEN, 1º, com Overall | 15 | **15** |
| Novice, 1º, com Overall | 15 | **0** |

Um Overall conquistado fora de uma classe elegível soma no campeonato e **não**
soma no anual. Tratá-lo de outro modo exigiria regra esportiva que não existe.

## Elegibilidade ao Super Overall

Configuração homologada — todas pontuam, só a OPEN alimenta o anual:

| Classe | Pontua no campeonato | Alimenta o Super Overall |
|---|---|---|
| Estreante | ✅ | ❌ |
| Novice | ✅ | ❌ |
| **Open** | ✅ | **✅** |
| Master | ✅ | ❌ |

A marca é **atributo da classe**, no catálogo da organização
(`/classes-catalog`), **nunca o código `OPEN` comparado dentro do motor**. É o
que permite criar, editar, ordenar, ativar e desativar classes sem alterar
programa — há teste que marca MASTER como elegível e prova que ela passa a
contar, sem uma linha de código mudada.

## Os dois rankings

| Ranking | Endpoint | Soma |
|---|---|---|
| Campeonato Brasileiro | `GET /ranking` | `points` |
| Super Overall anual | `GET /ranking/super-overall` | `superOverallPoints` |
| Equipes | `GET /ranking/teams` | `points` |
| Empresas | `GET /ranking/companies` | `points` |

O ranking do campeonato **não** pode somar a métrica do anual: isso faria
Estreante, Novice e Master desaparecerem do pódio. O anual **não** pode somar a
do campeonato: isso traria de volta, por dentro, as classes que a regra exclui.

## Desempate

Aplicado nesta ordem; o primeiro critério que separar encerra a questão:

1. Mais títulos **Overall**
2. Mais **1º** lugares
3. Mais **2º** lugares
4. Mais **3º** lugares
5. **`TIE_UNRESOLVED`**

**4º e 5º pontuam (2 e 1) mas NÃO desempatam.** Pontuação e desempate são
conceitos diferentes, e os contadores de 4º e 5º continuam mantidos apenas para
auditoria.

Esgotada a hierarquia, o empate **não é quebrado**: nada de id, nome, CPF, data,
timestamp, ordem de inscrição ou sorteio. Os empatados ficam **sem colocação**,
marcados como `tieUnresolved`, e a decisão volta para quem tem competência.

## Importação

O operador importa; a regra oficial prevalece.

```
OPERADOR → ARQUIVO → COLOCAÇÃO + CLASSE + OVERALL
         → REGRA DA TEMPORADA → points e superOverallPoints
         → RANKING DO CAMPEONATO / SUPER OVERALL ANUAL
```

Uma coluna de pontos no arquivo **não é fonte**: é uma afirmação a conferir.
Quando a linha traz colocação, o sistema calcula
`placementPoints + overallBonus` e compara.

### Divergência gera CONFLICT

```
Colocação: 1º · Overall: sim · Pontos no arquivo: 14
Regra oficial: 5 + 10 = 15
→ CONFLICT
```

A linha **não é aplicada**. O operador vê os três números — importado,
calculado e diferença — no `reason` e no campo `pointsMismatch`, e decide o que
corrigir: o arquivo ou a tabela da temporada. **Não há mecanismo para ignorar a
divergência sem auditoria**; o evento `SCORE_CONFLICT` registra os números.

### Idempotência

`ExternalResult(source, externalId)` é único, e `RankingPoint` é único por
`(seasonId, athleteId, resultId)` e por `externalResultId`. Reimportar a mesma
linha marca `DUPLICATE` e **não** gera segundo ponto, segundo Overall nem
segunda entrada no ranking. A garantia é do **banco**, não da aplicação: duas
importações concorrentes da mesma linha produzem exatamente um ponto porque a
segunda gravação é impossível.

## Publicação

Resultado **não publicado não alimenta ranking nenhum** — nem o do campeonato,
nem o anual. Alteração posterior de resultado publicado gera nova versão,
recalcula os agregados e fica em auditoria; o recálculo é idempotente e não
duplica pontos.

## Rastreabilidade

`GET /athletes/:id/ranking-points` responde "por que este atleta tem 15 pontos?"
com a linha inteira: evento, categoria, **classe**, colocação, `placementPoints`,
`overallBonus`, `points`, `superOverallPoints`, versão do resultado, autor e
data. O total é **reconstituível a partir das parcelas**, e a origem vai até o
resultado ou a importação que gerou o ponto. **CPF não acompanha.**

## Auditoria

`RANKING_UPDATE`, `OVERALL_DECLARE`, `MUSCLEWAR_IMPORT`, `MUSCLEWAR_APPLY`,
`RESULT_PUBLICATION`, `RESULT_OVERRIDE` e, novos nesta fase, `SCORE_CONFLICT` e
`SUPER_OVERALL_UPDATE`. Os nomes seguem o padrão `ENTIDADE_VERBO` já existente
no projeto, e não os do enunciado.

## Segurança

`RankingPoint`, `ClassCatalog`, `MuscleWarImportItem` e as demais tabelas
envolvidas permanecem com `ENABLE` **e** `FORCE ROW LEVEL SECURITY`. Alterar
pontuação, Overall, ranking ou resultado oficial exige permissão
(`ranking.manage`, `results.publish`, `musclewar.apply`); usuário comum e
anônimo não alteram nada. CPF continua restrito e fora do ranking público.

---

# Estado das definições *(revisto na fase 11.4)*

Os itens abaixo **deixaram de ser pendência** — foram definidos pelo
organizador. Ver `docs/phase-11.4-regulamento-ranking.md`.

1. ✅ **Critério do campeão Overall.** É a regra, não a lacuna: o campeão é
   **fato declarado** pelo operador ou pela importação, e o sistema não deve
   inventar algoritmo para descobri-lo.
2. ✅ **Desempate além do 3º lugar.** A hierarquia é definitiva e para no 3º;
   4º e 5º pontuam e não desempatam.
3. ✅ **Pontuação do 6º em diante.** Zero é o valor definido.
4. ✅ **Super Overall de equipes e empresas.** Vale a **mesma regra**: só a
   OPEN é elegível. O modelo já suporta o acumulado sem tabela nova — cada
   `RankingPoint` carrega `superOverallPoints` ao lado de `teamId` e
   `companyId` —, e nenhuma tela ou competição paralela foi criada nesta fase.

## Ainda PENDING DEFINITION

Não preenchido com suposição:

1. **Apuração dentro da classe** — método, descarte da maior/menor colocação,
   painel mínimo e ordem dos desempates internos. Ver
   `docs/HOMOLOGACAO-ESPORTIVA.md`, Parte III.
2. **Quais resultados de atleta são elegíveis para a equipe** — sem regra de
   descarte, de teto ou de mínimo, todos os resultados pontuados contam.
