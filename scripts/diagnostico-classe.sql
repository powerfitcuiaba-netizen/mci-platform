-- ==========================================================================
-- DIAGNÓSTICO DA TAXONOMIA DE CLASSE — SOMENTE LEITURA.
--
--   psql "$DATABASE_URL" -f scripts/diagnostico-classe.sql
--
-- Responde as oito perguntas do GATE 20 sobre os lançamentos históricos já
-- aplicados. NENHUMA delas escreve: não há INSERT, UPDATE, DELETE, ALTER,
-- CREATE, DROP, TRUNCATE nem BEGIN. São SELECTs e nada mais — é isso que
-- `tests/diagnostico-classe.test.mjs` confere, linha a linha, para que a
-- garantia não dependa de alguém reler o arquivo.
--
-- NÃO SELECIONA CPF, telefone, e-mail nem data de nascimento. A pergunta é
-- sobre categoria e classe; dado de pessoa não tem recorte onde aparecer, e
-- diagnóstico é justamente o texto que circula por mais gente.
--
-- O QUE A SAÍDA NÃO PROVA: rodando como `mci_app` sob FORCE ROW LEVEL
-- SECURITY e sem contexto de ator, as tabelas do ledger devolvem ZERO LINHA.
-- Zero aqui significa "esta conexão não enxerga", e NÃO "não existe". A
-- PARTE 0 abaixo existe para que quem lê a saída saiba em qual dos dois casos
-- está antes de interpretar qualquer número.
-- ==========================================================================

\echo ''
\echo '=== PARTE 0 — QUEM ESTÁ PERGUNTANDO (sem isto os zeros não significam nada)'
SELECT
  current_database()                                    AS banco,
  current_user                                          AS usuario,
  (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS ignora_rls,
  (SELECT relrowsecurity FROM pg_class WHERE relname = 'RankingPoint')     AS rls_no_ledger,
  (SELECT relforcerowsecurity FROM pg_class WHERE relname = 'RankingPoint') AS force_rls_no_ledger;

\echo ''
\echo '=== 1..6 — OS LANÇAMENTOS IMPORTADOS, EM UMA LINHA'
SELECT
  count(*)                                           AS lancamentos,
  count(*) FILTER (WHERE "categoryId"     IS NOT NULL) AS com_categoria,
  count(*) FILTER (WHERE "catalogClassId" IS NOT NULL) AS com_classe_do_catalogo,
  count(*) FILTER (WHERE "classId"        IS NOT NULL) AS com_classe_de_evento,
  count(*) FILTER (WHERE "athleteId"      IS NOT NULL) AS com_atleta,
  count(*) FILTER (WHERE points > 0)                   AS com_pontos,
  count(*) FILTER (WHERE "didNotShow")                 AS nao_compareceu,
  coalesce(sum(points), 0)                             AS soma_dos_pontos
FROM "RankingPoint"
WHERE source = 'MUSCLEWAR';

\echo ''
\echo '=== 6 — QUANTOS TÊM O TEXTO DA CLASSE NA ORIGEM (é dele que o reparo parte)'
SELECT
  count(*)                                             AS resultados_externos,
  count(*) FILTER (WHERE "className" IS NOT NULL)      AS com_texto_de_classe,
  count(*) FILTER (WHERE "categoryCode" IS NOT NULL)   AS com_codigo_de_categoria
FROM "ExternalResult";

\echo ''
\echo '=== 7 — DISTRIBUIÇÃO POR CATEGORIA'
SELECT
  coalesce(c.code, '(sem categoria)') AS categoria,
  count(*)                            AS lancamentos,
  count(*) FILTER (WHERE p."catalogClassId" IS NULL) AS sem_classe,
  coalesce(sum(p.points), 0)          AS pontos
FROM "RankingPoint" p
LEFT JOIN "Category" c ON c.id = p."categoryId"
WHERE p.source = 'MUSCLEWAR'
GROUP BY 1
ORDER BY 1;

\echo ''
\echo '=== 8 — DISTRIBUIÇÃO POR CLASSE, PELO TEXTO DA ORIGEM'
SELECT
  coalesce(e."categoryCode", '(sem categoria)') AS categoria,
  coalesce(e."className", '(sem classe)')       AS classe_na_origem,
  count(*)                                      AS lancamentos,
  count(*) FILTER (WHERE p."catalogClassId" IS NOT NULL) AS ja_resolvidos
FROM "RankingPoint" p
JOIN "ExternalResult" e ON e.id = p."externalResultId"
WHERE p.source = 'MUSCLEWAR'
GROUP BY 1, 2
ORDER BY 1, 2;

\echo ''
\echo '=== CATÁLOGO ATUAL — as genéricas têm categoria NULA e precisam continuar tendo'
SELECT
  o.name                                  AS organizacao,
  cc.code,
  coalesce(cc."displayName", cc.name)     AS exibicao,
  coalesce(cat.code, '(genérica)')        AS categoria,
  cc."superOverallEligible"               AS super_overall,
  cc.active
FROM "ClassCatalog" cc
JOIN "Organization" o ON o.id = cc."organizationId"
LEFT JOIN "Category" cat ON cat.id = cc."categoryId"
ORDER BY o.name, cat.code NULLS FIRST, cc.code;

\echo ''
\echo '=== ÍNDICES DE UNICIDADE DO CATÁLOGO (as duas regras precisam existir)'
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'ClassCatalog'
ORDER BY indexname;

\echo ''
\echo '=== FIM — nenhuma linha foi escrita por este arquivo.'
