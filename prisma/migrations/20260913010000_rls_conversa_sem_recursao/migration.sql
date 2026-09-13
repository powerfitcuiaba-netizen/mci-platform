-- ============================================================================
-- RECURSÃO DE POLÍTICA NO MESSENGER — correção estrutural.
--
-- O DEFEITO
--
--   política de "Conversation"        -> mci_in_conversation(id)
--   mci_in_conversation               -> consultava "ConversationMember"
--   política de "ConversationMember"  -> ... OR mci_in_conversation("conversationId")
--                                              ^ MESMA conversa, sem fim
--
-- Uma política que consulta a própria tabela que ela protege é um ciclo. Ele
-- só não estourava quando a varredura encontrava a linha do próprio usuário
-- primeiro e o EXISTS parava. Quem NÃO tem linha naquela conversa nunca
-- curto-circuita — e aí a recursão não termina.
--
-- Medido em produção simulada: PostgresError 54001, stack depth limit
-- exceeded, 10 tentativas de 10, na rota POST /messenger/conversations. O
-- rastro do PostgreSQL repetia `SQL function "mci_in_conversation"` até
-- esgotar a pilha. Depois disso, até `SELECT count(*) FROM "Conversation"`
-- estourava.
--
-- A CORREÇÃO — quebrar o ciclo, não afrouxar a barreira
--
-- `Conversation` passa a carregar os participantes ATIVOS na própria linha, e
-- a política vira uma verificação LOCAL: nenhuma consulta a outra tabela, logo
-- nenhum caminho de volta. `ConversationMember` e `Message` consultam
-- `Conversation`, cuja política é local — terminam em um nível.
--
-- O que NÃO mudou: quem enxerga o quê. Participante vê; não participante não
-- vê. RLS continua ligado, FORCE continua ligado, nenhum papel ganhou
-- BYPASSRLS, nenhum bypass foi criado. A regra é a mesma; o caminho até ela é
-- que deixou de ser circular — e ficou mais barato, porque virou uma
-- comparação de array em vez de uma subconsulta por linha.
--
-- INVARIANTE que a aplicação mantém: `participantIds` contém exatamente os
-- `profileId` dos membros com `leftAt IS NULL`. Há teste conferindo isso
-- depois de criar conversa, adicionar participante e sair do grupo.
-- ============================================================================

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "participantIds" TEXT[] NOT NULL DEFAULT '{}';
-- Quem JÁ foi participante e saiu. Existe por uma razão precisa do PostgreSQL:
-- um UPDATE exige que a linha resultante continue VISÍVEL para quem a escreve.
-- Sem isto, ninguém conseguiria sair de um grupo — a própria gravação que
-- remove a pessoa do array a tornaria invisível, e o banco recusaria.
--
-- A consequência é limitada e está escrita aqui de propósito: a CASCA da
-- conversa (id, tipo, título) continua legível para quem já participou. O
-- CONTEÚDO não: mensagens e linhas de participação exigem estar em
-- `participantIds`, e quem saiu não está mais. Quem saiu já conhecia o título
-- do grupo em que esteve; o que ele deixa de ver é tudo o que passa a ser dito
-- depois da saída.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "formerParticipantIds" TEXT[] NOT NULL DEFAULT '{}';

-- `ADD COLUMN IF NOT EXISTS` não toca em coluna que já existe — nem para
-- corrigir o DEFAULT dela. Isto aqui é o que faz esta migration CONSERTAR um
-- banco que já divergiu, em vez de só descrever o banco ideal.
--
-- Não é hipótese: o banco de teste perdeu os dois DEFAULT porque um
-- `prisma db push` reconciliou o banco contra um schema.prisma que ainda não
-- os declarava. O sintoma foi um 500 em POST /messenger/conversations —
-- `Null constraint violation on the fields: (formerParticipantIds)` — porque
-- o `createMany` omite a coluna e espera o banco preencher.
ALTER TABLE "Conversation" ALTER COLUMN "participantIds" SET DEFAULT '{}';
ALTER TABLE "Conversation" ALTER COLUMN "formerParticipantIds" SET DEFAULT '{}';

-- Retrocompatibilidade: preenche as conversas que já existem.
UPDATE "Conversation" c
   SET "participantIds" = COALESCE((
     SELECT array_agg(m."profileId")
       FROM "ConversationMember" m
      WHERE m."conversationId" = c.id AND m."leftAt" IS NULL
   ), '{}');

-- Quem procura "as minhas conversas" filtra por este array.
CREATE INDEX IF NOT EXISTS "Conversation_participantIds_idx" ON "Conversation" USING GIN ("participantIds");

-- ---------------------------------------------------------------- políticas
DROP POLICY IF EXISTS conversa_participante ON "Conversation";

-- Separadas por comando de propósito: sair de um grupo é um UPDATE que REMOVE
-- o próprio usuário do array. Com uma política única, o WITH CHECK recusaria a
-- linha nova — o usuário não poderia sair.
DROP POLICY IF EXISTS conversa_leitura ON "Conversation";
CREATE POLICY conversa_leitura ON "Conversation"
  FOR SELECT USING (
    mci_current_profile_id() = ANY("participantIds")
    OR mci_current_profile_id() = ANY("formerParticipantIds")
  );

DROP POLICY IF EXISTS conversa_criacao ON "Conversation";
CREATE POLICY conversa_criacao ON "Conversation"
  FOR INSERT WITH CHECK (mci_current_profile_id() = ANY("participantIds"));

DROP POLICY IF EXISTS conversa_atualizacao ON "Conversation";
CREATE POLICY conversa_atualizacao ON "Conversation"
  FOR UPDATE USING (mci_current_profile_id() = ANY("participantIds"))
  WITH CHECK (true);

DROP POLICY IF EXISTS conversa_exclusao ON "Conversation";
CREATE POLICY conversa_exclusao ON "Conversation"
  FOR DELETE USING (mci_current_profile_id() = ANY("participantIds"));

-- A função deixa de consultar "ConversationMember": é ela que fechava o ciclo.
CREATE OR REPLACE FUNCTION mci_in_conversation(conv_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Conversation" c
     WHERE c.id = conv_id
       AND mci_current_profile_id() = ANY(c."participantIds")
  )
$$;

DROP POLICY IF EXISTS membro_participante ON "ConversationMember";
-- Repare no `= ANY(c."participantIds")`: a condição é conferida AQUI, e não
-- delegada à política de "Conversation". É o que impede quem saiu do grupo de
-- continuar enxergando os participantes — a casca ele vê, a lista não.
CREATE POLICY membro_participante ON "ConversationMember"
  USING (
    "profileId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Conversation" c
       WHERE c.id = "conversationId" AND mci_current_profile_id() = ANY(c."participantIds")
    )
  )
  WITH CHECK (true);

DROP POLICY IF EXISTS mensagem_participante ON "Message";
-- Mensagem exige participação ATIVA. Quem saiu do grupo para de ler no mesmo
-- instante — inclusive o que já estava escrito.
CREATE POLICY mensagem_participante ON "Message"
  USING (EXISTS (
    SELECT 1 FROM "Conversation" c
     WHERE c.id = "conversationId" AND mci_current_profile_id() = ANY(c."participantIds")
  ))
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Conversation" c
       WHERE c.id = "conversationId" AND mci_current_profile_id() = ANY(c."participantIds")
    )
    AND "senderId" = mci_current_profile_id()
  );
