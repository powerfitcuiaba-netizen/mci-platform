# Procedimento — os dois diagnósticos somente leitura em produção

**Para:** Helder Falcão · **Data:** 2026-09-27 · **Estado:** proposto, **não executado**

Este documento descreve como rodar, em produção, os dois diagnósticos que precedem a decisão
sobre a migration `20260927030000`. Nada aqui foi executado contra produção.

> **O segundo diagnóstico foi corrigido.** Na primeira redação deste documento ele devolvia um
> "está tudo certo" falso em qualquer banco com RLS ativa — o que inclui produção. A seção 4
> conta o defeito, a correção e as provas. Os dois diagnósticos estão prontos para rodar; nenhum
> foi executado contra produção.

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

### Como ele roda

```
node scripts/diagnostico-delegacoes-inertes.js --listar-admins       # descobre o id
node scripts/diagnostico-delegacoes-inertes.js <id-de-uma-conta-SUPER_ADMIN>
```

O id é obrigatório porque a leitura exige contexto de RLS (seção 4). `--listar-admins` existe
para que ninguém precise escrever uma consulta improvisada ao lado da credencial: ele lê `User`,
que não tem RLS, e imprime id, nome e situação das contas `SUPER_ADMIN`. Sem e-mail.

### Códigos de saída

| Código | Significado |
| --- | --- |
| `0` | nenhuma concessão viva perde efeito |
| `1` | **há concessão que deixa de conceder** — decisão humana antes de publicar |
| `2` | **não foi possível ler**: falta id, contexto recusado, conta não administradora, ou falha |

O `2` é a correção principal: antes, "não consigo ler" e "não há nada" saíam iguais.

---

## 4. O defeito que o diagnóstico 2 tinha, e como foi corrigido

`CentralAuthorization` tem, desde a migration `20260926020000`:

```sql
ALTER TABLE "CentralAuthorization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CentralAuthorization" FORCE ROW LEVEL SECURITY;
```

e a política de leitura é:

```sql
central_leitura :: (mci_is_platform_admin() OR ("userId" = mci_current_user_id()))
```

A versão anterior abria um `PrismaClient` **cru**, sem passar por `withUserContext` — portanto
sem `mci.user_id` na sessão. Com isso `mci_current_user_id()` era nulo, `mci_is_platform_admin()`
era falso, a política não deixava passar linha nenhuma, e **`FORCE` faz a regra valer inclusive
para o dono da tabela**, que é o próprio usuário da aplicação (`mci`, sem `SUPERUSER` e sem
`BYPASSRLS`).

### Medido, em banco sintético

| Consulta | Linhas |
| --- | --- |
| `SET mci.user_id = '<id de um SUPER_ADMIN>'` → `SELECT count(*) FROM "CentralAuthorization"` | **1** |
| sem contexto — como o script rodava | **0** |

E a saída do script, no mesmo banco que tinha a concessão:

```
total de linhas vivas .................. 0
NENHUMA concessão viva perde efeito com a correção de A-02.
```

**Código de saída 0.** Um "pode publicar" falso, na única pergunta que o script existe para
responder.

### A correção

O defeito de fundo não era a RLS: era a saída **não distinguir** "não há delegação" de "não
consigo ver delegação nenhuma". São opostos, e apareciam iguais.

A leitura passou a acontecer dentro de uma transação com contexto declarado:

```js
await tx.$queryRaw`SELECT set_config('mci.user_id', ${idDoAdministrador}, true)`;
const [contexto] = await tx.$queryRaw`
  SELECT mci_current_user_id() AS usuario, mci_is_platform_admin() AS administrador`;
```

É o **mesmo `SET LOCAL`** que toda requisição autenticada usa. Nenhum mecanismo novo: sem
`BYPASSRLS`, sem `SECURITY DEFINER`, sem política afrouxada. O script entra pela porta que já
existe, em vez de contorná-la.

E duas guardas:

* **contexto não aceito** → código 2, com a explicação de que vazio não é ausência;
* **conta não é administradora de plataforma** → código 2, porque a política devolveria apenas
  as concessões daquela conta — leitura parcial apresentada como quadro inteiro.

### As provas

`tests/diagnostico-delegacoes-inertes.test.mjs` roda o script **como processo**, contra o banco
de teste, e mede saída e código de saída — o que quebrou em produção foi a execução, não uma
função interna. Sete casos: recusa sem id; enxerga a inerte com contexto; não acusa a conforme;
recusa conta não administradora; `--listar-admins`; não imprime URL nem e-mail; e o contraste que
dá sentido ao resto — **banco realmente vazio responde "não há" com código 0**, sem se confundir
com a recusa.

Dois mutantes defendem a correção: **TE-D1** remove o `set_config` (a leitura volta a acontecer
sem contexto) e **TE-D2** desativa a guarda de administrador.

---

## 5. Como garantir que nada é alterado — três camadas

**Camada 1 — o código.** Os dois scripts usam apenas `findMany`. Confira você mesmo antes de
autorizar:

```
grep -nE '\.(create|update|upsert|delete|createMany|updateMany|deleteMany|executeRaw)\(' \
  scripts/diagnostico-treinadores-legados.js scripts/diagnostico-delegacoes-inertes.js
```

A saída esperada é **vazia** — e conferida assim nesta sessão. O parêntese no fim do padrão não
é detalhe: sem ele, `c.createdAt` casa com `create` e a conferência acusa uma escrita que não
existe. Um comando de verificação que dá falso positivo treina quem revisa a ignorá-lo.

**Camada 2 — o banco recusa escrever.** Rode com a sessão marcada como somente leitura. O
separador depende de a URL já ter query string, e a forma abaixo resolve isso **sem imprimir a
URL**:

```
SEP=$([ "${DATABASE_URL#*\?}" != "$DATABASE_URL" ] && echo '&' || echo '?')
DATABASE_URL="${DATABASE_URL}${SEP}options=-c%20default_transaction_read_only%3Don" \
  node scripts/diagnostico-treinadores-legados.js
```

Testado nesta sessão, nas duas formas de URL (com e sem `?`): a leitura funciona normalmente,
`set_config('mci.user_id', …, true)` continua funcionando — ele não é escrita de dado —, e
qualquer `UPDATE` é recusado pelo PostgreSQL. Não depende de o script se comportar bem: é o
servidor que recusa.

**Camada 3 — a trilha.** Os scripts não gravam auditoria porque não fazem ato administrativo. O
registro do que foi consultado é a saída guardada (seção 7), com data, hora e quem rodou.

---

## 6. Como executar sem expor credenciais

**Regra:** a `DATABASE_URL` **nunca** é digitada, colada, ecoada ou passada por argumento.

### Pré-requisitos — conferidos no repositório

| Requisito | Situação |
| --- | --- |
| Os scripts existem na imagem | **sim** — o `Dockerfile` faz `COPY scripts ./scripts` |
| Diretório de trabalho | `/app`, com `/app/scripts/...` |
| `@prisma/client` gerado | **sim** — `npx prisma generate` roda no build |
| `DATABASE_URL` no ambiente | **sim** — é a mesma que a API usa |
| Permissão de banco | a **mesma** da aplicação: usuário `mci`, sem `SUPERUSER` e sem `BYPASSRLS`. Nenhum privilégio novo é pedido |
| Usuário do processo | `node` (uid 1000), não root |

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

Para o diagnóstico 2, dois comandos — o primeiro descobre o id, o segundo consulta:

```
node scripts/diagnostico-delegacoes-inertes.js --listar-admins
node scripts/diagnostico-delegacoes-inertes.js <id-que-apareceu-acima>
```

com a mesma trava de sessão somente leitura, se quiser a camada 2:

```
DATABASE_URL="$DATABASE_URL?options=-c%20default_transaction_read_only%3Don" \
  node scripts/diagnostico-delegacoes-inertes.js <id>
```

— a variável é **referenciada**, não escrita, e não aparece na tela. Confira antes se a
`DATABASE_URL` já tem `?`; se tiver, troque `?` por `&`.

### O RISCO DE RODAR FORA DO CONTÊINER — corrigido, e vale entender

`require('@prisma/client')` carrega o arquivo `.env` para dentro de `process.env`. Consequência
medida: numa máquina de desenvolvimento com `.env` presente, rodar com `DATABASE_URL` ausente do
ambiente **não falhava** — o script conectava no banco do `.env` e imprimia números
perfeitamente plausíveis **de outro banco**, sem dizer qual havia lido.

Duas correções, ambas nos dois scripts:

1. a URL é lida do ambiente **antes** do `require`, então "ausente no ambiente" passa a
   significar ausente no ambiente, e a recusa sai com código 2;
2. a saída começa com **`banco consultado: <nome>`**. Nome de banco não é segredo — a credencial
   é —, e evidência que não identifica a base não é evidência.

Em produção o `.env` nunca existiu na imagem (está no `.dockerignore`, linhas 16–17). A correção
serve à máquina de quem investiga, que é onde o engano era possível.

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

1. **Rodar o diagnóstico 1** em produção, pelo Shell do `mci-api`.
2. **Rodar o diagnóstico 2** em produção, pelos dois comandos da seção 6.
3. **Push** dos commits locais — ainda não feito.

Nada das três foi executado. A correção do diagnóstico 2 (seção 4) está pronta, testada e
commitada localmente.
