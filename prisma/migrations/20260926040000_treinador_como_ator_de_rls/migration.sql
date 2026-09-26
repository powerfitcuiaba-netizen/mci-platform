-- ===========================================================================
-- O TREINADOR PASSA A SER UM ATOR QUE O BANCO CONHECE.
--
-- O PROBLEMA, MEDIDO E NÃO SUPOSTO
--
-- O módulo Treinadores & Equipes autoriza o treinador na CAMADA DE APLICAÇÃO
-- por `CoachOrganization` (decisão R-04: identidade global, atuação por
-- federação). O banco não sabia nada disso. As políticas de `Athlete` e de
-- `AthleteTeamMembership` reconhecem `mci_member_of` e `mci_operator_of`, que
-- leem `OrganizationMember` — e o treinador NÃO tem linha em
-- `OrganizationMember`, justamente porque a autorização dele é outra tabela.
--
-- Resultado medido: `GET /coaches/me/athletes` respondia 200 com lista VAZIA
-- para o treinador aprovado, autorizado na federação e responsável pela equipe.
-- A aplicação o autorizava e o banco o cegava. Pior: um visitante ANÔNIMO lia
-- mais atletas que ele, porque `atleta_leitura` libera
-- `mci_current_user_id() IS NULL`.
--
-- Isto NÃO é contornar RLS. Não há `USING (true)`, não há `BYPASSRLS`, não há
-- `SECURITY DEFINER`, não há política global para `anon`. O que se acrescenta é
-- uma condição NOVA e estreita: o treinador APROVADO, AUTORIZADO naquela
-- federação e RESPONSÁVEL por aquela equipe lê as linhas daquela equipe. Fora
-- desses três predicados simultâneos, nada muda para ninguém.
--
-- POR QUE O PREDICADO OLHA `teamId`, E NÃO O VÍNCULO
--
-- A tentação era escrever `mci_treinador_do_atleta(athleteId)` percorrendo
-- `AthleteTeamMembership`. Isso produziria RECURSÃO DE POLÍTICA, e a recursão é
-- real, não hipotética:
--
--   `vinculo_leitura` (em AthleteTeamMembership) chama `mci_atleta_do_usuario`,
--   que LÊ `Athlete` — logo `atleta_leitura` é avaliada; se `atleta_leitura`
--   passasse a ler `AthleteTeamMembership`, voltaríamos ao começo, e o
--   PostgreSQL aborta com "infinite recursion detected in policy for relation".
--
-- A saída é olhar apenas colunas de tabelas que não fecham o ciclo:
-- `mci_treinador_da_equipe(team_id)` lê `Team` (sem RLS), `CoachOrganization` e
-- `Coach`. Nenhuma delas lê `Athlete` nem `AthleteTeamMembership`.
--
-- Em `Athlete` o predicado usa a coluna `teamId` — o ESPELHO do vínculo
-- corrente, mantido por `membershipService` na MESMA transação que grava o
-- vínculo (ver `criarVinculo`). Para VISIBILIDADE o espelho basta e não abre
-- ciclo; a lista autoritativa que o serviço devolve continua saindo de
-- `AthleteTeamMembership`, que é a verdade do vínculo.
--
-- ALCANCE DA LEITURA, EXPLÍCITO: o treinador passa a LER linha de `Athlete` e
-- de `AthleteTeamMembership` da própria equipe. Não ganha INSERT, UPDATE nem
-- DELETE em nenhuma das duas — as políticas de escrita não são tocadas por esta
-- migration. E o CPF continua fora do alcance dele: ele vive em
-- `AthleteIdentity`, tabela separada com RLS próprio, que esta migration não
-- menciona.
-- ===========================================================================

-- O id do cadastro de treinador APROVADO desta conta, ou NULL.
--
-- NULL é o caso comum (quase ninguém é treinador), e comparar qualquer coluna
-- com NULL dá NULL, que o EXISTS trata como falso. A função falha FECHADA por
-- construção, sem precisar de um `IF` para isso.
CREATE OR REPLACE FUNCTION mci_treinador_aprovado_do_usuario() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c."id" FROM "Coach" c
  WHERE c."userId" = mci_current_user_id()
    AND c."status" = 'APPROVED'
  LIMIT 1
$$;

-- Esta conta é a treinadora RESPONSÁVEL por esta equipe, e está AUTORIZADA na
-- federação da equipe?
--
-- Os três predicados valem juntos: cadastro aprovado (R-03), autorização viva
-- naquela federação (R-04) e responsabilidade por aquela equipe. Derrubar
-- qualquer um derruba a visibilidade — é o que faz da suspensão e da revogação
-- efeitos imediatos, sem job e sem cache.
CREATE OR REPLACE FUNCTION mci_treinador_da_equipe(team_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT team_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "Team" t
    JOIN "CoachOrganization" co
      ON co."coachId" = t."coachId"
     AND co."organizationId" = t."organizationId"
    WHERE t."id" = team_id
      AND t."coachId" = mci_treinador_aprovado_do_usuario()
      AND co."status" = 'APPROVED'
  )
$$;


-- --------------------------------------------------------------------------
-- `Athlete` — a leitura ganha o treinador da equipe do atleta.
--
-- As três cláusulas anteriores são reproduzidas sem alteração: visitante
-- anônimo (superfície pública), o próprio dono da conta, e membro da
-- federação. A quarta é nova.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS atleta_leitura ON "Athlete";

CREATE POLICY atleta_leitura ON "Athlete" FOR SELECT
  USING (
    mci_current_user_id() IS NULL
    OR "userId" = mci_current_user_id()
    OR mci_member_of("organizationId")
    OR mci_treinador_da_equipe("teamId")
  );


-- --------------------------------------------------------------------------
-- `AthleteTeamMembership` — a leitura ganha o treinador da equipe do vínculo.
--
-- As duas cláusulas anteriores continuam: operador da federação da equipe e o
-- próprio atleta. A terceira é nova, e é o que faz o painel do treinador
-- mostrar os atletas dele.
--
-- O treinador vê o vínculo com a EQUIPE DELE, inclusive os encerrados daquela
-- equipe — é o histórico da própria equipe, que ele precisa para conferir quem
-- estava nela em cada etapa (R-01). Vínculo com outra equipe continua invisível
-- para ele.
-- --------------------------------------------------------------------------
DROP POLICY IF EXISTS vinculo_leitura ON "AthleteTeamMembership";

CREATE POLICY vinculo_leitura ON "AthleteTeamMembership" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId"
        AND mci_operator_of(t."organizationId")
    )
    OR mci_atleta_do_usuario("athleteId")
    OR mci_treinador_da_equipe("teamId")
  );


-- ===========================================================================
-- `CoachOrganization` — QUEM ESCREVE A AUTORIZAÇÃO É A FEDERAÇÃO.
--
-- A migration anterior (`20260926020000`) deu a escrita desta tabela somente a
-- `mci_is_platform_admin()`. Estava errado, e o erro era de LEITURA DA DECISÃO,
-- não de implementação: R-03 diz que a administração central aprova o CADASTRO
-- do treinador; R-04 diz que a atuação é por federação. Quem decide se um
-- treinador atua na federação A é a federação A.
--
-- MEDIDO antes da correção: `POST /coaches/:id/organizations` pelo diretor da
-- federação respondia 500 com PostgresError 42501 — "new row violates row-level
-- security policy for table CoachOrganization". A camada de aplicação autorizava
-- (a permissão `coaches.authorize_org` é do `EVENT_DIRECTOR`) e o banco recusava.
--
-- A condição nova é `mci_operator_of("organizationId")`: o operador da PRÓPRIA
-- federação, e o predicado é sobre a coluna da linha, então a federação A não
-- consegue escrever linha da federação B nem no INSERT nem no UPDATE — o
-- `WITH CHECK` cobre o estado FINAL da linha, que é exatamente onde uma troca de
-- `organizationId` no meio do caminho seria pega.
--
-- `mci_is_platform_admin()` continua valendo: a administração central pode agir
-- em qualquer federação, como em todo o resto do sistema.
-- ===========================================================================
DROP POLICY IF EXISTS coach_org_escrita ON "CoachOrganization";
DROP POLICY IF EXISTS coach_org_alteracao ON "CoachOrganization";

CREATE POLICY coach_org_escrita ON "CoachOrganization"
  FOR INSERT WITH CHECK (
    mci_is_platform_admin()
    OR mci_operator_of("organizationId")
  );

CREATE POLICY coach_org_alteracao ON "CoachOrganization"
  FOR UPDATE
  USING (
    mci_is_platform_admin()
    OR mci_operator_of("organizationId")
  )
  WITH CHECK (
    mci_is_platform_admin()
    OR mci_operator_of("organizationId")
  );


-- ===========================================================================
-- O TREINADOR PRECISA LER O ATLETA QUE AINDA NÃO É DA EQUIPE DELE.
--
-- MEDIDO: com a política acima (treinador lê atleta da PRÓPRIA equipe),
-- `POST /team-membership-requests` respondia 404 ATHLETE_NOT_FOUND, e
-- `POST /athletes/lookup-affiliation` respondia sempre `found: false`. A causa é
-- circular por construção: para CONVIDAR alguém para a equipe, o treinador tem
-- de enxergá-lo ANTES de ele estar na equipe — e o predicado por `teamId` só
-- enxerga quem já está.
--
-- A condição passa a ser a FEDERAÇÃO: o treinador APROVADO e AUTORIZADO na
-- federação lê linha de `Athlete` daquela federação. Três coisas sustentam que
-- isso não amplia exposição de dado pessoal:
--
--   1. NÃO É EXPOSIÇÃO NOVA. `atleta_leitura` já libera
--      `mci_current_user_id() IS NULL` — visitante ANÔNIMO lê linha de `Athlete`,
--      porque a vitrine pública do atleta e o ranking dependem disso. Um
--      treinador autorizado passa a ler o que qualquer visitante já lia; antes
--      desta cláusula, ele lia MENOS que um anônimo, o que era o defeito.
--
--   2. O QUE R-05 PROTEGE NÃO ESTÁ AQUI. CPF vive em `AthleteIdentity`,
--      documento em `AthleteDocument`: tabelas separadas, com RLS própria, que
--      esta migration não menciona e que nenhuma cláusula de treinador alcança.
--      `Athlete` guarda identidade esportiva e filiação.
--
--   3. O LIMITE DE "SÓ OS MEUS" É DA APLICAÇÃO, e é onde ele pertence.
--      `coachService.meusAtletas` lista apenas os vínculos ativos das equipes do
--      treinador; a busca por matrícula exige o número COMPLETO, devolve um
--      registro ou nenhum, é auditada com autor e tem teto de requisições. A RLS
--      aqui garante o PISO (nada de outra federação); o teto de cada resposta é
--      a projeção explícita do serviço.
--
-- A cláusula por equipe sai de `atleta_leitura` porque a de federação a contém —
-- duas cláusulas para a mesma permissão só dariam trabalho a quem for auditar.
-- Em `AthleteTeamMembership` a cláusula por EQUIPE permanece: o histórico de
-- vínculo de atleta de OUTRA equipe continua invisível ao treinador.
-- ===========================================================================
CREATE OR REPLACE FUNCTION mci_treinador_autorizado_de(org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT org_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "CoachOrganization" co
    JOIN "Coach" c ON c."id" = co."coachId"
    WHERE co."organizationId" = org_id
      AND co."status" = 'APPROVED'
      AND c."userId" = mci_current_user_id()
      AND c."status" = 'APPROVED'
  )
$$;

DROP POLICY IF EXISTS atleta_leitura ON "Athlete";

CREATE POLICY atleta_leitura ON "Athlete" FOR SELECT
  USING (
    mci_current_user_id() IS NULL
    OR "userId" = mci_current_user_id()
    OR mci_member_of("organizationId")
    OR mci_treinador_autorizado_de("organizationId")
  );


-- ===========================================================================
-- A CONFIRMAÇÃO DO ATLETA PRECISA PODER GRAVAR O VÍNCULO DELE.
--
-- A regra aprovada do módulo é que o vínculo nasce da CONFIRMAÇÃO DO ATLETA:
-- enviar solicitação não vincula ninguém. Quem executa a escrita, então, é a
-- sessão do atleta — e `vinculo_escrita` era `FOR ALL` com operador da federação
-- nos dois lados.
--
-- MEDIDO: `POST /team-membership-requests/:id/confirm` respondia 500 com
-- PostgresError 42501 em `AthleteTeamMembership.create`. A aplicação autorizava
-- por TITULARIDADE (ver `membershipService.vincularPorConfirmacao`, que recusa
-- quem não é o dono da conta do atleta) e o banco recusava por não reconhecer
-- essa titularidade.
--
-- A correção separa `FOR ALL` em duas políticas, e a separação é o ponto:
--
--   INSERT  — operador da federação da equipe OU O PRÓPRIO ATLETA da linha.
--   UPDATE/DELETE — SOMENTE operador. O atleta NÃO encerra o próprio vínculo
--   por aqui: sair de uma equipe passa por `athletes.transfer`, que é o poder
--   central de R-02. Se `FOR ALL` tivesse ganhado a cláusula do dono, o atleta
--   poderia encerrar o vínculo sozinho — e a regra "o treinador não perde o
--   atleta sem decisão central" cairia pela porta oposta.
--
-- O predicado é `mci_atleta_do_usuario("athleteId")`, avaliado na LINHA NOVA:
-- o atleta só cria vínculo PARA SI. Não há caminho para criar vínculo de
-- terceiro, nem para apontar o vínculo a outro atleta no meio do caminho.
--
-- A trava de vínculo único continua sendo o índice em `activeAthleteId`, que
-- nenhuma política afeta: o atleta confirmando um segundo vínculo é recusado
-- pelo banco exatamente como qualquer outro ator.
-- ===========================================================================
-- Os três DROP abaixo não são cerimônia: sem eles, uma reexecução desta
-- migration aborta no primeiro `CREATE POLICY` com 42710 ("policy already
-- exists") e TUDO o que vem depois no arquivo deixa de ser aplicado. Medido
-- aqui: a política de auditoria, que está no fim do arquivo, ficou sem a
-- cláusula do treinador exatamente por isso, e a falha se manifestou como
-- "a busca do treinador não deixa rastro" — longe da causa.
DROP POLICY IF EXISTS vinculo_escrita ON "AthleteTeamMembership";
DROP POLICY IF EXISTS vinculo_criacao ON "AthleteTeamMembership";
DROP POLICY IF EXISTS vinculo_alteracao ON "AthleteTeamMembership";
DROP POLICY IF EXISTS vinculo_remocao ON "AthleteTeamMembership";

CREATE POLICY vinculo_criacao ON "AthleteTeamMembership" FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId")
    )
    OR mci_atleta_do_usuario("athleteId")
  );

CREATE POLICY vinculo_alteracao ON "AthleteTeamMembership" FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId")
    )
  );

CREATE POLICY vinculo_remocao ON "AthleteTeamMembership" FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId" AND mci_operator_of(t."organizationId")
    )
  );


-- ===========================================================================
-- A AÇÃO DO TREINADOR TEM DE ENTRAR NA TRILHA.
--
-- MEDIDO: a busca por matrícula feita pelo treinador executava, respondia 200 e
-- NÃO deixava registro. `auditoria_escrita` aceita o INSERT quando o autor é o
-- ator corrente E (a organização é nula OU o autor é membro dela OU é atleta
-- dela OU tem pedido de perfil nela). O treinador não é nenhuma dessas coisas —
-- a autorização dele é `CoachOrganization` —, então o INSERT era recusado com
-- 42501, e `auditService.record` desfazia o savepoint e seguia adiante,
-- registrando o erro no log da aplicação.
--
-- POR QUE ISSO É GRAVE E NÃO COSMÉTICO. A auditoria da busca por matrícula é uma
-- das TRÊS contenções de enumeração do módulo (as outras são exigir a matrícula
-- completa e o teto de requisições). Sem ela, uma varredura de matrículas feita
-- por treinador autorizado não deixaria rastro nenhum na trilha — e é
-- exatamente o ator que tem motivo para varrer.
--
-- A cláusula nova é a mesma que autoriza o treinador em toda esta migration, e
-- mantém as duas garantias que a política já dava: o `userId` da linha continua
-- tendo de ser o ator corrente (ninguém grava trilha no nome de outro), e a
-- organização continua tendo de ser uma em que o autor tem relação real.
-- ===========================================================================
DROP POLICY IF EXISTS auditoria_escrita ON "AuditLog";

CREATE POLICY auditoria_escrita ON "AuditLog" FOR INSERT
  WITH CHECK (
    "userId" IS NOT DISTINCT FROM mci_current_user_id()
    AND (
      "organizationId" IS NULL
      OR mci_member_of("organizationId")
      OR mci_treinador_autorizado_de("organizationId")
      OR EXISTS (
        SELECT 1 FROM "Athlete" a
        WHERE a."organizationId" = "AuditLog"."organizationId"
          AND a."userId" = mci_current_user_id()
      )
      OR EXISTS (
        SELECT 1 FROM "AthleteProfileRequest" r
        WHERE r."organizationId" = "AuditLog"."organizationId"
          AND r."userId" = mci_current_user_id()
      )
    )
  );
