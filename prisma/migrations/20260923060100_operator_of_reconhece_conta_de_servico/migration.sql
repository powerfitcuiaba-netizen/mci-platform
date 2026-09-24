-- ============================================================================
-- `mci_operator_of` passa a reconhecer a conta de serviço da federação.
--
-- Migration SEPARADA de propósito: PostgreSQL não deixa usar um valor de enum
-- na mesma transação em que ele foi acrescentado. Juntar as duas faria o
-- deploy falhar no primeiro ambiente limpo.
--
-- O QUE MUDA: um papel a mais na lista.
-- O QUE NÃO MUDA: absolutamente todo o resto. A função continua exigindo
-- membresia NAQUELA organização — nenhuma política foi afrouxada, nenhum
-- USING(true) foi criado, e o FORCE RLS continua em todas as tabelas. A conta
-- de serviço não vê mais do que um operador humano da mesma federação vê, e
-- vê MENOS que qualquer um deles no nível da aplicação, onde não tem permissão
-- nenhuma.
-- ============================================================================

CREATE OR REPLACE FUNCTION mci_operator_of(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT mci_is_platform_admin() OR EXISTS (
    SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = org_id
      AND m."userId" = mci_current_user_id()
      AND m.role IN (
        'ADMIN', 'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'JUDGE_COORDINATOR',
        'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR',
        'RESULTS_OPERATOR', 'RANKING_MANAGER',
        'FEDERATION_SERVICE'
      )
  )
$$;
