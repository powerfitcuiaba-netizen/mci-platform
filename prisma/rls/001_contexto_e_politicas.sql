-- ============================================================================
-- ROW LEVEL SECURITY — MCI PLATFORM
--
-- ATENÇÃO: este arquivo NÃO está em prisma/migrations/ de propósito.
-- `prisma migrate deploy` roda sozinho no arranque do container. Se estas
-- políticas entrassem lá antes de validadas, um deploy aplicaria RLS numa
-- aplicação que ainda não envia o contexto de sessão — e o efeito de RLS sem
-- contexto não é "acesso restrito", é NEGAR TUDO. A API subiria e responderia
-- vazio ou 500 em cada rota.
--
-- Ver README.md nesta pasta para o procedimento de ativação e validação.
--
-- ----------------------------------------------------------------------------
-- COMO FUNCIONA
--
-- A aplicação conecta com UM usuário de banco. Quem é o usuário HUMANO da
-- requisição chega por variável de sessão, gravada com set_config(..., true)
-- dentro da transação — o `true` faz o valor morrer no fim dela, então uma
-- conexão devolvida ao pool não carrega a identidade de quem a usou antes.
--
-- Duas condições sem as quais nada disto vale:
--   1. o papel da aplicação NÃO pode ser dono das tabelas, ou o Postgres o
--      isenta das políticas. Daí FORCE ROW LEVEL SECURITY abaixo;
--   2. o papel da aplicação NÃO pode ter BYPASSRLS nem ser SUPERUSER.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS mci;

-- ---------------------------------------------------------------------------
-- Contexto da requisição.
-- `true` no segundo argumento de current_setting devolve NULL em vez de erro
-- quando a variável não foi definida. Sem isso, toda consulta fora de uma
-- requisição (uma migration, um psql manual) quebraria.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mci.uid() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('mci.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION mci.papel() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('mci.role', true), ''), 'PUBLICO')
$$;

-- SUPER_ADMIN e ADMIN_MCI enxergam tudo. É deliberado e auditado: sem isso não
-- há suporte nem correção de dado.
CREATE OR REPLACE FUNCTION mci.eh_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN')
$$;

-- SECURITY DEFINER porque esta função consulta OrganizationMember, que também
-- tem RLS. Sem isso a política de OrganizationMember chamaria esta função, que
-- consultaria OrganizationMember de novo: recursão infinita.
CREATE OR REPLACE FUNCTION mci.eh_membro(org_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = org_id
      AND m."userId" = mci.uid()
      AND m.active
  )
$$;

-- ============================================================================
-- POLÍTICAS
-- ============================================================================

-- --- Organização -----------------------------------------------------------
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_leitura ON "Organization";
CREATE POLICY org_leitura ON "Organization" FOR SELECT
  USING (mci.eh_admin() OR mci.eh_membro(id));

DROP POLICY IF EXISTS org_escrita ON "Organization";
CREATE POLICY org_escrita ON "Organization" FOR ALL
  USING (mci.eh_admin()) WITH CHECK (mci.eh_admin());

-- --- Vínculo de membro -----------------------------------------------------
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS membro_leitura ON "OrganizationMember";
CREATE POLICY membro_leitura ON "OrganizationMember" FOR SELECT
  USING (mci.eh_admin() OR "userId" = mci.uid() OR mci.eh_membro("organizationId"));

DROP POLICY IF EXISTS membro_escrita ON "OrganizationMember";
CREATE POLICY membro_escrita ON "OrganizationMember" FOR ALL
  USING (mci.eh_admin()) WITH CHECK (mci.eh_admin());

-- --- Atleta ----------------------------------------------------------------
-- Isolamento por organização (seção 10) mais o próprio atleta sobre seu
-- cadastro. O documento pessoal NÃO é protegido por linha e sim por coluna: RLS
-- decide quais LINHAS aparecem, nunca quais colunas. A supressão de
-- `documentNumber` para quem não tem athletes.read.sensitive é feita na camada
-- de serviço, e é lá que precisa ser testada.
ALTER TABLE "Athlete" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Athlete" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS atleta_leitura ON "Athlete";
CREATE POLICY atleta_leitura ON "Athlete" FOR SELECT
  USING (
    mci.eh_admin()
    OR mci.eh_membro("organizationId")
    OR "userId" = mci.uid()
  );

DROP POLICY IF EXISTS atleta_escrita ON "Athlete";
CREATE POLICY atleta_escrita ON "Athlete" FOR ALL
  USING (mci.eh_admin() OR mci.eh_membro("organizationId"))
  WITH CHECK (mci.eh_admin() OR mci.eh_membro("organizationId"));

-- --- Nota de julgamento ----------------------------------------------------
-- A política mais importante do arquivo (seção 35).
--
-- O juiz alcança APENAS as próprias notas. Não é preferência de interface: se o
-- juiz consegue ler a súmula do colega antes de fechar a dele, o julgamento
-- deixa de ser independente. O banco recusa, e nenhum bug de rota pode afrouxar.
ALTER TABLE "JudgingScore" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "JudgingScore" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nota_leitura ON "JudgingScore";
CREATE POLICY nota_leitura ON "JudgingScore" FOR SELECT
  USING (
    "judgeUserId" = mci.uid()
    -- Quem apura precisa do painel inteiro; quem só pontua, não.
    OR mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI')
  );

DROP POLICY IF EXISTS nota_escrita ON "JudgingScore";
CREATE POLICY nota_escrita ON "JudgingScore" FOR ALL
  USING ("judgeUserId" = mci.uid() OR mci.eh_admin())
  -- WITH CHECK impede o caso mais grave: gravar nota em nome de outro juiz.
  WITH CHECK ("judgeUserId" = mci.uid() OR mci.eh_admin());

-- --- Resultado -------------------------------------------------------------
-- Publicado é público. Em revisão, só quem revisa — pódio vazando antes da hora
-- é resultado divulgado errado (seção 14).
ALTER TABLE "CompetitionResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CompetitionResult" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS resultado_leitura ON "CompetitionResult";
CREATE POLICY resultado_leitura ON "CompetitionResult" FOR SELECT
  USING (
    status = 'PUBLICADO'
    OR mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO',
                       'COORDENADOR_JURI', 'PROMOTOR', 'AUDITOR')
  );

DROP POLICY IF EXISTS resultado_escrita ON "CompetitionResult";
CREATE POLICY resultado_escrita ON "CompetitionResult" FOR ALL
  USING (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI'))
  WITH CHECK (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI'));

-- Colocação acompanha a visibilidade do resultado a que pertence.
ALTER TABLE "AthletePlacement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthletePlacement" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS colocacao_leitura ON "AthletePlacement";
CREATE POLICY colocacao_leitura ON "AthletePlacement" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "CompetitionResult" r WHERE r.id = "resultId"));

DROP POLICY IF EXISTS colocacao_escrita ON "AthletePlacement";
CREATE POLICY colocacao_escrita ON "AthletePlacement" FOR ALL
  USING (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI'))
  WITH CHECK (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'DIRETOR_COMPETICAO', 'COORDENADOR_JURI'));

-- --- Pesagem ---------------------------------------------------------------
ALTER TABLE "WeighIn" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WeighIn" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pesagem_acesso ON "WeighIn";
CREATE POLICY pesagem_acesso ON "WeighIn" FOR ALL
  USING (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'PROMOTOR', 'DIRETOR_COMPETICAO', 'PESAGEM', 'STAFF'))
  WITH CHECK (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'PROMOTOR', 'DIRETOR_COMPETICAO', 'PESAGEM', 'STAFF'));

-- --- Trilha de auditoria ---------------------------------------------------
-- Só leitura, e só para quem audita. Ninguém edita nem apaga auditoria pela
-- aplicação: não há política de UPDATE nem de DELETE, e a ausência é a regra
-- (seção 80).
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auditoria_leitura ON "AuditLog";
CREATE POLICY auditoria_leitura ON "AuditLog" FOR SELECT
  USING (mci.papel() IN ('SUPER_ADMIN', 'ADMIN_MCI', 'ADMIN', 'AUDITOR'));

DROP POLICY IF EXISTS auditoria_insercao ON "AuditLog";
CREATE POLICY auditoria_insercao ON "AuditLog" FOR INSERT
  WITH CHECK (true);
