-- POR QUE o sistema decidiu, e não só O QUE ele decidiu.
--
-- A revisão mostrava o veredito — "Reconhecido", "Conflito" — sem dizer qual
-- chave produziu aquilo. Um operador que não sabe por que a linha casou não
-- tem como conferir se casou certo, e um CONFLICT sem os candidatos na tela
-- vira um botão de "vincular" apertado no escuro.
--
--   matchedBy        a chave que reconheceu a linha: AFFILIATION_NUMBER ou
--                    CPF. NULO quando não houve reconhecimento — inclusive
--                    quando houve apenas SUGESTÃO por nome, porque nome não
--                    reconhece ninguém.
--
--   matchCandidates  em CONFLICT de identidade, quem são os candidatos em
--                    disputa e o que cada chave afirma. É JSON porque é um
--                    retrato do momento da análise, não uma relação a manter
--                    sincronizada: o operador precisa ver o que o sistema viu
--                    quando decidiu parar.
--
-- Aditiva e anulável: nenhuma linha existente é alterada, nenhuma política de
-- RLS é tocada, nenhum índice removido. Lotes já importados continuam como
-- estão, com os dois campos nulos — que é a verdade sobre eles: foram
-- analisados por um motor que ainda não registrava o critério.

ALTER TABLE "MuscleWarImportItem" ADD COLUMN IF NOT EXISTS "matchedBy" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN IF NOT EXISTS "matchCandidates" JSONB;
