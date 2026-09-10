-- ============================================================================
-- Vínculo único atleta → equipe/empresa, com histórico.
--
-- TRAVA DE INTEGRIDADE, garantida pelo BANCO e não pela tela: um atleta não
-- pode ter dois vínculos ativos ao mesmo tempo. `activeAthleteId` carrega o id
-- do atleta enquanto o vínculo está aberto e NULL depois de encerrado; o índice
-- único sobre ela recusa o segundo vínculo.
--
-- É o que protege o caso concorrente: dois treinadores tentando vincular o
-- mesmo atleta ao mesmo tempo produzem dois INSERTs, e um deles perde a corrida
-- com violação de unicidade. Nenhuma checagem em service resolveria isso
-- sozinha — entre o SELECT e o INSERT cabe a outra transação.
--
-- No PostgreSQL, NULL não conflita com NULL: vínculos encerrados se acumulam à
-- vontade, e é por isso que o histórico pode ser preservado sem afrouxar a
-- trava. Ninguém apaga o passado do atleta para trocá-lo de equipe.
--
-- Migration não destrutiva: tabela nova, e os vínculos já existentes em
-- Athlete.teamId são migrados como vínculo ativo.
-- ============================================================================

CREATE TABLE "AthleteTeamMembership" (
  "id"              TEXT NOT NULL,
  "athleteId"       TEXT NOT NULL,
  "teamId"          TEXT NOT NULL,
  "companyId"       TEXT,
  "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"         TIMESTAMP(3),
  "reason"          TEXT,
  "activeAthleteId" TEXT,
  "createdById"     TEXT,
  "endedById"       TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AthleteTeamMembership_pkey" PRIMARY KEY ("id")
);

-- A trava. Um único vínculo ativo por atleta, conferido pelo banco.
CREATE UNIQUE INDEX "AthleteTeamMembership_activeAthleteId_key"
  ON "AthleteTeamMembership" ("activeAthleteId");

CREATE INDEX "AthleteTeamMembership_athleteId_startedAt_idx"
  ON "AthleteTeamMembership" ("athleteId", "startedAt");
CREATE INDEX "AthleteTeamMembership_teamId_idx" ON "AthleteTeamMembership" ("teamId");

ALTER TABLE "AthleteTeamMembership" ADD CONSTRAINT "AthleteTeamMembership_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AthleteTeamMembership" ADD CONSTRAINT "AthleteTeamMembership_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AthleteTeamMembership" ADD CONSTRAINT "AthleteTeamMembership_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AthleteTeamMembership" ADD CONSTRAINT "AthleteTeamMembership_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AthleteTeamMembership" ADD CONSTRAINT "AthleteTeamMembership_endedById_fkey"
  FOREIGN KEY ("endedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Vínculos que já existiam viram vínculo ativo, sem inventar data de início:
-- vale a data de cadastro do atleta, que é a informação real disponível.
INSERT INTO "AthleteTeamMembership"
  ("id", "athleteId", "teamId", "companyId", "startedAt", "activeAthleteId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text, a."id", a."teamId", t."companyId", a."createdAt", a."id",
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Athlete" a
JOIN "Team" t ON t."id" = a."teamId"
WHERE a."teamId" IS NOT NULL;

-- O vínculo é dado esportivo da organização: quem vê o atleta vê a equipe dele;
-- escrever exige operador, e o service ainda restringe a transferência a quem
-- tem permissão de transferir.
ALTER TABLE "AthleteTeamMembership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthleteTeamMembership" FORCE ROW LEVEL SECURITY;

CREATE POLICY vinculo_leitura ON "AthleteTeamMembership" FOR SELECT USING (true);

CREATE POLICY vinculo_escrita ON "AthleteTeamMembership" FOR ALL
  USING (EXISTS (SELECT 1 FROM "Team" t WHERE t.id = "teamId" AND mci_operator_of(t."organizationId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Team" t WHERE t.id = "teamId" AND mci_operator_of(t."organizationId")));
