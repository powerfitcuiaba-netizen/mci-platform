-- ============================================================================
-- A MENSAGEM DE ABERTURA DA FEDERAÇÃO AOS SEUS ATLETAS.
--
-- Não é notificação e não é post social. Notificação nasce de um evento que
-- aconteceu com UMA pessoa; post entra num feed que se rola e se esquece.
-- Isto é o contrário das duas: um recado da organização para TODOS os seus
-- atletas, que precisa ser visto ANTES de o atleta fazer qualquer outra coisa
-- — abertura de inscrição, mudança de regulamento, prazo de filiação.
--
-- MIGRATION ADITIVA. Duas tabelas novas, nenhuma coluna alterada, nenhum dado
-- tocado. Tudo com IF NOT EXISTS: rodar duas vezes não quebra, o que importa
-- porque `prisma migrate deploy` é o único passo do deploy em produção.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "AthleteNotice" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  -- A janela de validade. Nulo dos dois lados é "desde já e até segunda
  -- ordem", que é o caso comum e não deveria exigir preenchimento.
  "startsAt"       TIMESTAMP(3),
  "endsAt"         TIMESTAMP(3),
  -- Uma vez por pessoa, ou toda vez. O padrão é uma vez: repetir o mesmo
  -- aviso a cada acesso ensina o atleta a fechá-lo sem ler.
  "showOnce"       BOOLEAN NOT NULL DEFAULT true,
  -- Desativar não apaga: o recado já foi lido por gente, e a marcação de
  -- leitura é registro de que a comunicação chegou.
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AthleteNotice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AthleteNoticeRead" (
  "id"       TEXT NOT NULL,
  "noticeId" TEXT NOT NULL,
  "userId"   TEXT NOT NULL,
  "readAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AthleteNoticeRead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AthleteNotice_organizationId_active_idx"
  ON "AthleteNotice" ("organizationId", "active");

-- A UNICIDADE É A REGRA, e não uma otimização: sem ela, dois cliques no mesmo
-- instante gravariam duas leituras e `showOnce` continuaria funcionando por
-- acaso. Com ela, a segunda gravação é recusada pelo banco.
CREATE UNIQUE INDEX IF NOT EXISTS "AthleteNoticeRead_noticeId_userId_key"
  ON "AthleteNoticeRead" ("noticeId", "userId");
CREATE INDEX IF NOT EXISTS "AthleteNoticeRead_userId_idx"
  ON "AthleteNoticeRead" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AthleteNotice_organizationId_fkey') THEN
    ALTER TABLE "AthleteNotice" ADD CONSTRAINT "AthleteNotice_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AthleteNotice_createdById_fkey') THEN
    ALTER TABLE "AthleteNotice" ADD CONSTRAINT "AthleteNotice_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AthleteNoticeRead_noticeId_fkey') THEN
    ALTER TABLE "AthleteNoticeRead" ADD CONSTRAINT "AthleteNoticeRead_noticeId_fkey"
      FOREIGN KEY ("noticeId") REFERENCES "AthleteNotice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AthleteNoticeRead_userId_fkey') THEN
    ALTER TABLE "AthleteNoticeRead" ADD CONSTRAINT "AthleteNoticeRead_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ------------------------------------------------------------------- RLS
--
-- O RECADO É PARA OS ATLETAS DAQUELA FEDERAÇÃO, e para mais ninguém. Quem
-- opera a organização também o vê — é ele quem o escreve.
--
-- Precisa de um predicado que o conjunto de helpers ainda não tinha:
-- "sou atleta desta organização". `mci_member_of` não serve, porque atleta
-- não é membro da organização — ele tem CADASTRO nela, que é outra relação.

CREATE OR REPLACE FUNCTION mci_atleta_da_organizacao(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Athlete" a
    WHERE a."organizationId" = org_id
      AND a."userId" = mci_current_user_id()
  )
$$;

ALTER TABLE "AthleteNotice"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthleteNotice"     FORCE  ROW LEVEL SECURITY;
ALTER TABLE "AthleteNoticeRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthleteNoticeRead" FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aviso_leitura    ON "AthleteNotice";
DROP POLICY IF EXISTS aviso_criacao    ON "AthleteNotice";
DROP POLICY IF EXISTS aviso_alteracao  ON "AthleteNotice";
DROP POLICY IF EXISTS aviso_remocao    ON "AthleteNotice";

-- NÃO HÁ LEITURA ANÔNIMA. Um recado interno da federação aos seus atletas não
-- é vitrine — `mci_current_user_id() IS NULL` não aparece aqui de propósito.
CREATE POLICY aviso_leitura ON "AthleteNotice" FOR SELECT
  USING (mci_member_of("organizationId") OR mci_atleta_da_organizacao("organizationId"));

CREATE POLICY aviso_criacao ON "AthleteNotice" FOR INSERT
  WITH CHECK (mci_operator_of("organizationId"));

CREATE POLICY aviso_alteracao ON "AthleteNotice" FOR UPDATE
  USING (mci_operator_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));

CREATE POLICY aviso_remocao ON "AthleteNotice" FOR DELETE
  USING (mci_operator_of("organizationId"));

DROP POLICY IF EXISTS leitura_do_aviso_leitura   ON "AthleteNoticeRead";
DROP POLICY IF EXISTS leitura_do_aviso_criacao   ON "AthleteNoticeRead";

-- A MARCAÇÃO DE LEITURA É DE QUEM LEU. O operador da organização também a vê,
-- porque "quem foi avisado" é justamente o que ele precisa saber — mas ele
-- não pode criá-la no lugar de ninguém: `WITH CHECK` exige que o usuário da
-- linha seja o usuário da sessão. Marcar leitura por outra pessoa seria
-- fabricar prova de que ela foi comunicada.
CREATE POLICY leitura_do_aviso_leitura ON "AthleteNoticeRead" FOR SELECT
  USING (
    "userId" = mci_current_user_id()
    OR EXISTS (
      SELECT 1 FROM "AthleteNotice" n
      WHERE n.id = "AthleteNoticeRead"."noticeId"
        AND mci_operator_of(n."organizationId")
    )
  );

CREATE POLICY leitura_do_aviso_criacao ON "AthleteNoticeRead" FOR INSERT
  WITH CHECK ("userId" = mci_current_user_id());

-- Sem política de UPDATE nem de DELETE: a leitura aconteceu ou não aconteceu.
-- Ausência de política é negação — não é esquecimento.
