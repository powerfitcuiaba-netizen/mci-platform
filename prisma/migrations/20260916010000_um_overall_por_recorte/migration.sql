-- UM Overall por recorte — inclusive no recorte do evento inteiro.
--
-- `@@unique([eventId, categoryId])` parece resolver, e não resolve: no
-- PostgreSQL dois NULL são DISTINTOS entre si. O Overall do evento inteiro é
-- justamente o recorte com `categoryId` nulo, de modo que dois títulos gerais
-- cabiam na mesma tabela — e o serviço, que busca com `findFirst`, só enxergava
-- um deles.
--
-- O índice parcial abaixo fecha exatamente esse caso, e só ele: títulos com
-- categoria continuam protegidos pela unicidade que já existe.
--
-- A proteção mora no BANCO de propósito. Uma verificação em serviço perde a
-- corrida entre duas requisições simultâneas; o índice não perde.
--
-- Aditiva: nenhuma linha é alterada, nenhuma política de RLS é tocada. Se
-- houver duplicata preexistente a criação falha — e falhar alto é o
-- comportamento certo, porque duplicata aqui é dois campeões homologados no
-- mesmo evento, que ninguém deve descobrir em silêncio.

CREATE UNIQUE INDEX IF NOT EXISTS "EventOverallTitle_eventId_geral_key"
  ON "EventOverallTitle"("eventId")
  WHERE "categoryId" IS NULL;
