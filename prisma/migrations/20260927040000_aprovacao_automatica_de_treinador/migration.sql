-- ==========================================================================
-- APROVAÇÃO AUTOMÁTICA DO CADASTRO DE TREINADOR (EQUIPE).
--
-- DECISÃO DE NEGÓCIO, e ela MUDA R-03.
--
-- R-03 dizia que só a administração central da MuscleContest aprova ou recusa o
-- cadastro de treinador. A decisão nova retira a análise manual do caminho do
-- cadastro NOVO: quem preenche o formulário corretamente entra no sistema na
-- hora. O que NÃO muda, e continua sendo R-04: aprovação de cadastro não é
-- autorização para atuar em federação nenhuma. São duas decisões diferentes, de
-- duas autoridades diferentes, e só a primeira ficou automática.
--
-- POR QUE UMA COLUNA NOVA, E NÃO SÓ `status = 'APPROVED'`
--
-- Três estados passam a existir, e sem esta coluna dois deles ficam
-- indistinguíveis no banco:
--
--   1. aprovado POR PESSOA        `reviewedById` e `reviewedAt` preenchidos
--   2. aprovado PELA REGRA        `autoApprovedAt` preenchido
--   3. aprovado pela MIGRATION    os três nulos — o legado do achado A-05
--      de 20260926020000
--
-- O estado 3 é o que `20260927030000` devolve a PENDING, com o predicado
-- `"reviewedById" IS NULL AND "reviewedAt" IS NULL`. Se a aprovação automática
-- gravasse apenas `status`, ela cairia nesse mesmo predicado e a próxima
-- execução daquela migration derrubaria treinadores legítimos para pendente.
--
-- Por isso a aprovação automática grava `autoApprovedAt` E `reviewedAt` — o
-- segundo tira a linha do predicado do legado; o primeiro diz POR QUE ela está
-- fora dele. Sem os dois, ou o legado atropela o novo, ou quem lê a linha não
-- tem como saber se houve pessoa.
--
-- NADA RETROATIVO. Nenhuma linha existente é alterada: a coluna nasce nula em
-- todas, e cadastro antigo que está PENDING continua PENDING, esperando a
-- análise específica que a decisão nova não dispensa para o passado.
-- ==========================================================================

ALTER TABLE "Coach" ADD COLUMN "autoApprovedAt" TIMESTAMP(3);

-- Índice parcial: a pergunta operacional é "quais foram aprovados pela regra?",
-- e ela só interessa nas linhas que têm a data. Índice cheio numa coluna quase
-- toda nula é espaço e escrita sem leitor.
CREATE INDEX "Coach_autoApprovedAt_idx" ON "Coach" ("autoApprovedAt")
  WHERE "autoApprovedAt" IS NOT NULL;
