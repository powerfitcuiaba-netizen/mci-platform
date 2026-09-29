-- ===========================================================================
-- A LEITURA DE ATLETA PELO TREINADOR — ACHADO A-03, E O QUE ELE REALMENTE É.
--
-- O ACHADO. `atleta_leitura` liberava linha de `Athlete` de TODA a federação ao
-- treinador aprovado e autorizado nela (`mci_treinador_autorizado_de`). R-05 diz
-- que o treinador vê dado esportivo dos atletas VINCULADOS A ELE. A política era
-- mais larga que a decisão.
--
-- O QUE FOI MEDIDO ANTES DE ESCOLHER A CORREÇÃO, e que muda o desenho:
--
--   1. A PRIMEIRA cláusula desta mesma política é `mci_current_user_id() IS NULL`
--      — visitante ANÔNIMO lê TODA linha de `Athlete`. A vitrine pública do
--      atleta, o ranking público e a busca pública dependem disso. Logo o
--      conjunto que o treinador autorizado lê é SUBCONJUNTO do que qualquer
--      requisição sem sessão já lê. A cláusula do treinador não expõe um dado
--      que estivesse fechado: ela apenas devolve ao ator autenticado o que o
--      anônimo tem.
--
--   2. O QUE R-05 PROTEGE NÃO ESTÁ EM `Athlete`. CPF vive em `AthleteIdentity`,
--      documento em `AthleteDocument`, cada um com RLS própria, que esta
--      migration não menciona e que nenhuma cláusula de treinador alcança.
--
--   3. A PRIVACIDADE DE `Athlete`, NESTA ARQUITETURA, É DA PROJEÇÃO. Quem decide
--      o que sai para o treinador é `SELECT_ATLETA_ESPORTIVO` (coachService) e
--      `SELECT_LOCALIZACAO` (membershipRequestService) — listas explícitas, sem
--      `cpf`, sem telefone, sem nascimento, sem documento. A RLS aqui é o PISO.
--
-- O QUE ESTA MIGRATION ESTREITA, E POR QUE SÓ ISSO
--
-- A cláusula passa a exigir, além de cadastro aprovado (R-03) e autorização viva
-- na federação (R-04), que o treinador seja RESPONSÁVEL POR ALGUMA EQUIPE naquela
-- federação. É o estreitamento que não custa função nenhuma: treinador sem equipe
-- na federação não tem a quem listar (não há vínculo) e não tem para onde
-- convidar (o pedido de vínculo exige equipe PRÓPRIA, ver
-- `membershipRequestService.autorizarSolicitacao`). Ele lia a federação inteira
-- sem ter um uso legítimo para a leitura.
--
-- O EFEITO PRÁTICO é imediato em três situações reais: treinador recém-autorizado
-- que ainda não recebeu equipe; treinador que teve a última equipe passada a
-- outro responsável; treinador autorizado numa federação onde nunca atuou.
--
-- O QUE NÃO FOI FEITO, E FICA REGISTRADO COMO DECISÃO PENDENTE
--
-- Estreitar até "somente os atletas efetivamente vinculados"
-- (`mci_treinador_da_equipe("teamId")` sozinho) QUEBRA dois fluxos medidos do
-- módulo, e já quebrou uma vez: com esse predicado,
-- `POST /team-membership-requests` responde 404 ATHLETE_NOT_FOUND e
-- `POST /athletes/lookup-affiliation` responde sempre `found: false` — porque
-- para CONVIDAR alguém é preciso enxergá-lo ANTES de ele estar na equipe. A
-- listagem de pedidos pendentes da equipe perderia o nome do convidado pelo mesmo
-- motivo.
--
-- As saídas conhecidas para fechar o resíduo são DUAS, e nenhuma pode ser tomada
-- por conta própria:
--
--   (i)  amarrar a leitura larga a um PROPÓSITO declarado na transação (um
--        `SET LOCAL` de intenção, conferido pela política), de modo que só a
--        busca por matrícula e a criação do pedido leiam além do vínculo. Não é
--        contorno de RLS — não há SECURITY DEFINER, BYPASSRLS nem USING(true) —,
--        mas espalha uma marca de intenção por três serviços, e ESQUECER a marca
--        produz lista vazia silenciosa, que é o defeito exato que este módulo já
--        teve;
--   (ii) mudar COMO o atleta é descoberto para convite (consentimento,
--        diretório de opt-in, ou convite por código gerado pelo atleta). É regra
--        de produto, e este projeto não inventa regra.
--
-- Ambas exigem decisão formal. Fica reportado, e não decidido aqui.
--
-- Nenhum dado é lido, escrito ou apagado por esta migration.
-- ===========================================================================

-- Treinador APROVADO, AUTORIZADO nesta federação e RESPONSÁVEL por ao menos uma
-- equipe dela.
--
-- Os quatro predicados valem juntos, e derrubar qualquer um derruba a leitura na
-- requisição seguinte: é o que faz da suspensão do cadastro, da revogação da
-- autorização e da troca de responsável pela equipe efeitos imediatos, sem job e
-- sem cache.
--
-- Lê `CoachOrganization`, `Coach` e `Team`. Nenhuma das três lê `Athlete` nem
-- `AthleteTeamMembership`, então não há ciclo de política a fechar — a recursão é
-- real neste esquema e está documentada na migration 20260926040000.
CREATE OR REPLACE FUNCTION mci_treinador_com_equipe_em(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT org_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "CoachOrganization" co
    JOIN "Coach" c ON c."id" = co."coachId"
    JOIN "Team" t
      ON t."coachId" = co."coachId"
     AND t."organizationId" = co."organizationId"
    WHERE co."organizationId" = org_id
      AND co."status" = 'APPROVED'
      AND c."userId" = mci_current_user_id()
      AND c."status" = 'APPROVED'
  )
$$;

-- As três primeiras cláusulas são reproduzidas sem alteração: visitante anônimo
-- (superfície pública), o próprio dono da conta, e membro da federação. Só a
-- quarta muda, e muda para menos.
DROP POLICY IF EXISTS atleta_leitura ON "Athlete";

CREATE POLICY atleta_leitura ON "Athlete" FOR SELECT
  USING (
    mci_current_user_id() IS NULL
    OR "userId" = mci_current_user_id()
    OR mci_member_of("organizationId")
    OR mci_treinador_com_equipe_em("organizationId")
  );
