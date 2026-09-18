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
-- perderia o "antes". Invalidar zera o que PONTUA (`points`, `overallBonus`,
-- `superOverallPoints`) e não toca no que ACONTECEU: `placing` e
-- `placementPoints` seguem como estavam. É por isso que restaurar não precisa
-- adivinhar nada — a linha já guarda o estado de antes da invalidação.
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

-- PROVENIÊNCIA, e não destino da restauração: registra a colocação com que o
-- lançamento NASCEU, para que a auditoria possa dizer de onde ele partiu depois
-- de uma ou mais correções. Gravada na primeira alteração e nunca reescrita.
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "placingOriginal" INTEGER;

-- Só os invalidados. Índice parcial porque a consulta que importa é "o que foi
-- invalidado neste evento", e não uma varredura do ledger inteiro.
CREATE INDEX IF NOT EXISTS "RankingPoint_voidedAt_idx"
  ON "RankingPoint" ("seasonId", "voidedAt") WHERE "voidedAt" IS NOT NULL;
