-- AJUSTE ADMINISTRATIVO DE PONTUAÇÃO.
--
-- A homologação às vezes corrige a pontuação de uma participação sem que a
-- COLOCAÇÃO tenha mudado. Até aqui só existia a correção de colocação, que
-- recalcula os pontos pelo motor — e é a ferramenta certa quando o erro está
-- na colocação, mas não quando está no ponto.
--
-- A TERCEIRA PARCELA, E POR QUE NÃO ESCREVER DIRETO EM `points`
--
-- O ledger mantém `points = placementPoints + overallBonus`, e essa
-- decomposição é o que torna o total reconstituível — o que torna o ledger
-- auditável. Escrever o novo total direto em `points` quebraria a conta e
-- apagaria a informação de que houve intervenção humana.
--
-- `adjustmentPoints` entra como terceira parcela:
--
--   points = placementPoints + overallBonus + adjustmentPoints
--
-- Zero enquanto ninguém ajusta. Explícito quando alguém ajusta. E preservado
-- quando a colocação for corrigida depois: o motor recalcula as duas
-- primeiras parcelas e conserva esta.
--
-- NÃO DESTRUTIVA: uma coluna nova com DEFAULT 0 e uma tabela nova. Nenhuma
-- linha existente é reescrita — as que existem passam a ter ajuste zero, que
-- é exatamente o que elas sempre tiveram.
--
-- IDEMPOTENTE: IF NOT EXISTS em tudo.

ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "adjustmentPoints" INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------- o histórico dos ajustes
--
-- Uma linha por intervenção: de quanto para quanto, por quê e por quem.
-- `voidedAt` desfaz um ajuste sem apagá-lo — história de campeonato não se
-- remove, se invalida.

CREATE TABLE IF NOT EXISTS "RankingPointAdjustment" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "rankingPointId" TEXT NOT NULL,
  "previousPoints" INTEGER NOT NULL,
  "newPoints"      INTEGER NOT NULL,
  "reason"         TEXT NOT NULL,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt"       TIMESTAMP(3),
  "voidedById"     TEXT,
  "voidReason"     TEXT,
  CONSTRAINT "RankingPointAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RankingPointAdjustment_rankingPointId_createdAt_idx"
  ON "RankingPointAdjustment" ("rankingPointId", "createdAt");
CREATE INDEX IF NOT EXISTS "RankingPointAdjustment_organizationId_createdAt_idx"
  ON "RankingPointAdjustment" ("organizationId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RankingPointAdjustment_organizationId_fkey') THEN
    ALTER TABLE "RankingPointAdjustment" ADD CONSTRAINT "RankingPointAdjustment_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RankingPointAdjustment_rankingPointId_fkey') THEN
    ALTER TABLE "RankingPointAdjustment" ADD CONSTRAINT "RankingPointAdjustment_rankingPointId_fkey"
      FOREIGN KEY ("rankingPointId") REFERENCES "RankingPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RankingPointAdjustment_createdById_fkey') THEN
    ALTER TABLE "RankingPointAdjustment" ADD CONSTRAINT "RankingPointAdjustment_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RankingPointAdjustment_voidedById_fkey') THEN
    ALTER TABLE "RankingPointAdjustment" ADD CONSTRAINT "RankingPointAdjustment_voidedById_fkey"
      FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ------------------------------------------------------------------- RLS
--
-- A MESMA POLÍTICA DO LANÇAMENTO QUE ELA AJUSTA, e FORCE junto: sem FORCE o
-- dono das tabelas fica isento, e o `rlsGuard` recusa a partida da aplicação
-- ao encontrar uma tabela nesse estado.
--
-- Não há política de leitura pública: quem alterou a pontuação de quem é
-- informação de operação, não de torcida.

ALTER TABLE "RankingPointAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankingPointAdjustment" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ajuste_leitura   ON "RankingPointAdjustment";
DROP POLICY IF EXISTS ajuste_criacao   ON "RankingPointAdjustment";
DROP POLICY IF EXISTS ajuste_alteracao ON "RankingPointAdjustment";

CREATE POLICY ajuste_leitura   ON "RankingPointAdjustment" FOR SELECT USING (mci_operator_of("organizationId"));
CREATE POLICY ajuste_criacao   ON "RankingPointAdjustment" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY ajuste_alteracao ON "RankingPointAdjustment" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));

-- Sem política de DELETE, de propósito: ajuste se INVALIDA (`voidedAt`), não
-- se apaga. Ausência de política é negação — não é esquecimento.
