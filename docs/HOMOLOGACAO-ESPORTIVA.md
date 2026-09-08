# Homologação esportiva — o que o comitê técnico precisa ratificar

**Situação: REGRAS DE RANKING HOMOLOGADAS.** A tabela de pontos (5/4/3/2/1, e
0 do 6º em diante), o bônus Overall (+10), a elegibilidade ao Super Overall
(só a OPEN) e a hierarquia de desempate (Overall → 1º → 2º → 3º →
`TIE_UNRESOLVED`) estão **definidas e implementadas**, e valem igualmente para
atletas, equipes e empresas.

**O julgamento esportivo é EXTERNO ao MCI** (decisão do organizador, fase
11.5). Método de apuração, descarte de notas, painel mínimo e critério de
desempate *dentro da classe* não são decisões desta plataforma: acontecem no
processo de julgamento externo, e o MCI recebe a colocação já definida. O que
segue nesta página é o que **é** responsabilidade do MCI — a pontuação de
ranking a partir da colocação recebida.

Este documento separa, sem ambiguidade, o que é **REGRA HOMOLOGADA** do que é
**PENDING HOMOLOGATION**. Nada pendente é apresentado como oficial.

Cada regra está acompanhada da demonstração do seu efeito concreto no pódio, em
`tests/regulamento-11-4.test.mjs` (a matriz da regra, caso a caso) e
`tests/ranking-oficial.test.mjs` (o comportamento na plataforma real). Os casos
são executáveis e mostram, com números, quem fica em cada posição.

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

## Vínculo único atleta → equipe/empresa *(fase 11.2)*

**Um atleta tem, no máximo, um vínculo ativo de equipe.** Não é validação de
tela: é trava de integridade cadastral, aplicada em Frontend → API → Service →
**Banco de dados**.

Uma segunda tentativa de vínculo é **recusada pelo backend** com `409
ATHLETE_ALREADY_LINKED`, e a mensagem **nomeia a equipe atual** (e a empresa,
quando houver), em vez de um erro genérico:

> *Não é possível vincular este atleta. Ele está atualmente vinculado a
> {equipe} ({empresa}). Para mudar de equipe, solicite a alteração ao operador
> da Muscle Contest.*

**A trava final é do banco.** `AthleteTeamMembership.activeAthleteId` é único e
só recebe valor enquanto o vínculo está ativo (NULL depois de encerrado, e NULLs
não colidem em PostgreSQL). Duas requisições simultâneas não produzem dois
vínculos: uma cria, a outra recebe 409 — não por ordem de chegada na aplicação,
mas porque a segunda gravação é impossível. O caso concorrente está em
`tests/vinculo-equipe.test.mjs`.

**O treinador não transfere sozinho.** Vincular um atleta livre
(`athletes.update`) e tirá-lo de outra equipe (`athletes.transfer`) são atos
distintos, com permissões distintas: a transferência exige o operador da Muscle
Contest. `teamId` é **recusado com mensagem** no payload de edição do atleta —
não descartado em silêncio, que responderia 200 sem ter mudado nada — e a
recusa aponta as duas rotas próprias.

**A história é preservada.** Encerrar um vínculo não apaga a linha: ela guarda
início, fim, quem autorizou e o motivo (`GET /athletes/:id/team-history`), e
toda transferência gera auditoria (`ATHLETE_TEAM_LINK`, `ATHLETE_TEAM_TRANSFER`,
`ATHLETE_TEAM_UNLINK`).

**A inscrição arma a trava junto com o atleta.** A inscrição cria o perfil
quando o CPF é novo; se gravasse apenas o espelho `Athlete.teamId` sem abrir o
vínculo, o atleta nasceria com equipe e sem trava — e outra equipe o
reivindicaria sem receber recusa. O vínculo nasce na mesma operação.

**A importação não é a porta dos fundos.** O arquivo é redigido fora da
plataforma; se a equipe declarada nele fosse aceita sem conferência, bastaria um
CSV para uma equipe acumular pontos de atleta que não é dela. A equipe do
resultado é resolvida assim:

| Situação da linha | Equipe do ponto |
|---|---|
| Data cai dentro de um vínculo registrado | a equipe **daquele** vínculo |
| Sem data, ou data anterior a qualquer vínculo | a equipe do **vínculo ativo** |
| Atleta nunca teve vínculo | a equipe **declarada no arquivo** |

Se o arquivo declarar equipe diferente da que responde pelo resultado, a linha
**não é aplicada**: fica em `CONFLICT`, nomeando as duas equipes, para o
operador corrigir o arquivo ou registrar a transferência pela via própria. Um
resultado antigo continua pertencendo à equipe de então — transferir de equipe
não reescreve o passado —, mas **datar a linha no passado não atribui o
resultado a quem se queira**: sem vínculo cobrindo a data, quem responde é o
vínculo ativo.

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

# PARTE II — PONTOS SUBMETIDOS À HOMOLOGAÇÃO

Cada item traz o seu estado. Os resolvidos foram **definidos pelo organizador** e
estão implementados; o que segue pendente não foi presumido.

## P1. Como se determina o campeão Overall

✅ **RESOLVIDO na fase 11.2 — por definição, e não por implementação.** O
organizador estabeleceu que **quem é o campeão Overall é dado informado** pelo
operador ou pela importação, e que o sistema **não deve tentar descobri-lo
sozinho** até existir regra específica de apuração.

É exatamente o que está implementado: o título é registrado
(`POST /events/:id/overall`) ou vem marcado na importação (coluna `overall`),
sempre com autor e data em auditoria. A pontuação (+10) é regra homologada; a
determinação continua sendo fato declarado.

✅ **RATIFICADO na fase 11.4.** Não é lacuna à espera de regra: *é* a regra. O
sistema **não deve inventar algoritmo** para descobrir o campeão Overall. Se um
dia houver regra de apuração, ela entra neste mesmo ponto sem alterar o resto
do motor.

## P2. Quais resultados de atleta são "elegíveis" para a equipe

✅ **RESOLVIDO na fase 13 — ratificado pelo organizador.** A equipe **segue a
regra de pontuação já homologada**: não há descarte, teto de atletas pontuando
nem mínimo por equipe. **Todos** os resultados pontuados do atleta contam para
a equipe, com a mesma tabela e o mesmo desempate do ranking individual.

Não é ausência de regra à espera de definição: *é* a regra. Qualquer corte
seria presunção, e o sistema não presume.

## P3. Desempate além do 3º lugar

✅ **RESOLVIDO na fase 11.4 — a hierarquia é DEFINITIVA.** Overall → 1º → 2º →
3º e, persistindo o empate, `TIE_UNRESOLVED`. Não há critério adicional a
definir: **4º e 5º não desempatam**, e o empate que sobrevive à hierarquia não
é quebrado por id, nome, CPF, data, timestamp, ordem de inscrição, alfabética
ou sorteio.

Pontuação e desempate são conceitos diferentes: o 4º vale 2 pontos e não
desempata; o 5º vale 1 e não desempata.

## P4. Qual entidade representa "empresa" como competidora

✅ **RESOLVIDO na fase 11.2 — por definição do organizador.** A empresa é uma
entidade própria, `Company`, e **não** uma reinterpretação de `Brand`,
`Sponsor`, `Gym` ou `Coach`. A empresa **se cadastra e entra na competição com
as suas equipes**: fica *acima* da equipe, e é pela equipe que os pontos dos
atletas chegam até ela.

```
EMPRESA (Company)
   └── EQUIPE (Team)
          └── ATLETA (Athlete)
```

A mesma tabela de pontos e o mesmo desempate valem para os três níveis, sem
peso, multiplicador ou bônus próprio (`GET /rankings/companies`).

**Patrocínio não é isso.** `Sponsor` e `Brand` continuam sendo relação
**comercial** e não competitiva: patrocinar uma equipe não vincula atleta nem
gera ponto. Os três eixos são deliberadamente separados no modelo:

| Eixo | Entidade | Gera pontuação | Vincula atleta |
|---|---|---|---|
| Equipe esportiva | `Team` | ✅ | ✅ (vínculo único) |
| Empresa/organização | `Company` | ✅ (via suas equipes) | ➖ (pela equipe) |
| Patrocínio/parceria comercial | `Sponsor` / `Brand` | ❌ | ❌ |

**Campo de importação:** o adapter reconhece `company` / `empresa` /
`company_name` / `nome_empresa`. Quando a linha traz apenas a equipe, a empresa
é resolvida pela equipe — a coluna só é necessária para desambiguar.

## P5. Pontuação do 6º lugar em diante

✅ **RESOLVIDO na fase 11.4 — zero é o valor DEFINIDO.** A tabela homologada é
5/4/3/2/1 e, do 6º em diante, **0 pontos**. Não é lacuna à espera de tabela
estendida: extrapolar a progressão seria inventar regulamento tanto quanto
deixar o valor em aberto.

## P6. Decisões de apuração dentro da classe — NÃO são do MCI

Método, descarte da maior/menor colocação, painel mínimo e ordem dos desempates
*dentro da classe* **saíram desta lista**: o julgamento é externo, e essas
decisões pertencem a quem julga. Não se confundem com o desempate de **ranking**
da Parte I, que é do MCI e está homologado.

---

# PARTE III — O QUE O MCI NÃO DECIDE

Esta parte existia para submeter ao comitê as decisões de apuração dentro da
classe: descarte da maior e da menor colocação, painel mínimo para o descarte
valer, e a ordem entre os critérios de desempate.

**Ela foi encerrada na fase 11.5, por decisão do organizador: o julgamento
esportivo acontece FORA do MCI.** Essas três decisões continuam existindo — só
que não aqui. Quem julga define método, descarte e desempate; o MCI recebe a
colocação já definida e não a recalcula.

O que a plataforma faz com o que recebe:

| O MCI recebe | O MCI faz | O MCI **não** faz |
|---|---|---|
| Colocação oficial por atleta | Registra, versiona, audita | Recalcular ou conferir mérito |
| Empate não resolvido | Registra como empate e **trava a publicação** | Desempatar por id, ordem ou nome |
| Pontuação importada divergente | Marca `CONFLICT` para decisão humana | Substituir pela sua própria conta |

O empate é o ponto mais sensível e por isso é testado explicitamente: um
resultado externo que chega empatado é gravado empatado, a publicação é
recusada, e só uma correção versionada — com motivo e autor — o resolve. Ver
`tests/e2e-campeonato.test.mjs`.

Sem apuração interna não há mais o que ratificar nesta parte. As pendências
reais do MCI estão na Parte II.
