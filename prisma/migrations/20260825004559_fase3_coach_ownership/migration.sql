-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Participant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "identification" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TEAM',
    "userId" TEXT,
    "coachId" TEXT,
    "teamId" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Participant_coachId_fkey" FOREIGN KEY ("coachId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Participant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Participant" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Participant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Participant" ("createdAt", "createdById", "id", "identification", "name", "type", "updatedAt", "userId") SELECT "createdAt", "createdById", "id", "identification", "name", "type", "updatedAt", "userId" FROM "Participant";
DROP TABLE "Participant";
ALTER TABLE "new_Participant" RENAME TO "Participant";
CREATE UNIQUE INDEX "Participant_identification_key" ON "Participant"("identification");
CREATE UNIQUE INDEX "Participant_userId_key" ON "Participant"("userId");
CREATE INDEX "Participant_type_idx" ON "Participant"("type");
CREATE INDEX "Participant_coachId_idx" ON "Participant"("coachId");
CREATE INDEX "Participant_teamId_idx" ON "Participant"("teamId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
