-- O TÍTULO OVERALL PASSA A ALCANÇAR O COMPETIDOR SEM CADASTRO.
--
-- POR QUE ISTO É NECESSÁRIO
--
-- `EventOverallTitle.athleteId` era NOT NULL e aponta para `Athlete`. O MCI
-- foi construído para carregar histórico oficial ANTES de os atletas se
-- cadastrarem: os 191 resultados do Ipiranga estão no ledger com `athleteId`
-- NULO e a identidade em `ExternalAthlete`.
--
-- Consequência medida: declarar o Overall daquele campeonato era impossível.
-- Não por regra esportiva — por forma do modelo. A organização tem o campeão
-- na súmula, a plataforma tem o resultado no ledger, e não havia onde gravar
-- o fato.
--
-- O QUE MUDA
--
-- `athleteId` passa a aceitar nulo e entra `externalAthleteId`. Um título
-- aponta para UM competidor, cadastrado ou não — nunca para os dois, nunca
-- para nenhum. A restrição CHECK abaixo é quem garante isso no banco, e não
-- uma convenção do código: convenção some na primeira escrita por outro
-- caminho.
--
-- NÃO DESTRUTIVA E REVERSÍVEL
--
-- Nenhum DROP de tabela, nenhum DELETE, nenhum TRUNCATE. Afrouxar NOT NULL e
-- acrescentar coluna nullable não invalida linha nenhuma existente: todo
-- título já gravado tem `athleteId` preenchido e satisfaz o CHECK. A
-- unicidade `(eventId, categoryId)` fica como está — um título por recorte
-- continua sendo a regra.
--
-- NÃO TOCA EM `RankingPoint`, em pontuação, em categoria nem em classe.

ALTER TABLE "EventOverallTitle" ALTER COLUMN "athleteId" DROP NOT NULL;

ALTER TABLE "EventOverallTitle" ADD COLUMN IF NOT EXISTS "externalAthleteId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EventOverallTitle_externalAthleteId_fkey'
  ) THEN
    ALTER TABLE "EventOverallTitle"
      ADD CONSTRAINT "EventOverallTitle_externalAthleteId_fkey"
      FOREIGN KEY ("externalAthleteId") REFERENCES "ExternalAthlete"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "EventOverallTitle_externalAthleteId_idx"
  ON "EventOverallTitle" ("externalAthleteId");

-- EXATAMENTE UM COMPETIDOR POR TÍTULO.
--
-- Nem zero (um título sem dono não é título), nem dois (aí o bônus teria duas
-- casas para pousar, e qual delas receberia dependeria da ordem da consulta).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'EventOverallTitle_um_competidor'
  ) THEN
    ALTER TABLE "EventOverallTitle"
      ADD CONSTRAINT "EventOverallTitle_um_competidor"
      CHECK ((("athleteId" IS NOT NULL)::int + ("externalAthleteId" IS NOT NULL)::int) = 1);
  END IF;
END $$;
