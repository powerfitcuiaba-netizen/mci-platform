# Regulamento do ranking — MCI

**Regras oficiais do Campeonato Brasileiro Muscle Contest International.**

Este documento é a referência única do que está **HOMOLOGADO**. Nada aqui é
provisório, experimental ou sujeito a confirmação. As regras foram definidas
pelo organizador do campeonato e implementadas.

Conferível sem subir nada, lendo `tests/pontuacao-11-3.test.mjs` e
`tests/regulamento-11-4.test.mjs`; na plataforma real, `tests/ranking-oficial.test.mjs`.

---

## Classes

Configuração homologada:

| Classe | Pontua no campeonato | Alimenta o Super Overall |
|---|---|---|
| **ESTREANTE** | ✅ | ❌ |
| **NOVICE** | ✅ | ❌ |
| **OPEN** | ✅ | **✅** |
| **MASTER** | ✅ | ❌ |

`JUNIOR` **não** faz parte da configuração oficial atual.

O operador continua podendo **criar, editar, ativar, desativar e ordenar**
classes pelo catálogo da organização (`/classes-catalog`), sem alteração de
código: a elegibilidade é atributo do dado, nunca o código `OPEN` comparado
dentro do motor.

## Pontuação

| Colocação | Pontos |
|---|---|
| 1º | **5** |
| 2º | **4** |
| 3º | **3** |
| 4º | **2** |
| 5º | **1** |
| **6º em diante** | **0** |

Zero é o valor **definido** para o 6º em diante — não uma lacuna à espera de
tabela estendida, e não um valor extrapolado da progressão.

A tabela vive em `RankingPointsRule`, **por temporada**, e é versionável. Não há
tabela de pontos escrita no frontend.

## Overall

**Campeão Overall = +10 pontos**, somados aos da colocação.

```
1º lugar             →   5
   e campeão Overall → +10
                       ───
                TOTAL   15
```

**QUEM é o campeão Overall é fato declarado** pelo operador ou pela importação.
O sistema **não inventa algoritmo** para descobri-lo. Isso é a regra, não uma
pendência: a determinação é do regulamento esportivo; a pontuação é do sistema.

## Super Overall anual

**Todas as classes pontuam no campeonato. Somente a OPEN alimenta o Super
Overall anual.**

```
se a classe é elegível (OPEN):   superOverallPoints = competition_points
caso contrário:                  superOverallPoints = 0
```

O bônus de Overall **não tem elegibilidade própria**: segue a da participação
que o originou.

| Caso | Campeonato | Super Overall |
|---|---|---|
| OPEN, 1º | 5 | **5** |
| OPEN, 1º + Overall | 15 | **15** |
| NOVICE, 1º | 5 | **0** |
| NOVICE, 1º + Overall | 15 | **0** |
| ESTREANTE, 1º + Overall | 15 | **0** |
| MASTER, 1º + Overall | 15 | **0** |

### As duas métricas nunca se misturam

| | Soma | Alimenta |
|---|---|---|
| `GET /ranking` — Campeonato | `points` | todas as classes |
| `GET /ranking/super-overall` — anual | `superOverallPoints` | só as elegíveis |

Usar a métrica do anual no ranking do campeonato apagaria Estreante, Novice e
Master do pódio. Usar a do campeonato no anual traria de volta, por dentro, as
classes que a regra exclui.

## Desempate — DEFINITIVO

Aplicado nesta ordem; o primeiro critério que separar encerra a questão:

1. Mais títulos **Overall**
2. Mais **1º** lugares
3. Mais **2º** lugares
4. Mais **3º** lugares
5. **`TIE_UNRESOLVED`**

**4º e 5º pontuam (2 e 1) e NÃO desempatam.** Pontuação e desempate são
conceitos diferentes; os contadores de 4º e 5º existem apenas para auditoria.

Esgotada a hierarquia, o empate **não é quebrado**: nada de id, nome, CPF, data,
timestamp, ordem de inscrição, alfabética ou sorteio. Os empatados ficam sem
colocação, marcados como `tieUnresolved`, e a decisão volta para quem tem
competência de tomá-la.

## Equipes e empresas

**A mesma tabela, o mesmo bônus, o mesmo desempate e a mesma elegibilidade.**
Sem fórmula, peso, multiplicador ou critério próprio.

```
EMPRESA (Company) → EQUIPE (Team) → ATLETA (Athlete)
```

`GET /ranking/teams` e `GET /ranking/companies` somam `points` e ordenam pela
hierarquia oficial — o mesmo `classificar()` do ranking de atletas.

**Super Overall de equipes e empresas:** vale a mesma regra de elegibilidade —
**somente OPEN**. O modelo já suporta o acumulado **sem tabela nova**: cada
`RankingPoint` carrega `superOverallPoints` ao lado de `teamId` e `companyId`,
de modo que somar por equipe ou por empresa exclui Estreante, Novice e Master
por construção. Nenhuma tela ou competição paralela foi criada para isso nesta
fase, conforme determinado.

**Patrocinador não pontua.** `Sponsor` e `Brand` são relação comercial: não
vinculam atleta, não geram ponto e não alteram ranking.

## Importação

O operador importa; a regra oficial prevalece. Uma coluna de pontos no arquivo
**não é fonte** — é afirmação a conferir. Divergência entre o número importado e
o calculado gera **`CONFLICT`**, com os três números à vista (importado,
calculado, diferença) e evento `SCORE_CONFLICT`. **Nunca há correção
silenciosa.**

Idempotência garantida pelo **banco**: reimportar a mesma linha não duplica
ponto, Overall nem ranking, inclusive sob importações concorrentes.

## Publicação

Resultado **não publicado não alimenta ranking nenhum**. Alteração posterior de
resultado publicado gera nova versão, recalcula os agregados, fica em auditoria
e não duplica pontos.

## Rastreabilidade

`GET /athletes/:id/ranking-points` explica cada ponto: evento, categoria,
classe, colocação, `placementPoints`, `overallBonus`, `points`,
`superOverallPoints`, versão do resultado, autor e data. O total é
reconstituível a partir das parcelas. **CPF não acompanha.**

---

# PENDING DEFINITION

O que segue sem regra, e **não foi presumido**:

1. **Apuração dentro da classe** — método, descarte da maior/menor colocação,
   painel mínimo para o descarte e ordem dos desempates *internos*. Não se
   confunde com o desempate de **ranking**, homologado acima. Ver
   `docs/HOMOLOGACAO-ESPORTIVA.md`, Parte III.
2. **Quais resultados de atleta são elegíveis para a equipe** — sem regra de
   descarte, de teto de atletas pontuando ou de mínimo por equipe, todos os
   resultados pontuados contam.
