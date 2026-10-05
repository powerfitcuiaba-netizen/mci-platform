-- ===========================================================================
-- CORREÇÃO ADMINISTRATIVA DE FILIAÇÃO EM RESULTADO IMPORTADO
--
-- O QUE ESTA MIGRATION RESOLVE
--
-- A fonte erra. No arquivo oficial do Razor o atleta veio com a filiação 2952
-- quando a correta, já cadastrada no MCI, é 2932. O sistema acertou em NÃO
-- vincular — nome não identifica ninguém, e é essa recusa que impede creditar
-- pontos de campeonato a um homônimo.
--
-- Faltava ao operador um jeito seguro e auditável de corrigir o dígito.
--
-- POR QUE COLUNAS NOVAS, E NÃO UM UPDATE EM `memberNumber`
--
-- `memberNumber` é PROVA DOCUMENTAL: é o que a fonte escreveu. Sobrescrevê-lo
-- apagaria justamente a evidência de que houve erro na origem, e a decisão do
-- operador deixaria de ser conferível contra o arquivo. As duas leituras
-- coexistem, e a efetiva é `correctedMemberNumber ?? memberNumber`.
--
-- POR QUE NÃO É DESTRUTIVA
--
-- Quatro colunas NOVAS, todas anuláveis, sem DEFAULT que reescreva linha.
-- Nenhum dado existente é alterado, nenhuma constraint existente muda, e a
-- tabela não é reescrita: no PostgreSQL, ADD COLUMN anulável sem default é
-- alteração de catálogo, não varredura de heap.
--
-- POR QUE NENHUM ÍNDICE NOVO
--
-- A busca de candidatos da correção é por `Athlete(organizationId,
-- affiliationId, affiliationNumber)`, que JÁ tem índice único parcial
-- (20260921120000_matricula_identifica_um_atleta). `correctedMemberNumber`
-- não é chave de busca de ninguém: ela é lida pela própria linha, por id.
-- Criar índice sem consulta que o use é custo de escrita sem retorno.
--
-- `correctedById` segue `linkedById` da mesma tabela: TEXT sem FOREIGN KEY. É
-- o padrão desta tabela, e divergir só nesta coluna criaria inconsistência
-- sem ganho nenhum.
--
-- RLS: nada a fazer. `MuscleWarImportItem` já está sob política pela
-- organização do lote; coluna nova herda a política da tabela.
-- ===========================================================================

ALTER TABLE "MuscleWarImportItem" ADD COLUMN "correctedMemberNumber" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "correctionReason" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "correctedById" TEXT;
ALTER TABLE "MuscleWarImportItem" ADD COLUMN "correctedAt" TIMESTAMP(3);
