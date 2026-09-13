-- ============================================================================
-- CADASTRO COMPLETO — colunas de contato, endereço e filiação.
--
-- ADITIVA. Dez colunas novas, todas ANULÁVEIS e sem DEFAULT. Nenhum DROP,
-- nenhum TRUNCATE, nenhum UPDATE, nenhuma constraint nova, nenhum índice novo.
--
-- POR QUE TODAS ANULÁVEIS
--
-- As contas que já existem em produção foram criadas antes destes campos. Uma
-- coluna NOT NULL exigiria preencher retroativamente dado que ninguém tem —
-- ou inventar valor, que é pior. A obrigatoriedade mora na VALIDAÇÃO do
-- cadastro novo, onde ela pertence: o formulário exige, o banco aceita a
-- história que já estava lá.
--
-- O QUE NÃO ENTRA AQUI, E POR QUÊ
--
-- CPF: continua em `AthleteIdentity` — tabela própria, sob RLS, única por
-- organização. Trazê-lo para `User` levaria o dado mais sensível do sistema
-- para toda conta criada, inclusive mídia, marca e público, que não competem.
-- A decisão de isolá-lo foi tomada antes e não é desfeita por conveniência de
-- formulário.
--
-- FOTO DE PERFIL: `SocialProfile.avatarKey` já existe, com upload que confere
-- o tipo pelos BYTES do arquivo e grava no R2. Uma segunda coluna de foto
-- criaria duas fontes de verdade para a mesma imagem.
--
-- ÍNDICES: nenhum. Estes campos são lidos junto com a linha do usuário, pelo
-- id — nunca filtrados nem ordenados. Índice sem consulta que o use é custo de
-- escrita sem retorno de leitura.
--
-- IMPACTO EM DADOS EXISTENTES: nenhum. Linhas atuais ganham NULL nas colunas
-- novas e seguem funcionando. Login, sessão e permissões não olham para estes
-- campos.
-- ============================================================================

-- Contato e endereço de qualquer usuário.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "whatsapp" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "postalCode" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "addressLine" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "addressNumber" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "addressComplement" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "city" TEXT;

-- Matrícula do atleta DENTRO da entidade de filiação. A entidade já é o
-- `affiliationId`; sozinho, o número não identifica ninguém, porque duas
-- federações podem emitir a mesma numeração.
ALTER TABLE "Athlete" ADD COLUMN IF NOT EXISTS "affiliationNumber" TEXT;
