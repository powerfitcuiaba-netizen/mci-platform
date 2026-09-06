-- ============================================================================
-- Conversa: a política volta a ser estritamente "só participante lê".
--
-- Uma tentativa anterior de liberar a leitura de conversa sem participantes —
-- para acomodar o INSERT ... RETURNING da criação — se mostrou um furo de
-- segurança e foi rejeitada pelos testes. O motivo é sutil e vale registrar:
-- o subquery sobre "ConversationMember" dentro da política é avaliado com os
-- privilégios de quem consulta, e "ConversationMember" também tem RLS. Para um
-- terceiro, o subquery não enxerga membro nenhum, o NOT EXISTS se torna
-- verdadeiro e a conversa alheia fica visível. Uma política nunca pode ter sua
-- decisão dependendo de linhas que o próprio consultante não pode ver.
--
-- A criação de conversa foi corrigida onde o problema realmente estava: em
-- src/services/messengerService.js, que agora grava sem RETURNING e só lê a
-- conversa de volta depois que os participantes existem.
--
-- Esta migration é idempotente e deixa a política no estado estrito.
-- ============================================================================

DROP POLICY IF EXISTS conversa_participante ON "Conversation";

CREATE POLICY conversa_participante ON "Conversation"
  USING (mci_in_conversation(id))
  WITH CHECK (true);
