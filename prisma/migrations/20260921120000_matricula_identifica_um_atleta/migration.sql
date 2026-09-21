-- ===========================================================================
-- A MATRÍCULA IDENTIFICA UMA PESSOA DENTRO DA FEDERAÇÃO.
--
-- O QUE ESTA MIGRATION FECHA
--
-- O banco aceitava dois cadastros com a MESMA matrícula na MESMA filiação, e
-- o vínculo tardio lidava com isso defensivamente: ao encontrar dois donos,
-- recusava vincular e marcava CONFLITO. Correto, e insuficiente — porque a
-- ambiguidade podia aparecer DEPOIS do vínculo.
--
-- A sequência que quebrava: cadastra-se a primeira pessoa com NPC-123; naquele
-- instante ela é dona única, o vínculo é inequívoco, o histórico vai para ela.
-- Semanas depois cadastra-se a segunda com o mesmo número. Agora há dois
-- donos — e o ponto já está somando no ranking do primeiro, por ordem de
-- chegada. Recusar o vínculo quando a ambiguidade nasce não desfaz nada.
--
-- Por isso o estado deixa de ser possível, em vez de ser tratado.
--
-- POR QUE UM ÍNDICE PARCIAL
--
-- Atleta sem filiação registrada existe aos montes, e todos têm
-- `affiliationNumber` nulo. Um índice único comum trataria cada nulo como
-- valor distinto no PostgreSQL — funcionaria —, mas o predicado explícito diz
-- a INTENÇÃO: a regra vale para quem tem os dois campos, e só para esses.
--
-- POR QUE A GUARDA VEM ANTES
--
-- Se já existirem duplicatas, `CREATE UNIQUE INDEX` falha com uma mensagem que
-- aponta para uma linha e não conta o tamanho do problema. Quem estiver
-- migrando precisa saber QUANTOS pares estão duplicados e QUAIS, para decidir
-- antes de tentar de novo — e precisa que a migration pare inteira, em vez de
-- aplicar metade.
-- ===========================================================================

DO $$
DECLARE
  duplicados int;
  exemplos text;
BEGIN
  SELECT count(*), COALESCE(string_agg(amostra, '; '), '')
    INTO duplicados, exemplos
  FROM (
    SELECT "organizationId" || '/' || "affiliationId" || '/' || "affiliationNumber"
           || ' (' || count(*) || ' cadastros)' AS amostra
    FROM "Athlete"
    WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL
    GROUP BY "organizationId", "affiliationId", "affiliationNumber"
    HAVING count(*) > 1
    LIMIT 20
  ) AS pares;

  IF duplicados > 0 THEN
    RAISE EXCEPTION
      'Existem % matrícula(s) com mais de um cadastro na mesma filiação. '
      'A unicidade NÃO foi aplicada e nada foi alterado. '
      'Resolva os cadastros duplicados antes de repetir esta migration. Pares: %',
      duplicados, exemplos;
  END IF;
END
$$;

CREATE UNIQUE INDEX "Athlete_organizationId_affiliationId_affiliationNumber_key"
  ON "Athlete" ("organizationId", "affiliationId", "affiliationNumber")
  WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL;
