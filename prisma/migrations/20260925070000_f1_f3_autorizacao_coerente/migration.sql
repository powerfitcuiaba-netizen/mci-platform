-- ===========================================================================
-- F1 e F3 — o banco passa a concordar com o serviço.
--
-- Os dois achados do T1 têm a MESMA forma: a aplicação autoriza uma operação
-- que a política de linha depois recusa, e o resultado sai como 500. Nenhum dos
-- dois é falha de autorização — a autorização está correta nos dois casos. É
-- desacordo entre as duas camadas.
--
-- Esta migration é ADITIVA: nenhuma coluna, tabela, índice ou dado é removido.
-- Ela substitui DUAS políticas, e o que muda em cada uma está escrito abaixo.
-- Nenhuma política é afrouxada: as duas passam a reconhecer o DONO do dado,
-- que é quem a aplicação já autorizava.
-- ===========================================================================

-- ------------------------------------------------------------------------ F1
-- EXCLUSÃO LÓGICA DE COMENTÁRIO.
--
-- `comentario_leitura` era `deletedAt IS NULL AND EXISTS(post)`. Sem ramificação
-- de autor, a linha marcada como apagada deixa de ser visível para QUALQUER um —
-- inclusive para quem a apagou —, e o PostgreSQL recusa a própria gravação com
--
--     42501: new row violates row-level security policy for table "Comment"
--
-- Medido em psql, com o ator correto definido: `SET "content" = 'x'` grava
-- (UPDATE 1) e `SET "deletedAt" = now()` recusa. O soft delete produzia
-- exatamente a linha que a política proibia.
--
-- A correção ESPELHA as ramificações que `comentario_alteracao` JÁ reconhece, e
-- que são exatamente os três atores que `socialService.deleteComment` autoriza
-- (linha 563): a moderação, o autor do comentário e o autor da PUBLICAÇÃO.
--
-- As três são necessárias, e a terceira foi medida: com apenas moderação e autor
-- do comentário, o autor da publicação apagando comentário alheio na casa dele
-- continuava recebendo 42501 — porque a linha nova não era visível para ele.
-- Não é invenção nova: é a assimetria entre `Post` e `Comment` sendo desfeita.
--
-- NÃO VAZA COMENTÁRIO APAGADO NO FEED: quem lista é
-- `socialService.listComments`, que filtra `deletedAt: null` na consulta
-- (socialService.js:541); quem apaga confere `comentario.deletedAt` (linha 560);
-- e quem responde recusa pai apagado (linha 506). A RLS aqui é a segunda
-- barreira, não a única.
DROP POLICY IF EXISTS comentario_leitura ON "Comment";
CREATE POLICY comentario_leitura ON "Comment"
  FOR SELECT USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Post" p
      WHERE p.id = "Comment"."postId" AND p."authorId" = mci_current_profile_id()
    )
    OR (
      "deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId")
    )
  );

-- ------------------------------------------------------------------------ F3
-- O ATLETA EDITANDO O PRÓPRIO CADASTRO.
--
-- `atleta_alteracao` era
--
--     USING      ("userId" = mci_current_user_id() OR mci_member_of(org))
--     WITH CHECK (mci_operator_of(org))
--
-- ou seja: o dono VIA a linha para alterar e NÃO podia gravá-la. E
-- `athleteService.update` tem ramificação explícita para o dono (`ehODono`), que
-- remove os campos do operador e salva o resto. As duas camadas diziam coisas
-- opostas, e a rota respondia 500 (42501) para o atleta editando o cadastro
-- dele.
--
-- A correção acrescenta o dono ao WITH CHECK. E ela é MAIS do que permissão:
-- `"userId" = mci_current_user_id()` é avaliado na LINHA NOVA, então o dono não
-- consegue reatribuir o atleta para outra conta — a tentativa produz uma linha
-- nova que não passa mais no check. É justamente o campo cujo vínculo acidental
-- originou a operação anterior.
--
-- O QUE CONTINUA SENDO DO OPERADOR, e onde isso é garantido: filiação,
-- matrícula, número de atleta, equipe, treinador, academia e situação
-- (`status`, `proStatus`) são removidos do payload por
-- `athleteService.update` quando o ator é o dono sem `athletes.update`
-- (a lista `camposRestritos`). A RLS é row-level e não tem como comparar coluna
-- a coluna; a garantia de coluna é do serviço, e há teste que a mede.
DROP POLICY IF EXISTS atleta_alteracao ON "Athlete";
CREATE POLICY atleta_alteracao ON "Athlete"
  FOR UPDATE
  USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId") OR "userId" = mci_current_user_id());
