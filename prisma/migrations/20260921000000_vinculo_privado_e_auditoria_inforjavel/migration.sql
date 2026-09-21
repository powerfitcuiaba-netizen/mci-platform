-- ===========================================================================
-- DUAS CLÁUSULAS INCONDICIONAIS QUE SOBRARAM DE FASES ANTERIORES.
--
-- Nenhuma das duas foi criada por engano: cada uma resolveu um problema real
-- no dia em que nasceu, e cada uma cobrou um preço que só aparece quando
-- alguém vai olhar. Esta migration paga os dois.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. AthleteTeamMembership: a leitura era de todo mundo.
--
-- `vinculo_leitura` era `USING (true)` para SELECT. Isso liberava, para
-- QUALQUER UM — inclusive anônimo, inclusive de outra federação —, a tabela
-- inteira de vínculos: quem pertence a qual equipe, desde quando, até quando,
-- POR QUE saiu (o campo `reason` é texto livre escrito pelo operador) e quem
-- registrou a saída.
--
-- O QUE FOI CONFERIDO ANTES DE FECHAR
--
-- A página pública do atleta mostra a equipe dele, mas lê `Athlete.team` — a
-- relação direta —, e não esta tabela. As três rotas que a consultam
-- (`/athletes/:id/team-history`, vínculo e transferência) exigem autenticação
-- E permissão no serviço. Nenhum caminho anônimo depende dela.
--
-- A cláusula nova espelha a de ESCRITA, que já existia e já estava correta,
-- mais o dono: o atleta lê o próprio histórico de equipe. Sem essa segunda
-- metade, "minha filiação" precisaria de um operador para funcionar.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS vinculo_leitura ON "AthleteTeamMembership";

CREATE POLICY vinculo_leitura ON "AthleteTeamMembership" FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "Team" t
      WHERE t."id" = "AthleteTeamMembership"."teamId"
        AND mci_operator_of(t."organizationId")
    )
    OR mci_atleta_do_usuario("athleteId")
  );


-- ---------------------------------------------------------------------------
-- 2. AuditLog: a escrita não era conferida.
--
-- `auditoria_restrita` era `FOR ALL` com `USING` restritivo e
-- `WITH CHECK (true)`. A leitura estava protegida; a ESCRITA não tinha
-- predicado nenhum. Quem alcançasse um INSERT nesta tabela podia gravar
-- qualquer linha — inclusive com o `userId` de outra pessoa.
--
-- POR QUE ISSO IMPORTA NUMA TABELA QUE SÓ A APLICAÇÃO ESCREVE
--
-- Porque a premissa desta plataforma é que quem decide é o BANCO, e não o
-- código: é essa premissa que sustenta `FORCE ROW LEVEL SECURITY`, o
-- `rlsGuard` que recusa subir sem RLS efetivo, e a recusa de tratar o
-- frontend como autoridade. Uma trilha de auditoria que o banco não confere é
-- uma trilha que vale o que vale a intenção de quem escreve nela — e trilha de
-- auditoria existe justamente para o caso em que a intenção é má.
--
-- AS TRÊS PROPRIEDADES QUE AS POLÍTICAS NOVAS DÃO
--
-- (a) NÃO SE ASSINA NO LUGAR DE OUTRO. `userId` da linha tem de ser o da
--     sessão. `IS NOT DISTINCT FROM` e não `=` porque os dois podem ser nulos
--     — visitante anônimo grava com `userId` nulo, e `NULL = NULL` é nulo, que
--     reprova. Esta é a propriedade que mais importa: sem ela, uma linha
--     "SUPER_ADMIN apagou o resultado" pode ser escrita por qualquer um.
--
-- (b) NÃO SE ESCREVE NA TRILHA DE OUTRA FEDERAÇÃO. `organizationId` tem de ser
--     nulo (ação de plataforma, como LOGIN) ou uma organização à qual a pessoa
--     esteja LIGADA.
--
--     "Ligada" é mais largo que "membro" de propósito, e o número veio de
--     medição: numa amostra de 987 escritas de auditoria da suíte, 517 tinham
--     ator membro da organização, 448 não tinham organização — e 22 tinham
--     organização SEM o ator ser membro. Todas as 22 eram a mesma ação:
--     `ATHLETE_PROFILE_REQUEST_CREATE`, o atleta abrindo o próprio pedido numa
--     federação da qual ele ainda não faz parte. Exigir `mci_member_of` teria
--     derrubado exatamente esse caso — e derrubado EM SILÊNCIO, porque
--     `audit.record` engole a falha e segue.
--
--     Por isso os dois `EXISTS`: quem tem cadastro de atleta na organização, e
--     quem tem pedido de cadastro nela. É a ligação que a própria ação
--     pressupõe, conferida no banco em vez de presumida no código.
--
-- (c) AUDITORIA NÃO SE REESCREVE NEM SE APAGA. Não há política de UPDATE nem
--     de DELETE: sob `FORCE ROW LEVEL SECURITY`, comando sem política é
--     comando negado, para todo mundo, o dono do schema inclusive. A trilha
--     passa a ser estritamente append-only.
--
--     `TRUNCATE` continua possível — ele é privilégio de tabela e não passa por
--     política —, e é o que a suíte usa entre testes. Em produção, quem tem
--     TRUNCATE nesta tabela é o dono do schema, e isso é decisão de
--     provisionamento, não de RLS.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS auditoria_restrita ON "AuditLog";

CREATE POLICY auditoria_leitura ON "AuditLog" FOR SELECT
  USING (
    mci_is_platform_admin()
    OR ("organizationId" IS NOT NULL AND mci_operator_of("organizationId"))
  );

CREATE POLICY auditoria_escrita ON "AuditLog" FOR INSERT
  WITH CHECK (
    "userId" IS NOT DISTINCT FROM mci_current_user_id()
    AND (
      "organizationId" IS NULL
      OR mci_member_of("organizationId")
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
