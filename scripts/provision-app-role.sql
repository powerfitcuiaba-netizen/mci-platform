-- ============================================================================
-- Provisionamento do papel de aplicação.
--
-- Executar UMA vez por banco, com um usuário que tenha CREATEROLE (não o
-- usuário das migrations). Depois desta execução, a API pode conectar como
-- `mci_app`, para quem as políticas de RLS são obrigatórias.
--
-- A senha NÃO fica neste arquivo: passe-a pelo ambiente, por exemplo
--   psql -v senha="'$MCI_APP_PASSWORD'" -f scripts/provision-app-role.sql
-- ============================================================================

\if :{?senha}
\else
  \echo 'Defina a variável :senha — ex.: psql -v senha="'"'"'...'"'"'" -f scripts/provision-app-role.sql'
  \quit
\endif

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mci_app') THEN
    CREATE ROLE mci_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE mci_app WITH PASSWORD :senha;

GRANT USAGE ON SCHEMA public TO mci_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mci_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mci_app;

-- Tabelas criadas por migrations futuras já nascem acessíveis ao papel.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mci_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO mci_app;
