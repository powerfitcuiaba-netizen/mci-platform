-- AlterTable
ALTER TABLE "public"."Tournament" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "slug" TEXT;

-- AlterTable
ALTER TABLE "public"."Enrollment" ADD COLUMN     "athleteId" TEXT,
ADD COLUMN     "eventCategoryId" TEXT,
ADD COLUMN     "registrationNumber" TEXT;

-- CreateTable
CREATE TABLE "public"."Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "document" TEXT,
    "country" TEXT NOT NULL DEFAULT 'BR',
    "state" TEXT,
    "city" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Athlete" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "stageName" TEXT,
    "documentNumber" TEXT,
    "birthDate" TIMESTAMP(3),
    "gender" TEXT,
    "nationality" TEXT NOT NULL DEFAULT 'BR',
    "country" TEXT NOT NULL DEFAULT 'BR',
    "state" TEXT,
    "city" TEXT,
    "phone" TEXT,
    "whatsapp" TEXT,
    "email" TEXT,
    "instagram" TEXT,
    "photoKey" TEXT,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ATIVO',
    "proStatus" TEXT NOT NULL DEFAULT 'NAO_PRO',
    "proSince" TIMESTAMP(3),
    "proSourceEventId" TEXT,
    "teamId" TEXT,
    "coachId" TEXT,
    "gymId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Athlete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AthleteNumber" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AthleteNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProStatusChange" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "reason" TEXT,
    "sourceEventId" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Coach" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Gym" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Division" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "gender" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Category" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CompetitionClass" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScoringRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dropHighest" INTEGER NOT NULL DEFAULT 0,
    "dropLowest" INTEGER NOT NULL DEFAULT 0,
    "tiebreakers" TEXT[] DEFAULT ARRAY['SOMA_COMPLETA', 'CONFRONTO_DIRETO']::TEXT[],
    "requireFullPanel" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventCategory" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "classId" TEXT,
    "scoringRuleId" TEXT,
    "name" TEXT NOT NULL,
    "maxAthletes" INTEGER,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WeighIn" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "weightGrams" INTEGER NOT NULL,
    "heightMm" INTEGER,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operatorUserId" TEXT,
    "notes" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeighIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Credential" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "personName" TEXT NOT NULL,
    "athleteId" TEXT,
    "userId" TEXT,
    "qrCode" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "issuedByUserId" TEXT,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CredentialScan" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "gate" TEXT,
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "operatorUserId" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StageSlot" (
    "id" TEXT NOT NULL,
    "eventCategoryId" TEXT NOT NULL,
    "heatNumber" INTEGER NOT NULL DEFAULT 1,
    "displayOrder" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AGUARDANDO',
    "calledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgePanel" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headJudgeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgePanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgePanelMember" (
    "id" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "judgeUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgePanelMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgingSession" (
    "id" TEXT NOT NULL,
    "eventCategoryId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "scoringRuleId" TEXT,
    "round" TEXT NOT NULL DEFAULT 'FINAL',
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "startedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgingScore" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "judgeUserId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "placing" INTEGER NOT NULL,
    "clientRef" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CompetitionResult" (
    "id" TEXT NOT NULL,
    "eventCategoryId" TEXT NOT NULL,
    "sessionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RASCUNHO',
    "signature" TEXT,
    "snapshot" JSONB,
    "calculatedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "overrideReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AthletePlacement" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "placing" INTEGER NOT NULL,
    "score" INTEGER NOT NULL,
    "fullScore" INTEGER NOT NULL,
    "tied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthletePlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Season" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pointsTable" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RankingEntry" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "categoryId" TEXT,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "eventsCount" INTEGER NOT NULL DEFAULT 0,
    "bestPlacing" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RankingPoint" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "placing" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "public"."Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_document_key" ON "public"."Organization"("document");

-- CreateIndex
CREATE INDEX "Organization_active_idx" ON "public"."Organization"("active");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_active_idx" ON "public"."OrganizationMember"("userId", "active");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_role_idx" ON "public"."OrganizationMember"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "public"."OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Athlete_userId_key" ON "public"."Athlete"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Athlete_slug_key" ON "public"."Athlete"("slug");

-- CreateIndex
CREATE INDEX "Athlete_organizationId_status_idx" ON "public"."Athlete"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Athlete_organizationId_proStatus_idx" ON "public"."Athlete"("organizationId", "proStatus");

-- CreateIndex
CREATE INDEX "Athlete_fullName_idx" ON "public"."Athlete"("fullName");

-- CreateIndex
CREATE INDEX "Athlete_state_city_idx" ON "public"."Athlete"("state", "city");

-- CreateIndex
CREATE INDEX "Athlete_teamId_idx" ON "public"."Athlete"("teamId");

-- CreateIndex
CREATE INDEX "Athlete_coachId_idx" ON "public"."Athlete"("coachId");

-- CreateIndex
CREATE INDEX "Athlete_deletedAt_idx" ON "public"."Athlete"("deletedAt");

-- CreateIndex
CREATE INDEX "AthleteNumber_athleteId_active_idx" ON "public"."AthleteNumber"("athleteId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AthleteNumber_organizationId_number_key" ON "public"."AthleteNumber"("organizationId", "number");

-- CreateIndex
CREATE INDEX "ProStatusChange_athleteId_createdAt_idx" ON "public"."ProStatusChange"("athleteId", "createdAt");

-- CreateIndex
CREATE INDEX "Team_organizationId_active_idx" ON "public"."Team"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_slug_key" ON "public"."Team"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "Coach_organizationId_active_idx" ON "public"."Coach"("organizationId", "active");

-- CreateIndex
CREATE INDEX "Coach_userId_idx" ON "public"."Coach"("userId");

-- CreateIndex
CREATE INDEX "Gym_organizationId_active_idx" ON "public"."Gym"("organizationId", "active");

-- CreateIndex
CREATE INDEX "Division_organizationId_active_idx" ON "public"."Division"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Division_organizationId_code_key" ON "public"."Division"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Category_divisionId_active_idx" ON "public"."Category"("divisionId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Category_divisionId_code_key" ON "public"."Category"("divisionId", "code");

-- CreateIndex
CREATE INDEX "CompetitionClass_organizationId_active_idx" ON "public"."CompetitionClass"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionClass_organizationId_code_key" ON "public"."CompetitionClass"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringRule_organizationId_name_key" ON "public"."ScoringRule"("organizationId", "name");

-- CreateIndex
CREATE INDEX "EventCategory_tournamentId_status_idx" ON "public"."EventCategory"("tournamentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_tournamentId_categoryId_classId_key" ON "public"."EventCategory"("tournamentId", "categoryId", "classId");

-- CreateIndex
CREATE INDEX "WeighIn_enrollmentId_supersededAt_idx" ON "public"."WeighIn"("enrollmentId", "supersededAt");

-- CreateIndex
CREATE INDEX "WeighIn_measuredAt_idx" ON "public"."WeighIn"("measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_qrCode_key" ON "public"."Credential"("qrCode");

-- CreateIndex
CREATE INDEX "Credential_tournamentId_type_idx" ON "public"."Credential"("tournamentId", "type");

-- CreateIndex
CREATE INDEX "Credential_athleteId_idx" ON "public"."Credential"("athleteId");

-- CreateIndex
CREATE INDEX "CredentialScan_credentialId_scannedAt_idx" ON "public"."CredentialScan"("credentialId", "scannedAt");

-- CreateIndex
CREATE INDEX "StageSlot_eventCategoryId_status_idx" ON "public"."StageSlot"("eventCategoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StageSlot_eventCategoryId_heatNumber_displayOrder_key" ON "public"."StageSlot"("eventCategoryId", "heatNumber", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JudgePanel_tournamentId_name_key" ON "public"."JudgePanel"("tournamentId", "name");

-- CreateIndex
CREATE INDEX "JudgePanelMember_judgeUserId_idx" ON "public"."JudgePanelMember"("judgeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgePanelMember_panelId_judgeUserId_key" ON "public"."JudgePanelMember"("panelId", "judgeUserId");

-- CreateIndex
CREATE INDEX "JudgingSession_panelId_status_idx" ON "public"."JudgingSession"("panelId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingSession_eventCategoryId_round_key" ON "public"."JudgingSession"("eventCategoryId", "round");

-- CreateIndex
CREATE INDEX "JudgingScore_sessionId_idx" ON "public"."JudgingScore"("sessionId");

-- CreateIndex
CREATE INDEX "JudgingScore_judgeUserId_idx" ON "public"."JudgingScore"("judgeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScore_sessionId_judgeUserId_enrollmentId_key" ON "public"."JudgingScore"("sessionId", "judgeUserId", "enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScore_sessionId_judgeUserId_clientRef_key" ON "public"."JudgingScore"("sessionId", "judgeUserId", "clientRef");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScore_sessionId_judgeUserId_placing_key" ON "public"."JudgingScore"("sessionId", "judgeUserId", "placing");

-- CreateIndex
CREATE INDEX "CompetitionResult_eventCategoryId_status_idx" ON "public"."CompetitionResult"("eventCategoryId", "status");

-- CreateIndex
CREATE INDEX "CompetitionResult_status_publishedAt_idx" ON "public"."CompetitionResult"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "AthletePlacement_athleteId_idx" ON "public"."AthletePlacement"("athleteId");

-- CreateIndex
CREATE INDEX "AthletePlacement_resultId_placing_idx" ON "public"."AthletePlacement"("resultId", "placing");

-- CreateIndex
CREATE UNIQUE INDEX "AthletePlacement_resultId_enrollmentId_key" ON "public"."AthletePlacement"("resultId", "enrollmentId");

-- CreateIndex
CREATE INDEX "Season_organizationId_active_idx" ON "public"."Season"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Season_organizationId_year_name_key" ON "public"."Season"("organizationId", "year", "name");

-- CreateIndex
CREATE INDEX "RankingEntry_seasonId_totalPoints_idx" ON "public"."RankingEntry"("seasonId", "totalPoints");

-- CreateIndex
CREATE UNIQUE INDEX "RankingEntry_seasonId_athleteId_categoryId_key" ON "public"."RankingEntry"("seasonId", "athleteId", "categoryId");

-- CreateIndex
CREATE INDEX "RankingPoint_athleteId_seasonId_idx" ON "public"."RankingPoint"("athleteId", "seasonId");

-- CreateIndex
CREATE UNIQUE INDEX "RankingPoint_seasonId_athleteId_resultId_key" ON "public"."RankingPoint"("seasonId", "athleteId", "resultId");

-- CreateIndex
CREATE UNIQUE INDEX "Tournament_slug_key" ON "public"."Tournament"("slug");

-- CreateIndex
CREATE INDEX "Tournament_organizationId_status_idx" ON "public"."Tournament"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_athleteId_status_idx" ON "public"."Enrollment"("athleteId", "status");

-- CreateIndex
CREATE INDEX "Enrollment_eventCategoryId_status_idx" ON "public"."Enrollment"("eventCategoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_eventCategoryId_athleteId_key" ON "public"."Enrollment"("eventCategoryId", "athleteId");

-- AddForeignKey
ALTER TABLE "public"."Tournament" ADD CONSTRAINT "Tournament_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Enrollment" ADD CONSTRAINT "Enrollment_eventCategoryId_fkey" FOREIGN KEY ("eventCategoryId") REFERENCES "public"."EventCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Enrollment" ADD CONSTRAINT "Enrollment_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "public"."Coach"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "public"."Gym"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteNumber" ADD CONSTRAINT "AthleteNumber_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteNumber" ADD CONSTRAINT "AthleteNumber_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProStatusChange" ADD CONSTRAINT "ProStatusChange_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProStatusChange" ADD CONSTRAINT "ProStatusChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coach" ADD CONSTRAINT "Coach_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coach" ADD CONSTRAINT "Coach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Gym" ADD CONSTRAINT "Gym_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Division" ADD CONSTRAINT "Division_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Category" ADD CONSTRAINT "Category_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionClass" ADD CONSTRAINT "CompetitionClass_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScoringRule" ADD CONSTRAINT "ScoringRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "public"."Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_scoringRuleId_fkey" FOREIGN KEY ("scoringRuleId") REFERENCES "public"."ScoringRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WeighIn" ADD CONSTRAINT "WeighIn_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "public"."Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WeighIn" ADD CONSTRAINT "WeighIn_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "public"."Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialScan" ADD CONSTRAINT "CredentialScan_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialScan" ADD CONSTRAINT "CredentialScan_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageSlot" ADD CONSTRAINT "StageSlot_eventCategoryId_fkey" FOREIGN KEY ("eventCategoryId") REFERENCES "public"."EventCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgePanel" ADD CONSTRAINT "JudgePanel_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "public"."Tournament"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgePanel" ADD CONSTRAINT "JudgePanel_headJudgeId_fkey" FOREIGN KEY ("headJudgeId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgePanelMember" ADD CONSTRAINT "JudgePanelMember_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "public"."JudgePanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgePanelMember" ADD CONSTRAINT "JudgePanelMember_judgeUserId_fkey" FOREIGN KEY ("judgeUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_eventCategoryId_fkey" FOREIGN KEY ("eventCategoryId") REFERENCES "public"."EventCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "public"."JudgePanel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_scoringRuleId_fkey" FOREIGN KEY ("scoringRuleId") REFERENCES "public"."ScoringRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."JudgingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_judgeUserId_fkey" FOREIGN KEY ("judgeUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "public"."Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionResult" ADD CONSTRAINT "CompetitionResult_eventCategoryId_fkey" FOREIGN KEY ("eventCategoryId") REFERENCES "public"."EventCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionResult" ADD CONSTRAINT "CompetitionResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."JudgingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionResult" ADD CONSTRAINT "CompetitionResult_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionResult" ADD CONSTRAINT "CompetitionResult_publishedByUserId_fkey" FOREIGN KEY ("publishedByUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthletePlacement" ADD CONSTRAINT "AthletePlacement_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "public"."CompetitionResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthletePlacement" ADD CONSTRAINT "AthletePlacement_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "public"."Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthletePlacement" ADD CONSTRAINT "AthletePlacement_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Season" ADD CONSTRAINT "Season_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingEntry" ADD CONSTRAINT "RankingEntry_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingEntry" ADD CONSTRAINT "RankingEntry_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingEntry" ADD CONSTRAINT "RankingEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "public"."CompetitionResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

