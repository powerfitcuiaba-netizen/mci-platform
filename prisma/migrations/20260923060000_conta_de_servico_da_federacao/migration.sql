-- ============================================================================
-- CONTA DE SERVIÇO DA FEDERAÇÃO — identidade técnica, uma por organização.
--
-- POR QUE ELA EXISTE
--
-- O autocadastro passa a concluir sozinho e a conciliar o histórico do atleta.
-- Conciliar significa ESCREVER no ledger: `RankingPoint.athleteId` deixa de ser
-- nulo. E escrever no ledger exige ser operador da federação — é o que a
-- política `lancamento_alteracao` cobra, e ela não vai mudar.
--
-- Havia dois jeitos de fazer o autocadastro escrever ali: alargar a política
-- para o atleta, ou rodar a operação como alguém que JÁ é operador. O primeiro
-- daria a quem se cadastra permissão de escrita na tabela de pontuação. Este
-- arquivo implementa o segundo.
--
-- O QUE ELA É, E O QUE NÃO É
--
-- É uma identidade técnica. NÃO é conta de pessoa: `isServiceAccount` a marca,
-- o login a recusa, e o cadastro aberto nunca a produz. No nível da APLICAÇÃO
-- ela não recebe permissão nenhuma além da base — todo o seu poder está no
-- banco, e o RLS o confina a UMA federação.
--
-- POR QUE A AMARRA É DO BANCO, E NÃO DE CONVENÇÃO
--
-- "uma conta de serviço por federação" é a frase que impede uma identidade de
-- alcançar o histórico de outra. Frase não impede nada. O índice único em
-- `serviceOrganizationId` impede, e a restrição de coerência impede que exista
-- conta de serviço sem federação — que seria uma identidade técnica solta, sem
-- fronteira nenhuma.
-- ============================================================================

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isServiceAccount" boolean NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "serviceOrganizationId" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_serviceOrganizationId_fkey'
  ) THEN
    ALTER TABLE "User"
      ADD CONSTRAINT "User_serviceOrganizationId_fkey"
      FOREIGN KEY ("serviceOrganizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- UMA, e uma só, por federação.
CREATE UNIQUE INDEX IF NOT EXISTS "User_serviceOrganizationId_key"
  ON "User"("serviceOrganizationId");

-- Marca e federação andam juntas: uma sem a outra é estado sem significado.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conta_de_servico_coerente'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "conta_de_servico_coerente" CHECK (
      ("isServiceAccount" = false AND "serviceOrganizationId" IS NULL)
      OR
      ("isServiceAccount" = true AND "serviceOrganizationId" IS NOT NULL)
    );
  END IF;
END $$;

-- O papel da membresia. Acrescentar valor a enum não destrói nada; o valor só
-- pode ser USADO depois que esta transação fechar, e é por isso que a função
-- `mci_operator_of` é atualizada na migration seguinte, e não aqui.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'FEDERATION_SERVICE';
