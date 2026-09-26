-- ============================================================================
-- MÓDULO TREINADORES & EQUIPES — estrutura de dados.
--
-- ESCRITA À MÃO, e não gerada. `prisma migrate dev` pediu para RESETAR o banco
-- de QA por causa de drift de checksum em duas migrations antigas
-- (`20260918030000_lancamento_invalidado` e
-- `20260923060000_conta_de_servico_da_federacao`), drift que é anterior a esta
-- fase. Resetar apagaria o banco de trabalho, então a migration foi escrita à
-- mão — que é como todas as deste repositório já são — e aplicada por
-- `migrate deploy`.
--
-- ADITIVA. Acrescenta 3 enums, 4 tabelas, colunas em `Coach` e uma coluna em
-- `Team`. NÃO apaga, NÃO renomeia e NÃO altera tipo de coluna, tabela, índice,
-- política ou dado existente. Nenhuma tabela existente perde RLS.
--
-- AS QUATRO TABELAS NOVAS NASCEM COM RLS E FORCE. `Coach` e `Team`, que já
-- existiam sem RLS, continuam como estavam: ligar RLS nelas altera a leitura de
-- rotas que já funcionam, e isso é fase própria, com plano de impacto — está
-- registrado como pendência no relatório.
-- ============================================================================


-- --------------------------------------------------------------------------
-- 1. ENUMS
-- --------------------------------------------------------------------------

-- Só estados com transição e efeito operacional definidos. `RASCUNHO` e
-- `EM_ANALISE` ficaram fora de propósito: não há salvamento parcial nem etapa
-- de análise com efeito próprio nesta etapa, e estado sem transição é estado
-- morto que alguém vai tentar usar depois.
CREATE TYPE "CoachStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'CANCELLED');

-- Espelha `AthleteProfileRequestStatus`, que é o vocabulário que o autocadastro
-- já usa. `CONFIRMED` é a confirmação DO ATLETA — é ela que autoriza o vínculo.
CREATE TYPE "TeamMembershipRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED');

-- Decisão R-04: identidade do treinador é global; ATUAR numa federação é outra
-- pergunta, e é `CoachOrganization` que a responde.
CREATE TYPE "CoachOrganizationStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED');


-- --------------------------------------------------------------------------
-- 2. `Coach` GANHA SITUAÇÃO CADASTRAL
--
-- SEM `organizationId`, e a ausência é a decisão R-04. O treinador é global —
-- está escrito em `partnerService.js` desde antes deste módulo — e duplicar a
-- identidade por federação é exatamente o que a decisão proíbe.
--
-- `status` nasce `APPROVED` para as linhas que JÁ EXISTEM. É a escolha
-- conservadora: um cadastro criado por operador antes deste módulo já passou
-- pelo controle de acesso da época, e marcá-lo `PENDING` tiraria do ar um
-- vínculo de atleta que hoje funciona. O DEFAULT da coluna é `PENDING`, então
-- todo cadastro NOVO nasce pendente, que é a regra R-03.
-- --------------------------------------------------------------------------
ALTER TABLE "Coach" ADD COLUMN "status" "CoachStatus" NOT NULL DEFAULT 'PENDING';
UPDATE "Coach" SET "status" = 'APPROVED';

ALTER TABLE "Coach" ADD COLUMN "registration"    TEXT;
ALTER TABLE "Coach" ADD COLUMN "bio"             TEXT;
ALTER TABLE "Coach" ADD COLUMN "phone"           TEXT;
ALTER TABLE "Coach" ADD COLUMN "email"           TEXT;
ALTER TABLE "Coach" ADD COLUMN "reviewedById"    TEXT;
ALTER TABLE "Coach" ADD COLUMN "reviewedAt"      TIMESTAMP(3);
ALTER TABLE "Coach" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Coach" ADD COLUMN "suspendedReason" TEXT;

CREATE INDEX "Coach_status_idx" ON "Coach"("status");

ALTER TABLE "Coach" ADD CONSTRAINT "Coach_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --------------------------------------------------------------------------
-- 3. `Team` GANHA O TREINADOR RESPONSÁVEL
--
-- É por aqui que as duas metades do módulo se ligam sem duplicar nada: a
-- identidade global vive em `Coach`, o escopo de federação vive em
-- `Team.organizationId`.
--
-- NULO nas equipes que já existem, e tem de ser: exigir treinador quebraria o
-- cadastro atual de equipes.
-- --------------------------------------------------------------------------
ALTER TABLE "Team" ADD COLUMN "coachId" TEXT;
CREATE INDEX "Team_coachId_idx" ON "Team"("coachId");
ALTER TABLE "Team" ADD CONSTRAINT "Team_coachId_fkey"
  FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --------------------------------------------------------------------------
-- 4. `CoachDocument` — documentação restrita da análise
--
-- Espelha `AthleteDocument`: mesmo formato, mesmo `storageKey` único, mesma
-- guarda de armazenamento. Decisão R-05: NUNCA aparece no painel do treinador,
-- no ranking público, em API pública, em exportação ou em log.
-- --------------------------------------------------------------------------
CREATE TABLE "CoachDocument" (
  "id"           TEXT NOT NULL,
  "coachId"      TEXT NOT NULL,
  "kind"         "DocumentKind" NOT NULL DEFAULT 'OTHER',
  "title"        TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,
  "mimeType"     TEXT NOT NULL DEFAULT 'application/octet-stream',
  "storageKey"   TEXT NOT NULL,
  "sizeBytes"    INTEGER NOT NULL DEFAULT 0,
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CoachDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachDocument_storageKey_key" ON "CoachDocument"("storageKey");
CREATE INDEX "CoachDocument_coachId_kind_idx" ON "CoachDocument"("coachId", "kind");

ALTER TABLE "CoachDocument" ADD CONSTRAINT "CoachDocument_coachId_fkey"
  FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachDocument" ADD CONSTRAINT "CoachDocument_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --------------------------------------------------------------------------
-- 5. `CoachOrganization` — onde o treinador global pode ATUAR
--
-- Uma autorização por par treinador/federação. Reautorizar é ATUALIZAR a linha,
-- não empilhar outra: com duas linhas o histórico de concessão fica ambíguo e
-- ninguém sabe qual vale.
-- --------------------------------------------------------------------------
CREATE TABLE "CoachOrganization" (
  "id"             TEXT NOT NULL,
  "coachId"        TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "status"         "CoachOrganizationStatus" NOT NULL DEFAULT 'PENDING',
  "grantedById"    TEXT,
  "grantedAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "revokedAt"      TIMESTAMP(3),
  "reason"         TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoachOrganization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachOrganization_coachId_organizationId_key"
  ON "CoachOrganization"("coachId", "organizationId");
CREATE INDEX "CoachOrganization_organizationId_status_idx"
  ON "CoachOrganization"("organizationId", "status");

ALTER TABLE "CoachOrganization" ADD CONSTRAINT "CoachOrganization_coachId_fkey"
  FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachOrganization" ADD CONSTRAINT "CoachOrganization_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachOrganization" ADD CONSTRAINT "CoachOrganization_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CoachOrganization" ADD CONSTRAINT "CoachOrganization_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- --------------------------------------------------------------------------
-- 6. `TeamMembershipRequest` — a solicitação, com confirmação do atleta
--
-- ENVIAR SOLICITAÇÃO NÃO VINCULA NINGUÉM. O vínculo em si continua entrando por
-- `membershipService.linkTeam`, que é o caminho existente e que carrega a trava
-- de unicidade do banco.
--
-- `pendingAthleteId` É A TRAVA, e usa o MESMO truque de
-- `AthleteTeamMembership.activeAthleteId`: a coluna carrega o id do atleta
-- ENQUANTO a solicitação está pendente e vira NULL quando ela é decidida. Com o
-- índice único, dois treinadores não conseguem deixar dois pedidos abertos para
-- a mesma pessoa — e a garantia é do PostgreSQL, não de um SELECT anterior, que
-- é justamente a janela que a fraude usaria.
-- --------------------------------------------------------------------------
CREATE TABLE "TeamMembershipRequest" (
  "id"               TEXT NOT NULL,
  "athleteId"        TEXT NOT NULL,
  "teamId"           TEXT NOT NULL,
  "coachId"          TEXT,
  "status"           "TeamMembershipRequestStatus" NOT NULL DEFAULT 'PENDING',
  "requestedById"    TEXT,
  "requestedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedById"      TEXT,
  "decidedAt"        TIMESTAMP(3),
  "reason"           TEXT,
  "membershipId"     TEXT,
  "pendingAthleteId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TeamMembershipRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeamMembershipRequest_pendingAthleteId_key"
  ON "TeamMembershipRequest"("pendingAthleteId");
CREATE INDEX "TeamMembershipRequest_athleteId_status_idx"
  ON "TeamMembershipRequest"("athleteId", "status");
CREATE INDEX "TeamMembershipRequest_teamId_status_idx"
  ON "TeamMembershipRequest"("teamId", "status");
CREATE INDEX "TeamMembershipRequest_coachId_status_idx"
  ON "TeamMembershipRequest"("coachId", "status");

ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_coachId_fkey"
  FOREIGN KEY ("coachId") REFERENCES "Coach"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A COERÊNCIA ENTRE ESTADO E TRAVA, garantida pelo banco.
--
-- Sem isto, alguém poderia gravar uma solicitação `PENDING` com
-- `pendingAthleteId` nulo — e a trava de unicidade deixaria de valer justamente
-- para o caso que ela existe para impedir. A restrição amarra as duas colunas.
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_pendente_coerente"
  CHECK (
    ("status" = 'PENDING'  AND "pendingAthleteId" = "athleteId")
    OR
    ("status" <> 'PENDING' AND "pendingAthleteId" IS NULL)
  );

-- Decidida tem de ter data de decisão; pendente não pode ter.
ALTER TABLE "TeamMembershipRequest" ADD CONSTRAINT "TeamMembershipRequest_decisao_coerente"
  CHECK (
    ("status" = 'PENDING'  AND "decidedAt" IS NULL)
    OR
    ("status" <> 'PENDING' AND "decidedAt" IS NOT NULL)
  );


-- --------------------------------------------------------------------------
-- 7. `CentralAuthorization` — a decisão R-02, tornada verificável
--
-- R-02: transferência, desvínculo e correção que afetem a atribuição de pontos
-- só podem ser efetivados por `SUPER_ADMIN` ou por administrador central
-- FORMALMENTE AUTORIZADO. "Formalmente autorizado" não pode ser um papel
-- genérico: precisa de quem concedeu, quando, por quê, com que escopo e até
-- quando.
--
-- MEDIDO antes de criar esta tabela: o projeto NÃO tem mecanismo de delegação.
-- A autorização hoje vem de `User.role` e `OrganizationMember.role`, e nenhum dos
-- dois carrega concessão, prazo nem revogação. Não havia estrutura para reusar.
--
-- `activeKey` é a mesma técnica de unicidade parcial das outras duas travas:
-- carrega `userId:permission:organizationId` enquanto a concessão vale, e vira
-- NULL na revogação.
-- --------------------------------------------------------------------------
CREATE TABLE "CentralAuthorization" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "permission"     TEXT NOT NULL,
  "organizationId" TEXT,
  "reason"         TEXT NOT NULL,
  "grantedById"    TEXT NOT NULL,
  "grantedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"      TIMESTAMP(3),
  "revokedById"    TEXT,
  "revokedAt"      TIMESTAMP(3),
  "revokeReason"   TEXT,
  "activeKey"      TEXT,
  CONSTRAINT "CentralAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CentralAuthorization_activeKey_key" ON "CentralAuthorization"("activeKey");
CREATE INDEX "CentralAuthorization_userId_permission_idx"
  ON "CentralAuthorization"("userId", "permission");
CREATE INDEX "CentralAuthorization_organizationId_idx"
  ON "CentralAuthorization"("organizationId");

ALTER TABLE "CentralAuthorization" ADD CONSTRAINT "CentralAuthorization_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CentralAuthorization" ADD CONSTRAINT "CentralAuthorization_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CentralAuthorization" ADD CONSTRAINT "CentralAuthorization_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CentralAuthorization" ADD CONSTRAINT "CentralAuthorization_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Revogada tem de ter data de revogação e não pode ter chave viva.
ALTER TABLE "CentralAuthorization" ADD CONSTRAINT "CentralAuthorization_revogacao_coerente"
  CHECK (
    ("revokedAt" IS NULL     AND "activeKey" IS NOT NULL)
    OR
    ("revokedAt" IS NOT NULL AND "activeKey" IS NULL)
  );


-- ============================================================================
-- 8. RLS NAS QUATRO TABELAS NOVAS
--
-- Elas NASCEM com RLS e FORCE. `Coach` e `Team`, que já existiam sem RLS,
-- continuam como estavam — ligar RLS nelas altera a leitura de rotas que já
-- funcionam, e isso exige plano de impacto próprio.
--
-- FORCE em todas: sem ele o DONO do schema fica isento das políticas, e o dono
-- é quem a aplicação usa nas migrations. É a mesma decisão da fase 10.2.
-- ============================================================================

ALTER TABLE "CoachDocument"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachDocument"         FORCE ROW LEVEL SECURITY;
ALTER TABLE "CoachOrganization"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CoachOrganization"     FORCE ROW LEVEL SECURITY;
ALTER TABLE "TeamMembershipRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TeamMembershipRequest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "CentralAuthorization"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CentralAuthorization"  FORCE ROW LEVEL SECURITY;


-- --------------------------------------------------------------------------
-- `CoachDocument` — documento pessoal, e por isso a política mais fechada.
--
-- Decisão R-05: o painel do treinador NÃO expõe documento. Quem lê é a
-- plataforma, para validar identidade, e o próprio dono do cadastro. Nenhum
-- operador de federação alcança.
--
-- `WITH CHECK` espelha o `USING` para que ninguém mova um documento de um
-- cadastro para outro — a lição do S6, na fase T4.
-- --------------------------------------------------------------------------
CREATE POLICY coach_documento_leitura ON "CoachDocument"
  FOR SELECT USING (
    mci_is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "CoachDocument"."coachId" AND c."userId" = mci_current_user_id()
    )
  );

CREATE POLICY coach_documento_escrita ON "CoachDocument"
  FOR INSERT WITH CHECK (
    mci_is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "CoachDocument"."coachId" AND c."userId" = mci_current_user_id()
    )
  );

CREATE POLICY coach_documento_remocao ON "CoachDocument"
  FOR DELETE USING (mci_is_platform_admin());


-- --------------------------------------------------------------------------
-- `CoachOrganization` — quem enxerga a autorização de atuação.
--
-- O próprio treinador, a federação envolvida e a plataforma. A escrita é da
-- plataforma: quem autoriza atuação não é a própria pessoa autorizada.
-- --------------------------------------------------------------------------
CREATE POLICY coach_org_leitura ON "CoachOrganization"
  FOR SELECT USING (
    mci_is_platform_admin()
    OR mci_operator_of("organizationId")
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "CoachOrganization"."coachId" AND c."userId" = mci_current_user_id()
    )
  );

CREATE POLICY coach_org_escrita ON "CoachOrganization"
  FOR INSERT WITH CHECK (mci_is_platform_admin());

CREATE POLICY coach_org_alteracao ON "CoachOrganization"
  FOR UPDATE USING (mci_is_platform_admin()) WITH CHECK (mci_is_platform_admin());


-- --------------------------------------------------------------------------
-- `TeamMembershipRequest` — os três atores legítimos.
--
-- O ATLETA, porque é ele quem decide; o TREINADOR que pediu, porque precisa
-- acompanhar; e o operador da federação da equipe, porque é a federação que
-- responde pelo vínculo.
--
-- `mci_atleta_do_usuario(athleteId)` é o helper que já existe e que responde "o
-- atleta desta linha é o da conta corrente".
--
-- A ALTERAÇÃO é onde a regra vive: o atleta decide, e o `WITH CHECK` impede que
-- a decisão mude de atleta ou de equipe no caminho. O treinador NÃO pode
-- decidir — ele só cancela o que pediu, e isso é `CANCELLED`, não `CONFIRMED`.
-- A separação de quem pode gravar qual estado é do SERVIÇO; a política garante
-- que nenhum dos três consiga reescrever a linha para fora do seu alcance.
-- --------------------------------------------------------------------------
CREATE POLICY vinculo_pedido_leitura ON "TeamMembershipRequest"
  FOR SELECT USING (
    mci_is_platform_admin()
    OR mci_atleta_do_usuario("athleteId")
    OR EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t.id = "TeamMembershipRequest"."teamId" AND mci_operator_of(t."organizationId")
    )
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "TeamMembershipRequest"."coachId" AND c."userId" = mci_current_user_id()
    )
  );

CREATE POLICY vinculo_pedido_criacao ON "TeamMembershipRequest"
  FOR INSERT WITH CHECK (
    mci_is_platform_admin()
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "TeamMembershipRequest"."coachId" AND c."userId" = mci_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t.id = "TeamMembershipRequest"."teamId" AND mci_operator_of(t."organizationId")
    )
  );

CREATE POLICY vinculo_pedido_alteracao ON "TeamMembershipRequest"
  FOR UPDATE
  USING (
    mci_is_platform_admin()
    OR mci_atleta_do_usuario("athleteId")
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "TeamMembershipRequest"."coachId" AND c."userId" = mci_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t.id = "TeamMembershipRequest"."teamId" AND mci_operator_of(t."organizationId")
    )
  )
  WITH CHECK (
    mci_is_platform_admin()
    OR mci_atleta_do_usuario("athleteId")
    OR EXISTS (
      SELECT 1 FROM "Coach" c
      WHERE c.id = "TeamMembershipRequest"."coachId" AND c."userId" = mci_current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t.id = "TeamMembershipRequest"."teamId" AND mci_operator_of(t."organizationId")
    )
  );


-- --------------------------------------------------------------------------
-- `CentralAuthorization` — a delegação, e ela é a mais sensível de todas.
--
-- Quem concede é a plataforma. Quem LÊ é a plataforma e o próprio delegado —
-- porque saber que poder se tem é legítimo, e não saber é pior.
--
-- NÃO HÁ POLÍTICA DE UPDATE NEM DE DELETE, de propósito: revogar é gravar
-- `revokedAt` e limpar `activeKey`, e isso passa pelo INSERT de uma linha nova
-- mais o UPDATE que só a plataforma faz. Deixar UPDATE aberto permitiria
-- esticar o prazo da própria delegação — que é autoelevação com outro nome.
--
-- A revogação é feita pela plataforma através de uma política de UPDATE
-- restrita a `mci_is_platform_admin()`, declarada abaixo. O serviço recusa que
-- alguém revogue ou conceda para si mesmo; a política garante que ninguém fora
-- da plataforma sequer alcance a linha.
-- --------------------------------------------------------------------------
CREATE POLICY central_leitura ON "CentralAuthorization"
  FOR SELECT USING (
    mci_is_platform_admin()
    OR "userId" = mci_current_user_id()
  );

CREATE POLICY central_concessao ON "CentralAuthorization"
  FOR INSERT WITH CHECK (mci_is_platform_admin());

CREATE POLICY central_revogacao ON "CentralAuthorization"
  FOR UPDATE USING (mci_is_platform_admin()) WITH CHECK (mci_is_platform_admin());
