-- O ESTADO DO ATLETA: ATIVO, SUSPENSO, ARQUIVADO.
--
-- POR QUE ISTO NÃO EXISTIA
--
-- `Athlete` não tinha nenhuma coluna de estado. Um atleta suspenso pela
-- organização não tinha onde ser registrado como tal, e a única forma de
-- "tirar" alguém era apagar — que leva o histórico esportivo junto.
--
-- O QUE MUDA
--
-- `status` nasce ATIVO para TODO atleta existente: o default garante isso sem
-- precisar de UPDATE, e nenhum cadastro atual muda de comportamento.
--
-- `statusReason`, `statusChangedAt` e `statusChangedById` guardam a decisão
-- junto do estado. Suspender sem motivo registrado é o tipo de ato que, seis
-- meses depois, ninguém consegue explicar — e a auditoria sozinha não basta:
-- ela guarda o evento, e a linha precisa carregar o estado corrente.
--
-- SUSPENDER NÃO É APAGAR, E ARQUIVAR TAMBÉM NÃO.
--
-- Nenhuma destas colunas toca pontuação, resultado, inscrição ou vínculo
-- histórico. O atleta suspenso continua inteiro no ranking e no histórico —
-- a suspensão é sobre o que ele PODE FAZER daqui para frente, não sobre o que
-- já aconteceu no palco.
--
-- ADITIVA E REVERSÍVEL. Nenhum DROP, nenhum DELETE, nenhum TRUNCATE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AthleteStatus') THEN
    CREATE TYPE "AthleteStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
  END IF;
END $$;

ALTER TABLE "Athlete" ADD COLUMN IF NOT EXISTS "status" "AthleteStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "Athlete" ADD COLUMN IF NOT EXISTS "statusReason" TEXT;
ALTER TABLE "Athlete" ADD COLUMN IF NOT EXISTS "statusChangedAt" TIMESTAMP(3);
ALTER TABLE "Athlete" ADD COLUMN IF NOT EXISTS "statusChangedById" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Athlete_statusChangedById_fkey') THEN
    ALTER TABLE "Athlete"
      ADD CONSTRAINT "Athlete_statusChangedById_fkey"
      FOREIGN KEY ("statusChangedById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- A listagem filtra por estado, e a lista de atletas de uma federação grande
-- é justamente onde o filtro precisa ser barato.
CREATE INDEX IF NOT EXISTS "Athlete_organizationId_status_idx"
  ON "Athlete" ("organizationId", "status");
