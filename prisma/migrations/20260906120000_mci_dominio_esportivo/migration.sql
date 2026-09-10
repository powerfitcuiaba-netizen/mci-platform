-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'JUDGE_COORDINATOR', 'JUDGE', 'STAFF', 'REGISTRATION_OPERATOR', 'CHECKIN_OPERATOR', 'WEIGHIN_OPERATOR', 'RESULTS_OPERATOR', 'RANKING_MANAGER', 'SOCIAL_ADMIN', 'MODERATOR', 'ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'MEDIA');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "public"."AffiliationKind" AS ENUM ('FEDERATION', 'ENTITY', 'ASSOCIATION', 'TEAM', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."Sex" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "public"."ProStatus" AS ENUM ('NONE', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED');

-- CreateEnum
CREATE TYPE "public"."DocumentKind" AS ENUM ('ID', 'MEDICAL', 'TERM', 'AFFILIATION_PROOF', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."EventStatus" AS ENUM ('DRAFT', 'PLANNED', 'REGISTRATIONS_OPEN', 'REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING', 'RESULTS_IN_REVIEW', 'RESULTS_PUBLISHED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."RegistrationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."CheckInStatus" AS ENUM ('CHECKED_IN', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."CredentialType" AS ENUM ('ATHLETE', 'COACH', 'STAFF', 'JUDGE', 'MEDIA', 'PHOTOGRAPHER', 'SPONSOR', 'GUEST');

-- CreateEnum
CREATE TYPE "public"."CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "public"."BatchStatus" AS ENUM ('SCHEDULED', 'CALLED', 'ON_STAGE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."StageOrderStatus" AS ENUM ('WAITING', 'CALLED', 'PRESENT', 'ABSENT');

-- CreateEnum
CREATE TYPE "public"."PanelJudgeRole" AS ENUM ('HEAD', 'JUDGE');

-- CreateEnum
CREATE TYPE "public"."JudgingRound" AS ENUM ('PREJUDGING', 'COMPARISON', 'FINALS');

-- CreateEnum
CREATE TYPE "public"."JudgingSessionStatus" AS ENUM ('OPEN', 'SCORING', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."TabulationMethod" AS ENUM ('RELATIVE_PLACEMENT_SUM');

-- CreateEnum
CREATE TYPE "public"."TieBreaker" AS ENUM ('HEAD_JUDGE_PLACING', 'COUNT_BACK', 'SUM_WITHOUT_DROP');

-- CreateEnum
CREATE TYPE "public"."ResultStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "public"."ResultEntryStatus" AS ENUM ('RANKED', 'TIE_UNRESOLVED', 'DISQUALIFIED', 'ABSENT');

-- CreateEnum
CREATE TYPE "public"."SeasonStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "public"."PointSource" AS ENUM ('EVENT', 'MUSCLEWAR');

-- CreateEnum
CREATE TYPE "public"."ImportSourceType" AS ENUM ('CSV', 'JSON', 'API');

-- CreateEnum
CREATE TYPE "public"."ImportStatus" AS ENUM ('PENDING', 'PREVIEWED', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."MatchStatus" AS ENUM ('MATCHED', 'MATCH_PENDING', 'CONFLICT', 'DUPLICATE', 'IMPORT_REJECTED', 'APPLIED');

-- CreateEnum
CREATE TYPE "public"."SponsorshipStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "public"."ProfileKind" AS ENUM ('ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'FAN', 'MEDIA');

-- CreateEnum
CREATE TYPE "public"."PostVisibility" AS ENUM ('PUBLIC', 'FOLLOWERS', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."MediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "public"."ReportTargetType" AS ENUM ('POST', 'COMMENT', 'PROFILE', 'MESSAGE');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "public"."CommunityVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."CommunityRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "public"."ConversationKind" AS ENUM ('DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "public"."ConversationRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateTable
CREATE TABLE "public"."Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "role" "public"."UserRole" NOT NULL DEFAULT 'ATHLETE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Affiliation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "public"."AffiliationKind" NOT NULL DEFAULT 'ENTITY',
    "state" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Affiliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Athlete" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "stageName" TEXT,
    "cpf" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3),
    "sex" "public"."Sex" NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'BR',
    "state" TEXT,
    "city" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "photoKey" TEXT,
    "athleteNumber" TEXT,
    "affiliationId" TEXT,
    "teamId" TEXT,
    "coachId" TEXT,
    "gymId" TEXT,
    "proStatus" "public"."ProStatus" NOT NULL DEFAULT 'NONE',
    "proSince" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Athlete_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AthleteDocument" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "kind" "public"."DocumentKind" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AthleteProHistory" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "status" "public"."ProStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "eventId" TEXT,
    "title" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteProHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Coach" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "public"."EventStatus" NOT NULL DEFAULT 'DRAFT',
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "venue" TEXT,
    "city" TEXT,
    "state" TEXT,
    "seasonId" TEXT,
    "scoringRuleSetId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventDocument" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sex" "public"."Sex" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EventCategory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Division" (
    "id" TEXT NOT NULL,
    "eventCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Division_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CompetitionClass" (
    "id" TEXT NOT NULL,
    "divisionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "minWeightGrams" INTEGER,
    "maxWeightGrams" INTEGER,
    "minHeightCm" INTEGER,
    "maxHeightCm" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitionClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CategoryRule" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "CategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Registration" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "affiliationId" TEXT,
    "status" "public"."RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RegistrationItem" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "status" "public"."RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "bibNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistrationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CheckIn" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "status" "public"."CheckInStatus" NOT NULL DEFAULT 'CHECKED_IN',
    "operatorId" TEXT,
    "device" TEXT,
    "checkedInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WeighIn" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "weightGrams" INTEGER NOT NULL,
    "heightCm" INTEGER,
    "operatorId" TEXT,
    "device" TEXT,
    "notes" TEXT,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeighIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Credential" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" "public"."CredentialType" NOT NULL,
    "holderName" TEXT NOT NULL,
    "registrationId" TEXT,
    "code" TEXT NOT NULL,
    "status" "public"."CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CredentialScan" (
    "id" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "gate" TEXT,
    "scannedById" TEXT,
    "accepted" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StageBatch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" "public"."BatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StageOrder" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "registrationItemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "public"."StageOrderStatus" NOT NULL DEFAULT 'WAITING',
    "calledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StageOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgePanel" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgePanel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PanelJudge" (
    "id" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "judgeId" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "role" "public"."PanelJudgeRole" NOT NULL DEFAULT 'JUDGE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PanelJudge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgingSession" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "panelId" TEXT NOT NULL,
    "batchId" TEXT,
    "round" "public"."JudgingRound" NOT NULL DEFAULT 'PREJUDGING',
    "status" "public"."JudgingSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScoreCriterion" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ScoreCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgingScore" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "judgeId" TEXT NOT NULL,
    "registrationItemId" TEXT NOT NULL,
    "placing" INTEGER NOT NULL,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgingScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgingScoreCriterion" (
    "id" TEXT NOT NULL,
    "scoreId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "JudgingScoreCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ScoringRuleSet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" "public"."TabulationMethod" NOT NULL DEFAULT 'RELATIVE_PLACEMENT_SUM',
    "dropHighLow" BOOLEAN NOT NULL DEFAULT false,
    "dropHighLowMinJudges" INTEGER NOT NULL DEFAULT 7,
    "tieBreakers" "public"."TieBreaker"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoringRuleSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Result" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "status" "public"."ResultStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT NOT NULL,
    "hasUnresolvedTie" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Result_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ResultEntry" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "registrationItemId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "placing" INTEGER,
    "status" "public"."ResultEntryStatus" NOT NULL DEFAULT 'RANKED',
    "score" INTEGER NOT NULL,
    "rawScore" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ResultVersion" (
    "id" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResultVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RankingSeason" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" "public"."SeasonStatus" NOT NULL DEFAULT 'OPEN',
    "scoringRuleSetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankingSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RankingPointsRule" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "placing" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingPointsRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RankingPoint" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "categoryId" TEXT,
    "source" "public"."PointSource" NOT NULL,
    "eventId" TEXT,
    "resultId" TEXT,
    "externalResultId" TEXT,
    "placing" INTEGER,
    "points" INTEGER NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ranking" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "categoryId" TEXT,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "position" INTEGER,
    "state" TEXT,
    "country" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ranking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MuscleWarImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "seasonId" TEXT,
    "eventId" TEXT,
    "sourceType" "public"."ImportSourceType" NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "status" "public"."ImportStatus" NOT NULL DEFAULT 'PENDING',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "appliedById" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MuscleWarImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MuscleWarImportItem" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "externalResultId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "cpf" TEXT,
    "athleteName" TEXT,
    "affiliationCode" TEXT,
    "categoryCode" TEXT,
    "divisionName" TEXT,
    "className" TEXT,
    "placing" INTEGER,
    "points" INTEGER,
    "eventName" TEXT,
    "eventDate" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "matchStatus" "public"."MatchStatus" NOT NULL DEFAULT 'MATCH_PENDING',
    "reason" TEXT,
    "athleteId" TEXT,
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MuscleWarImportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExternalResult" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MUSCLEWAR',
    "externalId" TEXT NOT NULL,
    "seasonId" TEXT,
    "athleteId" TEXT NOT NULL,
    "categoryCode" TEXT,
    "className" TEXT,
    "placing" INTEGER,
    "points" INTEGER NOT NULL DEFAULT 0,
    "eventName" TEXT,
    "eventDate" TIMESTAMP(3),
    "importItemId" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Brand" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sponsor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "brandId" TEXT,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Sponsorship" (
    "id" TEXT NOT NULL,
    "sponsorId" TEXT NOT NULL,
    "eventId" TEXT,
    "teamId" TEXT,
    "athleteId" TEXT,
    "status" "public"."SponsorshipStatus" NOT NULL DEFAULT 'ACTIVE',
    "scope" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsorship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AthleteBrandPartnership" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "status" "public"."SponsorshipStatus" NOT NULL DEFAULT 'PENDING',
    "scope" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AthleteBrandPartnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SocialProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "handle" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "kind" "public"."ProfileKind" NOT NULL DEFAULT 'FAN',
    "bio" TEXT,
    "avatarKey" TEXT,
    "coverKey" TEXT,
    "athleteId" TEXT,
    "coachId" TEXT,
    "gymId" TEXT,
    "teamId" TEXT,
    "brandId" TEXT,
    "sponsorId" TEXT,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Post" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "visibility" "public"."PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "eventId" TEXT,
    "communityId" TEXT,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "saveCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "kind" "public"."MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Comment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PostLike" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CommentLike" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentLike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PostShare" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PostSave" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostSave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Follow" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Story" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" "public"."MediaKind" NOT NULL DEFAULT 'IMAGE',
    "caption" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StoryView" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoryView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Block" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContentReport" (
    "id" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "targetType" "public"."ReportTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "public"."ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Community" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "public"."CommunityVisibility" NOT NULL DEFAULT 'PUBLIC',
    "rules" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CommunityMember" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "role" "public"."CommunityRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Conversation" (
    "id" TEXT NOT NULL,
    "kind" "public"."ConversationKind" NOT NULL DEFAULT 'DIRECT',
    "title" TEXT,
    "directKey" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ConversationMember" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "role" "public"."ConversationRole" NOT NULL DEFAULT 'MEMBER',
    "lastReadAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "mediaKind" "public"."MediaKind",
    "sharedPostId" TEXT,
    "sharedProfileId" TEXT,
    "replyToId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MessageReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "link" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "public"."Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_active_idx" ON "public"."Organization"("active");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "public"."OrganizationMember"("userId");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_role_idx" ON "public"."OrganizationMember"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_role_key" ON "public"."OrganizationMember"("organizationId", "userId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "public"."User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "public"."User"("status");

-- CreateIndex
CREATE INDEX "Affiliation_organizationId_active_idx" ON "public"."Affiliation"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Affiliation_organizationId_code_key" ON "public"."Affiliation"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Athlete_userId_key" ON "public"."Athlete"("userId");

-- CreateIndex
CREATE INDEX "Athlete_organizationId_fullName_idx" ON "public"."Athlete"("organizationId", "fullName");

-- CreateIndex
CREATE INDEX "Athlete_organizationId_proStatus_idx" ON "public"."Athlete"("organizationId", "proStatus");

-- CreateIndex
CREATE INDEX "Athlete_affiliationId_idx" ON "public"."Athlete"("affiliationId");

-- CreateIndex
CREATE INDEX "Athlete_teamId_idx" ON "public"."Athlete"("teamId");

-- CreateIndex
CREATE INDEX "Athlete_coachId_idx" ON "public"."Athlete"("coachId");

-- CreateIndex
CREATE UNIQUE INDEX "Athlete_organizationId_cpf_key" ON "public"."Athlete"("organizationId", "cpf");

-- CreateIndex
CREATE UNIQUE INDEX "Athlete_organizationId_athleteNumber_key" ON "public"."Athlete"("organizationId", "athleteNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AthleteDocument_storageKey_key" ON "public"."AthleteDocument"("storageKey");

-- CreateIndex
CREATE INDEX "AthleteDocument_athleteId_kind_idx" ON "public"."AthleteDocument"("athleteId", "kind");

-- CreateIndex
CREATE INDEX "AthleteProHistory_athleteId_effectiveAt_idx" ON "public"."AthleteProHistory"("athleteId", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_name_key" ON "public"."Team"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Coach_userId_key" ON "public"."Coach"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Gym_organizationId_name_key" ON "public"."Gym"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Event_slug_key" ON "public"."Event"("slug");

-- CreateIndex
CREATE INDEX "Event_organizationId_status_idx" ON "public"."Event"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Event_startDate_idx" ON "public"."Event"("startDate");

-- CreateIndex
CREATE UNIQUE INDEX "EventDocument_storageKey_key" ON "public"."EventDocument"("storageKey");

-- CreateIndex
CREATE INDEX "EventDocument_eventId_idx" ON "public"."EventDocument"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_code_key" ON "public"."Category"("code");

-- CreateIndex
CREATE INDEX "Category_active_sortOrder_idx" ON "public"."Category"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "EventCategory_eventId_idx" ON "public"."EventCategory"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventCategory_eventId_categoryId_key" ON "public"."EventCategory"("eventId", "categoryId");

-- CreateIndex
CREATE INDEX "Division_eventCategoryId_idx" ON "public"."Division"("eventCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Division_eventCategoryId_code_key" ON "public"."Division"("eventCategoryId", "code");

-- CreateIndex
CREATE INDEX "CompetitionClass_divisionId_idx" ON "public"."CompetitionClass"("divisionId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitionClass_divisionId_code_key" ON "public"."CompetitionClass"("divisionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryRule_classId_key_key" ON "public"."CategoryRule"("classId", "key");

-- CreateIndex
CREATE INDEX "Registration_eventId_status_idx" ON "public"."Registration"("eventId", "status");

-- CreateIndex
CREATE INDEX "Registration_athleteId_idx" ON "public"."Registration"("athleteId");

-- CreateIndex
CREATE UNIQUE INDEX "Registration_eventId_athleteId_key" ON "public"."Registration"("eventId", "athleteId");

-- CreateIndex
CREATE INDEX "RegistrationItem_classId_status_idx" ON "public"."RegistrationItem"("classId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationItem_registrationId_classId_key" ON "public"."RegistrationItem"("registrationId", "classId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckIn_registrationId_key" ON "public"."CheckIn"("registrationId");

-- CreateIndex
CREATE INDEX "CheckIn_status_idx" ON "public"."CheckIn"("status");

-- CreateIndex
CREATE INDEX "WeighIn_registrationId_measuredAt_idx" ON "public"."WeighIn"("registrationId", "measuredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_code_key" ON "public"."Credential"("code");

-- CreateIndex
CREATE INDEX "Credential_eventId_type_idx" ON "public"."Credential"("eventId", "type");

-- CreateIndex
CREATE INDEX "Credential_status_idx" ON "public"."Credential"("status");

-- CreateIndex
CREATE INDEX "CredentialScan_credentialId_scannedAt_idx" ON "public"."CredentialScan"("credentialId", "scannedAt");

-- CreateIndex
CREATE INDEX "StageBatch_eventId_status_idx" ON "public"."StageBatch"("eventId", "status");

-- CreateIndex
CREATE INDEX "StageBatch_classId_idx" ON "public"."StageBatch"("classId");

-- CreateIndex
CREATE INDEX "StageOrder_batchId_idx" ON "public"."StageOrder"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "StageOrder_batchId_registrationItemId_key" ON "public"."StageOrder"("batchId", "registrationItemId");

-- CreateIndex
CREATE UNIQUE INDEX "StageOrder_batchId_position_key" ON "public"."StageOrder"("batchId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "JudgePanel_eventId_name_key" ON "public"."JudgePanel"("eventId", "name");

-- CreateIndex
CREATE INDEX "PanelJudge_judgeId_idx" ON "public"."PanelJudge"("judgeId");

-- CreateIndex
CREATE UNIQUE INDEX "PanelJudge_panelId_judgeId_key" ON "public"."PanelJudge"("panelId", "judgeId");

-- CreateIndex
CREATE UNIQUE INDEX "PanelJudge_panelId_seat_key" ON "public"."PanelJudge"("panelId", "seat");

-- CreateIndex
CREATE INDEX "JudgingSession_status_idx" ON "public"."JudgingSession"("status");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingSession_classId_round_key" ON "public"."JudgingSession"("classId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreCriterion_categoryId_code_key" ON "public"."ScoreCriterion"("categoryId", "code");

-- CreateIndex
CREATE INDEX "JudgingScore_sessionId_idx" ON "public"."JudgingScore"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScore_sessionId_judgeId_registrationItemId_key" ON "public"."JudgingScore"("sessionId", "judgeId", "registrationItemId");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScore_sessionId_judgeId_placing_key" ON "public"."JudgingScore"("sessionId", "judgeId", "placing");

-- CreateIndex
CREATE UNIQUE INDEX "JudgingScoreCriterion_scoreId_criterionId_key" ON "public"."JudgingScoreCriterion"("scoreId", "criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringRuleSet_name_key" ON "public"."ScoringRuleSet"("name");

-- CreateIndex
CREATE INDEX "Result_status_idx" ON "public"."Result"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Result_eventId_classId_key" ON "public"."Result"("eventId", "classId");

-- CreateIndex
CREATE INDEX "ResultEntry_athleteId_idx" ON "public"."ResultEntry"("athleteId");

-- CreateIndex
CREATE INDEX "ResultEntry_resultId_placing_idx" ON "public"."ResultEntry"("resultId", "placing");

-- CreateIndex
CREATE UNIQUE INDEX "ResultEntry_resultId_registrationItemId_key" ON "public"."ResultEntry"("resultId", "registrationItemId");

-- CreateIndex
CREATE INDEX "ResultVersion_resultId_idx" ON "public"."ResultVersion"("resultId");

-- CreateIndex
CREATE UNIQUE INDEX "ResultVersion_resultId_version_key" ON "public"."ResultVersion"("resultId", "version");

-- CreateIndex
CREATE INDEX "RankingSeason_organizationId_status_idx" ON "public"."RankingSeason"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RankingSeason_organizationId_name_key" ON "public"."RankingSeason"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RankingPointsRule_seasonId_placing_key" ON "public"."RankingPointsRule"("seasonId", "placing");

-- CreateIndex
CREATE UNIQUE INDEX "RankingPoint_externalResultId_key" ON "public"."RankingPoint"("externalResultId");

-- CreateIndex
CREATE INDEX "RankingPoint_seasonId_athleteId_idx" ON "public"."RankingPoint"("seasonId", "athleteId");

-- CreateIndex
CREATE INDEX "RankingPoint_source_idx" ON "public"."RankingPoint"("source");

-- CreateIndex
CREATE UNIQUE INDEX "RankingPoint_seasonId_athleteId_resultId_key" ON "public"."RankingPoint"("seasonId", "athleteId", "resultId");

-- CreateIndex
CREATE INDEX "Ranking_seasonId_totalPoints_idx" ON "public"."Ranking"("seasonId", "totalPoints");

-- CreateIndex
CREATE UNIQUE INDEX "Ranking_seasonId_athleteId_categoryId_key" ON "public"."Ranking"("seasonId", "athleteId", "categoryId");

-- CreateIndex
CREATE INDEX "MuscleWarImport_organizationId_status_idx" ON "public"."MuscleWarImport"("organizationId", "status");

-- CreateIndex
CREATE INDEX "MuscleWarImport_createdAt_idx" ON "public"."MuscleWarImport"("createdAt");

-- CreateIndex
CREATE INDEX "MuscleWarImportItem_importId_matchStatus_idx" ON "public"."MuscleWarImportItem"("importId", "matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "MuscleWarImportItem_importId_externalResultId_key" ON "public"."MuscleWarImportItem"("importId", "externalResultId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalResult_importItemId_key" ON "public"."ExternalResult"("importItemId");

-- CreateIndex
CREATE INDEX "ExternalResult_athleteId_idx" ON "public"."ExternalResult"("athleteId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalResult_source_externalId_key" ON "public"."ExternalResult"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "public"."Brand"("slug");

-- CreateIndex
CREATE INDEX "Brand_organizationId_active_idx" ON "public"."Brand"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Sponsor_organizationId_name_key" ON "public"."Sponsor"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Sponsorship_sponsorId_status_idx" ON "public"."Sponsorship"("sponsorId", "status");

-- CreateIndex
CREATE INDEX "Sponsorship_eventId_idx" ON "public"."Sponsorship"("eventId");

-- CreateIndex
CREATE INDEX "AthleteBrandPartnership_status_idx" ON "public"."AthleteBrandPartnership"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AthleteBrandPartnership_athleteId_brandId_key" ON "public"."AthleteBrandPartnership"("athleteId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_userId_key" ON "public"."SocialProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_handle_key" ON "public"."SocialProfile"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_athleteId_key" ON "public"."SocialProfile"("athleteId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_coachId_key" ON "public"."SocialProfile"("coachId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_gymId_key" ON "public"."SocialProfile"("gymId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_teamId_key" ON "public"."SocialProfile"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_brandId_key" ON "public"."SocialProfile"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialProfile_sponsorId_key" ON "public"."SocialProfile"("sponsorId");

-- CreateIndex
CREATE INDEX "SocialProfile_kind_idx" ON "public"."SocialProfile"("kind");

-- CreateIndex
CREATE INDEX "SocialProfile_displayName_idx" ON "public"."SocialProfile"("displayName");

-- CreateIndex
CREATE INDEX "Post_authorId_createdAt_idx" ON "public"."Post"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "Post_visibility_createdAt_idx" ON "public"."Post"("visibility", "createdAt");

-- CreateIndex
CREATE INDEX "Post_eventId_idx" ON "public"."Post"("eventId");

-- CreateIndex
CREATE INDEX "Post_communityId_createdAt_idx" ON "public"."Post"("communityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostMedia_storageKey_key" ON "public"."PostMedia"("storageKey");

-- CreateIndex
CREATE INDEX "PostMedia_postId_position_idx" ON "public"."PostMedia"("postId", "position");

-- CreateIndex
CREATE INDEX "Comment_postId_createdAt_idx" ON "public"."Comment"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "public"."Comment"("parentId");

-- CreateIndex
CREATE INDEX "PostLike_profileId_idx" ON "public"."PostLike"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "PostLike_postId_profileId_key" ON "public"."PostLike"("postId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentLike_commentId_profileId_key" ON "public"."CommentLike"("commentId", "profileId");

-- CreateIndex
CREATE INDEX "PostShare_postId_createdAt_idx" ON "public"."PostShare"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "PostShare_profileId_idx" ON "public"."PostShare"("profileId");

-- CreateIndex
CREATE INDEX "PostSave_profileId_createdAt_idx" ON "public"."PostSave"("profileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostSave_postId_profileId_key" ON "public"."PostSave"("postId", "profileId");

-- CreateIndex
CREATE INDEX "Follow_followingId_idx" ON "public"."Follow"("followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_followingId_key" ON "public"."Follow"("followerId", "followingId");

-- CreateIndex
CREATE UNIQUE INDEX "Story_storageKey_key" ON "public"."Story"("storageKey");

-- CreateIndex
CREATE INDEX "Story_authorId_expiresAt_idx" ON "public"."Story"("authorId", "expiresAt");

-- CreateIndex
CREATE INDEX "Story_expiresAt_idx" ON "public"."Story"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StoryView_storyId_profileId_key" ON "public"."StoryView"("storyId", "profileId");

-- CreateIndex
CREATE INDEX "Block_blockedId_idx" ON "public"."Block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerId_blockedId_key" ON "public"."Block"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "public"."ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_targetType_targetId_idx" ON "public"."ContentReport"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentReport_reporterId_targetType_targetId_key" ON "public"."ContentReport"("reporterId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Community_slug_key" ON "public"."Community"("slug");

-- CreateIndex
CREATE INDEX "CommunityMember_profileId_idx" ON "public"."CommunityMember"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityMember_communityId_profileId_key" ON "public"."CommunityMember"("communityId", "profileId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_directKey_key" ON "public"."Conversation"("directKey");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "public"."Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "ConversationMember_profileId_joinedAt_idx" ON "public"."ConversationMember"("profileId", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMember_conversationId_profileId_key" ON "public"."ConversationMember"("conversationId", "profileId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "public"."Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_senderId_idx" ON "public"."Message"("senderId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReaction_messageId_profileId_emoji_key" ON "public"."MessageReaction"("messageId", "profileId", "emoji");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "public"."Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "public"."Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "public"."AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "public"."AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "public"."AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "public"."AuditLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Affiliation" ADD CONSTRAINT "Affiliation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_affiliationId_fkey" FOREIGN KEY ("affiliationId") REFERENCES "public"."Affiliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "public"."Coach"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "public"."Gym"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Athlete" ADD CONSTRAINT "Athlete_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteDocument" ADD CONSTRAINT "AthleteDocument_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteDocument" ADD CONSTRAINT "AthleteDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteProHistory" ADD CONSTRAINT "AthleteProHistory_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteProHistory" ADD CONSTRAINT "AthleteProHistory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteProHistory" ADD CONSTRAINT "AthleteProHistory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Coach" ADD CONSTRAINT "Coach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Gym" ADD CONSTRAINT "Gym_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_scoringRuleSetId_fkey" FOREIGN KEY ("scoringRuleSetId") REFERENCES "public"."ScoringRuleSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventDocument" ADD CONSTRAINT "EventDocument_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventDocument" ADD CONSTRAINT "EventDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EventCategory" ADD CONSTRAINT "EventCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Division" ADD CONSTRAINT "Division_eventCategoryId_fkey" FOREIGN KEY ("eventCategoryId") REFERENCES "public"."EventCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompetitionClass" ADD CONSTRAINT "CompetitionClass_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CategoryRule" ADD CONSTRAINT "CategoryRule_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Registration" ADD CONSTRAINT "Registration_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Registration" ADD CONSTRAINT "Registration_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Registration" ADD CONSTRAINT "Registration_affiliationId_fkey" FOREIGN KEY ("affiliationId") REFERENCES "public"."Affiliation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Registration" ADD CONSTRAINT "Registration_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Registration" ADD CONSTRAINT "Registration_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RegistrationItem" ADD CONSTRAINT "RegistrationItem_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RegistrationItem" ADD CONSTRAINT "RegistrationItem_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckIn" ADD CONSTRAINT "CheckIn_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckIn" ADD CONSTRAINT "CheckIn_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WeighIn" ADD CONSTRAINT "WeighIn_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."Registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WeighIn" ADD CONSTRAINT "WeighIn_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "public"."Registration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialScan" ADD CONSTRAINT "CredentialScan_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialScan" ADD CONSTRAINT "CredentialScan_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageBatch" ADD CONSTRAINT "StageBatch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageBatch" ADD CONSTRAINT "StageBatch_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageOrder" ADD CONSTRAINT "StageOrder_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."StageBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StageOrder" ADD CONSTRAINT "StageOrder_registrationItemId_fkey" FOREIGN KEY ("registrationItemId") REFERENCES "public"."RegistrationItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgePanel" ADD CONSTRAINT "JudgePanel_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PanelJudge" ADD CONSTRAINT "PanelJudge_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "public"."JudgePanel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PanelJudge" ADD CONSTRAINT "PanelJudge_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_panelId_fkey" FOREIGN KEY ("panelId") REFERENCES "public"."JudgePanel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingSession" ADD CONSTRAINT "JudgingSession_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."StageBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ScoreCriterion" ADD CONSTRAINT "ScoreCriterion_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."JudgingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScore" ADD CONSTRAINT "JudgingScore_registrationItemId_fkey" FOREIGN KEY ("registrationItemId") REFERENCES "public"."RegistrationItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScoreCriterion" ADD CONSTRAINT "JudgingScoreCriterion_scoreId_fkey" FOREIGN KEY ("scoreId") REFERENCES "public"."JudgingScore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgingScoreCriterion" ADD CONSTRAINT "JudgingScoreCriterion_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "public"."ScoreCriterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Result" ADD CONSTRAINT "Result_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Result" ADD CONSTRAINT "Result_classId_fkey" FOREIGN KEY ("classId") REFERENCES "public"."CompetitionClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Result" ADD CONSTRAINT "Result_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResultEntry" ADD CONSTRAINT "ResultEntry_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "public"."Result"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResultEntry" ADD CONSTRAINT "ResultEntry_registrationItemId_fkey" FOREIGN KEY ("registrationItemId") REFERENCES "public"."RegistrationItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResultEntry" ADD CONSTRAINT "ResultEntry_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResultVersion" ADD CONSTRAINT "ResultVersion_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "public"."Result"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ResultVersion" ADD CONSTRAINT "ResultVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingSeason" ADD CONSTRAINT "RankingSeason_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingSeason" ADD CONSTRAINT "RankingSeason_scoringRuleSetId_fkey" FOREIGN KEY ("scoringRuleSetId") REFERENCES "public"."ScoringRuleSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPointsRule" ADD CONSTRAINT "RankingPointsRule_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_resultId_fkey" FOREIGN KEY ("resultId") REFERENCES "public"."Result"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RankingPoint" ADD CONSTRAINT "RankingPoint_externalResultId_fkey" FOREIGN KEY ("externalResultId") REFERENCES "public"."ExternalResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ranking" ADD CONSTRAINT "Ranking_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ranking" ADD CONSTRAINT "Ranking_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ranking" ADD CONSTRAINT "Ranking_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImport" ADD CONSTRAINT "MuscleWarImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImport" ADD CONSTRAINT "MuscleWarImport_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImport" ADD CONSTRAINT "MuscleWarImport_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImport" ADD CONSTRAINT "MuscleWarImport_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImport" ADD CONSTRAINT "MuscleWarImport_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImportItem" ADD CONSTRAINT "MuscleWarImportItem_importId_fkey" FOREIGN KEY ("importId") REFERENCES "public"."MuscleWarImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MuscleWarImportItem" ADD CONSTRAINT "MuscleWarImportItem_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalResult" ADD CONSTRAINT "ExternalResult_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "public"."RankingSeason"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalResult" ADD CONSTRAINT "ExternalResult_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExternalResult" ADD CONSTRAINT "ExternalResult_importItemId_fkey" FOREIGN KEY ("importItemId") REFERENCES "public"."MuscleWarImportItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Brand" ADD CONSTRAINT "Brand_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsor" ADD CONSTRAINT "Sponsor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsor" ADD CONSTRAINT "Sponsor_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "public"."Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsorship" ADD CONSTRAINT "Sponsorship_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "public"."Sponsor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsorship" ADD CONSTRAINT "Sponsorship_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsorship" ADD CONSTRAINT "Sponsorship_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Sponsorship" ADD CONSTRAINT "Sponsorship_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteBrandPartnership" ADD CONSTRAINT "AthleteBrandPartnership_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AthleteBrandPartnership" ADD CONSTRAINT "AthleteBrandPartnership_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "public"."Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_athleteId_fkey" FOREIGN KEY ("athleteId") REFERENCES "public"."Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "public"."Coach"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "public"."Gym"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "public"."Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SocialProfile" ADD CONSTRAINT "SocialProfile_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "public"."Sponsor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "public"."Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Post" ADD CONSTRAINT "Post_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "public"."Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostMedia" ADD CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostLike" ADD CONSTRAINT "PostLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostLike" ADD CONSTRAINT "PostLike_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommentLike" ADD CONSTRAINT "CommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "public"."Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommentLike" ADD CONSTRAINT "CommentLike_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostShare" ADD CONSTRAINT "PostShare_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostShare" ADD CONSTRAINT "PostShare_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostSave" ADD CONSTRAINT "PostSave_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostSave" ADD CONSTRAINT "PostSave_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Follow" ADD CONSTRAINT "Follow_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Story" ADD CONSTRAINT "Story_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StoryView" ADD CONSTRAINT "StoryView_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "public"."Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StoryView" ADD CONSTRAINT "StoryView_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Block" ADD CONSTRAINT "Block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Block" ADD CONSTRAINT "Block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommunityMember" ADD CONSTRAINT "CommunityMember_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "public"."Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CommunityMember" ADD CONSTRAINT "CommunityMember_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationMember" ADD CONSTRAINT "ConversationMember_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_sharedPostId_fkey" FOREIGN KEY ("sharedPostId") REFERENCES "public"."Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_sharedProfileId_fkey" FOREIGN KEY ("sharedProfileId") REFERENCES "public"."SocialProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "public"."Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageReaction" ADD CONSTRAINT "MessageReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageReaction" ADD CONSTRAINT "MessageReaction_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."SocialProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

