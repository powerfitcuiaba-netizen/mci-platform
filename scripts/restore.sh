#!/usr/bin/env bash
#
# Restauração do PostgreSQL do MCI em banco NOVO.
#
# Recusa-se a escrever num banco que já tenha tabelas: restaurar por cima de
# base viva mistura dois estados e produz corrupção difícil de perceber. Crie
# um banco vazio e aponte para ele.
#
# Uso:
#   TARGET_DATABASE_URL='postgresql://...' scripts/restore.sh arquivo.dump
#
set -euo pipefail

ARQUIVO="${1:?informe o arquivo .dump}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL não definida}"

[ -f "$ARQUIVO" ] || { echo "arquivo não encontrado: $ARQUIVO" >&2; exit 1; }

# Mesmo tratamento do backup: psql e pg_restore não aceitam os parâmetros do
# Prisma na URL.
URL_LIMPA="${TARGET_DATABASE_URL%%\?*}"

# Confere o checksum antes de tocar no banco, se ele acompanhar o dump.
if [ -f "$ARQUIVO.sha256" ]; then
  ESPERADO=$(cat "$ARQUIVO.sha256")
  ATUAL=$(sha256sum "$ARQUIVO" | awk '{print $1}')
  [ "$ESPERADO" = "$ATUAL" ] || { echo "FALHA: checksum não confere — dump corrompido." >&2; exit 1; }
fi

TABELAS=$(psql "$URL_LIMPA" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")
if [ "$TABELAS" -ne 0 ]; then
  echo "FALHA: o banco de destino já tem $TABELAS tabelas. Restaure em banco vazio." >&2
  exit 1
fi

INICIO=$(date -u +%s%3N)
pg_restore --dbname="$URL_LIMPA" --no-owner --no-privileges --exit-on-error "$ARQUIVO"
FIM=$(date -u +%s%3N)

RESTAURADAS=$(psql "$URL_LIMPA" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'")

# O RLS é parte do dado, não da aplicação: um restore que perca FORCE ROW LEVEL
# SECURITY entrega um banco aberto com cara de banco restaurado.
SEM_FORCE=$(psql "$URL_LIMPA" -tAc \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relrowsecurity and not c.relforcerowsecurity")
COM_FORCE=$(psql "$URL_LIMPA" -tAc \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relforcerowsecurity")

if [ "$SEM_FORCE" -ne 0 ]; then
  echo "FALHA: $SEM_FORCE tabela(s) voltaram com RLS sem FORCE." >&2
  exit 1
fi

echo "{\"tabelas\":$RESTAURADAS,\"ms\":$((FIM-INICIO)),\"tabelasComForceRls\":$COM_FORCE}"
