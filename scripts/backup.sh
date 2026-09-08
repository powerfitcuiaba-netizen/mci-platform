#!/usr/bin/env bash
#
# Backup do PostgreSQL do MCI.
#
# Formato custom (-Fc): comprimido, restaurável por `pg_restore` com paralelismo
# e seletivo por objeto. Um .sql puro só se restaura inteiro e de uma vez.
#
# O que este backup NÃO protege: os arquivos do storage. Documento de atleta,
# mídia social e anexo de mensagem vivem fora do banco — em disco ou em bucket
# S3 — e precisam da sua própria cópia. Ver docs/BACKUP-RESTORE.md.
#
# Uso:
#   DATABASE_URL='postgresql://...' scripts/backup.sh [diretório]
#   DATABASE_URL='postgresql://...' BACKUP_DIR=/var/backups/mci scripts/backup.sh
#
set -euo pipefail

# As ferramentas do PostgreSQL NÃO estão na imagem da aplicação — ela roda a
# API, não administra banco, e não deve carregar a credencial de backup. Este
# script pertence a um job separado, com o cliente do PostgreSQL instalado
# (a imagem oficial `postgres:16` serve). Conferir aqui transforma um
# "command not found" no meio da madrugada numa instrução.
for ferramenta in pg_dump psql pg_restore; do
  command -v "$ferramenta" >/dev/null 2>&1 || {
    echo "FALHA: '$ferramenta' não encontrado." >&2
    echo "Rode o backup de um ambiente com o cliente do PostgreSQL instalado —" >&2
    echo "a imagem da aplicação não o traz de propósito. Ver docs/BACKUP-RESTORE.md." >&2
    exit 1
  }
done

# Argumento posicional vence a variável de ambiente. A variável existe porque
# cron e unidades systemd passam ambiente com facilidade e argumento com
# atrito — e um destino errado só aparece no dia do desastre.
DESTINO="${1:-${BACKUP_DIR:-./backups}}"
: "${DATABASE_URL:?DATABASE_URL não definida}"

# A DATABASE_URL da aplicação carrega parâmetros do Prisma (`?schema=`,
# `connection_limit`, `pgbouncer`) que o pg_dump recusa com "invalid URI query
# parameter". Descoberto tentando: o script morria e deixava um arquivo de zero
# byte com cara de backup. Aqui a URL é limpa antes de qualquer coisa.
URL_LIMPA="${DATABASE_URL%%\?*}"

mkdir -p "$DESTINO"
CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
ARQUIVO="$DESTINO/mci-$CARIMBO.dump"

# Falha no meio do dump não pode deixar arquivo parcial parecendo backup bom.
limpar_parcial() { rm -f "$ARQUIVO" "$ARQUIVO.sha256"; }
trap 'limpar_parcial' ERR

# O MCI usa FORCE ROW LEVEL SECURITY. Sob FORCE, as políticas valem TAMBÉM
# para o dono do schema, e `pg_dump` executado por ele falha com
# "query would be affected by row-level security policy". Não é defeito do
# banco nem do dump: é a proteção funcionando.
#
# O backup precisa de um papel com BYPASSRLS — ver scripts/provision-backup-role.sql.
# Conferir ANTES de dumpar transforma uma falha críptica no meio da noite numa
# mensagem que diz o que fazer.
PODE_LER=$(psql "$URL_LIMPA" -tAc "SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user")
if [ "$PODE_LER" != "t" ]; then
  cat >&2 <<'AVISO'
FALHA: o papel atual não consegue ler todas as linhas.

As tabelas do MCI usam FORCE ROW LEVEL SECURITY, que aplica as políticas de
linha inclusive ao dono do schema. Um pg_dump executado por esse papel produz
um backup INCOMPLETO ou falha no meio.

Use o papel de backup, que existe para isto:

  psql -d <banco> -v DBNAME=<banco> -v senha="'<senha>'" \
       -f scripts/provision-backup-role.sql

  DATABASE_URL='postgresql://mci_backup:<senha>@host:5432/<banco>' scripts/backup.sh

NÃO desligue o FORCE ROW LEVEL SECURITY para o backup passar.
AVISO
  exit 1
fi

INICIO=$(date -u +%s%3N)

# --no-owner e --no-privileges: o dump é restaurado num servidor cujos papéis
# podem ter outros nomes. Quem recria o papel de aplicação é
# scripts/provision-app-role.sql, no procedimento de restauração.
pg_dump --dbname="$URL_LIMPA" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="$ARQUIVO"

FIM=$(date -u +%s%3N)

# Checksum para detectar corrupção em trânsito ou no armazenamento frio.
sha256sum "$ARQUIVO" | awk '{print $1}' > "$ARQUIVO.sha256"

# Um arquivo criado com sucesso NÃO é um backup válido. Ler o índice prova que
# o dump é legível e tem conteúdo; sem isto, a falha só apareceria no desastre.
OBJETOS=$(pg_restore --list "$ARQUIVO" | grep -c '^[0-9]' || true)
if [ "$OBJETOS" -lt 1 ]; then
  echo "FALHA: o dump não contém objeto algum — arquivo inútil." >&2
  exit 1
fi

TAMANHO=$(stat -c%s "$ARQUIVO")
echo "{\"arquivo\":\"$ARQUIVO\",\"bytes\":$TAMANHO,\"ms\":$((FIM-INICIO)),\"objetos\":$OBJETOS,\"sha256\":\"$(cat "$ARQUIVO.sha256")\"}"
