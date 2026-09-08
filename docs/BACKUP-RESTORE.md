# Backup, restauração e recuperação de desastre

Procedimento operacional do MCI. Tudo aqui foi **executado**, não apenas
escrito: os números do fim do documento vêm de um ensaio real, com backup,
restauração em banco novo e a aplicação subindo contra o banco recuperado.

---

## 1. O que este backup protege — e o que NÃO protege

| | Coberto pelo dump do banco |
|---|---|
| Atletas, eventos, inscrições, resultados, pontos, ranking | **sim** |
| Usuários, papéis, vínculos de organização | **sim** |
| Hashes de senha (bcrypt) | **sim** |
| Trilha de auditoria (`AuditLog`) | **sim** |
| Importações MuscleWar e seus estados (`CONFLICT`, `MATCH_PENDING`) | **sim** |
| Políticas de RLS e `FORCE ROW LEVEL SECURITY` | **sim** |
| **Arquivos do storage** — documento de atleta, mídia social, anexo de mensagem, foto | **NÃO** |

> **O backup do banco NÃO protege o storage.** Os arquivos vivem fora do
> PostgreSQL — em disco (`STORAGE_DIR`) ou em bucket S3. O dump guarda apenas
> a **referência** (`storageKey`, `fileName`, `sizeBytes`).
>
> Isso foi verificado, não suposto. No ensaio, um documento de evento foi
> enviado, o banco foi dumpado e restaurado num ambiente com storage vazio.
> Resultado: a listagem do evento **mostrava o documento** com título, tipo e
> tamanho, e o download devolvia `HTTP 404 FILE_NOT_FOUND`. Depois de copiar
> também os arquivos, o mesmo download voltou `HTTP 200` com o SHA-256 idêntico
> ao original.
>
> Um plano de recuperação que só copia o banco entrega um catálogo de arquivos
> que não existem mais.

**O storage precisa da sua própria cópia**, com a mesma disciplina do banco:

* **S3 / compatível (produção):** ative versionamento no bucket, e replicação
  entre regiões ou cópia agendada para um segundo bucket. Não confie apenas na
  durabilidade do provedor — ela não protege contra exclusão acidental nem
  contra chave comprometida.
* **Disco local (`STORAGE_DIR`):** cópia sincronizada do diretório junto com o
  dump, no mesmo agendamento, para o mesmo destino frio.

O par banco + storage tem de ser copiado **na mesma janela**. Um dump de hoje
com arquivos de ontem produz referências quebradas.

---

## 2. Por que o backup exige um papel próprio

As tabelas do MCI usam **`FORCE ROW LEVEL SECURITY`**: as políticas de linha
valem **inclusive para o dono do schema**. Sem `FORCE`, quem é dono lê tudo e o
RLS vira decoração — a escolha é deliberada.

O efeito colateral aparece na primeira tentativa de backup:

```
ERROR: query would be affected by row-level security policy for table "Athlete"
```

Ou seja: **com a configuração de segurança correta, `pg_dump` pelo caminho
óbvio falha**. Quem descobrir isso durante um desastre descobre tarde.

A saída **não** é afrouxar o RLS. É um papel dedicado, somente-leitura, com
`BYPASSRLS`:

```bash
psql -d mci -v DBNAME=mci -v senha="'<senha forte>'" \
     -f scripts/provision-backup-role.sql
```

O papel resultante é `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
BYPASSRLS` com `SELECT` em tudo — hoje e no que vier depois. Ele serve ao
backup e a mais nada.

> **NÃO desligue o `FORCE ROW LEVEL SECURITY` para o backup passar.** O script
> confere o papel **antes** de dumpar e recusa com uma mensagem que diz o que
> fazer, em vez de produzir um dump silenciosamente incompleto.

---

## 3. Fazer o backup

```bash
DATABASE_URL='postgresql://mci_backup:<senha>@host:5432/mci' \
BACKUP_DIR=/var/backups/mci \
  scripts/backup.sh
```

Saída (uma linha JSON, própria para log de cron):

```json
{"arquivo":"/var/backups/mci/mci-20260908T034213Z.dump","bytes":270634,"ms":163,"objetos":641,"sha256":"4358d756…"}
```

O script:

1. **limpa a URL** — a `DATABASE_URL` da aplicação carrega parâmetros do Prisma
   (`?schema=`, `connection_limit`, `pgbouncer`) que o `pg_dump` recusa com
   *invalid URI query parameter*. Sem essa limpeza o script morria deixando um
   arquivo de zero byte com cara de backup;
2. **confere o papel** (`BYPASSRLS` ou superusuário) antes de qualquer escrita;
3. dumpa em **formato custom** (`-Fc`, compressão 9, `--no-owner
   --no-privileges`) — restaurável seletivamente e em paralelo;
4. grava o **SHA-256** ao lado;
5. **lê o índice do próprio dump** (`pg_restore --list`) e reprova se não houver
   objeto algum. Um arquivo criado com sucesso não é um backup válido;
6. em qualquer falha, **apaga o arquivo parcial** — nada de meio-backup na pasta
   parecendo bom.

### Agendamento

`cron`, diário, fora do horário de evento:

```cron
0 4 * * *  DATABASE_URL='postgresql://mci_backup:...@host:5432/mci' BACKUP_DIR=/var/backups/mci /opt/mci/scripts/backup.sh >> /var/log/mci-backup.log 2>&1
```

A senha do papel de backup vem do gerenciador de segredos do ambiente ou de um
arquivo com permissão `0600` lido pela unidade — **nunca versionada e nunca
escrita neste repositório**.

---

## 4. Retenção

Política mínima recomendada para uma temporada de campeonato:

| Janela | Frequência | Guardar |
|---|---|---|
| Últimos 7 dias | diária | 7 cópias |
| Últimas 4 semanas | semanal (domingo) | 4 cópias |
| Últimos 12 meses | mensal (dia 1) | 12 cópias |
| Fim de temporada | uma cópia por temporada | **permanente** |

Duas regras que não são negociáveis:

* **Uma cópia fora do servidor do banco.** Backup no mesmo disco não sobrevive
  ao desastre que motivou o backup.
* **O dump contém CPF.** É dado pessoal na acepção da LGPD: guarde cifrado em
  repouso, com acesso restrito e registrado, e destrua ao fim da retenção.
  Aplica-se ao arquivo o mesmo cuidado que se aplica ao banco.

---

## 5. Restaurar

**Sempre em banco vazio.** O script recusa destino que já tenha tabelas —
restaurar por cima de base viva mistura dois estados e produz corrupção difícil
de perceber.

```bash
createdb -O mci_owner mci_recuperado

TARGET_DATABASE_URL='postgresql://mci_owner:<senha>@host:5432/mci_recuperado' \
  scripts/restore.sh /var/backups/mci/mci-20260908T034213Z.dump
```

```json
{"tabelas":73,"ms":827,"tabelasComForceRls":21}
```

O script confere o **checksum antes de tocar no banco**, restaura com
`--exit-on-error` e, ao final, verifica que **nenhuma tabela voltou com RLS sem
`FORCE`** — um banco recuperado com a barreira enfraquecida seria um vazamento
silencioso no pior momento possível.

Depois do restore, recrie o papel de aplicação no banco novo:

```bash
psql -d mci_recuperado -v senha="'<senha>'" -f scripts/provision-app-role.sql
```

---

## 6. Procedimento de desastre, do começo ao fim

1. **Parar a aplicação.** Escrita em base inconsistente aumenta o estrago.
2. **Escolher o dump** — o mais recente cujo checksum confere.
3. **Restaurar o storage** da mesma janela (bucket ou diretório). *Não pule
   este passo:* o banco sozinho recupera as referências, não os arquivos.
4. **Criar o banco vazio** e rodar `scripts/restore.sh`.
5. **Provisionar o papel de aplicação** (`provision-app-role.sql`) e o de
   backup (`provision-backup-role.sql`) no banco novo.
6. **Subir a aplicação** apontando para o banco recuperado e para o storage
   recuperado.
7. **Conferir `/ready`** — tem de vir `{"ready":true}` com `database`,
   `storage` **e `rls`** verdadeiros. A aplicação recusa subir sem RLS efetivo.
8. **Rodar a conferência da seção 7.**
9. Só então liberar o acesso.

---

## 7. Conferência obrigatória depois de restaurar

Nenhum destes itens é opcional. Todos foram executados no ensaio e todos
passaram.

| Conferência | Como | Esperado |
|---|---|---|
| Aplicação sobe | `GET /ready` | `{"ready":true,...,"rls":true}` |
| Credenciais sobreviveram | login de admin, diretor e atleta | `200` com token |
| Senha errada continua recusada | login com senha inválida | `401` |
| Ranking do campeonato | `GET /ranking?seasonId=…` | SHA-256 **idêntico** ao de antes |
| Ranking de equipes | `GET /ranking/teams` | SHA-256 idêntico |
| Super Overall | `GET /ranking/super-overall` | SHA-256 idêntico |
| Ranking de empresas | `GET /ranking/companies` | SHA-256 idêntico |
| Títulos Overall | `GET /events/:id/overall` | mesma quantidade |
| CPF fora do público | `GET /public/athletes` | nenhum CPF |
| CPF por busca | `GET /athletes?search=<dígitos>` | `0` resultados |
| CPF com permissão | diretor da organização | CPF visível |
| CPF sem permissão | diretor de **outra** organização | só máscara, ou nada |
| Cross-tenant | organização B escrevendo na A | `403` |
| Anônimo | escrita sem token | `401` |
| Auditoria | `GET /audit?organizationId=…` | acessível ao admin, `403` ao vizinho, `401` ao anônimo |
| MuscleWar | preview da importação | `CONFLICT` e `MATCH_PENDING` preservados |
| MuscleWar idempotente | reaplicar a importação | ranking **inalterado** |
| Storage | download de um documento | `200` **se** o storage foi restaurado |

Conferência no nível do banco, com `psql`:

```sql
-- Tem de bater com a origem.
select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relforcerowsecurity;
select count(*) from pg_policies where schemaname = 'public';

-- O CPF vive em AthleteIdentity, protegido por RLS de linha.
-- Sem contexto de ator, tem de vir ZERO.
select count(*) from "AthleteIdentity";
```

---

## 8. Números do ensaio executado

Ensaio real, em 8 de setembro de 2026, com a base de recuperação de desastre:
43 tabelas povoadas, **279 linhas**, 6 atletas, 2 organizações, 2 eventos, 2
resultados, 11 lançamentos de ponto, 2 títulos Overall, 1 importação MuscleWar
com `CONFLICT` e `MATCH_PENDING` abertos, 90 registros de auditoria.

| Etapa | Medido |
|---|---|
| Backup (dump + checksum + leitura do índice) | **163 ms** — 270 634 bytes, 641 objetos |
| Provisionar banco vazio | **150 ms** |
| `pg_restore` | **827 ms** — 73 tabelas, 21 com `FORCE RLS` |
| Aplicação de pé até `/ready 200` | **378 ms** |
| Primeiro login com sucesso | **365 ms** |
| **`RTO_OBSERVED`** (banco vazio → primeiro login) | **1 720 ms** |

`RPO_OBSERVED` = **intervalo entre backups**. O procedimento não usa
*point-in-time recovery*, então a perda máxima é tudo o que foi escrito desde o
último dump: com o agendamento diário sugerido, **até 24 horas**.

> Para reduzir o `RPO` é preciso arquivamento contínuo de WAL
> (`archive_command` + `restore_command`) ou uma réplica em *streaming*. Isso
> **não está implementado** e é decisão de infraestrutura do ambiente de
> produção, não do repositório. Registrado aqui como limitação conhecida, não
> como item concluído.

### Sobre estes números

São de **um ensaio local**, num único host, com uma base pequena (dump de
270 KB). **Não são um RTO de produção** e não devem ser citados como tal. O que
eles provam é que o procedimento **funciona de ponta a ponta** e que cada passo
tem uma medida associada; o tempo real escala com o tamanho da base e com a
banda até o armazenamento frio.

**Meça de novo no ambiente de produção, com dados de produção**, antes de
prometer qualquer RTO a alguém.

---

## 9. Verificações que já falham sozinhas

Provado no ensaio — cada guarda foi disparada de propósito:

| Cenário | Resultado |
|---|---|
| Backup por papel sem `BYPASSRLS` | recusa, explica o `FORCE RLS`, **não deixa arquivo** |
| Restore em banco com tabelas | recusa: *"o banco de destino já tem 73 tabelas"* |
| Dump adulterado (1 byte a mais) | recusa: *"checksum não confere"* — **0 tabelas criadas** |
| Dump sem objeto algum | recusa: *"arquivo inútil"* |
| Restore que voltasse sem `FORCE RLS` | recusa e relata quantas tabelas |

Tudo isso é exercitado automaticamente em `tests/backup-restore.test.mjs`,
contra um PostgreSQL real, a cada rodada de CI. A pipeline reprova se essa
suíte for **pulada** — uma suíte que pula silenciosamente é uma suíte que não
existe.

---

## 10. O que este procedimento NÃO faz

Registrado explicitamente para não ser confundido com item resolvido:

* **Não faz backup do storage.** Seção 1.
* **Não faz *point-in-time recovery*.** Sem WAL arquivado, o `RPO` é o intervalo
  entre dumps.
* **Não copia o dump para fora do host.** O envio para armazenamento frio, e a
  cifragem em repouso, são do ambiente.
* **Não cifra o arquivo.** O dump contém CPF; cifrar em repouso é obrigação de
  quem o guarda.
* **Não testa restauração periodicamente em produção.** A CI ensaia a cada
  push com base de teste. Um ensaio com **dados reais**, em ambiente separado e
  com cadência definida, continua sendo responsabilidade operacional.
