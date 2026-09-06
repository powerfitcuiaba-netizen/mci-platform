-- ============================================================================
-- CPF sai de "Athlete" e passa a viver em "AthleteIdentity", com política
-- própria.
--
-- Motivo: o RLS do PostgreSQL é barreira de LINHA, não de coluna. Onde a
-- política libera a linha, libera todas as colunas dela. A política de
-- "Athlete" precisa liberar leitura ao ator anônimo — sem isso o diretório
-- público de atletas, o ranking e a página pública de evento devolvem vazio —
-- e isso significava que a linha inteira, CPF incluído, ficava ao alcance de
-- qualquer visitante no nível do banco. O que mantinha o número fora das
-- respostas era a projeção do service, e só ela: um SELECT * esquecido numa
-- rota pública bastaria para vazá-lo.
--
-- Com o dado sensível em linha própria, a barreira de linha passa a
-- protegê-lo de fato. A política abaixo não tem predicado anônimo: exige
-- operador da organização ou o próprio atleta.
--
-- Os dados existentes são movidos, não apagados. A coluna antiga só é
-- removida depois da cópia, e a unicidade por organização viaja junto.
-- ============================================================================

CREATE TABLE "AthleteIdentity" (
  "athleteId"      TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "cpf"            TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AthleteIdentity_pkey" PRIMARY KEY ("athleteId")
);

-- Move o que já existe antes de derrubar a coluna.
INSERT INTO "AthleteIdentity" ("athleteId", "organizationId", "cpf", "createdAt", "updatedAt")
SELECT a."id", a."organizationId", a."cpf", a."createdAt", a."updatedAt"
FROM "Athlete" a;

CREATE UNIQUE INDEX "AthleteIdentity_organizationId_cpf_key"
  ON "AthleteIdentity" ("organizationId", "cpf");
CREATE INDEX "AthleteIdentity_cpf_idx" ON "AthleteIdentity" ("cpf");

ALTER TABLE "AthleteIdentity"
  ADD CONSTRAINT "AthleteIdentity_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AthleteIdentity"
  ADD CONSTRAINT "AthleteIdentity_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A coluna antiga sai só agora, com os dados já copiados.
DROP INDEX IF EXISTS "Athlete_organizationId_cpf_key";
ALTER TABLE "Athlete" DROP COLUMN "cpf";

-- ------------------------------------------------------------------ política
ALTER TABLE "AthleteIdentity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthleteIdentity" FORCE ROW LEVEL SECURITY;

-- Sem predicado anônimo, ao contrário de "Athlete": o visitante não tem
-- nenhuma leitura aqui.
--
-- O EXISTS sobre "Athlete" é seguro porque falha FECHADO: se o consultante não
-- enxerga a linha do atleta, o EXISTS é falso e o acesso é negado. É o oposto
-- de um NOT EXISTS, que concederia acesso justamente a quem não enxerga — erro
-- cometido e revertido na fase anterior, registrado aqui para não se repetir.
CREATE POLICY identidade_restrita ON "AthleteIdentity"
  USING (
    mci_operator_of("organizationId")
    OR EXISTS (
      SELECT 1 FROM "Athlete" a
      WHERE a.id = "athleteId" AND a."userId" = mci_current_user_id()
    )
  )
  WITH CHECK (mci_operator_of("organizationId"));
