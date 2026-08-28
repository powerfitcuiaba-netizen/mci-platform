#!/bin/sh
# Roda uma única vez, quando o volume do PostgreSQL é criado do zero.
# Sem isto, `npm test` rodaria contra o banco de desenvolvimento e apagaria
# os dados dele a cada execução da suíte.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
    CREATE DATABASE mci_test;
SQL
