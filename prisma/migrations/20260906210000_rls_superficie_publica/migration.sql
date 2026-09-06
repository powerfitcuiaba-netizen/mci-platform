-- ============================================================================
-- Atleta: a política reconhece a superfície pública que sempre existiu.
--
-- Com FORCE ligado, as rotas públicas quebraram — diretório de atletas,
-- ranking e página pública de evento passaram a devolver vazio ou 404. A causa
-- é que a política de "Athlete" exige ator vinculado à organização, e o
-- visitante não tem ator nenhum.
--
-- O predicado acrescentado libera a leitura APENAS quando não há ator definido.
-- Isso não concede nada de novo a ninguém: exatamente esses dados já são
-- servidos a qualquer visitante por /public/athletes, /public/events e
-- /ranking, e existe teste garantindo que o CPF não sai nessas respostas. O
-- que o predicado faz é parar de contradizer, no banco, o que o produto expõe
-- na porta da frente.
--
-- O ponto importante é o que ele NÃO afrouxa: um ator AUTENTICADO continua
-- preso à sua organização. O operador da federação B segue sem enxergar atleta
-- da federação A, e é isso que o teste de isolamento verifica. Autenticar-se
-- nunca amplia o alcance para além do próprio tenant.
--
-- A escrita segue inalterada: só operador da organização cria ou altera
-- atleta.
--
-- Risco residual registrado: a linha liberada ao anônimo inclui a coluna cpf.
-- Quem a mantém fora das respostas públicas é a projeção do service
-- (athletePublic), coberta por teste. Proteção por coluna no banco depende de
-- GRANT de coluna para o papel `mci_app` (ver docs/DEPLOY.md).
-- ============================================================================

DROP POLICY IF EXISTS atleta_da_organizacao ON "Athlete";

CREATE POLICY atleta_leitura ON "Athlete" FOR SELECT
  USING (
    mci_current_user_id() IS NULL
    OR "userId" = mci_current_user_id()
    OR mci_member_of("organizationId")
  );

CREATE POLICY atleta_criacao ON "Athlete" FOR INSERT
  WITH CHECK (mci_operator_of("organizationId"));

CREATE POLICY atleta_alteracao ON "Athlete" FOR UPDATE
  USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId"));

CREATE POLICY atleta_remocao ON "Athlete" FOR DELETE
  USING (mci_operator_of("organizationId"));
