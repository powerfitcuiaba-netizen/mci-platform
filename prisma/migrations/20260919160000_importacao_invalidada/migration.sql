-- ===========================================================================
-- INVALIDAR UM LOTE JÁ APLICADO, SEM APAGAR O QUE ELE PUBLICOU.
--
-- Excluir uma importação são duas operações diferentes, e o schema precisa
-- saber distinguir:
--
--   lote que NUNCA foi aplicado  some do banco, com os seus itens. Não há
--   estado a registrar — ele deixa de existir.
--
--   lote JÁ APLICADO             gerou RankingPoint. DELETE físico aqui perde
--   histórico esportivo, então o lote permanece, marcado como INVALIDATED,
--   com quem invalidou, quando e por quê. Os lançamentos que ele gerou são
--   invalidados pelo mecanismo homologado (`voidedAt` em RankingPoint), não
--   removidos.
--
-- Tudo aditivo: nenhuma coluna existente muda de tipo, nenhuma linha é
-- reescrita, e um lote antigo continua válido com os três campos nulos.
-- ===========================================================================

-- Novo estado terminal. Não substitui REJECTED: rejeitar é recusar ANTES de
-- publicar; invalidar é desfazer DEPOIS de publicado.
ALTER TYPE "ImportStatus" ADD VALUE IF NOT EXISTS 'INVALIDATED';

ALTER TABLE "MuscleWarImport" ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP(3);
ALTER TABLE "MuscleWarImport" ADD COLUMN IF NOT EXISTS "invalidatedById" TEXT;
ALTER TABLE "MuscleWarImport" ADD COLUMN IF NOT EXISTS "invalidateReason" TEXT;

-- O autor da invalidação segue a mesma regra dos outros vínculos com User no
-- modelo: se a conta for removida, o registro do lote permanece e o autor
-- fica nulo. Perder a auditoria junto com o usuário seria pior.
ALTER TABLE "MuscleWarImport"
  ADD CONSTRAINT "MuscleWarImport_invalidatedById_fkey"
  FOREIGN KEY ("invalidatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A listagem do operador filtra por lote invalidado para mostrar o selo.
CREATE INDEX IF NOT EXISTS "MuscleWarImport_invalidatedAt_idx"
  ON "MuscleWarImport" ("invalidatedAt");
