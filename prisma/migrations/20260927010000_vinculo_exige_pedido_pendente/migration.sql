-- ===========================================================================
-- O VÍNCULO NASCIDO DA CONFIRMAÇÃO EXIGE O PEDIDO — ACHADO A-04.
--
-- O QUE ESTAVA ERRADO
--
-- `vinculo_criacao` (migration 20260926040000) autorizava o INSERT quando
-- `mci_atleta_do_usuario("athleteId")`, e NADA na cláusula falava de `teamId`. O
-- predicado dizia "o atleta cria vínculo para si"; não dizia "para a equipe que
-- o convidou". Traduzido para o domínio: o dono de uma conta de atleta podia
-- gravar vínculo com QUALQUER equipe, inclusive equipe de treinador que nunca
-- o convidou.
--
-- NÃO ERA ALCANÇÁVEL PELA APLICAÇÃO HOJE, e isso é a razão de a correção não ser
-- opcional. O único caminho que grava por essa cláusula é
-- `membershipRequestService.confirmar`, que passa `pedido.teamId` — a equipe vem
-- do pedido, nunca do corpo da requisição. A política era mais larga que o
-- serviço, e a folga estava esperando o próximo endpoint, o próximo script ou a
-- próxima refatoração que passasse `teamId` de outra fonte. A RLS é o PISO: ela
-- não pode depender de o código acima estar escrito com cuidado.
--
-- A CONDIÇÃO NOVA, E POR QUE É ESTA
--
-- O vínculo por confirmação pressupõe um convite PENDENTE daquela equipe para
-- aquele atleta. A ordem da transação de `confirmar` é o que torna o predicado
-- verificável: o vínculo é criado ANTES de o pedido virar CONFIRMED, então no
-- instante do INSERT o pedido ainda está PENDING — e é exatamente esse estado
-- que a política exige.
--
-- SEM RECURSÃO DE POLÍTICA. A cláusula lê `TeamMembershipRequest`, cuja política
-- de leitura (`vinculo_pedido_leitura`) chama `mci_atleta_do_usuario`, que lê
-- `Athlete`; `atleta_leitura` lê `CoachOrganization` e `Coach`. Nenhuma delas
-- volta a `AthleteTeamMembership`, então o ciclo não fecha. (A recursão é real e
-- já foi medida neste projeto — ver o comentário da migration 20260926040000.)
--
-- O ATLETA CONSEGUE VER O PRÓPRIO PEDIDO, o que é o que faz o EXISTS encontrar a
-- linha: `vinculo_pedido_leitura` libera `mci_atleta_do_usuario("athleteId")`.
--
-- NADA MAIS MUDA. A cláusula do OPERADOR da federação é reproduzida byte a byte;
-- `vinculo_alteracao` e `vinculo_remocao` não são tocadas, e continuam sendo só
-- do operador — o atleta não encerra o próprio vínculo por aqui, que é o poder
-- central de R-02. Nenhum dado é lido, escrito ou apagado por esta migration.
-- ===========================================================================

DROP POLICY IF EXISTS vinculo_criacao ON "AthleteTeamMembership";

CREATE POLICY vinculo_criacao ON "AthleteTeamMembership" FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId")
    )
    OR (
      mci_atleta_do_usuario("athleteId")
      AND EXISTS (
        SELECT 1 FROM "TeamMembershipRequest" r
        WHERE r."athleteId" = "AthleteTeamMembership"."athleteId"
          AND r."teamId" = "AthleteTeamMembership"."teamId"
          AND r."status" = 'PENDING'
      )
    )
  );
