-- TAXONOMIA: CATEGORIA E CLASSE SÃO DUAS COISAS, E A CLASSE PRECISA DE DONO.
--
-- O QUE ESTA MIGRATION RESOLVE
--
-- "Women's Physique - Masters 35+" sempre foi decomposto corretamente pelo
-- adaptador em categoria WOMENS_PHYSIQUE + divisão Masters + rótulo 35+.
-- O que não existia era ONDE GUARDAR a classe resolvida: `RankingPoint.classId`
-- aponta para `CompetitionClass`, que só existe por divisão DE UM EVENTO do
-- MCI. Resultado histórico importado não tem evento do MCI, então `classId`
-- nascia nulo e o recorte `/ranking/by?classId=` nunca devolveu uma linha
-- importada — os 191 do Ipiranga entre elas.
--
-- `ClassCatalog` já era da organização e já era o lugar certo. Faltavam a
-- categoria e o nome de apresentação.
--
-- NÃO DESTRUTIVA
--
-- Nenhum DROP TABLE, nenhum TRUNCATE, nenhum DELETE. Todas as colunas novas
-- são anuláveis e nascem nulas. As quatro classes genéricas de cada
-- organização (ESTREANTE, NOVICE, OPEN, MASTER) ficam com `categoryId` NULO,
-- que é exatamente o significado que elas já tinham: valem para qualquer
-- categoria. Nenhuma linha é reescrita por esta migration.
--
-- IDEMPOTENTE: todo comando usa IF EXISTS / IF NOT EXISTS.

-- ---------------------------------------------------------------- colunas

ALTER TABLE "ClassCatalog"       ADD COLUMN IF NOT EXISTS "categoryId"     TEXT;
ALTER TABLE "ClassCatalog"       ADD COLUMN IF NOT EXISTS "displayName"    TEXT;
ALTER TABLE "RankingPoint"       ADD COLUMN IF NOT EXISTS "catalogClassId" TEXT;
ALTER TABLE "PublicRankingEntry" ADD COLUMN IF NOT EXISTS "catalogClassId" TEXT;

-- ------------------------------------------------- unicidade: DUAS REGRAS
--
-- POR QUE O ÍNDICE ANTIGO SAI, E POR QUE O NOVO É SQL ESCRITO À MÃO.
--
-- O antigo, UNIQUE (organizationId, code), impediria a mesma organização de
-- ter OPEN de Women's Physique e OPEN de Men's Physique ao mesmo tempo — que
-- é justamente o que esta fase precisa permitir. Ele sai; nenhuma linha sai
-- com ele.
--
-- O substituto NÃO pode ser um UNIQUE simples sobre as três colunas. Em
-- PostgreSQL, NULL é distinto de NULL num índice único, então
-- (NPC, NULL, 'OPEN') entraria DUAS VEZES sem violar nada, e a organização
-- ganharia duas classes genéricas OPEN. Medido nesta base, PG 16.13: o
-- UNIQUE simples aceitou a duplicata e a tabela ficou com 2 linhas.
--
-- Há duas saídas corretas. `UNIQUE ... NULLS NOT DISTINCT` (PG 15+) foi
-- medido e funciona — recusa a duplicata genérica e continua permitindo
-- (NPC,NULL,OPEN) ao lado de (NPC,WOMENS_PHYSIQUE,OPEN). A escolhida foi a
-- outra: DOIS ÍNDICES PARCIAIS, que dizem as duas regras separadamente,
-- valem em qualquer versão do PostgreSQL, e nomeiam no erro qual das duas
-- foi violada — "ClassCatalog_generica" ou "ClassCatalog_especifica" — em
-- vez de um nome só para os dois casos.
--
-- Prisma não expressa índice parcial. Por isso a unicidade NÃO está
-- declarada em schema.prisma e vive aqui. O teste
-- tests/taxonomia-de-classe.test.mjs confere que os dois índices existem no
-- banco: índice que só existe na migration some sem aviso no primeiro
-- `db push`, e foi assim que esta base já perdeu a coluna maxHeightCm.

DROP INDEX IF EXISTS "ClassCatalog_organizationId_code_key";

-- Uma classe genérica por (organização, código).
CREATE UNIQUE INDEX IF NOT EXISTS "ClassCatalog_generica"
  ON "ClassCatalog" ("organizationId", "code")
  WHERE "categoryId" IS NULL;

-- Uma classe por (organização, categoria, código).
CREATE UNIQUE INDEX IF NOT EXISTS "ClassCatalog_especifica"
  ON "ClassCatalog" ("organizationId", "categoryId", "code")
  WHERE "categoryId" IS NOT NULL;

-- ----------------------------------------------------------------- índices

CREATE INDEX IF NOT EXISTS "ClassCatalog_organizationId_categoryId_code_idx"
  ON "ClassCatalog" ("organizationId", "categoryId", "code");

CREATE INDEX IF NOT EXISTS "RankingPoint_seasonId_catalogClassId_idx"
  ON "RankingPoint" ("seasonId", "catalogClassId");

CREATE INDEX IF NOT EXISTS "PublicRankingEntry_seasonId_catalogClassId_idx"
  ON "PublicRankingEntry" ("seasonId", "catalogClassId");

CREATE INDEX IF NOT EXISTS "PublicRankingEntry_seasonId_categoryId_catalogClassId_idx"
  ON "PublicRankingEntry" ("seasonId", "categoryId", "catalogClassId");

-- ------------------------------------------------------------ chaves estrangeiras
--
-- ClassCatalog.categoryId CASCADE: apagar uma categoria apaga as classes que
-- só existiam dentro dela — não há classe de categoria nenhuma.
--
-- RankingPoint.catalogClassId SET NULL: o lançamento é história e não pode
-- desaparecer porque alguém desativou uma classe. Perde o recorte, mantém o
-- ponto — a mesma escolha que `classId` já fazia.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClassCatalog_categoryId_fkey') THEN
    ALTER TABLE "ClassCatalog"
      ADD CONSTRAINT "ClassCatalog_categoryId_fkey"
      FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RankingPoint_catalogClassId_fkey') THEN
    ALTER TABLE "RankingPoint"
      ADD CONSTRAINT "RankingPoint_catalogClassId_fkey"
      FOREIGN KEY ("catalogClassId") REFERENCES "ClassCatalog"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
