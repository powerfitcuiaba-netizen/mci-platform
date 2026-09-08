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

# As ferramentas do PostgreSQL NÃO estão na imagem da aplicação — ela roda a
# API, não administra banco, e não deve carregar a credencial de backup. Este
# script pertence a um job separado, com o cliente do PostgreSQL instalado
# (a imagem oficial `postgres:16` serve). Conferir aqui transforma um
# "command not found" no meio da madrugada numa instrução.
for ferramenta in pg_restore psql; do
  command -v "$ferramenta" >/dev/null 2>&1 || {
    echo "FALHA: '$ferramenta' não encontrado." >&2
    echo "Rode a restauração de um ambiente com o cliente do PostgreSQL instalado —" >&2
    echo "a imagem da aplicação não o traz de propósito. Ver docs/BACKUP-RESTORE.md." >&2
    exit 1
  }
done

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
