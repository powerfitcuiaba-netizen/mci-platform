-- ============================================================================
-- Políticas separadas por comando em Post e Comment.
--
-- Com FORCE ligado, as políticas passaram a valer para o caminho real da
-- aplicação e revelaram um conflito de design que estava escondido: as
-- publicações carregam contadores desnormalizados (likeCount, commentCount,
-- shareCount) que são incrementados por OUTROS usuários — quem curte, quem
-- comenta, quem compartilha. A política única exigia, em toda escrita, que o
-- ator fosse o autor da publicação. Resultado: curtir a publicação de alguém
-- ficava impossível, porque o incremento do contador era barrado.
--
-- A solução não é afrouxar a escrita: é dizer com precisão o que cada comando
-- pode fazer.
--
--   SELECT  regra de visibilidade (pública, própria ou de seguidores)
--   INSERT  só o próprio autor cria em seu nome
--   UPDATE  quem enxerga a publicação pode alterá-la, e a linha resultante
--           precisa continuar visível a ele — é o que permite o contador e o
--           soft delete sem permitir sequestrar a autoria
--   DELETE  só o autor ou a moderação
--
-- O `deletedAt IS NULL` sai do WITH CHECK de UPDATE de propósito: com ele, o
-- soft delete seria barrado por invalidar a própria linha que acabou de
-- escrever.
--
-- Nota importante sobre a proteção do conteúdo: o RLS aqui não distingue
-- coluna, então "quem vê pode escrever" inclui o texto. Quem impede um
-- terceiro de editar texto alheio continua sendo o service, que já checa
-- autoria — e há teste cobrindo isso. Restringir por coluna no banco depende
-- de GRANT de coluna para o papel `mci_app`, que só tem efeito quando a
-- aplicação conecta como ele (ver docs/DEPLOY.md).
-- ============================================================================

-- Moderação da plataforma: papéis que carregam social.moderate no RBAC.
CREATE OR REPLACE FUNCTION mci_is_moderator() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = mci_current_user_id()
      AND u.role IN ('SUPER_ADMIN', 'ADMIN', 'MODERATOR')
      AND u.status = 'ACTIVE'
  )
$$;

-- ---------------------------------------------------------------------- POST
DROP POLICY IF EXISTS post_visibilidade ON "Post";

CREATE POLICY post_leitura ON "Post" FOR SELECT
  USING (
    mci_is_moderator()
    OR ("deletedAt" IS NULL AND (
      visibility = 'PUBLIC'
      OR "authorId" = mci_current_profile_id()
      OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
    ))
  );

CREATE POLICY post_criacao ON "Post" FOR INSERT
  WITH CHECK ("authorId" = mci_current_profile_id());

CREATE POLICY post_alteracao ON "Post" FOR UPDATE
  USING (
    mci_is_moderator()
    OR ("deletedAt" IS NULL AND (
      visibility = 'PUBLIC'
      OR "authorId" = mci_current_profile_id()
      OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
    ))
  )
  WITH CHECK (
    mci_is_moderator()
    OR visibility = 'PUBLIC'
    OR "authorId" = mci_current_profile_id()
    OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
  );

CREATE POLICY post_remocao ON "Post" FOR DELETE
  USING ("authorId" = mci_current_profile_id() OR mci_is_moderator());

-- ------------------------------------------------------------------ COMMENT
DROP POLICY IF EXISTS comentario_do_post ON "Comment";

CREATE POLICY comentario_leitura ON "Comment" FOR SELECT
  USING ("deletedAt" IS NULL AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "postId"));

CREATE POLICY comentario_criacao ON "Comment" FOR INSERT
  WITH CHECK ("authorId" = mci_current_profile_id());

CREATE POLICY comentario_alteracao ON "Comment" FOR UPDATE
  USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "postId" AND p."authorId" = mci_current_profile_id())
  )
  WITH CHECK (true);

CREATE POLICY comentario_remocao ON "Comment" FOR DELETE
  USING ("authorId" = mci_current_profile_id() OR mci_is_moderator());
