-- ============================================================================
-- HISTÓRICO OFICIAL ANTES DO CADASTRO DO ATLETA
--
-- O MCI carrega primeiro o histórico dos campeonatos antigos; os atletas se
-- cadastram depois. Até aqui isso era impossível por construção:
-- `ExternalResult.athleteId` e `RankingPoint.athleteId` eram NOT NULL, e não
-- havia como guardar um resultado sem ter um cadastro para pendurá-lo.
--
-- O QUE ESTA MIGRATION FAZ, E POR QUE NESTA ORDEM
--
-- 1. cria `ExternalAthlete`, a identidade esportiva externa — quem competiu
--    segundo a FONTE, que é fato do campeonato, separado de quem é o usuário
--    do MCI, que é fato do cadastro;
-- 2. cria `PublicRankingEntry`, a projeção pública do ledger;
-- 3. dá a `ExternalResult`, `RankingPoint` e `Ranking` uma coluna
--    `organizationId` PRÓPRIA, com backfill a partir do atleta que elas já
--    tinham;
-- 4. só então afrouxa `athleteId` para nulável;
-- 5. e por último liga RLS nas cinco tabelas.
--
-- A ORDEM É A SEGURANÇA. O isolamento de tenant dessas tabelas NUNCA foi
-- declarado: ele era DERIVADO de `athleteId` ser obrigatório — toda linha
-- pertencia a um atleta, todo atleta a uma organização. Afrouxar a coluna
-- antes de existir `organizationId` preenchido abriria, ainda que por um
-- comando, a possibilidade de linha sem dono. Por isso a coluna nova nasce,
-- é preenchida e vira NOT NULL ANTES de a antiga deixar de ser obrigatória.
--
-- NENHUM DADO É APAGADO. Sem DROP de tabela, sem TRUNCATE, sem DELETE. As
-- únicas remoções são de CONSTRAINT e de índice, substituídos na mesma
-- transação.
--
-- MUDANÇA DE COMPORTAMENTO DELIBERADA: as FK de `athleteId` em
-- `ExternalResult` e `RankingPoint` deixam de ser ON DELETE CASCADE e passam a
-- ON DELETE SET NULL. Apagar um cadastro deixava de existir o histórico dele;
-- agora o histórico SOBREVIVE, desvinculado, que é o comportamento coerente
-- com um resultado que existia antes do cadastro e continua existindo depois
-- dele. `Ranking` segue em CASCADE porque é agregado descartável, refeito a
-- cada recálculo.
-- ============================================================================

-- ---------------------------------------------------------------- 1. IDENTIDADE
CREATE TABLE "ExternalAthlete" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL,
  "source"            TEXT NOT NULL DEFAULT 'MUSCLEWAR',
  "identityKey"       TEXT NOT NULL,
  "affiliationId"     TEXT,
  "affiliationNumber" TEXT,
  "displayName"       TEXT NOT NULL,
  "athleteId"         TEXT,
  "linkedAt"          TIMESTAMP(3),
  "linkedById"        TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalAthlete_pkey" PRIMARY KEY ("id")
);

-- A chave TOTAL. `organizationId + affiliationId + affiliationNumber` é a
-- identidade homologada, mas UNIQUE com coluna nula não deduplica nada no
-- PostgreSQL — NULOS são distintos entre si. `identityKey` carrega as duas
-- formas ('AFF:<filiação>:<matrícula>' e 'EXT:<origem>:<id externo>') numa
-- coluna NOT NULL, e é aí que a unicidade morde.
CREATE UNIQUE INDEX "ExternalAthlete_organizationId_identityKey_key"
  ON "ExternalAthlete"("organizationId", "identityKey");
CREATE INDEX "ExternalAthlete_organizationId_athleteId_idx"
  ON "ExternalAthlete"("organizationId", "athleteId");
CREATE INDEX "ExternalAthlete_affiliationId_affiliationNumber_idx"
  ON "ExternalAthlete"("affiliationId", "affiliationNumber");

-- E a regra de negócio, escrita onde ela é verdadeira: filiação + matrícula
-- identificam UMA pessoa dentro da organização. Índice PARCIAL porque a regra
-- só vale quando as duas existem.
CREATE UNIQUE INDEX "ExternalAthlete_org_afiliacao_matricula_key"
  ON "ExternalAthlete"("organizationId", "affiliationId", "affiliationNumber")
  WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL;

ALTER TABLE "ExternalAthlete"
  ADD CONSTRAINT "ExternalAthlete_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalAthlete_affiliationId_fkey"
  FOREIGN KEY ("affiliationId") REFERENCES "Affiliation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalAthlete_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalAthlete_linkedById_fkey"
  FOREIGN KEY ("linkedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ------------------------------------------------------- 2. PROJEÇÃO PÚBLICA
CREATE TABLE "PublicRankingEntry" (
  "id"                   TEXT NOT NULL,
  "seasonId"             TEXT NOT NULL,
  "organizationId"       TEXT NOT NULL,
  "competitorKey"        TEXT NOT NULL,
  "athleteId"            TEXT,
  "externalAthleteId"    TEXT,
  "displayName"          TEXT,
  "categoryId"           TEXT,
  "eventId"              TEXT,
  "classId"              TEXT,
  "teamId"               TEXT,
  "companyId"            TEXT,
  "placing"              INTEGER,
  "points"               INTEGER NOT NULL DEFAULT 0,
  "superOverallPoints"   INTEGER NOT NULL DEFAULT 0,
  "superOverallEligible" BOOLEAN NOT NULL DEFAULT false,
  "isOverallChampion"    BOOLEAN NOT NULL DEFAULT false,
  "didNotShow"           BOOLEAN NOT NULL DEFAULT false,
  "voided"               BOOLEAN NOT NULL DEFAULT false,
  "sourceKey"            TEXT NOT NULL,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PublicRankingEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PublicRankingEntry_seasonId_categoryId_idx" ON "PublicRankingEntry"("seasonId", "categoryId");
CREATE INDEX "PublicRankingEntry_seasonId_eventId_idx" ON "PublicRankingEntry"("seasonId", "eventId");
CREATE INDEX "PublicRankingEntry_seasonId_classId_idx" ON "PublicRankingEntry"("seasonId", "classId");
CREATE INDEX "PublicRankingEntry_seasonId_teamId_idx" ON "PublicRankingEntry"("seasonId", "teamId");
CREATE INDEX "PublicRankingEntry_seasonId_companyId_idx" ON "PublicRankingEntry"("seasonId", "companyId");
CREATE INDEX "PublicRankingEntry_seasonId_superOverallEligible_idx" ON "PublicRankingEntry"("seasonId", "superOverallEligible");
CREATE INDEX "PublicRankingEntry_organizationId_idx" ON "PublicRankingEntry"("organizationId");

ALTER TABLE "PublicRankingEntry"
  ADD CONSTRAINT "PublicRankingEntry_seasonId_fkey"
  FOREIGN KEY ("seasonId") REFERENCES "RankingSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------- 3. ExternalResult: tenancy
ALTER TABLE "ExternalResult" ADD COLUMN "organizationId"    TEXT;
ALTER TABLE "ExternalResult" ADD COLUMN "externalAthleteId" TEXT;

-- Uma identidade externa para cada resultado que já existe. A chave sai do
-- atleta que a linha já apontava: quando ele tem filiação E matrícula, a forma
-- AFF — que deduplica e é alcançável pelo vínculo tardio. Quando não tem, a
-- forma EXT, que dá casa e organização à linha sem fingir uma identidade que o
-- cadastro nunca declarou.
INSERT INTO "ExternalAthlete" (
  "id", "organizationId", "source", "identityKey",
  "affiliationId", "affiliationNumber", "displayName", "athleteId", "linkedAt"
)
SELECT DISTINCT ON (a."organizationId", chave.k)
  gen_random_uuid()::text,
  a."organizationId",
  er."source",
  chave.k,
  CASE WHEN a."affiliationId" IS NOT NULL AND a."affiliationNumber" IS NOT NULL
       THEN a."affiliationId" END,
  CASE WHEN a."affiliationId" IS NOT NULL AND a."affiliationNumber" IS NOT NULL
       THEN a."affiliationNumber" END,
  a."fullName",
  a."id",
  CURRENT_TIMESTAMP
FROM "ExternalResult" er
JOIN "Athlete" a ON a."id" = er."athleteId"
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN a."affiliationId" IS NOT NULL AND a."affiliationNumber" IS NOT NULL
      THEN 'AFF:' || a."affiliationId" || ':' || a."affiliationNumber"
    ELSE 'EXT:' || er."source" || ':' || er."externalId"
  END AS k
) chave
ORDER BY a."organizationId", chave.k, er."createdAt" ASC;

UPDATE "ExternalResult" er
SET "organizationId" = a."organizationId",
    "externalAthleteId" = ea."id"
FROM "Athlete" a
JOIN "ExternalAthlete" ea ON ea."organizationId" = a."organizationId"
WHERE a."id" = er."athleteId"
  AND ea."identityKey" = CASE
    WHEN a."affiliationId" IS NOT NULL AND a."affiliationNumber" IS NOT NULL
      THEN 'AFF:' || a."affiliationId" || ':' || a."affiliationNumber"
    ELSE 'EXT:' || er."source" || ':' || er."externalId"
  END;

-- A conferência é do banco, não da leitura de quem aplicou: se alguma linha
-- ficou sem dona, a migration PARA aqui em vez de seguir e ligar RLS sobre
-- dado órfão.
DO $$
DECLARE orfas INTEGER;
BEGIN
  SELECT COUNT(*) INTO orfas FROM "ExternalResult"
   WHERE "organizationId" IS NULL OR "externalAthleteId" IS NULL;
  IF orfas > 0 THEN
    RAISE EXCEPTION 'backfill de ExternalResult incompleto: % linha(s) sem organização ou identidade externa', orfas;
  END IF;
END $$;

ALTER TABLE "ExternalResult" ALTER COLUMN "organizationId"    SET NOT NULL;
ALTER TABLE "ExternalResult" ALTER COLUMN "externalAthleteId" SET NOT NULL;
ALTER TABLE "ExternalResult" ALTER COLUMN "athleteId"         DROP NOT NULL;

ALTER TABLE "ExternalResult" DROP CONSTRAINT "ExternalResult_athleteId_fkey";
ALTER TABLE "ExternalResult"
  ADD CONSTRAINT "ExternalResult_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalResult_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ExternalResult_externalAthleteId_fkey"
  FOREIGN KEY ("externalAthleteId") REFERENCES "ExternalAthlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "ExternalResult_organizationId_idx"    ON "ExternalResult"("organizationId");
CREATE INDEX "ExternalResult_externalAthleteId_idx" ON "ExternalResult"("externalAthleteId");

-- -------------------------------------------------- 4. RankingPoint: tenancy
ALTER TABLE "RankingPoint" ADD COLUMN "organizationId"    TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN "externalAthleteId" TEXT;

-- A organização sai do atleta, que hoje é obrigatório em toda linha.
UPDATE "RankingPoint" rp
SET "organizationId" = a."organizationId"
FROM "Athlete" a
WHERE a."id" = rp."athleteId";

-- A identidade externa só existe para o que veio de importação: o caminho
-- interno (`source: 'EVENT'`) nasce de julgamento no MCI e não tem identidade
-- em fonte externa nenhuma. Fica NULA ali, de propósito.
UPDATE "RankingPoint" rp
SET "externalAthleteId" = er."externalAthleteId"
FROM "ExternalResult" er
WHERE er."id" = rp."externalResultId";

DO $$
DECLARE orfas INTEGER;
BEGIN
  SELECT COUNT(*) INTO orfas FROM "RankingPoint" WHERE "organizationId" IS NULL;
  IF orfas > 0 THEN
    RAISE EXCEPTION 'backfill de RankingPoint incompleto: % lançamento(s) sem organização', orfas;
  END IF;
END $$;

ALTER TABLE "RankingPoint" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "RankingPoint" ALTER COLUMN "athleteId"      DROP NOT NULL;

-- O INVARIANTE DE VERDADE: todo lançamento tem um competidor. Ele não cabia
-- numa coluna NOT NULL porque as duas formas de competidor são legítimas e
-- mutuamente exclusivas por origem — cadastro do MCI no caminho interno,
-- identidade externa no importado. Cabe numa CHECK.
ALTER TABLE "RankingPoint"
  ADD CONSTRAINT "RankingPoint_competidor_presente"
  CHECK ("athleteId" IS NOT NULL OR "externalAthleteId" IS NOT NULL);

ALTER TABLE "RankingPoint" DROP CONSTRAINT "RankingPoint_athleteId_fkey";
ALTER TABLE "RankingPoint"
  ADD CONSTRAINT "RankingPoint_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "RankingPoint_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RankingPoint_externalAthleteId_fkey"
  FOREIGN KEY ("externalAthleteId") REFERENCES "ExternalAthlete"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "RankingPoint_organizationId_idx"              ON "RankingPoint"("organizationId");
CREATE INDEX "RankingPoint_seasonId_externalAthleteId_idx"  ON "RankingPoint"("seasonId", "externalAthleteId");

-- ------------------------------------------------------- 5. Ranking: tenancy
ALTER TABLE "Ranking" ADD COLUMN "organizationId"    TEXT;
ALTER TABLE "Ranking" ADD COLUMN "externalAthleteId" TEXT;
ALTER TABLE "Ranking" ADD COLUMN "competitorKey"     TEXT;
ALTER TABLE "Ranking" ADD COLUMN "displayName"       TEXT;

UPDATE "Ranking" r
SET "organizationId" = a."organizationId",
    "competitorKey"  = r."athleteId"
FROM "Athlete" a
WHERE a."id" = r."athleteId";

DO $$
DECLARE orfas INTEGER;
BEGIN
  SELECT COUNT(*) INTO orfas FROM "Ranking"
   WHERE "organizationId" IS NULL OR "competitorKey" IS NULL;
  IF orfas > 0 THEN
    RAISE EXCEPTION 'backfill de Ranking incompleto: % linha(s) sem organização ou competidor', orfas;
  END IF;
END $$;

ALTER TABLE "Ranking" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Ranking" ALTER COLUMN "competitorKey"  SET NOT NULL;
ALTER TABLE "Ranking" ALTER COLUMN "athleteId"      DROP NOT NULL;

ALTER TABLE "Ranking"
  ADD CONSTRAINT "Ranking_competidor_presente"
  CHECK ("athleteId" IS NOT NULL OR "externalAthleteId" IS NOT NULL);

-- A unicidade passa a ser pelo COMPETIDOR. Com duas colunas nuláveis no lugar
-- dela, o PostgreSQL trataria NULOS como distintos e a chave deixaria passar
-- duplicata exatamente no caso novo — o competidor sem cadastro.
DROP INDEX IF EXISTS "Ranking_seasonId_athleteId_categoryId_key";
ALTER TABLE "Ranking" DROP CONSTRAINT IF EXISTS "Ranking_seasonId_athleteId_categoryId_key";
CREATE UNIQUE INDEX "Ranking_seasonId_competitorKey_categoryId_key"
  ON "Ranking"("seasonId", "competitorKey", "categoryId");
CREATE INDEX "Ranking_organizationId_idx" ON "Ranking"("organizationId");

ALTER TABLE "Ranking"
  ADD CONSTRAINT "Ranking_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Ranking_externalAthleteId_fkey"
  FOREIGN KEY ("externalAthleteId") REFERENCES "ExternalAthlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------ 6. Preencher a projeção pública do que existe
--
-- Sem isto o ranking público ficaria VAZIO entre esta migration e o próximo
-- recálculo de cada temporada — e recálculo só acontece quando alguém aplica,
-- invalida ou corrige alguma coisa. Uma federação sem movimento ficaria fora
-- do ar por tempo indeterminado, sem erro nenhum aparecendo.
INSERT INTO "PublicRankingEntry" (
  "id", "seasonId", "organizationId", "competitorKey", "athleteId", "externalAthleteId",
  "displayName", "categoryId", "eventId", "classId", "teamId", "companyId",
  "placing", "points", "superOverallPoints", "superOverallEligible",
  "isOverallChampion", "didNotShow", "voided", "sourceKey"
)
SELECT
  rp."id", rp."seasonId", rp."organizationId",
  COALESCE(rp."athleteId", 'X:' || rp."externalAthleteId"),
  rp."athleteId", rp."externalAthleteId",
  ea."displayName",
  rp."categoryId", rp."eventId", rp."classId", rp."teamId", rp."companyId",
  rp."placing", rp."points", rp."superOverallPoints", rp."superOverallEligible",
  rp."isOverallChampion", rp."didNotShow", rp."voidedAt" IS NOT NULL,
  COALESCE(rp."eventId", rp."externalResultId", 'externo')
FROM "RankingPoint" rp
LEFT JOIN "ExternalAthlete" ea ON ea."id" = rp."externalAthleteId";

-- --------------------------------------------------------------------- 7. RLS
--
-- Até aqui estas tabelas NÃO tinham política nenhuma. O isolamento delas era
-- derivado de `athleteId` ser obrigatório — e é justamente essa dedução que a
-- parte 3 desfaz. A proteção passa a ser declarada.
--
-- LEDGER E IDENTIDADE: só operador da organização. Nem anônimo, nem atleta,
-- nem operador de outra federação. `mci_operator_of` já inclui o administrador
-- de plataforma.
--
-- PUBLICAÇÃO (`Ranking`, `PublicRankingEntry`): leitura também para quem não é
-- operador, mas NUNCA de forma global — a linha precisa pertencer a uma
-- temporada de uma organização ATIVA, conferido por `mci_ranking_publicado`.
-- Federação desativada sai do ar junto. Escrita continua sendo só de operador,
-- que é o que impede injeção de linha na superfície pública.

CREATE OR REPLACE FUNCTION mci_ranking_publicado(season_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "RankingSeason" s
    JOIN "Organization" o ON o."id" = s."organizationId"
    WHERE s."id" = season_id AND o."active"
  )
$$;

-- ExternalAthlete
ALTER TABLE "ExternalAthlete" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalAthlete" FORCE ROW LEVEL SECURITY;
CREATE POLICY identidade_externa_leitura   ON "ExternalAthlete" FOR SELECT USING (mci_operator_of("organizationId"));
CREATE POLICY identidade_externa_criacao   ON "ExternalAthlete" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY identidade_externa_alteracao ON "ExternalAthlete" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY identidade_externa_remocao   ON "ExternalAthlete" FOR DELETE USING (mci_operator_of("organizationId"));

-- ExternalResult
ALTER TABLE "ExternalResult" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalResult" FORCE ROW LEVEL SECURITY;
CREATE POLICY resultado_externo_leitura   ON "ExternalResult" FOR SELECT USING (mci_operator_of("organizationId"));
CREATE POLICY resultado_externo_criacao   ON "ExternalResult" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY resultado_externo_alteracao ON "ExternalResult" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY resultado_externo_remocao   ON "ExternalResult" FOR DELETE USING (mci_operator_of("organizationId"));

-- RankingPoint
ALTER TABLE "RankingPoint" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankingPoint" FORCE ROW LEVEL SECURITY;
CREATE POLICY lancamento_leitura   ON "RankingPoint" FOR SELECT USING (mci_operator_of("organizationId"));
CREATE POLICY lancamento_criacao   ON "RankingPoint" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY lancamento_alteracao ON "RankingPoint" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY lancamento_remocao   ON "RankingPoint" FOR DELETE USING (mci_operator_of("organizationId"));

-- Ranking (agregado publicado)
ALTER TABLE "Ranking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Ranking" FORCE ROW LEVEL SECURITY;
CREATE POLICY ranking_leitura   ON "Ranking" FOR SELECT USING (mci_operator_of("organizationId") OR mci_ranking_publicado("seasonId"));
CREATE POLICY ranking_criacao   ON "Ranking" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY ranking_alteracao ON "Ranking" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY ranking_remocao   ON "Ranking" FOR DELETE USING (mci_operator_of("organizationId"));

-- PublicRankingEntry (projeção publicada)
ALTER TABLE "PublicRankingEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PublicRankingEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY projecao_leitura   ON "PublicRankingEntry" FOR SELECT USING (mci_operator_of("organizationId") OR mci_ranking_publicado("seasonId"));
CREATE POLICY projecao_criacao   ON "PublicRankingEntry" FOR INSERT WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY projecao_alteracao ON "PublicRankingEntry" FOR UPDATE USING (mci_operator_of("organizationId")) WITH CHECK (mci_operator_of("organizationId"));
CREATE POLICY projecao_remocao   ON "PublicRankingEntry" FOR DELETE USING (mci_operator_of("organizationId"));
