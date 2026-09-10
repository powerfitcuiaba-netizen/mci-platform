-- ============================================================================
-- Empresas como competidoras.
--
-- REGRA HOMOLOGADA: a empresa se cadastra e entra com suas equipes. Ela fica
-- ACIMA da equipe, e os pontos sobem por essa cadeia:
--
--   atleta → equipe → empresa
--
-- A mesma tabela de pontos (5/4/3/2/1, +10 Overall) e o mesmo desempate valem
-- para os três. Não há peso, multiplicador nem bônus próprio de empresa, e a
-- pontuação continua rastreável até o resultado de cada atleta.
--
-- Migration não destrutiva: uma tabela nova e colunas opcionais.
-- ============================================================================

CREATE TABLE "Company" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "city"           TEXT,
  "state"          TEXT,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Company_organizationId_name_key" ON "Company" ("organizationId", "name");
CREATE INDEX "Company_organizationId_active_idx" ON "Company" ("organizationId", "active");

ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A equipe passa a poder apontar para a empresa que a inscreveu. Opcional: uma
-- equipe pode competir sem empresa, e aí simplesmente não pontua para nenhuma.
ALTER TABLE "Team" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Team" ADD CONSTRAINT "Team_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Team_companyId_idx" ON "Team" ("companyId");

-- Empresa gravada no lançamento, e não deduzida na leitura: trocar a equipe de
-- empresa depois do evento não pode reescrever a história do ranking.
ALTER TABLE "RankingPoint" ADD COLUMN "companyId" TEXT;
ALTER TABLE "RankingPoint" ADD CONSTRAINT "RankingPoint_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "RankingPoint_seasonId_companyId_idx" ON "RankingPoint" ("seasonId", "companyId");

-- Importação: o nome da empresa, resolvido contra o cadastro da organização.
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "companyName" TEXT;

-- Cadastro operacional da organização: quem é membro lê, quem opera escreve.
ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Company" FORCE ROW LEVEL SECURITY;

CREATE POLICY empresa_leitura ON "Company" FOR SELECT USING (true);

CREATE POLICY empresa_escrita ON "Company" FOR ALL
  USING (mci_operator_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));
