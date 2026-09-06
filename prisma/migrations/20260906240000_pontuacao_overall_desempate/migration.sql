-- ============================================================================
-- Motor oficial de pontuação, Overall e desempate.
--
-- Nada é destrutivo: só colunas novas com valor padrão e uma tabela nova. A
-- tabela de pontos por colocação já existia (RankingPointsRule, por temporada)
-- e continua sendo a fonte — os valores homologados entram como DADO, não como
-- constante de código, para que a tabela oficial possa substituí-los sem
-- alteração de programa.
-- ============================================================================

-- ------------------------------------------------------------- RankingPoint
-- Decomposição do ponto, para que o total seja reconstituível:
--   points = placementPoints + overallBonus
ALTER TABLE "RankingPoint" ADD COLUMN "placementPoints"   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RankingPoint" ADD COLUMN "overallBonus"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RankingPoint" ADD COLUMN "isOverallChampion" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RankingPoint" ADD COLUMN "teamId"            TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN "classId"           TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN "resultVersion"     INTEGER;
ALTER TABLE "RankingPoint" ADD COLUMN "awardedById"       TEXT;

-- Linhas anteriores à decomposição: o total já era só colocação.
UPDATE "RankingPoint" SET "placementPoints" = "points" WHERE "placementPoints" = 0 AND "points" <> 0;

ALTER TABLE "RankingPoint" ADD CONSTRAINT "RankingPoint_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RankingPoint" ADD CONSTRAINT "RankingPoint_classId_fkey"
  FOREIGN KEY ("classId") REFERENCES "CompetitionClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RankingPoint" ADD CONSTRAINT "RankingPoint_awardedById_fkey"
  FOREIGN KEY ("awardedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "RankingPoint_seasonId_teamId_idx" ON "RankingPoint" ("seasonId", "teamId");

-- ------------------------------------------------------------------ Ranking
-- Contadores de desempate materializados: a ordenação depende deles, e sem
-- eles o ranking não é auditável nem reordenável.
ALTER TABLE "Ranking" ADD COLUMN "overallWins"      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "firstPlaceCount"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "secondPlaceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "thirdPlaceCount"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "fourthPlaceCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "fifthPlaceCount"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Ranking" ADD COLUMN "tieUnresolved"    BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------- EventOverallTitle
-- O título é REGISTRADO pela organização, não calculado: o critério de
-- determinação do campeão Overall não foi homologado, e calculá-lo por conta
-- própria seria inventar regulamento. O bônus e o peso no desempate, esses
-- sim, estão homologados.
CREATE TABLE "EventOverallTitle" (
  "id"           TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "athleteId"    TEXT NOT NULL,
  "categoryId"   TEXT,
  "note"         TEXT,
  "declaredById" TEXT,
  "declaredAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventOverallTitle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventOverallTitle_eventId_categoryId_key"
  ON "EventOverallTitle" ("eventId", "categoryId");
CREATE INDEX "EventOverallTitle_athleteId_idx" ON "EventOverallTitle" ("athleteId");

ALTER TABLE "EventOverallTitle" ADD CONSTRAINT "EventOverallTitle_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventOverallTitle" ADD CONSTRAINT "EventOverallTitle_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventOverallTitle" ADD CONSTRAINT "EventOverallTitle_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EventOverallTitle" ADD CONSTRAINT "EventOverallTitle_declaredById_fkey"
  FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- O título aponta para o atleta e para o evento, ambos já protegidos. A leitura
-- segue a organização do evento; a escrita, o operador dela.
ALTER TABLE "EventOverallTitle" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventOverallTitle" FORCE ROW LEVEL SECURITY;

-- Título de campeão é resultado publicado por natureza: quem vê o evento vê o
-- campeão. A escrita é que fica restrita ao operador da organização.
CREATE POLICY overall_leitura ON "EventOverallTitle" FOR SELECT USING (true);

CREATE POLICY overall_escrita ON "EventOverallTitle" FOR ALL
  USING (EXISTS (SELECT 1 FROM "Event" e WHERE e.id = "eventId" AND mci_operator_of(e."organizationId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Event" e WHERE e.id = "eventId" AND mci_operator_of(e."organizationId")));
