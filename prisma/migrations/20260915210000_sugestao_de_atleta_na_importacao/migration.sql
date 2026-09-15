-- Reconhecimento por filiação + matrícula, e a SUGESTÃO por nome.
--
-- Duas colunas em "MuscleWarImportItem":
--
--   memberNumber        a matrícula informada pelo arquivo (o "Member Number"
--                       dos arquivos oficiais). Guardada na linha como todo o
--                       resto do que a origem informou, para que a decisão do
--                       operador seja conferível contra o que estava escrito.
--
--   suggestedAthleteId  a pista por semelhança de nome. É SUGESTÃO e nunca
--                       vínculo: fica numa coluna DIFERENTE de `athleteId`
--                       justamente para que nenhum caminho de aplicação a
--                       confunda com reconhecimento. Semelhança de nome não
--                       reconhece ninguém — duas atletas chamadas "Ana Silva"
--                       existem, e fundir as duas num cadastro só apaga uma
--                       carreira.
--
-- Aditiva e anulável: nenhuma linha existente é alterada, nenhuma política de
-- RLS é tocada, nenhum índice é removido. Lotes já importados continuam
-- exatamente como estão.

ALTER TABLE "MuscleWarImportItem" ADD COLUMN IF NOT EXISTS "memberNumber" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN IF NOT EXISTS "suggestedAthleteId" TEXT;

CREATE INDEX IF NOT EXISTS "MuscleWarImportItem_suggestedAthleteId_idx"
  ON "MuscleWarImportItem"("suggestedAthleteId");

DO $$
BEGIN
  ALTER TABLE "MuscleWarImportItem"
    ADD CONSTRAINT "MuscleWarImportItem_suggestedAthleteId_fkey"
    FOREIGN KEY ("suggestedAthleteId") REFERENCES "Athlete"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Índice que serve ao reconhecimento pelo par filiação + matrícula. Sem ele a
-- busca por matrícula varre a tabela de atletas a cada linha do arquivo.
CREATE INDEX IF NOT EXISTS "Athlete_affiliationId_affiliationNumber_idx"
  ON "Athlete"("affiliationId", "affiliationNumber");
