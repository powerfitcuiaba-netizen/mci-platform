#!/usr/bin/env node
// ==========================================================================
// DIAGNÓSTICO SOMENTE LEITURA — DELEGAÇÕES CENTRAIS QUE FICARAM INERTES.
//
// POR QUE ESTE SCRIPT EXISTE
//
// O achado A-02 da auditoria independente corrigiu duas coisas em
// `CentralAuthorization`: escopo de federação e prazo passaram a ser
// OBRIGATÓRIOS, e `effectivePermissions` passou a IGNORAR a linha que não tem
// um dos dois. A correção é de leitura, e de propósito: nenhuma linha real é
// alterada, apagada ou revogada por ela.
//
// A consequência operacional é direta e precisa ser conhecida ANTES do deploy:
// uma concessão que hoje vale — porque o escopo nulo valia em todas as
// federações, ou porque a ausência de prazo valia para sempre — deixa de valer
// no instante em que a versão nova sobe. Quem depender dela perde a permissão
// de `athletes.transfer` sem aviso.
//
// ESTE SCRIPT NÃO CORRIGE NADA. Ele lista, conta e para. A correção é ato
// administrativo: quem ainda precisar da delegação recebe uma concessão NOVA,
// pela rota, com escopo e prazo — e com motivo e trilha próprios, que é o que a
// auditoria de R-02 quer poder ler depois.
//
//     node scripts/diagnostico-delegacoes-inertes.js <id-de-uma-conta-SUPER_ADMIN>
//
// POR QUE ELE EXIGE UM ID, E POR QUE ISSO NÃO É BUROCRACIA
//
// `CentralAuthorization` tem `FORCE ROW LEVEL SECURITY` desde a migration
// 20260926020000, e a política de leitura é:
//
//     central_leitura :: mci_is_platform_admin() OR "userId" = mci_current_user_id()
//
// Um `PrismaClient` cru não passa por `withUserContext` e portanto não tem
// `mci.user_id` na sessão: `mci_current_user_id()` é nulo, a política não deixa
// passar linha nenhuma, e `FORCE` faz a regra valer INCLUSIVE para o dono da
// tabela — que é o usuário da aplicação, sem SUPERUSER e sem BYPASSRLS.
//
// A versão anterior deste script rodava exatamente assim. Medido em banco
// sintético que TINHA uma concessão viva:
//
//     com `mci.user_id` de um SUPER_ADMIN ....... 1 linha
//     sem contexto, como o script rodava ........ 0 linhas
//
// e a saída era `NENHUMA concessão viva perde efeito`, com código 0. Um
// "pode publicar" falso, na única pergunta que este script existe para responder.
//
// O defeito de fundo não era a RLS: era a saída não distinguir "não há
// delegação" de "não consigo ver delegação nenhuma". São opostos, e apareciam
// iguais. Por isso, agora:
//
//   * o contexto é declarado com `set_config('mci.user_id', $1, true)` — o MESMO
//     `SET LOCAL` que toda requisição autenticada usa. Nenhum mecanismo novo:
//     nem BYPASSRLS, nem SECURITY DEFINER, nem política afrouxada;
//   * o script CONFERE que o contexto foi aceito e que a conta é administradora
//     de plataforma. Se não for, ele FALHA com código 2 em vez de relatar
//     ausência. Diagnóstico que não consegue ler tem de dizer que não conseguiu.
//
// NENHUM SEGREDO É IMPRESSO: a DATABASE_URL não aparece, nem parcialmente.
// Também não sai e-mail de ninguém — a linha traz o id da conta e o nome, que
// é o que identifica a quem falar.
// ==========================================================================

const { PrismaClient } = require('@prisma/client');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const AMARELO = s => `\x1b[33m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

async function principal() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente no ambiente. Rode no mesmo ambiente da aplicação.');
    process.exitCode = 2;
    return;
  }

  const idDoAdministrador = process.argv[2] || process.env.MCI_ADMIN_ID || '';
  const prisma = new PrismaClient();
  try {
    // COMO OBTER O ID SEM IMPROVISAR UMA CONSULTA.
    //
    // Sem isto, quem roda no Shell do Render precisa escrever um `node -e` com
    // Prisma na mão — e improviso perto de credencial é como credencial vaza.
    // `User` não tem RLS, então esta leitura não depende de contexto.
    if (idDoAdministrador === '--listar-admins') {
      const contas = await prisma.user.findMany({
        where: { role: 'SUPER_ADMIN' },
        select: { id: true, name: true, status: true },
        orderBy: { createdAt: 'asc' }
      });
      console.log('=== CONTAS SUPER_ADMIN ===\n');
      for (const conta of contas) console.log(`  ${conta.id}  ${conta.name}  ${conta.status}`);
      console.log(`\n${contas.length} conta(s). Rode de novo passando um destes ids.`);
      return;
    }

    if (!idDoAdministrador) {
      // Não imprime nome de ninguém: só quantas contas existem, para a pessoa
      // saber que há de onde escolher.
      const quantas = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } }).catch(() => null);
      console.error('Informe o id de uma conta SUPER_ADMIN:');
      console.error('  node scripts/diagnostico-delegacoes-inertes.js <id>');
      console.error('Para ver os ids disponíveis:');
      console.error('  node scripts/diagnostico-delegacoes-inertes.js --listar-admins');
      console.error('A leitura de `CentralAuthorization` é protegida por RLS e exige contexto de');
      console.error('administração de plataforma. Sem ele a consulta volta VAZIA, e vazio aqui não');
      console.error('significa "não há delegação" — significa "não consigo ver".');
      if (quantas !== null) console.error(`Contas SUPER_ADMIN neste banco: ${quantas}.`);
      process.exitCode = 2;
      return;
    }

    const agora = new Date();

    // A LEITURA ACONTECE DENTRO DE UMA TRANSAÇÃO COM CONTEXTO.
    //
    // `set_config(..., true)` é `SET LOCAL`: vale só nesta transação e some com
    // ela. É o mesmo que `withUserContext` faz em toda requisição autenticada —
    // este script apenas entra pela mesma porta, em vez de tentar contorná-la.
    const vivas = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('mci.user_id', ${idDoAdministrador}, true)`;

      const [contexto] = await tx.$queryRaw`
        SELECT mci_current_user_id() AS usuario, mci_is_platform_admin() AS administrador`;

      if (contexto?.usuario !== idDoAdministrador) {
        throw Object.assign(new Error('contexto não aplicado'), { code: 'CONTEXTO_NAO_APLICADO' });
      }
      // Sem isto, uma conta comum leria só as concessões DELA e o script
      // apresentaria uma leitura parcial como se fosse o quadro inteiro.
      if (contexto?.administrador !== true) {
        throw Object.assign(new Error('conta não é administradora de plataforma'), { code: 'CONTA_NAO_ADMINISTRADORA' });
      }

      // Só as VIVAS interessam: a revogada já não concedia nada antes da mudança.
      return tx.centralAuthorization.findMany({
        where: { revokedAt: null },
        select: {
          id: true, userId: true, permission: true, organizationId: true,
          grantedAt: true, expiresAt: true,
          user: { select: { id: true, name: true, role: true } },
          organization: { select: { id: true, name: true } }
        },
        orderBy: { grantedAt: 'asc' }
      });
    });

    console.log(`contexto de leitura: conta ${idDoAdministrador} (administração de plataforma)\n`);

    const semEscopo = vivas.filter(c => !c.organizationId);
    const semPrazo = vivas.filter(c => c.organizationId && !c.expiresAt);
    const vencidas = vivas.filter(c => c.expiresAt && new Date(c.expiresAt) <= agora);
    const conformes = vivas.filter(c =>
      c.organizationId && c.expiresAt && new Date(c.expiresAt) > agora);

    console.log('=== DELEGAÇÕES CENTRAIS VIVAS ===\n');
    console.log(`total de linhas vivas .................. ${vivas.length}`);
    console.log(`${AMARELO('inertes por FALTA DE ESCOPO')} ........... ${semEscopo.length}`);
    console.log(`${AMARELO('inertes por FALTA DE PRAZO')} ............ ${semPrazo.length}`);
    console.log(`${CINZA('já vencidas (inertes antes e depois)')} ... ${vencidas.length}`);
    console.log(`${VERDE('conformes (escopo + prazo no futuro)')} ... ${conformes.length}\n`);

    const detalhar = (titulo, linhas) => {
      if (!linhas.length) return;
      console.log(`--- ${titulo} ---`);
      for (const c of linhas) {
        console.log(
          `  ${c.id}  ${c.permission}`
          + `  conta=${c.user?.name ?? '(sem nome)'} [${c.userId}] papel=${c.user?.role ?? '?'}`
          + `  escopo=${c.organization?.name ?? '(nenhum)'}`
          + `  prazo=${c.expiresAt ? new Date(c.expiresAt).toISOString().slice(0, 10) : '(nenhum)'}`
          + `  concedida=${new Date(c.grantedAt).toISOString().slice(0, 10)}`
        );
      }
      console.log('');
    };

    detalhar('PERDEM EFEITO POR FALTA DE ESCOPO', semEscopo);
    detalhar('PERDEM EFEITO POR FALTA DE PRAZO', semPrazo);

    const afetadas = semEscopo.length + semPrazo.length;
    if (!afetadas) {
      console.log(VERDE('NENHUMA concessão viva perde efeito com a correção de A-02.'));
      return;
    }

    console.log(AMARELO(`${afetadas} concessão(ões) viva(s) deixam de conceder quando a versão nova subir.`));
    console.log('Ação: quem ainda precisar da delegação recebe uma concessão NOVA pela rota');
    console.log('`POST /central-authorizations`, com federação e prazo. Nada é alterado por este script.');
    // Saída 1 para o script ser usável como porta de deploy: há decisão humana
    // pendente antes de subir.
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const EXPLICACAO = {
  CONTEXTO_NAO_APLICADO:
    'o banco não aceitou `mci.user_id`. A leitura seria vazia por falta de contexto, e vazio\n'
    + 'aqui NÃO significa "não há delegação". Nada foi relatado de propósito.',
  CONTA_NAO_ADMINISTRADORA:
    'o id informado não é de uma conta SUPER_ADMIN. Com ele, a política devolveria apenas as\n'
    + 'concessões DESSA conta — uma leitura parcial apresentada como se fosse o quadro inteiro.'
};

principal().catch(erro => {
  // A mensagem do Prisma pode carregar a URL de conexão; aqui sai só o código.
  console.error(`falha no diagnóstico: ${erro.code ?? erro.name ?? 'erro'}`);
  if (EXPLICACAO[erro.code]) console.error(EXPLICACAO[erro.code]);
  process.exitCode = 2;
});
