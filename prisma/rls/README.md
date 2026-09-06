# Row Level Security — ativação e validação

## Estado atual: ESCRITO, NÃO APLICADO

As políticas de `001_contexto_e_politicas.sql` **não foram executadas contra
nenhum banco**. Não estão em `prisma/migrations/` de propósito.

O motivo é concreto. O container roda `prisma migrate deploy` no arranque. Se
estas políticas estivessem em `migrations/`, o próximo deploy as aplicaria numa
aplicação que ainda não envia o contexto de sessão — e RLS sem contexto não
restringe o acesso, **nega tudo**. A API subiria e devolveria vazio ou erro em
cada rota, em produção, sem ninguém ter pedido essa mudança.

## Por que não basta rodar o SQL

Hoje a aplicação conecta como `mci`, que é **dono das tabelas**. O PostgreSQL
isenta o dono das políticas, a não ser que a tabela tenha
`FORCE ROW LEVEL SECURITY` — que o script liga. Consequência: no instante em que
o script rodar, toda consulta passa a ser filtrada, inclusive as que hoje
funcionam.

Por isso a ativação tem uma ordem, e ela não pode ser invertida.

## Ordem de ativação

**1. Criar um papel de aplicação que não seja dono das tabelas**

```sql
CREATE ROLE mci_app LOGIN PASSWORD '<segredo do cofre>';
GRANT CONNECT ON DATABASE mci TO mci_app;
GRANT USAGE ON SCHEMA public, mci TO mci_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mci_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mci_app;
```

`mci_app` **não pode** ter `SUPERUSER` nem `BYPASSRLS` — qualquer um dos dois
torna todo este arquivo decorativo.

**2. Passar as consultas por `comContexto`**

`src/config/contextoRls.js` já existe. Os repositórios ainda **não** o usam:
seguem chamando `prisma` diretamente. Enquanto isso não mudar, o banco não sabe
quem é o usuário da requisição e as políticas vão negar tudo.

Esta é a etapa mais longa e é pré-requisito real das seguintes.

**3. Aplicar as políticas em ambiente de teste**

```bash
psql "$DATABASE_URL" -f prisma/rls/001_contexto_e_politicas.sql
```

**4. Rodar a bateria de segurança**

Antes de considerar o RLS válido, cada caso abaixo precisa passar com a
aplicação conectando como `mci_app`:

| Cenário | Esperado |
|---|---|
| Juiz lê as próprias notas | permitido |
| Juiz lê nota de outro juiz da mesma bateria | **negado** |
| Juiz grava nota em nome de outro juiz | **negado** |
| Membro da organização A lê atleta da organização B | **negado** |
| Anônimo lê resultado `PUBLICADO` | permitido |
| Anônimo lê resultado `EM_REVISAO` | **negado** |
| Atleta lê o próprio cadastro | permitido |
| Não-auditor lê `AuditLog` | **negado** |
| Qualquer papel apaga linha de `AuditLog` | **negado** |

**5. Só então mover para `prisma/migrations/`**

Com os testes verdes, o arquivo vira migration versionada e passa a ser aplicado
pelo deploy.

## O que RLS não resolve

RLS decide quais **linhas** aparecem. Não decide quais **colunas**.

O CPF em `Athlete.documentNumber` não é protegido por nenhuma política deste
arquivo: quem enxerga a linha, enxerga a coluna. A supressão do documento para
quem não tem `athletes.read.sensitive` é feita na camada de serviço — e é lá que
precisa ter teste. Tratar RLS como se cobrisse isso seria acreditar numa
proteção que não existe.
