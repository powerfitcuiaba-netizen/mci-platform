-- ============================================================================
-- O autor enxerga o próprio conteúdo mesmo depois de ele sair do ar.
--
-- Terceiro caso da mesma família de problemas que o FORCE trouxe à tona: o
-- Prisma emite UPDATE ... RETURNING, e o RETURNING é submetido à política de
-- SELECT — aplicada à linha JÁ ALTERADA. Quando a alteração é justamente a que
-- tira a linha de circulação, a leitura de volta falha e a operação inteira
-- morre com "new row violates row-level security policy":
--
--   * expirar um story  → "expiresAt" deixa de ser futuro
--   * autor apagar um post (soft delete) → "deletedAt" deixa de ser nulo
--
-- A correção é dizer o que já era verdade: conteúdo próprio é do autor,
-- vencido ou apagado. Ele deixa de aparecer para os OUTROS, que é o efeito
-- pretendido; nunca deixou de ser dele.
--
-- Isso não amplia acesso de ninguém: os predicados de terceiro seguem
-- exatamente como estavam, e quem filtra story vencido e post apagado das
-- listagens é o service, com teste cobrindo.
-- ============================================================================

-- --------------------------------------------------------------------- POST
DROP POLICY IF EXISTS post_leitura ON "Post";

CREATE POLICY post_leitura ON "Post" FOR SELECT
  USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR ("deletedAt" IS NULL AND (
      visibility = 'PUBLIC'
      OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
    ))
  );

DROP POLICY IF EXISTS post_alteracao ON "Post";

CREATE POLICY post_alteracao ON "Post" FOR UPDATE
  USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR ("deletedAt" IS NULL AND (
      visibility = 'PUBLIC'
      OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
    ))
  )
  WITH CHECK (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR visibility = 'PUBLIC'
    OR (visibility = 'FOLLOWERS' AND mci_follows("authorId"))
  );

-- -------------------------------------------------------------------- STORY
DROP POLICY IF EXISTS story_seguidor ON "Story";

CREATE POLICY story_seguidor ON "Story"
  USING (
    "authorId" = mci_current_profile_id()
    OR ("expiresAt" > now() AND mci_follows("authorId"))
  )
  WITH CHECK ("authorId" = mci_current_profile_id());
