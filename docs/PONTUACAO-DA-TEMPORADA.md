# Como funciona a pontuação de uma temporada

O fluxo, do arquivo ao ranking público:

```
Importação (arquivo oficial)
        ↓
RankingPoint            ← o LEDGER: colocação, categoria, classe, competidor
        ↓
RankingPointsRule       ← a TABELA da temporada, cadastrada pelo administrador
        ↓
Recalcular              ← reaplica a tabela ao ledger
        ↓
Ranking                 ← o agregado, com o desempate homologado
        ↓
PublicRankingEntry      ← a projeção que a tela pública lê
```

A **fonte oficial da pontuação é a temporada**, não o arquivo. O arquivo
continua sendo a fonte de colocação, atleta, evento, categoria, classe e
demais fatos do campeonato; quantos pontos aquela colocação vale é decisão da
organização, e mora em `RankingPointsRule`.

## Por que "Recalcular" precisou ser corrigido

Até esta fase o botão só reconstruía o **agregado**: lia `RankingPoint.points`
e somava. Se a linha valia zero, o ranking valia zero — e continuava valendo
depois de quantos recálculos fossem.

Medido na base real da federação: os 191 resultados do Ipiranga entraram
**antes** de a temporada ter tabela. `pontuarResultado` não achou regra para
colocação nenhuma e gravou zero nas 191, corretamente — sem tabela não há o
que atribuir. Depois a tabela foi cadastrada (1=5, 2=4, 3=3, 4=2, 5=1), e não
havia caminho que a fizesse alcançar o que já estava gravado. O operador via a
tabela certa na tela, o `placing` certo no lançamento, e zero ponto no ranking.

Reimportar não resolvia: a idempotência do importador marca tudo como
DUPLICATE — que é justamente a proteção que impede duplicar os 191.

## O recálculo tem duas etapas

**ETAPA A — reconciliação.** Reaplica a tabela vigente a cada lançamento, a
partir do `placing` já gravado:

```
placementPoints     ← tabela da temporada para aquela colocação
points              ← placementPoints + overallBonus + adjustmentPoints
superOverallPoints  ← points onde a classe é elegível, zero nas demais
```

Em seguida, o Overall **declarado** volta a pousar sobre a colocação
corrigida — a normalização do bônus roda para cada evento da temporada que
tenha título declarado.

**ETAPA B — materialização.** `Ranking` e `PublicRankingEntry` são
reconstruídos a partir do estado corrigido.

### O que a ETAPA A não toca

`placing`, `didNotShow`, `categoryId`, `catalogClassId`, `athleteId`,
`eventId`, `source`, `externalResultId`, equipe, empresa e filiação. Nenhum
lançamento é criado, nenhum é apagado, nenhum é duplicado.

**`adjustmentPoints` é preservado.** Ele é a diferença que um operador
registrou com motivo e trilha de auditoria; recalcular a tabela não revoga
aquela decisão. Desfazê-la é outro ato, pelo caminho do ajuste, que registra.

**O lançamento invalidado não é repontuado.** Ele vale zero por decisão
administrativa registrada, e `placementPoints` guarda o que aconteceu no
campeonato para a restauração poder existir.

### Temporada sem tabela não zera nada

Sem regra cadastrada, a ETAPA A não roda e o recálculo devolve o aviso. A tela
diz **"Sem tabela de pontos nesta temporada: nada foi recalculado"**. Zerar
lançamentos porque a tabela sumiu seria destruir histórico por causa de uma
configuração ausente.

### É idempotente

A escrita só acontece onde algum campo difere. A segunda passada devolve
`lancamentosAlterados: 0`, e a tela diz **"N lançamentos conferidos. Nenhuma
alteração."**

## A regra de pontuação

Homologada, e a plataforma não a inventa:

| colocação | pontos |
|---|---|
| 1º | 5 |
| 2º | 4 |
| 3º | 3 |
| 4º | 2 |
| 5º | 1 |
| 6º em diante | 0 |
| NS (não compareceu) | 0 |

Os números acima são a tabela **oficial atual**. O motor não os embute: ele lê
o que o administrador cadastrou, qualquer que seja. Do 6º em diante vale zero
porque está fora da tabela — não é recusa, e não é valor extrapolado.

O bônus de Overall é **+10**, uma vez por título, e só na participação de
classe **absoluta**.

```
points = placementPoints + overallBonus + adjustmentPoints
```

---

# Como declarar o Overall manualmente

O arquivo MuscleWare **não traz o campeão Overall das categorias**. A
declaração manual é o mecanismo oficial para complementar essa informação — e
não uma gambiarra: o título é um fato declarado pela organização, e a
plataforma nunca o infere, nem escolhe o 1º colocado por conta própria.

```
Evento → Categoria (classe absoluta) → selecionar competidor → Salvar → Recalcular
```

Em **Administração → Overall**: escolha o campeonato, e cada categoria com
classe absoluta aparece com seus candidatos e a colocação da súmula. Declarar
exige dois passos — o clique abre a prévia com a conta aberta, e só a
confirmação explícita grava.

## O competidor pode não ter cadastro

O MCI carrega histórico oficial **antes** de os atletas se cadastrarem — é o
caminho normal, não a exceção. Um campeonato importado tem `athleteId` nulo
nos lançamentos e a identidade em `ExternalAthlete`.

Até esta fase, `EventOverallTitle.athleteId` era obrigatório e a elegibilidade
era conferida em `RegistrationItem` — a inscrição de um campeonato montado
dentro do MCI. Resultado importado não tem inscrição, nem `EventCategory`, nem
`CompetitionClass`. Declarar o Overall do Ipiranga respondia
`422 OVERALL_REQUIRES_ABSOLUTE_CLASS`: não por regra esportiva, por forma do
modelo.

Agora o título aponta para **um competidor, cadastrado ou não** — nunca os
dois, nunca nenhum, garantido por restrição `CHECK` no banco. E a
elegibilidade aceita também o fato já gravado no **ledger**: participação em
classe absoluta daquele campeonato, naquela categoria.

**A regra esportiva não mudou.** O título continua sendo da classe absoluta, o
bônus continua valendo uma vez, e a plataforma continua sem escolher campeão.
O que mudou foi onde ela procura a participação.

## Alterar e revogar

Título homologado **não se troca por um POST repetido**. Declarar outro
competidor no mesmo recorte responde `409 OVERALL_ALREADY_DECLARED`: quem
errou **revoga, com motivo obrigatório**, e declara de novo. As duas operações
ficam na trilha de auditoria — quem, quando, evento, categoria, competidor,
estado anterior e novo.

Revogar tira o bônus e **preserva a colocação**: só a parcela do Overall sai
da conta, e o ajuste administrativo permanece.

## Dois títulos para o mesmo competidor no mesmo campeonato

**Recusado**, com mensagem administrativa. A regra de pontuação para esse caso
não está homologada: +10 (é campeão absoluto do evento, uma vez) e +20 (cada
título vale o seu bônus) são leituras defensáveis, e escolher uma aqui seria a
plataforma legislando regra esportiva.

## O fluxo operacional completo

1. Importar o arquivo e conferir.
2. Aplicar a importação.
3. Cadastrar ou confirmar a **tabela de pontos** da temporada.
4. **Ranking → Temporada → Recalcular.**
5. **Evento → Overall**: declarar os campeões das categorias com classe absoluta.
6. **Recalcular** de novo.
7. Conferir o ranking público.

Não é preciso apagar nem reimportar um campeonato porque a tabela foi
cadastrada depois. Esse era exatamente o problema que esta fase corrigiu.
