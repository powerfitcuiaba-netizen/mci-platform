-- NS é participação, não linha quebrada; e a classe composta vira três leituras.
--
-- `didNotShow` separa "o atleta consta na chamada e não subiu" de "não deu
-- para ler a colocação". Pela regra homologada NS vale 0, e valer 0 é
-- participar: a linha pertence ao histórico do atleta. Antes disso ela era
-- recusada, o ranking saía certo por acidente (zero é zero) e a participação
-- sumia.
--
-- `classLabel` guarda a classe decomposta do texto composto da origem. O texto
-- INTEIRO continua em `className`, porque é dele que sai a chave de
-- idempotência: separar as duas leituras é o que impede que
-- "Bodybuilding - Novice" e "Classic Physique - Novice" colidam numa chave só.
--
-- Ambas nascem com padrão, então nenhuma linha existente precisa de backfill:
-- o que já está gravado continua significando exatamente o que significava.
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "classLabel" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "didNotShow" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RankingPoint" ADD COLUMN "didNotShow" BOOLEAN NOT NULL DEFAULT false;
