# Homologação operacional

Uma temporada inteira, do zero, executada pelo caminho que o operador realmente
usa: só HTTP, com a API em `NODE_ENV=production`, sem atalho pelo banco.

**86 verificações, nenhuma falha.** O que segue é o roteiro, os números
obtidos e — a parte que mais interessa a quem vai operar — **o que o operador
NÃO consegue fazer sozinho** e **onde a plataforma vai recusar o seu arquivo**.

Ambiente do ensaio: banco vazio, `prisma migrate deploy`, `prisma/seed.js`, e o
primeiro administrador criado por `scripts/criar-admin.js` — o mesmo caminho do
runbook de deploy, não um atalho de teste.

---

## 1. O roteiro, na ordem em que acontece

| Etapa | O que foi exercitado |
|---|---|
| **Acesso** | admin de bootstrap entra; organização criada; conta de operador criada e vinculada como `EVENT_DIRECTOR` + `RANKING_MANAGER` |
| **Temporada** | temporada criada; tabela oficial de pontos gravada (5/4/3/2/1); empresa competidora e duas equipes |
| **Atletas** | seis atletas com CPF; **CPF repetido é recusado** com `ATHLETE_CPF_EXISTS` |
| **Evento** | evento, categoria, divisão, classes OPEN e ESTREANTE; `DRAFT → PLANNED → REGISTRATIONS_OPEN`; **transição fora de ordem é recusada** |
| **Inscrições** | seis inscrições por CPF; fechamento das inscrições |
| **Piso** | check-in; **check-in repetido recusado** (409); check-in desfeito pelo operador; pesagem; credencial emitida, validada, revogada — e **a revogada não passa mais** (`accepted:false`) |
| **Palco** | bateria criada; ordem gravada e **conferida na leitura** (1,2,3,4); situação da bateria alterada |
| **Resultado** | `REGISTRATIONS_CLOSED → IN_OPERATION → IN_JUDGING`; resultado externo recebido; **colocação duplicada recusada** (`DUPLICATE_PLACING`); **atleta fora da classe recusado** (`ATHLETE_NOT_IN_CLASS`); publicação; **resultado publicado não aceita novo recebimento**; correção com justificativa; **duas versões guardadas**, com a justificativa registrada |
| **Overall e ranking** | Overall declarado; `RESULTS_IN_REVIEW → RESULTS_PUBLISHED → CLOSED`; ranking recalculado; **Overall soma +10 (5 + 10 = 15)**; **1º da ESTREANTE pontua no campeonato (5)**; **ESTREANTE não entra no Super Overall**; rankings de equipes e empresas; origem de cada ponto |
| **Auditoria** | trilha acessível ao admin, com `RESULT_RECEIVED`, `RESULT_PUBLICATION`, `RESULT_OVERRIDE`, `OVERALL_DECLARE` e `RANKING_UPDATE`; **nenhum CPF na trilha** |
| **MuscleWar** | planilha importada; pré-visualização; linha reconhecida, linha em `CONFLICT`, linha em `MATCH_PENDING`; pendente resolvido por vínculo manual; aplicação; **a linha em CONFLICT não é aplicada**; **reaplicar é idempotente**; ranking somado corretamente |

---

## 2. O que o operador NÃO faz sozinho

Isto **não é defeito** — é onde a plataforma exige escalar. Está aqui para que
ninguém descubra durante um evento.

Um `EVENT_DIRECTOR` + `RANKING_MANAGER` recebe `403` em:

| Operação | Permissão | Quem tem |
|---|---|---|
| **Corrigir resultado já publicado** | `results.override` | `SUPER_ADMIN`, `ADMIN` |
| **Criar outra organização** | `organizations.manage` | `SUPER_ADMIN` |
| **Ler a trilha de auditoria** | `audit.read` | `SUPER_ADMIN`, `ADMIN` |

A primeira é a que mais aparece na prática: **o diretor do evento recebe e
publica o resultado, mas não o reescreve depois de publicado**. Corrigir uma
prova oficial já divulgada exige um administrador da plataforma, e a correção
nasce como **nova versão com justificativa obrigatória** — o original não some.

> **Decisão que fica para a organização:** se a federação quiser que o diretor
> do evento leia a auditoria da própria organização, isso é uma mudança de
> política de permissão, não de código de barreira. Registrado aqui como
> escolha consciente a ratificar, não como pendência técnica.

---

## 3. A armadilha da planilha MuscleWar

**A coluna `pontos` é o total FINAL, não os pontos da colocação.**

Quem exporta a planilha naturalmente escreve os pontos da colocação — 5 para o
1º lugar. Se essa mesma linha estiver marcada como campeã Overall, a regra
oficial calcula **15** (5 da colocação + 10 do Overall), e a linha vira
`CONFLICT` com esta mensagem:

```
Pontuação divergente: o arquivo informa 5, a regra oficial da temporada
calcula 15 (colocação 1 + Overall), diferença de -10. Corrija o arquivo ou a
tabela da temporada antes de aplicar.
```

Isso foi verificado nos dois sentidos no ensaio: com `5` a linha é recusada,
com `15` ela é reconhecida e aplicada. **É o comportamento correto** — um
número que pode ser derivado de colocação, Overall e temporada não é fonte, é
uma afirmação a conferir, e divergir não pode passar em silêncio. Mas é a
primeira coisa que vai travar uma importação real, então:

* confira a coluna `pontos` **incluindo o bônus** antes de importar;
* ou corrija a tabela de pontos da temporada, se for ela que está errada;
* **não** existe caminho que aplique a linha divergente sem que alguém decida.

### O resto do fluxo de importação

* CPF que não existe no cadastro vira **`MATCH_PENDING`** — fica esperando
  decisão humana, não é criado nem descartado.
* Ligar manualmente a linha a um atleta (`POST /musclewar/items/:id/link`)
  resolve o pendente — e **não** resolve o `CONFLICT` de pontuação. São dois
  problemas diferentes e a plataforma não confunde um com o outro.
* Aplicar a importação aplica **só as linhas válidas**. As em `CONFLICT` ficam.
* **Reaplicar é idempotente**: nenhum ponto é somado duas vezes.

---

## 4. Conferências de regra esportiva que o ensaio confirma

Todas já homologadas; o ensaio mostra que a implementação as segue de ponta a
ponta, e não só no teste unitário:

* **Overall SOMA +10**, não substitui: a campeã ficou com `5 + 10 = 15`.
* **A ESTREANTE pontua o campeonato**: 1º lugar da classe = 5 pontos no
  ranking geral.
* **A ESTREANTE não entra no Super Overall**: só as classes marcadas como
  elegíveis — pela regra, a OPEN — alimentam a classificação anual.
* **O MCI não julga**: o resultado entra pela porta de recepção
  (`POST /classes/:id/result`), vindo da comissão externa. Não há nota, ficha
  de juiz nem critério de mérito para a plataforma avaliar.

---

## 5. Reproduzir

O roteiro é um script HTTP; nada nele depende de estado prévio além de um banco
migrado e semeado:

```bash
createdb mci_homolog
DATABASE_URL='postgresql://.../mci_homolog' npx prisma migrate deploy
DATABASE_URL='postgresql://.../mci_homolog' node prisma/seed.js
psql -d mci_homolog -v senha="'...'" -f scripts/provision-app-role.sql
DATABASE_URL='postgresql://.../mci_homolog' ADMIN_PASSWORD='...' \
  node scripts/criar-admin.js 'Nome Completo' admin@...
# subir a API contra esse banco e rodar o roteiro da seção 1
```

As barreiras que o roteiro exercita — cross-tenant, RLS, permissões,
idempotência, versionamento de resultado, regra de pontuação — têm cobertura
automática permanente na suíte (`tests/`), que roda a cada push. Este documento
é o registro do ensaio **operacional**, feito pelo caminho do operador.
