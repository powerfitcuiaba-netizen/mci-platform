-- ============================================================================
-- Classes gerenciáveis e elegibilidade ao Super Overall anual.
--
-- REGRA HOMOLOGADA (fase 11.2): todas as classes do Campeonato Brasileiro
-- pontuam — Estreante, Novice, Open e Master —, mas SOMENTE os pontos da OPEN
-- alimentam o ranking classificatório do Super Overall anual.
--
-- A distinção é ATRIBUTO DA CLASSE, e não o código "OPEN" escrito no motor de
-- pontuação. É o que permite ao operador criar, editar e desativar classes sem
-- alteração de programa, como exige a regra.
--
-- Duas coisas diferentes que o modelo passa a separar sem ambiguidade:
--   "pontua no evento"            → toda classe, pela tabela 5/4/3/2/1 (+10)
--   "é elegível ao Super Overall" → só onde a classe estiver marcada
--
-- Migration não destrutiva: colunas novas com padrão e uma tabela nova.
-- ============================================================================

-- ------------------------------------------------------- catálogo de classes
-- As classes de competição existem por divisão de cada evento e não respondem
-- à pergunta da elegibilidade fora dele — a importação de pontuações traz a
-- classe como texto e não está presa a um evento do MCI. Este catálogo é onde
-- o operador governa a lista, e onde os dois caminhos resolvem a elegibilidade.
CREATE TABLE "ClassCatalog" (
  "id"                   TEXT NOT NULL,
  "organizationId"       TEXT NOT NULL,
  "code"                 TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "superOverallEligible" BOOLEAN NOT NULL DEFAULT false,
  "active"               BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"            INTEGER NOT NULL DEFAULT 0,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClassCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassCatalog_organizationId_code_key" ON "ClassCatalog" ("organizationId", "code");
CREATE INDEX "ClassCatalog_organizationId_active_idx" ON "ClassCatalog" ("organizationId", "active");

ALTER TABLE "ClassCatalog" ADD CONSTRAINT "ClassCatalog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------- CompetitionClass
ALTER TABLE "CompetitionClass" ADD COLUMN "superOverallEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompetitionClass" ADD COLUMN "active"               BOOLEAN NOT NULL DEFAULT true;

-- --------------------------------------------------------------- RankingPoint
-- Gravada, e não consultada na leitura: mudar a configuração de uma classe não
-- pode reescrever a história de um campeonato já encerrado.
ALTER TABLE "RankingPoint" ADD COLUMN "superOverallEligible" BOOLEAN NOT NULL DEFAULT false;

-- -------------------------------------------------------- MuscleWarImportItem
-- Campos que o importador não tinha e que a regra exige. `isOverallChampion` é
-- DADO INFORMADO pela origem: a pontuação do Overall é regra homologada, mas
-- quem é o campeão o sistema não deduz.
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "isOverallChampion" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "teamName"          TEXT;

-- O catálogo é dado operacional da organização: quem é membro lê, quem opera
-- escreve. Mesma postura das demais tabelas de estrutura.
ALTER TABLE "ClassCatalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassCatalog" FORCE ROW LEVEL SECURITY;

CREATE POLICY catalogo_leitura ON "ClassCatalog" FOR SELECT USING (true);

CREATE POLICY catalogo_escrita ON "ClassCatalog" FOR ALL
  USING (mci_operator_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));
