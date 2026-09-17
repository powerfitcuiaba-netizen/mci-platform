-- O ranking público fazia SEQUENTIAL SCAN.
--
-- Medido com EXPLAIN ANALYZE, numa temporada de 5.000 linhas agregadas:
--
--   ANTES   Seq Scan em 5.000 linhas + top-N heapsort .... 2,43 ms
--   DEPOIS  Index Scan, lendo as 5 que interessam ........ 0,045 ms
--
-- 54x, mas o número não é o ponto: o ponto é que a varredura CRESCE com o
-- tamanho da temporada e o índice não. A rota é pública, anônima e devolve
-- cinco linhas — ela não pode ler a temporada inteira para isso.
--
-- As colunas e a ORDEM delas espelham exatamente o ORDER BY da consulta
-- (`position ASC, totalPoints DESC, id ASC`), que é o que permite ao
-- PostgreSQL pular o sort: um índice só por "seasonId" faria a filtragem e
-- deixaria a ordenação inteira de pé.
--
-- `id` fecha o índice porque fecha a ordenação: sem ele duas linhas empatadas
-- sairiam na ordem física da tabela, e a paginação por cursor — ancorada no id
-- — poderia repetir ou pular uma delas entre duas páginas.
--
-- Aditiva: nenhuma linha alterada, nenhum índice removido, nenhuma política de
-- RLS tocada. `IF NOT EXISTS` porque o índice pode já ter sido criado à mão
-- num ambiente de QA durante a medição.

CREATE INDEX IF NOT EXISTS "Ranking_seasonId_position_idx"
  ON "Ranking"("seasonId", "position" ASC, "totalPoints" DESC, "id" ASC);
