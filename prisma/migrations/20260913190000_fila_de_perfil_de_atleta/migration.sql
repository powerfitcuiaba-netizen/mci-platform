-- ============================================================================
-- FILA DE APROVAÇÃO DE PERFIL DE ATLETA.
--
-- ADITIVA. Um enum novo, uma tabela nova, índices e políticas da tabela nova.
-- Nenhum DROP, nenhum TRUNCATE, nenhum UPDATE em dado existente, e NENHUMA
-- política existente alterada — em especial `atleta_criacao`, que continua
-- exigindo `mci_operator_of`. A fila existe justamente para NÃO precisar
-- afrouxá-la.
--
-- POR QUE ELA EXISTE
--
-- Quem acaba de criar conta não é operador de federação nenhuma, então não
-- pode criar a própria linha de `Athlete`. Sem esta fila restariam duas
-- saídas ruins: não registrar atleta pelo autocadastro, ou deixar qualquer
-- pessoa escrever no tenant de uma federação. A fila separa PEDIR de
-- CONCEDER.
--
-- O CPF AQUI É TEMPORÁRIO, E ESTÁ PROTEGIDO
--
-- Ele fica nesta tabela entre o pedido e a análise porque o operador precisa
-- vê-lo para decidir. É a única exceção ao "CPF só em AthleteIdentity", e por
-- isso a tabela nasce com RLS FORÇADA e política estreita: enxergam a linha
-- apenas o DONO do pedido e os OPERADORES da organização. Na aprovação o
-- documento migra para `AthleteIdentity` e é apagado daqui.
-- ============================================================================

CREATE TYPE "AthleteProfileRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE "AthleteProfileRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "affiliationId" TEXT NOT NULL,
    "affiliationNumber" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "sex" "Sex" NOT NULL,
    "birthDate" TIMESTAMP(3),
    "cpf" TEXT,
    "photoKey" TEXT,
    "status" "AthleteProfileRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "athleteId" TEXT,
    CONSTRAINT "AthleteProfileRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AthleteProfileRequest_organizationId_status_idx" ON "AthleteProfileRequest"("organizationId", "status");
CREATE INDEX "AthleteProfileRequest_userId_idx" ON "AthleteProfileRequest"("userId");

-- Um pedido EM ABERTO por pessoa. O recorte por status é o que importa: sem
-- ele, quem fosse recusado uma vez nunca mais poderia tentar. O Prisma não
-- modela índice parcial, então ele vive aqui.
CREATE UNIQUE INDEX "AthleteProfileRequest_um_pendente_por_usuario"
  ON "AthleteProfileRequest"("userId") WHERE "status" = 'PENDING';

ALTER TABLE "AthleteProfileRequest" ADD CONSTRAINT "AthleteProfileRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AthleteProfileRequest" ADD CONSTRAINT "AthleteProfileRequest_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: apagar uma entidade de filiação que tem pedido pendurado apagaria
-- o histórico de quem pediu por ela.
ALTER TABLE "AthleteProfileRequest" ADD CONSTRAINT "AthleteProfileRequest_affiliationId_fkey"
  FOREIGN KEY ("affiliationId") REFERENCES "Affiliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AthleteProfileRequest" ADD CONSTRAINT "AthleteProfileRequest_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AthleteProfileRequest" ADD CONSTRAINT "AthleteProfileRequest_athleteId_fkey"
  FOREIGN KEY ("athleteId") REFERENCES "Athlete"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------- RLS
-- FORCE porque o dono da tabela também precisa obedecer: sem isso o papel da
-- aplicação passaria por cima da política.
ALTER TABLE "AthleteProfileRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AthleteProfileRequest" FORCE ROW LEVEL SECURITY;

-- LEITURA: o dono vê o próprio pedido; o operador da federação vê os que
-- foram endereçados a ela. Mais ninguém — nem outro atleta, nem operador de
-- outra federação.
DROP POLICY IF EXISTS pedido_atleta_leitura ON "AthleteProfileRequest";
CREATE POLICY pedido_atleta_leitura ON "AthleteProfileRequest"
  FOR SELECT USING (
    "userId" = mci_current_user_id()
    OR mci_operator_of("organizationId")
  );

-- CRIAÇÃO: só em nome próprio. É o ponto da fila — aqui NÃO se exige ser
-- operador, e é por isso que o autocadastro funciona sem furar
-- `atleta_criacao`.
DROP POLICY IF EXISTS pedido_atleta_criacao ON "AthleteProfileRequest";
CREATE POLICY pedido_atleta_criacao ON "AthleteProfileRequest"
  FOR INSERT WITH CHECK ("userId" = mci_current_user_id());

-- ALTERAÇÃO: o operador analisa; o dono só alcança a própria linha (para
-- cancelar). Quem decide o que cada um pode mudar é o serviço; a política
-- garante que ninguém alcance linha alheia.
DROP POLICY IF EXISTS pedido_atleta_alteracao ON "AthleteProfileRequest";
CREATE POLICY pedido_atleta_alteracao ON "AthleteProfileRequest"
  FOR UPDATE USING (
    "userId" = mci_current_user_id()
    OR mci_operator_of("organizationId")
  )
  WITH CHECK (
    "userId" = mci_current_user_id()
    OR mci_operator_of("organizationId")
  );

-- Sem política de DELETE: a fila é histórico auditável. Recusa não apaga.
