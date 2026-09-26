-- ============================================================================
-- S6 — AS QUATRO POLÍTICAS COM `WITH CHECK = true`.
--
-- O QUE `WITH CHECK = true` SIGNIFICA, E POR QUE NÃO É DETALHE
--
-- `USING` decide quais linhas o ator ALCANÇA. `WITH CHECK` decide como a linha
-- NOVA pode ficar. Com `WITH CHECK (true)`, quem alcança uma linha pode
-- reescrevê-la em qualquer coisa — inclusive numa linha que ele jamais poderia
-- ter alcançado. E em política `FOR ALL` o INSERT é governado SÓ pelo
-- `WITH CHECK`, então `true` ali significa inserção sem restrição nenhuma.
--
-- AS QUATRO NÃO TÊM O MESMO RISCO, e foi por isso que cada uma exigiu análise
-- própria. Um espelho ingênuo do `USING` QUEBRARIA fluxo legítimo em duas
-- delas — medido no código, não suposto.
--
-- ESTA MIGRATION NÃO CRIA, ALTERA NEM APAGA COLUNA, TABELA, ÍNDICE OU DADO.
-- Ela substitui quatro políticas e acrescenta uma quinta. Nada de RLS é
-- desligado, nenhuma política é afrouxada.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. `Comment` · UPDATE · o espelho do USING serve, e é o que faltava.
--
-- RISCO REPRODUZIDO: autor de um comentário podia reescrever `authorId` para
-- outro perfil — forjando comentário atribuído a terceiro — ou mover o
-- comentário para uma publicação que ele não alcança.
--
-- O `USING` desta política já reconhece os três atores certos, e é o mesmo
-- trio que `socialService` autoriza (moderação, autor do comentário, autor da
-- PUBLICAÇÃO — este último entrou no T2, ao corrigir o F1). Espelhá-lo no
-- `WITH CHECK` mantém o soft delete do autor da publicação funcionando, porque
-- a linha nova continua satisfazendo `EXISTS(post do ator)`.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS comentario_alteracao ON "Comment";
CREATE POLICY comentario_alteracao ON "Comment"
  FOR UPDATE
  USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Post" p
      WHERE p.id = "Comment"."postId" AND p."authorId" = mci_current_profile_id()
    )
  )
  WITH CHECK (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Post" p
      WHERE p.id = "Comment"."postId" AND p."authorId" = mci_current_profile_id()
    )
  );


-- ---------------------------------------------------------------------------
-- 2. `Conversation` · UPDATE · o espelho do USING NÃO serve, e sair prova isso.
--
-- RISCO REPRODUZIDO: participante podia reescrever `participantIds` inteiro —
-- entregar a conversa a estranhos e se apagar dela, ou inserir terceiros numa
-- conversa privada.
--
-- POR QUE NÃO ESPELHAR: `messengerService.sair` grava, numa só instrução,
-- `participantIds: restantes` (sem o ator) e `formerParticipantIds: push(ator)`.
-- Um `WITH CHECK` exigindo `ator = ANY(participantIds)` BLOQUEARIA sair da
-- conversa — fluxo legítimo. O comentário do próprio serviço registra que ele
-- contava com a política avaliar a linha ANTIGA.
--
-- A REGRA CERTA é: depois da gravação o ator continua RASTREÁVEL na conversa,
-- como participante ou como ex-participante. Sair passa; entregar a conversa e
-- desaparecer, não.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS conversa_atualizacao ON "Conversation";
CREATE POLICY conversa_atualizacao ON "Conversation"
  FOR UPDATE
  USING (mci_current_profile_id() = ANY ("participantIds"))
  WITH CHECK (
    mci_current_profile_id() = ANY ("participantIds")
    OR mci_current_profile_id() = ANY ("formerParticipantIds")
  );


-- ---------------------------------------------------------------------------
-- 3. `ConversationMember` · ALL · o espelho do USING seria INSUFICIENTE.
--
-- RISCO REPRODUZIDO, e é o pior dos quatro: política `FOR ALL` com
-- `WITH CHECK (true)` deixa o INSERT sem restrição. Qualquer autenticado podia
-- inserir uma linha de participação em QUALQUER conversa — entrar sozinho em
-- conversa privada alheia.
--
-- POR QUE NÃO ESPELHAR: o `USING` tem `"profileId" = mci_current_profile_id()`
-- como primeira alternativa. Espelhado no `WITH CHECK`, inserir a SI MESMO em
-- conversa alheia continuaria passando — exatamente o ataque.
--
-- A REGRA CERTA é a segunda alternativa sozinha: só se mexe em participação de
-- conversa da qual o ator participa. Medido nos dois fluxos que escrevem aqui:
--
--   `createConversation` grava a `Conversation` COM `participantIds` ANTES de
--   inserir os membros, então o criador já é participante quando o INSERT
--   acontece;
--   `addMembers` é executado por quem já participa, e os membros novos entram
--   em conversa onde o ator está.
--
-- Ou seja: a regra restringe o ataque sem fechar nenhum dos dois caminhos.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS membro_participante ON "ConversationMember";
CREATE POLICY membro_participante ON "ConversationMember"
  FOR ALL
  USING (
    "profileId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Conversation" c
      WHERE c.id = "ConversationMember"."conversationId"
        AND mci_current_profile_id() = ANY (c."participantIds")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Conversation" c
      WHERE c.id = "ConversationMember"."conversationId"
        AND mci_current_profile_id() = ANY (c."participantIds")
    )
  );


-- ---------------------------------------------------------------------------
-- 4. `Notification` · a única em que a escrita ampla é DESENHO, e fica
--    declarada como tal.
--
-- RISCO REPRODUZIDO NO UPDATE: `USING ("userId" = mci_current_user_id())` com
-- `WITH CHECK (true)` deixava o dono reatribuir a PRÓPRIA notificação para
-- outra conta — plantando aviso na caixa de terceiro. Isso é fechado abaixo.
--
-- O INSERT NÃO PODE SER FECHADO PELA MESMA REGRA, e a medição é direta:
-- `notificationService` faz `notification.createMany` com os `userIds` de OUTRAS
-- pessoas — é o que avisar alguém significa. Um atleta que comenta numa
-- publicação gera notificação para o autor dela. `WITH CHECK ("userId" =
-- mci_current_user_id())` desligaria a notificação da plataforma inteira.
--
-- Não existe predicado de LINHA que expresse "o sistema pode avisar quem for
-- pertinente" sem reimplementar em SQL a autorização que o serviço já faz. Por
-- isso o INSERT fica amplo, DECLARADO numa política separada — e não escondido
-- num `true` colado numa política `FOR ALL`, onde ninguém percebe que também
-- governa o UPDATE.
--
-- CONTROLES COMPENSATÓRIOS, e o que eles cobrem de verdade:
--   * `notificationService` é o único escritor da tabela (medido: nenhum outro
--     serviço chama `notification.create`);
--   * título e mensagem são literais do serviço, não texto escolhido por quem
--     dispara;
--   * a leitura continua fechada ao dono pelo `USING`, então ninguém enxerga
--     notificação alheia;
--   * a partir desta migration, ninguém MOVE uma notificação de dono.
--
-- RISCO REMANESCENTE, declarado: uma rota futura que aceite `userIds` e texto
-- do cliente transformaria isso em canal de mensagem forjada. A barreira para
-- esse caso é de aplicação, não de RLS, e está registrada no relatório do T4
-- como recomendação para a fase seguinte.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS notificacao_do_dono ON "Notification";
CREATE POLICY notificacao_do_dono ON "Notification"
  FOR ALL
  USING ("userId" = mci_current_user_id())
  WITH CHECK ("userId" = mci_current_user_id());

-- A entrega, separada e explícita. Políticas permissivas somam: para o INSERT
-- o PostgreSQL considera esta E a de cima, e a soma libera. Para UPDATE,
-- SELECT e DELETE esta política NÃO se aplica, então continua valendo só a
-- regra do dono.
DROP POLICY IF EXISTS notificacao_entrega ON "Notification";
CREATE POLICY notificacao_entrega ON "Notification"
  FOR INSERT
  WITH CHECK (true);
