-- ============================================================================
-- DESCOBERTA DE FILIAÇÕES PARA AUTOCADASTRO
--
-- O problema medido: quem acaba de criar conta não tem vínculo com
-- organização nenhuma, e `GET /affiliations` é escopado ao vínculo do ator.
-- A lista voltava vazia SEMPRE, e a fila de perfil de atleta ficava
-- inalcançável justamente para quem ela existe para atender.
--
-- POR QUE UMA COLUNA NOVA, E NÃO `Organization.active`
--
-- `active` responde "esta organização está operando?". A pergunta que o
-- autocadastro faz é outra: "esta federação aceita que uma pessoa de fora se
-- apresente a ela?". São decisões diferentes e devem poder divergir — uma
-- federação em plena operação pode não querer receber pedido espontâneo.
-- Reaproveitar `active` tornaria toda organização em operação publicamente
-- listável por efeito colateral desta migration, que é exatamente o que não
-- se quer.
--
-- O PADRÃO É `false`: NENHUMA organização passa a ser descoberta por causa
-- desta migration. Cada federação decide, por
-- `POST /organizations/:id/self-registration`, e o ato fica em auditoria.
-- ============================================================================

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "selfRegistrationOpen" BOOLEAN NOT NULL DEFAULT false;

-- A vitrine consulta por (aceita autocadastro + ativa). O índice parcial cobre
-- exatamente essa consulta e não pesa nas demais.
CREATE INDEX IF NOT EXISTS "Organization_autocadastro"
  ON "Organization" ("selfRegistrationOpen")
  WHERE "selfRegistrationOpen" = true AND "active" = true;
