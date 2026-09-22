-- O CATÁLOGO OFICIAL DE CATEGORIAS, COMO MIGRATION.
--
-- POR QUE ELE NÃO ESTAVA LÁ
--
-- O deploy roda `prisma migrate deploy` no pre-deploy e NUNCA rodou o seed.
-- `prisma/seed.js` é o único lugar que cria as categorias oficiais — então a
-- tabela `Category` nasceu vazia na base da federação e nunca foi preenchida.
--
-- O QUE ISSO CUSTOU, MEDIDO
--
-- Os 191 resultados do Ipiranga foram importados contra esse catálogo vazio.
-- A guarda que recusa categoria desconhecida existia, mas ficava DEPOIS da
-- resolução do atleta — e a base de atletas também estava vazia, que é o
-- caminho normal do histórico oficial. Toda linha saía como MATCH_PENDING
-- antes de chegar na guarda. Resultado: "191 aplicados, 0 conflitos", com
-- `categoryId` NULO nas 191 e o ranking mostrando "Geral".
--
-- A guarda foi movida para antes da resolução do atleta, no mesmo commit.
-- Esta migration resolve a outra metade: o catálogo passa a ser provisionado
-- pelo caminho que o deploy JÁ percorre.
--
-- POR QUE MIGRATION, E NÃO "rode o seed em produção"
--
-- O catálogo é pré-requisito do domínio, não dado de exemplo: sem ele nenhum
-- resultado tem recorte, e a plataforma aceita importação que não significa
-- nada. Pré-requisito de domínio pertence ao caminho reproduzível.
--
-- E o seed faz MAIS do que isto — critérios de julgamento, comunidades,
-- classes iniciais. Rodá-lo inteiro em produção para consertar uma tabela
-- teria alcance muito maior que o problema.
--
-- IDEMPOTENTE E NÃO DESTRUTIVA
--
-- `ON CONFLICT (code) DO NOTHING`: onde a categoria já existir, nada é
-- tocado — nem nome, nem sexo, nem ordem, nem `active`. Rodar duas vezes não
-- muda nada. Nenhum UPDATE, nenhum DELETE, nenhum DROP.
--
-- NÃO ALTERA OS 191 LANÇAMENTOS. Esta migration escreve em `Category` e em
-- mais nada. `RankingPoint` não é tocado: `categoryId` continua nulo onde
-- estava nulo, e a reconstituição da classe segue sendo trabalho do backfill,
-- que é outra decisão e outra autorização.
--
-- OS IDENTIFICADORES SÃO FIXOS, e não gerados. `Category.id` é `cuid()` do
-- lado do cliente — o banco não tem default —, então a migration precisa
-- fornecê-los. Literais fixos tornam a carga auditável e idêntica em qualquer
-- ambiente: a mesma categoria tem o mesmo id em QA e em produção, o que faz
-- dumps e comparações entre ambientes pararem de divergir por acidente.
--
-- A LISTA É A DE `prisma/seed.js`, na mesma ordem e com os mesmos códigos.
-- `tests/catalogo-oficial-de-categorias.test.mjs` confere que as duas não
-- divergem — se alguém acrescentar categoria em um lugar só, o teste reprova.

INSERT INTO "Category" ("id", "code", "name", "sex", "sortOrder", "active", "createdAt", "updatedAt") VALUES
  ('cat_mci_mens_bodybuilding',   'MENS_BODYBUILDING',   'Men''s Bodybuilding',   'MALE',    10,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_mens_physique',       'MENS_PHYSIQUE',       'Men''s Physique',       'MALE',    20,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_classic_physique',    'CLASSIC_PHYSIQUE',    'Classic Physique',      'MALE',    30,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_bodybuilding_212',    'BODYBUILDING_212',    '212 Bodybuilding',      'MALE',    40,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_womens_bodybuilding', 'WOMENS_BODYBUILDING', 'Women''s Bodybuilding', 'FEMALE',  50,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_womens_physique',     'WOMENS_PHYSIQUE',     'Women''s Physique',     'FEMALE',  60,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_wellness',            'WELLNESS',            'Wellness',              'FEMALE',  70,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_bikini',              'BIKINI',              'Bikini',                'FEMALE',  80,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_fitness',             'FITNESS',             'Fitness',               'FEMALE',  90,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_figure',              'FIGURE',              'Figure',                'FEMALE', 100,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cat_mci_fitmodel',            'FITMODEL',            'Fitmodel',              'FEMALE', 110,  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
