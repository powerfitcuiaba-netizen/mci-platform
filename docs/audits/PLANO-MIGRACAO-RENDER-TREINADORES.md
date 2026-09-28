# Plano de migração — módulo Treinadores & Equipes no Render

**Branch:** `claude/mci-platform-muscle-contest-o6haz9` · **HEAD:** `374a317`
**Data:** 2026-09-27

> **Este plano não foi executado em produção.** Nenhuma migração foi aplicada, nenhum
> deploy foi feito, nenhuma credencial foi lida ou alterada. O que está medido abaixo foi
> medido em **banco descartável local**, criado e destruído para esta conferência.

---

## 1. Como as migrações chegam ao Render hoje

`render.yaml`, serviço `mci-api`:

```
preDeployCommand: npx prisma migrate deploy && node scripts/provisionar-contas-de-servico.js
```

Duas consequências que governam todo este plano:

1. **As migrações pendentes sobem sozinhas no próximo deploy.** Não há passo manual, não há
   confirmação. Promover uma versão é aplicar as migrações que estiverem no repositório.
2. **Se o `preDeployCommand` falhar, o Render não promove a versão.** A versão antiga
   continua no ar. Isso é proteção — e é por isso que nenhuma migração deste conjunto pode
   depender de estado que só existe depois do deploy.

---

## 2. Inventário: o que está pendente

São **44 migrações** no repositório. As **sete** abaixo pertencem a este módulo e às
correções da auditoria. As cinco primeiras já foram aplicadas em desenvolvimento e em CI;
nenhuma foi aplicada em produção.

| Ordem | Migração | O que faz | Escreve dado? |
| --- | --- | --- | --- |
| 1 | `20260926020000_modulo_treinadores_equipes` | cria `CoachOrganization`, `CoachDocument`, `TeamMembershipRequest`, `CentralAuthorization`; adiciona colunas a `Coach` e `Team`; políticas do módulo | **SIM** — `UPDATE "Coach" SET status='APPROVED'` sem `WHERE` (achado **A-05**) |
| 2 | `20260926040000_treinador_como_ator_de_rls` | funções `mci_treinador_*`; o treinador passa a ser ator reconhecido pelo banco | não |
| 3 | `20260927010000_vinculo_exige_pedido_pendente` | `vinculo_criacao` exige convite PENDING daquela equipe (**A-04**) | não |
| 4 | `20260927020000_leitura_de_atleta_pelo_treinador` | `atleta_leitura` exige equipe na federação (**A-03**) | não |
| 5 | `20260927030000_status_legado_de_treinador` | devolve a `PENDING` o cadastro aprovado sem revisor (**A-05**) | **SIM** — `UPDATE` com `WHERE` estreito e idempotente |

As duas que escrevem dado são as únicas que exigem decisão humana antes do deploy. As três
do meio só alteram políticas e funções.

---

## 3. A ordem importa, e por quê

`20260926020000` aprova todo cadastro existente; `20260927030000` devolve a pendente o que
ninguém decidiu. **As duas rodam no mesmo deploy, nesta ordem**, então o estado final é o
correto mesmo que a primeira nunca tenha rodado em produção antes.

Se por algum motivo apenas parte do conjunto subir, o estado intermediário perigoso é
**depois de 1 e antes de 5**: nele, todo treinador legado está aprovado e portanto é ator
reconhecido pela RLS. `prisma migrate deploy` aplica em sequência dentro do mesmo comando,
e para no primeiro erro — o que reduz o risco, mas não o elimina se o comando for
interrompido. **Mitigação:** rodar o diagnóstico antes (passo 4.2) e conferir depois
(passo 4.6).

---

## 4. Roteiro de publicação

### 4.1 Pré-requisito: autorização

Helder Falcão precisa autorizar expressamente **duas** coisas, e elas são diferentes:

* **publicar o código** (push, PR, merge, deploy);
* **o que fazer com os cadastros legados de treinador** que voltam a `PENDING` — ver 4.2.

### 4.2 Diagnóstico somente leitura, ANTES de qualquer deploy

No shell do serviço `mci-api` (o ambiente já tem `DATABASE_URL`; **não** digite a URL):

```
node scripts/diagnostico-treinadores-legados.js
node scripts/diagnostico-delegacoes-inertes.js
```

Os dois são **somente leitura**, não imprimem `DATABASE_URL`, e-mail nem telefone, e saem
com código 1 quando há decisão humana pendente.

O primeiro responde: quantos cadastros voltam a `PENDING`, quais estão **EM USO** (com
equipe, com atleta no catálogo, com autorização de federação) e quais já foram aprovados
por uma pessoa e portanto não serão tocados.

O segundo responde: quais delegações centrais vivas deixam de conceder por não terem
escopo ou prazo (achado **A-02**).

**Guarde as duas saídas.** São a fotografia do antes, e a conferência do passo 4.6 depende
delas.

### 4.3 Decisão registrada

Para cada cadastro legado EM USO listado em 4.2, a administração central decide: aprovar
pela rota depois do deploy, ou deixar pendente. Para cada delegação inerte: reconceder com
escopo e prazo, ou deixar de valer. **As duas decisões são de pessoas, e ficam registradas
antes do deploy.**

### 4.4 Backup verificado

`docs/BACKUP-RESTORE.md` descreve o procedimento. O ponto que não pode ser pulado: **um
backup que nunca foi restaurado não é um backup**. Restaure numa base descartável e confira
que sobe antes de aplicar as migrações.

### 4.5 Deploy

Promover a versão. O `preDeployCommand` aplica as migrações e provisiona as contas de
serviço. Se ele falhar, **não force**: a versão antiga fica no ar, e é isso que se quer —
leia o log, entenda a falha, e volte ao passo 4.2.

### 4.6 Conferência depois do deploy

```
npx prisma migrate status          # espera-se "Database schema is up to date!"
node scripts/diagnostico-treinadores-legados.js
node scripts/diagnostico-delegacoes-inertes.js
```

Conferências obrigatórias:

* `migrate status` diz que está em dia, e as 44 migrações aparecem como aplicadas;
* no diagnóstico de treinadores, **"aprovados SEM revisor" agora é 0** — se não for, a
  migration 5 não rodou;
* os cadastros que estavam EM USO e voltaram a pendente são **exatamente** os que a saída
  de 4.2 previu — nem um a mais;
* nenhum cadastro que tinha revisor mudou de estado.

### 4.7 Depois, e só depois: aprovar o que foi decidido

A mesa central aprova pela rota `POST /coaches/:id/approve`, com motivo. Cada aprovação
gera trilha com autor, data e motivo, que é o que R-03 exige e o que a migration não podia
fazer.

---

## 5. O que foi medido nesta conferência

Tudo abaixo rodou em **banco local descartável**, nunca em produção.

| Verificação | Comando | Resultado |
| --- | --- | --- |
| As 44 migrações aplicam **do zero** numa base vazia | `CREATE DATABASE mci_migracao_zero` + `prisma migrate deploy` | **PASS** — "All migrations have been successfully applied" |
| Estado final em dia | `prisma migrate status` | **PASS** — "Database schema is up to date!" |
| Estado final também em dia no banco de teste da suíte | `prisma migrate status` | **PASS** |
| `atleta_leitura` final é a versão estreitada (**A-03**) | `pg_policies` | **PASS** — `… OR mci_treinador_com_equipe_em("organizationId")` |
| `vinculo_criacao` final exige convite PENDING (**A-04**) | `pg_policies` | **PASS** — `mci_atleta_do_usuario(...) AND EXISTS (… status = 'PENDING')` |
| As quatro funções auxiliares existem | `pg_proc` | **PASS** — `mci_treinador_aprovado_do_usuario`, `mci_treinador_autorizado_de`, `mci_treinador_com_equipe_em`, `mci_treinador_da_equipe` |
| Nenhuma função `mci_*` é `SECURITY DEFINER` | `pg_proc.prosecdef` | **PASS** — zero |
| Nenhuma política concede a `anon` | `pg_policies.roles` | **PASS** — zero |
| `FORCE ROW LEVEL SECURITY` continua ligado | `pg_class.relforcerowsecurity` | **PASS** — 34 tabelas |
| Migration 5 é idempotente | executada duas vezes em teste | **PASS** — a segunda não muda nada |

### Observações factuais (fora dos 12 achados, pré-existentes)

Registradas porque uma auditoria futura vai encontrá-las e merece saber que foram vistas:

* **Quatro políticas com predicado `true`:** `EventOverallTitle.overall_leitura`,
  `ClassCatalog.catalogo_leitura` e `Company.empresa_leitura` são `SELECT` em tabelas de
  catálogo e vitrine pública; `Notification.notificacao_entrega` é `INSERT` com
  `WITH CHECK (true)`, decisão documentada na migration `20260925230000`, que declara o
  risco remanescente ("uma rota futura que aceite `userIds` e texto do cliente
  transformaria isso em canal de mensagem forjada") e o classifica como barreira de
  aplicação. Nenhuma delas foi criada, alterada ou tocada por este trabalho.
* **Dois papéis com `BYPASSRLS`:** `postgres` (superusuário, inerente) e `mci_backup`
  (provisionado por `scripts/provision-backup-role.sql`; um papel de backup precisa ler
  tudo). Pré-existentes, e nenhum deles é o papel da aplicação.

---

## 6. Rollback

**Não há migração de volta automática, e isso é deliberado:** `prisma migrate` não gera
`down`, e escrever um `down` para políticas de RLS é a forma clássica de reabrir uma brecha
por engano num momento de pressa.

O caminho de volta é o **restore do backup** do passo 4.4, e a decisão de usá-lo é humana.

O que **pode** ser desfeito sem restore, se necessário, e o custo de cada um:

| Situação | O que fazer | Custo |
| --- | --- | --- |
| Cadastro legado voltou a pendente e precisa atuar já | Aprovar pela rota, com motivo (R-03) | Nenhum — é o caminho certo |
| Delegação central ficou inerte e é necessária | Conceder de novo, com escopo e prazo | Nenhum — é o caminho certo |
| A cláusula de A-03 cegou um treinador que deveria ver | Atribuir a ele a equipe na federação, ou revisar a autorização | Nenhum, se o estado do cadastro estiver correto |
| A política de A-04 recusa uma confirmação legítima | Verificar se existe convite PENDING daquela equipe. Se não existir, o convite é que falta | Nenhum |
| Precisa reverter a política em si | Restore do backup | Perda de tudo depois do ponto do backup |

---

## 7. O que este plano NÃO autoriza

* Não autoriza deploy. A autorização é de Helder Falcão, e é separada deste documento.
* Não autoriza rodar migração à mão em produção. Toda alteração estrutural é reproduzível
  por migration, e é assim que ela sobe.
* Não autoriza editar dado de produção pelo psql. Os três diagnósticos são **somente
  leitura** — conferido nos três em 2026-09-28 —, e a única escrita prevista é a da
  migration 5, com o predicado escrito no arquivo.
