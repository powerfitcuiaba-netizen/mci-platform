-- ============================================================================
-- Duas métricas separadas: pontos do campeonato e pontos elegíveis ao
-- Super Overall anual.
--
-- REGRA HOMOLOGADA (fase 11.3): todas as classes pontuam no Campeonato
-- Brasileiro pela tabela 5/4/3/2/1 (+10 do Overall). SOMENTE a OPEN alimenta o
-- ranking classificatório do Super Overall anual.
--
-- Até aqui o modelo respondia a segunda pergunta com um BOOLEANO
-- (`superOverallEligible`), e o ranking do Super Overall somava `points`
-- filtrando por ele. Dá o mesmo número, mas deixa a segunda métrica implícita:
-- para saber quanto um lançamento vale no Super Overall era preciso conhecer a
-- regra e refazer a conta. Agora o valor está gravado:
--
--   points               → pontos do CAMPEONATO   (toda classe)
--   superOverallPoints   → pontos do SUPER OVERALL (só onde elegível)
--
-- O booleano PERMANECE: é o fato registrado ("esta classe era elegível quando
-- o ponto foi atribuído"), enquanto a coluna nova é a consequência aritmética
-- dele. Guardar os dois permite auditar a decisão e o número separadamente, e
-- é o que mantém a história de um campeonato encerrado intacta quando a
-- configuração da classe muda depois.
--
-- O bônus de Overall segue a elegibilidade da participação que o originou: um
-- Overall conquistado numa classe não elegível soma no campeonato e NÃO soma
-- no Super Overall. A regra esportiva não define outro tratamento, e presumir
-- um seria inventar regulamento.
--
-- Migration não destrutiva: uma coluna nova com padrão, preenchida a partir do
-- que já está gravado. Nenhum DROP, nenhuma tabela recriada, nenhum dado
-- apagado.
-- ============================================================================

ALTER TABLE "RankingPoint" ADD COLUMN "superOverallPoints" INTEGER NOT NULL DEFAULT 0;

-- Backfill derivado do fato já registrado em cada linha: onde a classe era
-- elegível, os pontos do campeonato são também os do Super Overall. O
-- resultado é idêntico ao que a consulta antiga calculava em tempo de leitura,
-- de modo que nenhum ranking muda de valor por causa desta migration.
UPDATE "RankingPoint" SET "superOverallPoints" = "points" WHERE "superOverallEligible" = true;

-- Consulta do ranking anual: filtra por elegibilidade e soma a coluna nova.
CREATE INDEX "RankingPoint_seasonId_superOverallEligible_idx"
  ON "RankingPoint" ("seasonId", "superOverallEligible");

-- ------------------------------- divergência de pontuação na importação -----
-- A regra manda gerar CONFLICT quando o número de pontos do arquivo não bate
-- com o que a regra oficial calcula. O motivo em texto explica; esta coluna
-- guarda os três números para que a tela do operador os mostre lado a lado sem
-- precisar interpretar a frase:
--   { importedPoints, calculatedPoints, difference }
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "pointsMismatch" JSONB;
