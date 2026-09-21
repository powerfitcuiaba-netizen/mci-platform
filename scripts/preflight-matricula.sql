-- ===========================================================================
-- PREFLIGHT DA MIGRATION 20260921120000_matricula_identifica_um_atleta
--
-- SOMENTE LEITURA. Não há INSERT, UPDATE, DELETE, CREATE INDEX nem DDL de
-- espécie nenhuma neste arquivo. Ele não altera uma linha.
--
-- COMO RODAR
--
--   psql "<conexao-de-producao>" -v ON_ERROR_STOP=1 -f preflight.sql
--
-- ATENÇÃO — A ARMADILHA DESTE DIAGNÓSTICO:
--
-- As tabelas usam FORCE ROW LEVEL SECURITY. Rodado pelo papel da APLICAÇÃO
-- sem contexto de usuário, todo SELECT devolve ZERO LINHAS — e "0 duplicidades"
-- seria uma resposta falsa, indistinguível da verdadeira.
--
-- Por isso a PARTE 0 vem primeiro e emite um VEREDITO explícito sobre a
-- própria leitura. Se o veredito disser LEITURA NAO CONFIAVEL, o resto do
-- arquivo não significa nada: rode de novo como o papel de backup
-- (`mci_backup`, BYPASSRLS e somente leitura) ou como o administrador do banco.
-- ===========================================================================

\echo ''
\echo '=== PARTE 0 — esta conexão enxerga o dado? ==='
SELECT
  current_user                                          AS papel,
  (SELECT rolbypassrls FROM pg_roles
     WHERE rolname = current_user)                      AS papel_ignora_rls,
  c.relrowsecurity                                      AS athlete_tem_rls,
  c.relforcerowsecurity                                 AS athlete_tem_force_rls,
  (SELECT count(*) FROM "Athlete")                      AS atletas_visiveis,
  (SELECT count(*) FROM "Athlete"
     WHERE "affiliationId" IS NOT NULL
       AND "affiliationNumber" IS NOT NULL)             AS no_dominio_da_regra,
  CASE
    WHEN (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user)
      THEN 'LEITURA CONFIAVEL: o papel ignora RLS'
    WHEN NOT c.relrowsecurity
      THEN 'LEITURA CONFIAVEL: a tabela nao tem RLS'
    WHEN (SELECT count(*) FROM "Athlete") = 0
      THEN 'LEITURA NAO CONFIAVEL: zero atletas sob RLS ativo -- pode ser o RLS escondendo tudo. PARE.'
    ELSE 'LEITURA PARCIAL: RLS ativo e o papel ve so parte dos atletas. PARE.'
  END                                                   AS veredito
FROM pg_class c
WHERE c.oid = '"Athlete"'::regclass;

\echo ''
\echo '=== PARTE 1 — a mesma conta que a migration faz ==='
SELECT count(*) AS pares_duplicados
FROM (
  SELECT 1
  FROM "Athlete"
  WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL
  GROUP BY "organizationId", "affiliationId", "affiliationNumber"
  HAVING count(*) > 1
) AS pares;

\echo ''
\echo '=== PARTE 2 — se houver duplicidade, quem está envolvido ==='
\echo '(sem CPF: a coluna diz apenas SE existe identidade cadastrada)'
WITH duplicados AS (
  SELECT "organizationId", "affiliationId", "affiliationNumber"
  FROM "Athlete"
  WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL
  GROUP BY "organizationId", "affiliationId", "affiliationNumber"
  HAVING count(*) > 1
)
SELECT
  o."name"                                    AS organizacao,
  a."organizationId",
  f."code"                                    AS filiacao_codigo,
  a."affiliationId",
  a."affiliationNumber"                       AS matricula,
  a."id"                                      AS athlete_id,
  a."fullName"                                AS nome,
  a."stageName"                               AS nome_esportivo,
  a."athleteNumber"                           AS numero_de_atleta,
  a."proStatus"                               AS situacao_pro,
  a."createdAt"                               AS cadastrado_em,
  (a."userId" IS NOT NULL)                    AS tem_conta_vinculada,
  EXISTS (SELECT 1 FROM "AthleteIdentity" i
            WHERE i."athleteId" = a."id")     AS tem_cpf_cadastrado,
  -- RESULTADOS HISTÓRICOS, por origem
  (SELECT count(*) FROM "RankingPoint" rp
     WHERE rp."athleteId" = a."id")           AS pontos_de_ranking,
  (SELECT count(*) FROM "RankingPoint" rp
     WHERE rp."athleteId" = a."id"
       AND rp."voidedAt" IS NULL)             AS pontos_validos,
  (SELECT COALESCE(sum(rp."points"), 0) FROM "RankingPoint" rp
     WHERE rp."athleteId" = a."id"
       AND rp."voidedAt" IS NULL)             AS soma_de_pontos,
  (SELECT count(*) FROM "ExternalResult" er
     WHERE er."athleteId" = a."id")           AS resultados_importados,
  (SELECT count(*) FROM "ResultEntry" re
     WHERE re."athleteId" = a."id")           AS resultados_oficiais,
  (SELECT count(*) FROM "EventOverallTitle" t
     WHERE t."athleteId" = a."id")            AS titulos_overall,
  -- DEMAIS VÍNCULOS
  (SELECT count(*) FROM "Registration" r
     WHERE r."athleteId" = a."id")            AS inscricoes,
  (SELECT count(*) FROM "AthleteTeamMembership" m
     WHERE m."athleteId" = a."id")            AS vinculos_de_equipe,
  (SELECT count(*) FROM "ExternalAthlete" ea
     WHERE ea."athleteId" = a."id")           AS identidades_externas_adotadas,
  (SELECT count(*) FROM "MuscleWarImportItem" ii
     WHERE ii."athleteId" = a."id")           AS linhas_de_importacao,
  EXISTS (SELECT 1 FROM "SocialProfile" sp
            WHERE sp."athleteId" = a."id")    AS tem_perfil_social
FROM "Athlete" a
JOIN duplicados d
  ON  d."organizationId"   = a."organizationId"
  AND d."affiliationId"    = a."affiliationId"
  AND d."affiliationNumber" = a."affiliationNumber"
LEFT JOIN "Organization" o ON o."id" = a."organizationId"
LEFT JOIN "Affiliation"  f ON f."id" = a."affiliationId"
ORDER BY a."organizationId", a."affiliationId", a."affiliationNumber", a."createdAt";
