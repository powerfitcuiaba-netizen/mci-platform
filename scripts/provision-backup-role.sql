-- ============================================================================
-- Papel de BACKUP do MCI.
--
-- Por que existe: as tabelas do MCI usam FORCE ROW LEVEL SECURITY, que aplica
-- as políticas de linha INCLUSIVE ao dono do schema. Isso é proteção
-- deliberada — sem FORCE, quem é dono lê tudo e o RLS vira decoração. O efeito
-- colateral, descoberto tentando fazer o backup, é que `pg_dump` executado
-- pelo dono FALHA:
--
--   ERROR: query would be affected by row-level security policy for table "Athlete"
--
-- Ou seja: com a configuração de segurança correta, o backup pelo caminho
-- óbvio não funciona. Quem descobrir isso durante um desastre descobre tarde.
--
-- A saída NÃO é afrouxar o RLS. É um papel dedicado, com BYPASSRLS, usado
-- exclusivamente para leitura de backup e por mais ninguém:
--
--   * BYPASSRLS — precisa enxergar todas as linhas, é essa a função dele;
--   * NOSUPERUSER — não precisa de mais nada além disso;
--   * NOCREATEDB, NOCREATEROLE, NOINHERIT — sem poder colateral;
--   * somente SELECT — um papel de backup não escreve.
--
-- Conceder BYPASSRLS exige um papel administrativo. Em produção este passo é
-- executado uma vez, no provisionamento, e não pelo usuário da aplicação.
--
-- Uso:
--   psql -d mci -v senha="'<senha forte>'" -f scripts/provision-backup-role.sql
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mci_backup') THEN
    CREATE ROLE mci_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
END
$$;

ALTER ROLE mci_backup WITH PASSWORD :senha BYPASSRLS;

GRANT CONNECT ON DATABASE :"DBNAME" TO mci_backup;
GRANT USAGE ON SCHEMA public TO mci_backup;

-- Somente leitura, no que existe hoje e no que vier depois.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mci_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mci_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mci_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO mci_backup;

SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
FROM pg_roles WHERE rolname = 'mci_backup';
