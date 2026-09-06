-- ============================================================================
-- FORCE ROW LEVEL SECURITY
--
-- ENABLE ROW LEVEL SECURITY não vale para o DONO da tabela: o PostgreSQL o
-- isenta das políticas por padrão. Como as migrations rodam com o usuário
-- dono do schema, e a aplicação pode conectar com esse mesmo usuário, as
-- políticas criadas na migration anterior não estavam sendo aplicadas ao
-- caminho real da aplicação — a política negava e o dono lia assim mesmo.
--
-- FORCE remove essa isenção. A partir daqui, o dono também é filtrado, e a
-- única forma de ler dado restrito é ter o ator correto definido em
-- `mci.user_id` (ver src/config/rlsSession.js).
--
-- Nenhuma política é criada, alterada ou removida aqui. Nenhuma tabela é
-- recriada. A alteração é apenas do atributo relforcerowsecurity.
-- ============================================================================

ALTER TABLE "Conversation"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConversationMember"  FORCE ROW LEVEL SECURITY;
ALTER TABLE "Message"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "MessageReaction"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "Post"                FORCE ROW LEVEL SECURITY;
ALTER TABLE "PostMedia"           FORCE ROW LEVEL SECURITY;
ALTER TABLE "Comment"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "Story"               FORCE ROW LEVEL SECURITY;
ALTER TABLE "AthleteDocument"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "Athlete"             FORCE ROW LEVEL SECURITY;
ALTER TABLE "Result"              FORCE ROW LEVEL SECURITY;
ALTER TABLE "ResultEntry"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "MuscleWarImport"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "MuscleWarImportItem" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog"            FORCE ROW LEVEL SECURITY;
ALTER TABLE "Notification"        FORCE ROW LEVEL SECURITY;
