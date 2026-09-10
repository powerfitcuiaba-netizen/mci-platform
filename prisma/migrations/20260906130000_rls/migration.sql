-- ============================================================================
-- Row Level Security
--
-- Barreira de banco para os dados privados da plataforma: mensagens, posts
-- restritos, documentos de atleta, stories, resultados não publicados e
-- isolamento entre organizações.
--
-- O ator corrente é lido de `current_setting('mci.user_id', true)`, definido
-- por transação com SET LOCAL (ver src/config/rlsSession.js). Sem ator
-- definido, as políticas negam: falhar fechado é o comportamento correto.
--
-- As políticas valem para o papel de aplicação `mci_app`, que não é dono do
-- schema e não tem BYPASSRLS. A criação desse papel e as concessões ficam em
-- scripts/provision-app-role.sql: criar papel exige CREATEROLE, atributo que
-- o usuário de migration não deve ter.
-- ============================================================================

-- ---------------------------------------------------------------- auxiliares
-- STABLE e não SECURITY DEFINER: são funções de leitura, avaliadas com os
-- privilégios de quem consulta.

CREATE OR REPLACE FUNCTION mci_current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('mci.user_id', true), '')
$$;

CREATE OR REPLACE FUNCTION mci_current_profile_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT p.id FROM "SocialProfile" p WHERE p."userId" = mci_current_user_id()
$$;

-- Papéis da plataforma (não de um tenant): atravessam organizações.
CREATE OR REPLACE FUNCTION mci_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = mci_current_user_id()
      AND u.role IN ('SUPER_ADMIN', 'ADMIN')
      AND u.status = 'ACTIVE'
  )
$$;

CREATE OR REPLACE FUNCTION mci_member_of(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT mci_is_platform_admin() OR EXISTS (
    SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = org_id AND m."userId" = mci_current_user_id()
  )
$$;

-- Membro com papel operacional: quem pode ver dado restrito da organização
-- (CPF, documento, resultado ainda não publicado).
CREATE OR REPLACE FUNCTION mci_operator_of(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT mci_is_platform_admin() OR EXISTS (
    SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = org_id
      AND m."userId" = mci_current_user_id()
      AND m.role IN (
        'ADMIN', 'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'JUDGE_COORDINATOR',
        'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR',
        'RESULTS_OPERATOR', 'RANKING_MANAGER'
      )
  )
$$;

CREATE OR REPLACE FUNCTION mci_in_conversation(conv_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "ConversationMember" cm
    WHERE cm."conversationId" = conv_id
      AND cm."profileId" = mci_current_profile_id()
      AND cm."leftAt" IS NULL
  )
$$;

CREATE OR REPLACE FUNCTION mci_follows(target_profile text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Follow" f
    WHERE f."followerId" = mci_current_profile_id() AND f."followingId" = target_profile
  )
$$;

-- ------------------------------------------------------------------ MENSAGENS
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversa_participante ON "Conversation"
  USING (mci_in_conversation(id))
  WITH CHECK (true);

ALTER TABLE "ConversationMember" ENABLE ROW LEVEL SECURITY;
CREATE POLICY membro_participante ON "ConversationMember"
  USING ("profileId" = mci_current_profile_id() OR mci_in_conversation("conversationId"))
  WITH CHECK (true);

ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
CREATE POLICY mensagem_participante ON "Message"
  USING (mci_in_conversation("conversationId"))
  WITH CHECK (mci_in_conversation("conversationId") AND "senderId" = mci_current_profile_id());

ALTER TABLE "MessageReaction" ENABLE ROW LEVEL SECURITY;
CREATE POLICY reacao_participante ON "MessageReaction"
  USING (EXISTS (SELECT 1 FROM "Message" m WHERE m.id = "messageId" AND mci_in_conversation(m."conversationId")))
  WITH CHECK ("profileId" = mci_current_profile_id());

-- --------------------------------------------------------------------- POSTS
ALTER TABLE "Post" ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_visibilidade ON "Post"
  USING (
    "deletedAt" IS NULL AND (
      visibility = 'PUBLIC'
      OR "authorId" = mci_current_profile_id()
      OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
    )
  )
  WITH CHECK ("authorId" = mci_current_profile_id());

ALTER TABLE "PostMedia" ENABLE ROW LEVEL SECURITY;
CREATE POLICY midia_do_post ON "PostMedia"
  USING (EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "postId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "postId" AND p."authorId" = mci_current_profile_id()));

ALTER TABLE "Comment" ENABLE ROW LEVEL SECURITY;
CREATE POLICY comentario_do_post ON "Comment"
  USING ("deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "postId"))
  WITH CHECK ("authorId" = mci_current_profile_id());

ALTER TABLE "Story" ENABLE ROW LEVEL SECURITY;
CREATE POLICY story_seguidor ON "Story"
  USING ("expiresAt" > now() AND ("authorId" = mci_current_profile_id() OR mci_follows("authorId")))
  WITH CHECK ("authorId" = mci_current_profile_id());

-- --------------------------------------------------------------- DOCUMENTOS
ALTER TABLE "AthleteDocument" ENABLE ROW LEVEL SECURITY;
CREATE POLICY documento_do_atleta ON "AthleteDocument"
  USING (EXISTS (
    SELECT 1 FROM "Athlete" a
    WHERE a.id = "athleteId"
      AND (a."userId" = mci_current_user_id() OR mci_operator_of(a."organizationId"))
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Athlete" a
    WHERE a.id = "athleteId"
      AND (a."userId" = mci_current_user_id() OR mci_operator_of(a."organizationId"))
  ));

-- ------------------------------------------------------------------- ATLETAS
-- O atleta é dado da organização: fora dela, só o próprio usuário se enxerga.
ALTER TABLE "Athlete" ENABLE ROW LEVEL SECURITY;
CREATE POLICY atleta_da_organizacao ON "Athlete"
  USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));

-- ---------------------------------------------------------------- RESULTADOS
-- Resultado não publicado é restrito: só operador da organização do evento.
ALTER TABLE "Result" ENABLE ROW LEVEL SECURITY;
CREATE POLICY resultado_publicado ON "Result"
  USING (
    status = 'PUBLISHED'
    OR EXISTS (SELECT 1 FROM "Event" e WHERE e.id = "eventId" AND mci_operator_of(e."organizationId"))
  )
  WITH CHECK (EXISTS (SELECT 1 FROM "Event" e WHERE e.id = "eventId" AND mci_operator_of(e."organizationId")));

ALTER TABLE "ResultEntry" ENABLE ROW LEVEL SECURITY;
CREATE POLICY entrada_do_resultado ON "ResultEntry"
  USING (EXISTS (SELECT 1 FROM "Result" r WHERE r.id = "resultId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Result" r WHERE r.id = "resultId"));

-- ----------------------------------------------------------- IMPORTAÇÃO/AUDIT
ALTER TABLE "MuscleWarImport" ENABLE ROW LEVEL SECURITY;
CREATE POLICY importacao_da_organizacao ON "MuscleWarImport"
  USING (mci_operator_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));

ALTER TABLE "MuscleWarImportItem" ENABLE ROW LEVEL SECURITY;
CREATE POLICY item_da_importacao ON "MuscleWarImportItem"
  USING (EXISTS (SELECT 1 FROM "MuscleWarImport" i WHERE i.id = "importId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "MuscleWarImport" i WHERE i.id = "importId"));

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
CREATE POLICY auditoria_restrita ON "AuditLog"
  USING (mci_is_platform_admin() OR ("organizationId" IS NOT NULL AND mci_operator_of("organizationId")))
  WITH CHECK (true);

-- --------------------------------------------------------------- NOTIFICAÇÕES
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
CREATE POLICY notificacao_do_dono ON "Notification"
  USING ("userId" = mci_current_user_id())
  WITH CHECK (true);
