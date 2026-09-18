-- INVALIDAR UM LANÇAMENTO SEM APAGAR A HISTÓRIA.
--
-- O caminho interno já corrige resultado publicado: `results.override` grava
-- um `ResultVersion` com snapshot e motivo, e a apuração é refeita do zero. O
-- caminho IMPORTADO não tinha nada — depois de aplicado, um erro de súmula
-- não tinha conserto pelo fluxo previsto.
--
-- Três colunas ANULÁVEIS, sem DEFAULT, sem constraint nova: nenhuma linha
-- existente muda de valor, e nenhuma leitura atual passa a enxergar coisa
-- diferente. Quem não foi invalidado tem `voidedAt` nulo, que é exatamente o
-- estado de todos os lançamentos de hoje.
--
-- POR QUE NÃO APAGAR A LINHA: o ponto é o registro de que o atleta competiu.
-- Apagá-lo faria a participação desaparecer do histórico dele, e a auditoria
-- perderia o "antes". Invalidar zera o que PONTUA e preserva o que ACONTECEU —
-- `placementPoints` continua guardando a colocação original, que é o que
-- permite restaurar sem recalcular às cegas.
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

-- A colocação original sobrevive à invalidação e à correção. Sem ela, restaurar
-- exigiria adivinhar de onde os pontos vieram.
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "placingOriginal" INTEGER;

-- Só os invalidados. Índice parcial porque a consulta que importa é "o que foi
-- invalidado neste evento", e não uma varredura do ledger inteiro.
CREATE INDEX IF NOT EXISTS "RankingPoint_voidedAt_idx"
  ON "RankingPoint" ("seasonId", "voidedAt") WHERE "voidedAt" IS NOT NULL;
