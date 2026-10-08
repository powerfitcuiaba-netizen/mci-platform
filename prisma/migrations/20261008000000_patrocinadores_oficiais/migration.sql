-- ============================================================================
-- CATÁLOGO DE PATROCINADORES OFICIAIS DO CAMPEONATO.
--
-- O QUE ESTA TABELA É, E O QUE ELA NÃO É
--
-- Ela NÃO é o `Sponsor` que já existe. Aquele é uma empresa que patrocina um
-- evento, uma equipe ou um atleta DE UMA FEDERAÇÃO: tem `organizationId`
-- obrigatório, vive sob RLS por organização e se liga por `Sponsorship`.
--
-- Este catálogo é institucional: é quem patrocina o CAMPEONATO. Aparece na
-- tela de entrada — onde não existe organização nenhuma — e no rodapé da
-- vitrine pública. Por isso não tem `organizationId`: é o mesmo desenho de
-- `Category`, catálogo oficial e nacional que não pertence a federação alguma.
--
-- Nenhuma linha de `Sponsor`, `Brand` ou `Sponsorship` é tocada aqui.
--
-- POR QUE ELA TEM RLS, SE `Category` NÃO TEM
--
-- Porque o que ela guarda é compromisso comercial do campeonato inteiro, e a
-- escrita é de UM papel só. `Category` se protege pela permissão na rota; aqui
-- a permissão continua valendo E a política do banco repete a regra, para que
-- uma rota nova esquecida não abra o catálogo por omissão. É defesa em
-- profundidade sobre tabela nova — nenhuma política existente é afrouxada.
--
-- A LEITURA PÚBLICA É DO QUE ESTÁ ATIVO, e só. Patrocinador desativado
-- continua no banco (é histórico, e pode voltar), mas some da vitrine pela
-- própria política — não só pelo `where` do serviço.
-- ============================================================================

-- O NÍVEL É ENUM, e não texto livre: são exatamente quatro cotas, vendidas em
-- contrato. "Silver — apoio e parceiros" é a APRESENTAÇÃO do Silver, não um
-- quinto nível. A ordem declarada aqui é a hierarquia.
CREATE TYPE "SponsorLevel" AS ENUM ('GLOBAL', 'DIAMANTE', 'GOLD', 'SILVER');

CREATE TABLE "OfficialSponsor" (
    "id"          TEXT NOT NULL,
    "code"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "level"       "SponsorLevel" NOT NULL,
    "sortOrder"   INTEGER NOT NULL DEFAULT 0,
    "active"      BOOLEAN NOT NULL DEFAULT true,
    "logoKey"     TEXT NOT NULL,
    "siteUrl"     TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialSponsor_pkey" PRIMARY KEY ("id")
);

-- `code` é o identificador ESTÁVEL. É ele que torna o provisionamento das 15
-- marcas que já estavam no ar idempotente: rodar de novo encontra a linha em
-- vez de criar uma segunda.
CREATE UNIQUE INDEX "OfficialSponsor_code_key" ON "OfficialSponsor"("code");

-- A vitrine lê sempre o mesmo recorte: ativos, por nível e ordem.
CREATE INDEX "OfficialSponsor_active_level_sortOrder_idx"
  ON "OfficialSponsor"("active", "level", "sortOrder");

ALTER TABLE "OfficialSponsor"
  ADD CONSTRAINT "OfficialSponsor_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OfficialSponsor"
  ADD CONSTRAINT "OfficialSponsor_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- QUEM É SUPER ADMIN, EM SQL.
--
-- `mci_is_platform_admin()` já existe, mas ele aceita SUPER_ADMIN **e** ADMIN.
-- O catálogo oficial é de um papel só — uma federação, ou mesmo um ADMIN de
-- plataforma, não escolhe quem patrocina o campeonato brasileiro. Daí uma
-- função própria, em vez de afrouxar a que já existe e que outras políticas
-- usam.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mci_is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = mci_current_user_id()
      AND u.role = 'SUPER_ADMIN'
      AND u.status = 'ACTIVE'
  )
$$;

ALTER TABLE "OfficialSponsor" ENABLE ROW LEVEL SECURITY;
-- FORCE porque ENABLE não vale para o DONO da tabela, e as migrations rodam
-- com o dono do schema. Sem FORCE a política existiria e não se aplicaria ao
-- caminho real da aplicação — foi exatamente o defeito que a migration
-- `20260906180000_force_rls` corrigiu no resto do sistema.
ALTER TABLE "OfficialSponsor" FORCE ROW LEVEL SECURITY;

-- LEITURA: o que está ativo é público, inclusive para visitante anônimo (que
-- não tem `mci.user_id`). O super admin enxerga também o que está desativado,
-- que é o que a tela de administração precisa para reativar.
CREATE POLICY patrocinador_oficial_leitura ON "OfficialSponsor"
  FOR SELECT USING ("active" = true OR mci_is_super_admin());

-- ESCRITA: só super admin, nas três operações. `WITH CHECK` no INSERT e no
-- UPDATE para que a linha RESULTANTE também seja permitida — sem ele, um
-- update poderia gravar um estado que a política de leitura esconde de quem
-- acabou de escrevê-lo.
CREATE POLICY patrocinador_oficial_insercao ON "OfficialSponsor"
  FOR INSERT WITH CHECK (mci_is_super_admin());

CREATE POLICY patrocinador_oficial_alteracao ON "OfficialSponsor"
  FOR UPDATE USING (mci_is_super_admin()) WITH CHECK (mci_is_super_admin());

CREATE POLICY patrocinador_oficial_remocao ON "OfficialSponsor"
  FOR DELETE USING (mci_is_super_admin());
