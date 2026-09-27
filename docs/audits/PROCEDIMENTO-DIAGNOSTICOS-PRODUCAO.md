# Procedimento — os dois diagnósticos somente leitura em produção

**Para:** Helder Falcão · **Data:** 2026-09-27 · **Estado:** proposto, **não executado**

Este documento descreve como rodar, em produção, os dois diagnósticos que precedem a decisão
sobre a migration `20260927030000`. Nada aqui foi executado contra produção.

> **Leia a seção 4 antes de autorizar qualquer coisa.** O segundo diagnóstico, do jeito que
> está hoje, **devolve um "está tudo certo" falso** em qualquer banco com RLS ativa — o que
> inclui produção. Provado nesta sessão, em banco sintético. Ele precisa ser corrigido antes de
> valer como porta de deploy.

---

## 1. A ordem, e por que ela é essa

| # | Script | Responde | Trava que ele protege |
| --- | --- | --- | --- |
| 1 | `scripts/diagnostico-treinadores-legados.js` | quantos cadastros de treinador voltam a `PENDENTE`, e quais estão **em uso** | migration `20260927030000` |
| 2 | `scripts/diagnostico-delegacoes-inertes.js` | quais delegações centrais vivas **deixam de conceder** | correção A-02, que já está no código |

O primeiro vem antes porque é o que decide o **deploy**: a migration roda sozinha no
`preDeployCommand` do Render (`npx prisma migrate deploy`). O segundo decide o **aviso**: a
correção A-02 já está no código e passa a valer no mesmo instante, mas ela não apaga nem altera
linha nenhuma — o efeito é de leitura.

---

## 2. Diagnóstico 1 — cadastros de treinador aprovados sem revisor

### O que ele consulta

Uma única tabela, `Coach`, com uma única consulta:

```
prisma.coach.findMany({
  select: { id, name, status, createdAt, reviewedById, reviewedAt,
            _count: { teams, athletes, organizations } },
  orderBy: { createdAt: 'asc' }
})
```

Nenhum `where`: ele lê todos os cadastros e classifica em memória, com **o mesmo predicado da
migration, palavra por palavra**:

* **voltam a `PENDENTE`** — `status = 'APPROVED'` **e** `reviewedById IS NULL` **e**
  `reviewedAt IS NULL`;
* **não serão tocados** — `status = 'APPROVED'` com revisor ou data;
* **em uso** — dos que voltam, os que têm equipe, atleta no catálogo ou autorização de federação.

O predicado é o mesmo porque, se um dia divergirem, o diagnóstico deixa de diagnosticar o que
vai acontecer. `reviewedById` e `reviewedAt` são escritos **exclusivamente** por
`coachService.transicionar` — ou seja, só existem quando uma pessoa decidiu.

### O que ele imprime

Contagens, e depois uma linha por cadastro que volta a pendente, com **id, nome, data de criação
e o uso registrado**. Sem e-mail, sem telefone, sem CPF, sem documento. O nome está lá porque é o
que permite saber **a quem falar** — e é dado pessoal, então trate a saída como material
restrito (seção 7).

### Código de saída

| Código | Significado |
| --- | --- |
| `0` | nenhum cadastro volta a pendente — a migration não terá efeito |
| `1` | **há decisão humana pendente** antes de publicar |
| `2` | falha (ex.: `DATABASE_URL` ausente) |

O `1` é proposital: serve como porta de deploy em automação.

### Confiabilidade em produção — verificada

`Coach` **não tem RLS habilitada** em migration nenhuma (conferido em todas as 44). A consulta
vê todas as linhas mesmo sem contexto de usuário. **Este diagnóstico é confiável como está.**

---

## 3. Diagnóstico 2 — delegações centrais que ficam inertes

### O que ele consulta

Uma tabela, `CentralAuthorization`, só as linhas **vivas** (`revokedAt IS NULL`), com o usuário e
a organização relacionados. Classifica em quatro grupos: sem escopo, sem prazo, já vencidas e
conformes. Imprime id da concessão, permissão, **nome e id da conta**, papel, escopo, prazo e
data da concessão. Sem e-mail.

---

## 4. O defeito que impede o diagnóstico 2 de valer hoje

`CentralAuthorization` tem, desde a migration `20260926020000`:

```sql
ALTER TABLE "CentralAuthorization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CentralAuthorization" FORCE ROW LEVEL SECURITY;
```

e a política de leitura é:

```sql
central_leitura :: (mci_is_platform_admin() OR ("userId" = mci_current_user_id()))
```

O script abre um `PrismaClient` **cru**, sem passar por `withUserContext` — portanto sem
`mci.user_id` na sessão. Com isso `mci_current_user_id()` é nulo, `mci_is_platform_admin()` é
falso, a política não deixa passar linha nenhuma, e **`FORCE` faz a regra valer inclusive para o
dono da tabela**, que é o próprio usuário da aplicação (`mci`, sem `SUPERUSER` e sem `BYPASSRLS`).

### Medido, em banco sintético, nesta sessão

| Consulta | Linhas |
| --- | --- |
| `SET mci.user_id = '<id de um SUPER_ADMIN>'` → `SELECT count(*) FROM "CentralAuthorization"` | **1** |
| sem contexto — exatamente como o script roda hoje | **0** |

E a saída do script, no mesmo banco que tem a concessão:

```
total de linhas vivas .................. 0
NENHUMA concessão viva perde efeito com a correção de A-02.
```

**Código de saída 0.** Isto é um falso "pode publicar". Em produção ele diria a mesma coisa,
independentemente de quantas delegações existam de verdade.

### A correção que proponho

Abrir a transação com o contexto de leitura da administração central, do mesmo jeito que a
aplicação faz — sem mecanismo novo, sem `BYPASSRLS`, sem `SECURITY DEFINER`, sem afrouxar
política:

1. o script recebe, por argumento, o **id da conta `SUPER_ADMIN`** que autoriza a consulta;
2. abre uma transação e executa `SELECT set_config('mci.user_id', $1, true)` — o mesmo
   `SET LOCAL` que `withUserContext` usa em toda requisição autenticada;
3. faz a leitura **dentro** dessa transação;
4. se a contagem vier zero **e** o contexto não tiver sido aceito, o script **falha com código
   2** em vez de dizer que está tudo certo. Um diagnóstico que não consegue ler precisa dizer
   que não conseguiu ler — nunca dizer que não há nada.

O ponto 4 é o que importa mais: hoje a diferença entre "não há delegação" e "não consigo ver
delegação nenhuma" é invisível na saída, e são coisas opostas.

---

## 5. Como garantir que nada é alterado — três camadas

**Camada 1 — o código.** Os dois scripts usam apenas `findMany`. Confira você mesmo antes de
autorizar:

```
grep -nE '\.(create|update|upsert|delete|createMany|updateMany|deleteMany|executeRaw|queryRaw)\(' \
  scripts/diagnostico-treinadores-legados.js scripts/diagnostico-delegacoes-inertes.js
```

A saída esperada é **vazia** — e conferida assim nesta sessão. O parêntese no fim do padrão não
é detalhe: sem ele, `c.createdAt` casa com `create` e a conferência acusa uma escrita que não
existe. Um comando de verificação que dá falso positivo treina quem revisa a ignorá-lo.

**Camada 2 — o banco recusa escrever.** Rode com a sessão marcada como somente leitura,
acrescentando à URL de conexão:

```
?options=-c%20default_transaction_read_only%3Don
```

Testado nesta sessão: a leitura funciona normalmente e qualquer `UPDATE` é recusado pelo
PostgreSQL com `ERROR: cannot execute UPDATE in a read-only transaction` (código `25006`). Não
depende de o script se comportar bem — é o servidor que recusa.

**Camada 3 — a trilha.** Os scripts não gravam auditoria porque não fazem ato administrativo. O
registro do que foi consultado é a saída guardada (seção 7), com data, hora e quem rodou.

---

## 6. Como executar sem expor credenciais

**Regra:** a `DATABASE_URL` **nunca** é digitada, colada, ecoada ou passada por argumento.

### Caminho recomendado — Shell do serviço `mci-api` no Render

O serviço já tem `DATABASE_URL` no ambiente. No painel do Render, em **mci-api → Shell**:

```
node scripts/diagnostico-treinadores-legados.js
```

Só isso. Nada de `echo $DATABASE_URL`, nada de `env`, nada de `printenv`. Se precisar da camada 2
(sessão somente leitura), use:

```
DATABASE_URL="$DATABASE_URL?options=-c%20default_transaction_read_only%3Don" \
  node scripts/diagnostico-treinadores-legados.js
```

— a variável é **referenciada**, não escrita, e não aparece na tela. Confira antes se a
`DATABASE_URL` já tem `?`; se tiver, troque `?` por `&`.

### O que NÃO fazer

* copiar a `DATABASE_URL` para a sua máquina e rodar dali — a URL passa a existir no seu
  histórico de shell, no seu `.env` e no seu clipboard;
* colar a URL em qualquer conversa, inclusive esta;
* rodar com `set -x` ou qualquer modo de eco de comandos.

### Se o Shell do Render não estiver disponível no plano

A alternativa é um **Job** de uma execução só, no mesmo ambiente do serviço, com o mesmo comando.
Não use uma máquina de fora: o ganho é justamente não fazer a credencial viajar.

---

## 7. Como guardar o resultado

A saída contém **nomes de pessoas** — dado pessoal, ainda que mínimo. Tratamento:

1. **Guarde o texto integral** em local restrito (drive da administração central, acesso
   controlado), nomeado por data: `diagnostico-treinadores-legados-2026-09-27.txt`.
2. **Não commite o texto integral** neste repositório: ele é público.
3. **Commite apenas o agregado**, que é o que serve para decidir e não identifica ninguém:

   ```
   data, total de cadastros, aprovados, aprovados com revisor,
   aprovados sem revisor, destes em uso, código de saída
   ```

4. No Shell do Render, para capturar sem perder nada:

   ```
   node scripts/diagnostico-treinadores-legados.js 2>&1 | tee /tmp/diag-legados.txt
   ```

   e copie o conteúdo pela tela. Não envie o arquivo para serviço externo.

---

## 8. Como ler o resultado e decidir sobre a migration

| Resultado | O que significa | Decisão |
| --- | --- | --- |
| `aprovados SEM revisor = 0` | a migration não terá efeito nenhum | publicar sem ação prévia |
| `SEM revisor > 0` e `EM USO = 0` | cadastros voltam a pendente, mas ninguém está atuando com eles | publicar; aprovar formalmente depois, sem urgência |
| `EM USO > 0` | **essas pessoas param de atuar no instante do deploy** | decidir antes: aprovar formalmente **antes** de publicar, ou publicar em janela combinada e aprovar logo em seguida |

A aprovação formal é ato da administração central, pela rota `POST /coaches/:id/approve`, com
motivo — é R-03, e é exatamente o que a migration existe para restaurar. Nenhum script aprova
ninguém.

**Um detalhe de ordem que vale dinheiro:** aprovar **antes** do deploy resolve sozinho, porque a
aprovação grava `reviewedById` e `reviewedAt`, e a migration só toca em quem não tem os dois.
Quem for aprovado antes simplesmente deixa de ser alcançado por ela.

---

## 9. O que depende da sua autorização

1. **Corrigir o diagnóstico 2** (seção 4) — sem isso ele não serve como porta de deploy.
2. **Rodar o diagnóstico 1** em produção, pelo Shell do `mci-api`.
3. **Rodar o diagnóstico 2**, depois de corrigido.
4. **Push** dos 25 commits locais — ainda não feito.

Nada das quatro foi executado.
