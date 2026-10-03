# Identidade esportiva por matrícula — auditoria, prova e regra oficial

> **Regra oficial do projeto.** Um atleta é identificado pelo seu número de
> filiação/matrícula **no escopo da entidade de filiação**. O nome é atributo
> cadastral e de apresentação, **não** identificador para consolidação de
> resultados e pontuação.

Este documento é o resultado da fase de correção crítica de identidade
esportiva. Ele registra o que foi **medido**, não o que se supôs.

---

## 1. Causa raiz

A pergunta que originou a fase foi: *"o sistema está separando o mesmo atleta
em vários porque o nome muda entre eventos?"*

**Não.** O nome não é chave de identidade em lugar nenhum do domínio.

Varredura feita em `src/`, procurando cada padrão citado na homologação:

| Padrão procurado | Encontrado |
|---|---|
| `GROUP BY` por nome | nenhum |
| `JOIN` por nome | nenhum |
| geração de id a partir do nome | nenhuma |
| agregação de pontuação por nome | nenhuma |
| ranking agrupado por nome | nenhum |
| histórico agrupado por nome | nenhum |
| `WHERE` / `DISTINCT` por nome | só em **busca textual** e **ordenação alfabética** |

O nome aparece em exatamente um lugar do caminho de identidade
(`muscleWarService.js`, na montagem de **sugestões** para o operador), e ali ele
vem marcado `matchedBy: 'NAME'` com `exigeConfirmacaoHumana: true`. Nome sozinho
nunca decide.

**O que realmente separa um atleta — medido, e com teste que o demonstra:**

1. **Linha importada sem matrícula recebe identidade própria.** Sem
   `affiliationCode` + `memberNumber`, o importador não tem identidade declarada
   e ancora a linha no identificador do próprio resultado:
   `EXT:MUSCLEWAR:{externalResultId}`. Dois resultados da mesma pessoa, ambos sem
   matrícula, viram **duas identidades** — e nenhuma é alcançável pelo vínculo
   tardio, que casa justamente por matrícula.

2. **A consolidação por matrícula, quando o cadastro já existe, exige
   confirmação humana.** O sistema encontra a identidade, marca
   `matchedBy: MATRICULA`, e devolve `exigeConfirmacaoHumana: true`. Até alguém
   confirmar, os pontos ficam numa identidade separada.

Nenhuma das duas é "agrupamento por nome".

---

## 2. Regra antiga

Não existe "regra antiga" de identificação por nome a ser substituída. Desde a
fase do importador, a identidade é:

```
identityKey = AFF:{affiliationId}:{matrícula}     quando há filiação e matrícula
identityKey = EXT:{fonte}:{externalResultId}      quando não há
```

e o cadastro tem índice **único parcial**
`Athlete_organizationId_affiliationId_affiliationNumber_key`.

---

## 3. Regra nova

A regra não mudou; passou a ser **oficial, documentada e protegida por testes**:

- **Prioridade 1** — filiação + matrícula, normalizadas.
- **Prioridade 2** — identificador interno permanente (`Athlete.id`), quando já
  resolvido.
- **Prioridade 3** — nome, **apenas** como auxílio de busca e como sugestão que
  exige confirmação humana. Nunca como chave de consolidação.

### Normalização da matrícula

| Entrada | Saída | Por quê |
|---|---|---|
| `" 2932 "` | `"2932"` | branco de planilha não é identificador |
| `2932` (número) | `"2932"` | representação, não valor diferente |
| `"02932"` | `"02932"` | **o zero à esquerda é preservado** |

`"02932"` **não** é `"2932"`. Converter para número fundiria duas matrículas
possivelmente legítimas e diferentes.

### Por que o escopo da filiação não é preciosismo

Duas federações podem emitir a mesma matrícula. Os dois erros possíveis **não
têm o mesmo tamanho**:

- separar uma pessoa em duas → aborrecimento, e se conserta;
- **juntar duas pessoas numa** → apaga a carreira de alguém, e o original já não
  existe para desfazer.

Na dúvida, o lado seguro é **não fundir**.

---

## 4. Caso 2932 — antes e depois

**Não há número de produção neste documento.** O ambiente onde esta fase foi
executada não alcança o banco de produção, e a `DATABASE_URL` é segredo que não
se pede. O que existe é:

- `scripts/diagnostico-identidade-do-atleta.js`, **somente leitura**, que responde
  a pergunta com dados reais quando rodado por quem tem o acesso;
- a reprodução do caso com dados construídos, abaixo.

### Reprodução executada

Importados quatro resultados sob **três grafias diferentes**, antes de existir
cadastro:

```
L1  Lucas Lima            FED-MT  2932   OPEN     2º    80 pt
L2  Lucas de Lima         FED-MT  2932   OPEN     1º   100 pt
L3  LÚCAS GOUVÊIA LIMA    FED-MT  2932   MASTER   3º    60 pt
L4  Lucas Lima            FED-MT  (sem)  OPEN     1º   100 pt
```

Depois, cadastro criado com `fullName: "Lucas Gouveia Lima"`, matrícula `2932`.

**Resultado medido:**

| | Antes do cadastro | Depois |
|---|---|---|
| competidores distintos | 1 (sem dono) | **1 (com dono)** |
| resultados associados | 3 | **3** |
| pontos de colocação | 240 | **240** |
| lançamentos novos criados | — | **nenhum** |

As três grafias foram reconhecidas como a **mesma pessoa**. A linha `L4`, **sem
matrícula**, ficou de fora — e o diagnóstico a sinaliza como evidência para
conferência humana, sem vinculá-la.

---

## 5. Banco

**Nenhuma tabela alterada.** A estrutura necessária já existia:

| Objeto | Papel |
|---|---|
| `Athlete.affiliationId` + `affiliationNumber` | a identidade cadastral |
| `Athlete_organizationId_affiliationId_affiliationNumber_key` | único parcial: impede dois donos da mesma matrícula |
| `Athlete_affiliationId_affiliationNumber_idx` | a consulta por matrícula |
| `ExternalAthlete.identityKey` + `(organizationId, identityKey)` único | a identidade esportiva externa |
| `ExternalAthlete_affiliationId_affiliationNumber_idx` | a mesma consulta, do lado externo |
| `RankingPoint.athleteId` / `externalAthleteId` + CHECK | todo lançamento tem competidor |

---

## 6. Migration

**Nenhuma.** Zero migrations nesta fase.

---

## 7. Backfill

**Não executado, e deliberadamente não escrito.**

Um backfill de reassociação só se justifica diante de dado partido em produção.
A reprodução mostra que o caminho com matrícula **já consolida sozinho**; o que
resta é o conjunto de identidades sem matrícula, que **nenhuma regra automática
por identificador alcança** — alcançá-las por nome é exatamente o que esta
arquitetura existe para não fazer.

O caminho correto é: rodar o diagnóstico em produção, e só então decidir, com o
número na mão, se há o que consolidar e sob qual evidência.

---

## 8. Testes

`tests/identidade-por-matricula.test.mjs` — **22 aprovados**, importando pela
rota real e conferindo no banco.

| # | Caso | Resultado |
|---|---|---|
| 1 | mesmo nome, mesma matrícula | 1 atleta |
| 2 | nome diferente, mesma matrícula | 1 atleta |
| 3 | acentuação diferente | 1 atleta |
| 4 | nome abreviado | 1 atleta |
| 5 | nome igual, matrículas diferentes | 2 atletas |
| 6 | nome diferente, matrículas diferentes | 2 atletas |
| 7 | vários eventos | histórico consolidado |
| 8 | pontos de colocação | somam no mesmo atleta |
| 9 | Overall em vários eventos | mesmo atleta |
| 10 | reaplicar o lote | recusado como duplicata, zero ponto a mais |

Mais: normalização (4), fronteira de filiação, zero à esquerda, recusa de
matrícula repetida no cadastro, a causa medida (linha sem matrícula), o caso do
Lucas na ordem real, ranking sem duplicata e isolamento entre organizações.

### Verificação por mutação

| Mutação aplicada ao serviço real | Efeito |
|---|---|
| identidade passa a ser o NOME | **10 de 17 reprovam** |
| matrícula convertida para número | reprova o do zero à esquerda |
| identidade ignora a filiação | reprova o das duas federações |
| restaurado | 17 de 17 aprovam |

---

## 9. Segurança

RLS, autorização e isolamento **inalterados**. Nenhuma política foi criada,
afrouxada ou removida; nenhum `BYPASSRLS`, nenhum `SECURITY DEFINER` novo.

### Um falso achado, investigado antes de virar relatório

O teste de cross-tenant acusou que um operador de outra organização enxergava a
identidade desta. **Não era vazamento.** No banco local o papel de bootstrap
nasce **superusuário**, e superusuário ignora RLS incondicionalmente, mesmo com
`FORCE`. A asserção media o ambiente, não o produto.

Corrigido reprovisionando o banco como a CI faz — `mci_owner` **NOSUPERUSER**
como dono do schema, `mci_app` pelo `provision-app-role.sql`. Com o RLS valendo,
os 22 testes passam. O motivo está escrito dentro do próprio teste.

---

## 10. Performance

Os índices da consulta por matrícula **já existem**, nos dois lados, e não há
redundância a criar. Nenhuma consulta nova foi introduzida: a fase não alterou
caminho de leitura.

---

## 11. Frontend

**Nenhuma alteração necessária.** Conferido em três lugares:

- `adminAtleta.jsx` — matrícula no cabeçalho, no resumo e na seção de filiação;
- `minhaCarreira.jsx` — matrícula em destaque para o próprio atleta;
- `adminPlatform.jsx` — o ledger mostra, por lançamento: evento, **filiação da
  época com a matrícula**, categoria, classe, colocação, pontos de colocação,
  bônus de Overall, totais e **origem**.

Nenhuma tela agrupa por nome.

---

## 12. Regressão

Ver a seção de execução no commit que acompanha esta fase. Lint limpo; varredura
de segredos sem achado.

---

## 13. Arquivos

| Arquivo | O quê |
|---|---|
| `scripts/diagnostico-identidade-do-atleta.js` | diagnóstico somente leitura, por identificador |
| `tests/identidade-por-matricula.test.mjs` | os 22 testes |
| `docs/IDENTIDADE-POR-MATRICULA.md` | este documento |

Nenhum arquivo de domínio alterado.

---

## 14. Veredito

**A regra pedida já é o comportamento do sistema**, e agora está provada por
teste executável e verificada por mutação.

O que **não** pôde ser declarado: o estado real do atleta 2932 em produção. Isso
exige rodar o diagnóstico com acesso ao banco, e **nenhuma afirmação sobre ele
deve ser feita antes disso**.

---

## 15. O que esta fase NÃO prova

1. **Não há número de produção.** Tudo aqui foi medido em banco local.
2. **Não se mediu quantas identidades sem matrícula existem em produção** — é a
   primeira pergunta que o diagnóstico responde quando rodar lá.
3. **Não se testou consolidação de identidades órfãs**, porque ela não existe e
   não deve existir automaticamente: sem matrícula, só evidência humana decide.

---

## 16. Como rodar o diagnóstico

```
node scripts/diagnostico-identidade-do-atleta.js \
  --matricula 2932 \
  --ator <userId de um operador da organização> \
  [--organizacao <id>] [--filiacao <CÓDIGO>] [--json]
```

Ele **não escreve nada**. Exige ator porque as tabelas têm política de leitura
por organização: sem contexto, as consultas voltariam vazias e o relatório diria
*"não há registro"* quando o que houve foi *"não consigo ver"*.
