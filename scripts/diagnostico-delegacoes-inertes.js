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
//     node scripts/diagnostico-delegacoes-inertes.js
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

  const prisma = new PrismaClient();
  try {
    const agora = new Date();

    // Só as VIVAS interessam: a revogada já não concedia nada antes da mudança.
    const vivas = await prisma.centralAuthorization.findMany({
      where: { revokedAt: null },
      select: {
        id: true, userId: true, permission: true, organizationId: true,
        grantedAt: true, expiresAt: true,
        user: { select: { id: true, name: true, role: true } },
        organization: { select: { id: true, name: true } }
      },
      orderBy: { grantedAt: 'asc' }
    });

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

principal().catch(erro => {
  // A mensagem do Prisma pode carregar a URL de conexão; aqui sai só o código.
  console.error(`falha no diagnóstico: ${erro.code ?? erro.name ?? 'erro'}`);
  process.exitCode = 2;
});
