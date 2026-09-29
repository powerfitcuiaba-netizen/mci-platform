-- ============================================================================
-- AUTORIZAÇÃO AUTOMÁTICA NA NPC — a federação oficial única da plataforma.
--
-- A DECISÃO: a NPC é a única federação oficial do campeonato, e o treinador que
-- conclui o cadastro passa a estar autorizado a atuar nela no mesmo instante,
-- sem pedido, sem fila e sem espera. Autorização em QUALQUER OUTRA federação
-- continua sendo ato dela — R-04 intacta fora da NPC.
--
-- POR QUE ISTO EXIGE POLÍTICA NOVA, E NÃO UM ATALHO
--
-- `CoachOrganization` tem RLS FORÇADO, e a política de INSERT existente
-- (`coach_org_escrita`) exige `mci_is_platform_admin() OR
-- mci_operator_of("organizationId")`. A autorização automática é gravada DENTRO
-- da transação do próprio treinador — que não é operador de federação nenhuma —,
-- então ela seria recusada pelo banco.
--
-- As saídas que NÃO foram usadas, e por quê:
--   * BYPASSRLS ou SECURITY DEFINER privilegiado: escapar do RLS em vez de
--     expressar a regra nele. Proibido neste projeto, e com razão.
--   * afrouxar `coach_org_escrita`: daria a qualquer treinador a caneta de se
--     autorizar em qualquer federação, que é exatamente o contrário da decisão.
--   * gravar por fora, com a conta de serviço: esconderia a regra num script e
--     deixaria o banco sem defesa se alguém chamasse a rota direto.
--
-- A POLÍTICA ABAIXO é aditiva e conjuntiva: ela só permite a linha que a decisão
-- descreve, e nada mais. As cinco condições, todas obrigatórias:
--
--   1. a linha é APPROVED — não serve para plantar PENDING nem ressuscitar
--      REVOKED com outro status;
--   2. NÃO tem concedente humano (`grantedById IS NULL`) e se declara automática
--      (`autoGrantedAt IS NOT NULL`) — a trilha não ganha um revisor inventado;
--   3. o treinador é o DA CONTA que está inserindo, e o cadastro dele está
--      APPROVED — ninguém autoriza treinador alheio por aqui;
--   4. a organização é a DONA DA ENTIDADE OFICIAL (uma `Affiliation` ativa com
--      código NPC). É o mesmo marcador que `officialAffiliationService` usa para
--      responder "qual é a federação oficial", então serviço e banco concordam
--      por construção, em vez de por coincidência;
--   5. a organização está ativa.
--
-- POR QUE ELA NÃO DESFAZ UMA REVOGAÇÃO, que é o risco óbvio de deixar o
-- interessado inserir: a política é só de INSERT, e `@@unique([coachId,
-- organizationId])` já garante UMA linha por par. Se a federação revogou, a
-- linha EXISTE — o INSERT bate no índice único e falha, e alterar a linha
-- existente continua exigindo operador (`coach_org_alteracao`, inalterada).
-- O serviço usa `create` e não `upsert` justamente para isto: autorização
-- revogada permanece revogada.
--
-- `autoGrantedAt` é o mesmo desenho de `Coach.autoApprovedAt`: diz que a decisão
-- foi da REGRA, e distingue a linha automática da concedida por pessoa.
-- ============================================================================

ALTER TABLE "CoachOrganization" ADD COLUMN "autoGrantedAt" TIMESTAMP(3);

CREATE INDEX "CoachOrganization_autoGrantedAt_idx" ON "CoachOrganization" ("autoGrantedAt")
  WHERE "autoGrantedAt" IS NOT NULL;

CREATE POLICY coach_org_autorizacao_automatica ON "CoachOrganization"
  FOR INSERT
  WITH CHECK (
    "status" = 'APPROVED'
    AND "grantedById" IS NULL
    AND "autoGrantedAt" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "Coach" c
       WHERE c.id = "CoachOrganization"."coachId"
         AND c."userId" = mci_current_user_id()
         AND c.status = 'APPROVED'
    )
    AND EXISTS (
      SELECT 1 FROM "Organization" o
       WHERE o.id = "CoachOrganization"."organizationId"
         AND o.active
         AND EXISTS (
           SELECT 1 FROM "Affiliation" a
            WHERE a."organizationId" = o.id
              AND upper(a.code) = 'NPC'
              AND a.active
         )
    )
  );
