-- ============================================================================
-- O DONO LÊ O PRÓPRIO HISTÓRICO.
--
-- O DEFEITO QUE ESTA MIGRATION CONSERTA
--
-- A migration anterior (20260920000000) fechou `RankingPoint` e
-- `ExternalResult` para quem não é operador da organização. A intenção estava
-- certa — o ledger carrega a trilha administrativa, e ela não é de todo mundo.
-- O esquecimento foi que essas MESMAS linhas são o HISTÓRICO DE ALGUÉM.
--
-- `GET /me/history` lê `RankingPoint` com a sessão do próprio atleta. Um
-- atleta não é operador de nada, então a tela da carreira dele passou a
-- devolver vazio. Não existe leitura mais legítima do que a pessoa consultando
-- o que ela mesma competiu, e a política a barrava.
--
-- A PLATAFORMA JÁ TEM ESSE PADRÃO, e é dele que esta migration se aproxima:
-- `AthleteProfileRequest` admite `"userId" = mci_current_user_id()` ao lado do
-- operador. Aqui o caminho até o usuário passa por `Athlete.userId`.
--
-- O QUE NÃO MUDA
--
-- INSERT, UPDATE e DELETE continuam como estavam: o atleta LÊ, não escreve.
-- `ExternalAthlete`, `Ranking` e `PublicRankingEntry` não são tocadas.
--
-- O PONTO DE ATENÇÃO, e a razão de a função existir em vez de a condição ser
-- escrita direto na policy: `athleteId` PODE SER NULO. Um resultado histórico
-- carregado antes do cadastro não tem dono — e uma comparação descuidada com
-- nulo poderia tornar essas linhas visíveis a qualquer pessoa autenticada, que
-- é exatamente o oposto do que a fase inteira construiu.
--
-- Por isso `athlete_id IS NOT NULL` é a PRIMEIRA condição, e há teste dedicado
-- a ela em tests/rls-do-ledger.test.mjs: sem esse teste, a guarda valeria o
-- que vale um comentário.
-- ============================================================================

CREATE OR REPLACE FUNCTION mci_atleta_do_usuario(athlete_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT athlete_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Athlete" a
    WHERE a."id" = athlete_id AND a."userId" = mci_current_user_id()
  )
$$;

DROP POLICY IF EXISTS lancamento_leitura ON "RankingPoint";
CREATE POLICY lancamento_leitura ON "RankingPoint" FOR SELECT
  USING (mci_operator_of("organizationId") OR mci_atleta_do_usuario("athleteId"));

DROP POLICY IF EXISTS resultado_externo_leitura ON "ExternalResult";
CREATE POLICY resultado_externo_leitura ON "ExternalResult" FOR SELECT
  USING (mci_operator_of("organizationId") OR mci_atleta_do_usuario("athleteId"));
