-- A filiação da ÉPOCA, gravada no ponto de ranking.
--
-- `RankingPoint` já congelava equipe, empresa, classe e elegibilidade no
-- momento da atribuição, justamente para que mudanças de cadastro posteriores
-- não reescrevessem a história. A filiação ficava de fora: era lida do
-- cadastro atual do atleta na hora da consulta, de modo que uma troca de
-- federação transferia para a nova entidade pontos que a antiga tinha ganho.
--
-- São DUAS colunas porque filiação são duas coisas — a entidade e a matrícula
-- do atleta dentro dela. Duas federações podem emitir o mesmo número, e a
-- entidade sozinha não diz por qual registro o resultado foi reconhecido.
--
-- A matrícula é COPIADA, não referenciada: ela pode mudar dentro da mesma
-- entidade, e o retrato precisa sobreviver a essa mudança.
--
-- Aditiva e anulável: nenhuma linha existente é alterada, e os pontos
-- históricos permanecem com filiação NULA — que é a verdade sobre eles, e não
-- um valor presumido. Presumir a filiação atual para o passado seria
-- exatamente o defeito que esta migration existe para corrigir.

ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "affiliationId" TEXT;
ALTER TABLE "RankingPoint" ADD COLUMN IF NOT EXISTS "affiliationNumber" TEXT;

CREATE INDEX IF NOT EXISTS "RankingPoint_seasonId_affiliationId_idx"
  ON "RankingPoint"("seasonId", "affiliationId");

DO $$
BEGIN
  ALTER TABLE "RankingPoint"
    ADD CONSTRAINT "RankingPoint_affiliationId_fkey"
    FOREIGN KEY ("affiliationId") REFERENCES "Affiliation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
