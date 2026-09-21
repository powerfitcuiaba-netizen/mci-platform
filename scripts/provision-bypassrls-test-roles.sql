-- ============================================================================
-- OS DOIS PAPÉIS QUE O TESTE DE BYPASSRLS PRECISA — E QUE ELE NÃO PODE CRIAR.
--
-- POR QUE ESTE ARQUIVO EXISTE
--
-- `tests/bypassrls-real.test.mjs` prova duas coisas: que o atributo BYPASSRLS
-- derruba FORCE ROW LEVEL SECURITY de verdade, e que a barreira de partida
-- recusa uma conexão assim. Para isso ele precisa de um papel REAL com o
-- atributo.
--
-- O teste criava esse papel sozinho, e isso não funciona — nem deveria. O
-- PostgreSQL exige que QUEM CRIA um papel com BYPASSRLS tenha o atributo:
--
--   ERROR: permission denied to create role
--   DETAIL: Only roles with the BYPASSRLS attribute may create roles with the
--           BYPASSRLS attribute.
--
-- O papel da aplicação tem CREATEROLE na CI, mas NÃO tem — e não pode ter —
-- BYPASSRLS: dá-lo à aplicação é exatamente o que a barreira existe para
-- impedir. Então o papel de teste é provisionado por quem em produção o
-- provisionaria: o administrador do banco, uma vez, fora do caminho da
-- aplicação. É o mesmo desenho do papel de backup.
--
-- SÃO DOIS, E O SEGUNDO É O CASO QUE ENGANA
--
--   * `mci_teste_bypassrls` carrega o atributo;
--   * `mci_teste_bypassrls_membro` NÃO carrega, mas PODE ASSUMIR quem carrega.
--     O privilégio se alcança sem trocar de conexão, e é por isso que a
--     barreira pergunta por `pg_has_role(..., 'MEMBER')` e não por `USAGE`.
--
-- ONDE RODA: só na CI, contra um banco de descarte. Nenhum destes papéis
-- pertence a ambiente real, e o nome carrega "teste" justamente para que uma
-- execução distraída em produção salte aos olhos.
--
-- Uso:
--   psql -d mci_test -v senha="'<senha efêmera>'" \
--        -f scripts/provision-bypassrls-test-roles.sql
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_setting('is_superuser') <> 'on' THEN
    RAISE EXCEPTION
      'este script precisa de papel administrativo: conceder BYPASSRLS exige quem já o tem';
  END IF;
END $$;

DROP ROLE IF EXISTS mci_teste_bypassrls_membro;
DROP ROLE IF EXISTS mci_teste_bypassrls;

-- O papel que carrega o atributo. Somente leitura: o teste mede o que ele
-- ENXERGA, não o que ele escreve.
CREATE ROLE mci_teste_bypassrls LOGIN PASSWORD :senha
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;

-- Privilégio de tabela é OUTRA coisa que RLS. Sem SELECT concedido, a leitura
-- falharia por permissão e o teste estaria medindo a permissão, e não o
-- atributo.
GRANT USAGE ON SCHEMA public TO mci_teste_bypassrls;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mci_teste_bypassrls;

-- O papel que NÃO tem o atributo e pode assumir quem tem.
CREATE ROLE mci_teste_bypassrls_membro LOGIN PASSWORD :senha
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT mci_teste_bypassrls TO mci_teste_bypassrls_membro;
GRANT USAGE ON SCHEMA public TO mci_teste_bypassrls_membro;

DO $$
DECLARE
  tem boolean;
  herda boolean;
BEGIN
  SELECT rolbypassrls INTO tem FROM pg_roles WHERE rolname = 'mci_teste_bypassrls';
  IF NOT tem THEN
    RAISE EXCEPTION 'o papel de teste nasceu sem BYPASSRLS: o teste mediria nada';
  END IF;

  SELECT pg_has_role('mci_teste_bypassrls_membro', 'mci_teste_bypassrls', 'MEMBER')
    INTO herda;
  IF NOT herda THEN
    RAISE EXCEPTION 'o papel intermediário não pode assumir o papel com BYPASSRLS';
  END IF;
END $$;

\echo 'papéis de teste de BYPASSRLS provisionados'
