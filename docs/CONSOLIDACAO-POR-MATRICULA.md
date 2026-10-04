# Consolidação operacional por filiação + matrícula

> **Regra oficial, inalterada.** Um atleta é identificado pelo seu número de
> filiação/matrícula **no escopo da entidade de filiação**. Mesma filiação +
> mesma matrícula = mesmo atleta, qualquer que seja a grafia do nome. Mesma
> matrícula + filiação diferente = **atletas diferentes**. Nome igual +
> matrícula diferente = **atletas diferentes**.

Este documento é a FASE FINAL: ela **não** refaz a arquitetura de identidade —
essa já está auditada e provada em `docs/IDENTIDADE-POR-MATRICULA.md`. Ela ataca
o que sobrou: o **defeito operacional** que ainda conseguia deixar resultado do
mesmo atleta separado.

---

## 1. Causa raiz (medida, não suposta)

A consolidação automática por matrícula roda em **dois** momentos:

| Momento | Caminho |
|---|---|
| criação do cadastro | `athleteService.create` → `vincularPendentesDoAtleta` |
| aprovação do autocadastro | `athleteRequestService` → `vincularPendentesDoAtleta` |

**A edição do cadastro não era nenhum dos dois.** `athleteService.update` aceita
trocar `affiliationId` e `affiliationNumber` — e não reexecutava nada.

O caminho que ficava quebrado, encontrado por leitura do código e **reproduzido
em teste antes de existir conserto**:

1. o campeonato antigo é importado com a matrícula; o resultado entra no ledger
   sob a identidade `AFF:{filiação}:{matrícula}`, **sem dono**;
2. o atleta é cadastrado **sem filiação** — ou com a matrícula **digitada
   errada**, que é o caso comum;
3. o operador **corrige a matrícula** no perfil;
4. **nada acontecia.**

O histórico seguia órfão, e a única saída era um **clique humano** na tela de
sugestões — exatamente o clique que a regra homologada diz ser desnecessário
quando a identidade é inequívoca.

### Prova

`tests/consolidacao-por-matricula.test.mjs`, executado **antes** do conserto:

```
Tests  4 failed | 4 passed (8)
```

Os 4 que reprovaram são os que exigem consolidação automática após a correção da
matrícula. Os 4 que passaram são os **negativos** — o sistema já era
conservador, e continua.

---

## 2. Regra anterior

Não havia regra de identificação por nome a substituir. O que havia era uma
**lacuna de gatilho**: a regra certa não era chamada no momento em que a pessoa
se torna identificável.

---

## 3. Regra definitiva

A consolidação automática por filiação + matrícula roda em **três** momentos. O
terceiro é novo:

| Momento | Gatilho |
|---|---|
| criação do cadastro | já existia |
| aprovação do autocadastro | já existia |
| **correção da matrícula no perfil** | **`athleteService.update`, quando o PAR muda e fica completo** |

E só quando o **par muda**: salvar o perfil trocando a cidade não varre
histórico. O par **resultante** é o que conta — editar só o número mantendo a
filiação muda a chave do mesmo jeito, pelo mesmo motivo que
`assertMatriculaLivre` já olhava o resultante.

**A decisão não mudou de lugar.** Ela continua inteira dentro de
`vincularPendentesDoAtleta`, com as mesmas recusas:

- CPF divergente entre arquivo e cadastro → conflito, sem vínculo;
- filiação divergente → sem vínculo;
- matrícula com mais de um dono → sem vínculo;
- **nome: sem poder nenhum, em nenhum caminho.**

O vínculo usa `adotarLedger`, que **preenche ponteiro e não cria lançamento**:
mesmo resultado, mesmo lançamento, `athleteId` correto. Idempotente de graça,
porque todo `where` exige `athleteId: null`.

---

## 4. As seis gavetas

O diagnóstico agora classifica **cada resultado**, em função pura, testável sem
banco (`classificarResultado`):

| Gaveta | Quando |
|---|---|
| `CONSOLIDADO` | o resultado aponta para o cadastro do par |
| `SEPARADO MAS IDENTIFICÁVEL POR MATRÍCULA` | um cadastro, um par, nenhum conflito — consolida sozinho |
| `SEM MATRÍCULA` | o arquivo veio sem matrícula: **nenhuma** regra automática alcança |
| `AMBÍGUO` | mais de um cadastro para o par, ou dono que não é o cadastro do par |
| `DUPLICADO` | mesmo evento + classe + colocação repetidos sob a matrícula — **sinal, não prova** |
| `OUTRO` | sem identidade, ou histórico com matrícula ainda sem cadastro |

A ordem das regras importa, e a primeira que casa decide: duplicata antes de
tudo, porque invalida a leitura das outras; ausência de matrícula antes de
ambiguidade, porque sem identificador não há par a disputar.

---

## 5. Plano de correção — o que será e o que NÃO será consolidado

### SERÁ, automaticamente, sem clique

Resultado cuja identidade tem **filiação + matrícula** iguais às de **exatamente
um** cadastro, sem conflito de CPF e sem matrícula repetida. A partir desta fase
isso acontece também quando a matrícula é **corrigida depois**.

### NÃO SERÁ, por decisão e não por limitação

| Caso | Por quê |
|---|---|
| resultado **sem matrícula** | nenhum identificador o alcança; só evidência humana decide |
| mesma matrícula, **filiação diferente** | federações diferentes emitem números iguais — juntar apaga a carreira de alguém |
| **nome igual**, matrícula diferente | nome não é chave, em nenhuma hipótese |
| matrícula com **mais de um dono** | impasse sobre o cadastro; quem resolve é gente |
| **CPF divergente** entre arquivo e cadastro | a matrícula não desempata documento |

Os dois erros possíveis **não têm o mesmo tamanho**: separar uma pessoa em duas é
aborrecimento e se conserta; **juntar duas pessoas numa apaga a carreira de
alguém**, e o original já não existe para desfazer. Na dúvida, não fundir.

---

## 6. Backfill

**Não executado, e deliberadamente não escrito.**

A homologação é explícita: *"Somente depois do diagnóstico real: se existirem
registros comprovadamente associados à matrícula 2932, criar backfill
específico"* e *"NÃO executar backfill global antes do caso 2932"*.

O diagnóstico real **não foi executado** — ver §8. Sem o número, um backfill é
chute sobre dado alheio.

E há um ponto que o diagnóstico vai responder sozinho: o conserto desta fase faz
a consolidação acontecer **pela tela**. Para um caso identificável por matrícula,
a correção da matrícula no perfil já resolve, com auditoria, sem script e sem
acesso direto ao banco. É o caminho preferível: reproduzível, autorizado e
registrado.

---

## 7. Testes

`tests/consolidacao-por-matricula.test.mjs` — **20 aprovados**, com RLS valendo
de verdade (papel dono **NOSUPERUSER**, como a CI provisiona).

| Grupo | O quê |
|---|---|
| a matrícula corrigida depois (4) | consolida sozinho; corrige digitação; idempotente; auditoria com a chave |
| o conserto não pode virar fusão (4) | filiação diferente, nome igual, sem matrícula, outra organização |
| as seis gavetas (9) | função pura, cada gaveta e a assinatura de duplicata |
| os casos nomeados (3) | cadastro antes da importação; CPF como evidência sem matrícula; Overall sem duplicata |

Mais os **22** de `tests/identidade-por-matricula.test.mjs`, que continuam
valendo: 42 no total sobre identidade.

### Verificação por mutação — números medidos

| Mutação forçada | Testes que reprovam |
|---|---|
| o conserto desta fase é removido | **6 de 42** |
| a chave de identidade passa a ser o NOME | **21 de 42** |
| a matrícula é convertida para número | **1 de 42** (o do zero à esquerda) |
| a filiação sai da chave de identidade | **1 de 42** (o das duas federações) |
| restaurado | **42 de 42 passam** |

As duas mutações de 1 teste merecem explicação, porque número baixo pode parecer
cobertura fraca e não é: elas atingem uma **segunda** linha de defesa que
continua de pé. Converter a matrícula para número só muda o comportamento quando
existe zero à esquerda, e há um teste exatamente para isso. Tirar a filiação da
chave é absorvido por `impedimentoDoVinculo`, que recusa filiação divergente —
a fusão não acontece nem com a chave afrouxada. Duas guardas, e a mutação mostra
que a segunda funciona.

---

## 8. O que esta fase NÃO prova

1. **O diagnóstico real do 2932 em produção não foi executado.** O ambiente onde
   esta fase correu não alcança o banco de produção, e a `DATABASE_URL` é segredo
   que não se pede nem se aceita por chat. **Não há relatório ANTES real, e
   portanto não há DEPOIS.**
2. **Nenhum dado de produção foi alterado.** Zero migration, zero backfill, zero
   `DROP`, zero `TRUNCATE`.
3. **Não se mediu quantas identidades sem matrícula existem em produção.** É a
   primeira pergunta que o diagnóstico responde quando rodar lá.

---

## 9. Status

**STATUS = PENDENTE.**

A homologação pede 17 itens verdes, e o primeiro — *"diagnóstico real do 2932
executado"* — está vermelho. Um gate pendente derruba a declaração inteira, e
por isso **não** se escreve HOMOLOGADO aqui.

O que está verde: causa raiz localizada e provada, conserto implementado e
coberto, 42 testes de identidade, mutação verificada, RLS e cross-tenant
medidos com papel sem superusuário, regressão completa, lint, build e CI.

---

## 10. Como rodar o diagnóstico

```
node scripts/diagnostico-identidade-do-atleta.js \
  --matricula 2932 \
  --ator <userId de um operador da organização> \
  [--organizacao <id>] [--filiacao <CÓDIGO>] [--json]
```

Ele **não escreve nada**. Exige ator porque as tabelas têm política de leitura
por organização: sem contexto, as consultas voltariam vazias e o relatório diria
*"não há registro"* quando o que houve foi *"não consigo ver"*.

A saída traz, por resultado: evento, data, categoria, classe, colocação, Overall
com bônus, ajuste, pontos, nome na fonte, matrícula encontrada, filiação
encontrada, origem, identidade associada, status do vínculo — e a **gaveta**.
