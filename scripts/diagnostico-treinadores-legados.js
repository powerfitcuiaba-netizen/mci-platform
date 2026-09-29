#!/usr/bin/env node
// ==========================================================================
// DIAGNÓSTICO SOMENTE LEITURA — CADASTROS DE TREINADOR APROVADOS SEM REVISOR.
//
// POR QUE ESTE SCRIPT EXISTE
//
// A migration 20260926020000 executa `UPDATE "Coach" SET "status" = 'APPROVED'`
// SEM cláusula `WHERE`: ela aprova todo cadastro de treinador que já existia.
// R-03 diz que quem aprova é a administração central da MuscleContest — e uma
// migration não é a administração central. O achado é A-05.
//
// A migration 20260927030000 corrige, devolvendo a `PENDING` apenas as linhas
// aprovadas SEM revisor e SEM data de revisão — que são exatamente as que
// nenhuma pessoa decidiu (`reviewedById` e `reviewedAt` só são escritos por
// `coachService.transicionar`).
//
// ESTE SCRIPT NÃO ALTERA NADA. Ele responde, antes do deploy, três perguntas que
// a mesa central precisa responder ANTES de qualquer publicação:
//
//   1. quantos cadastros voltarão a pendente;
//   2. quais deles estão EM USO — com equipe, com autorização de federação, com
//      atleta vinculado — porque esses são os que param de funcionar até a
//      aprovação formal;
//   3. quais já foram aprovados por uma pessoa, e portanto não serão tocados.
//
//     node scripts/diagnostico-treinadores-legados.js
//
// NENHUM SEGREDO É IMPRESSO: a DATABASE_URL não aparece, nem parcialmente. Não
// sai e-mail nem telefone de ninguém — a linha traz id e nome, que é o que
// identifica a quem falar.
// ==========================================================================

// A URL É LIDA DO AMBIENTE **ANTES** DO `require`, e isso não é estilo.
//
// `require('@prisma/client')` carrega o arquivo `.env` para dentro de
// `process.env`. Medido: numa máquina com `.env` presente, rodar sem
// `DATABASE_URL` no ambiente NÃO falhava — o script conectava no banco do
// `.env` e imprimia números perfeitamente plausíveis DE OUTRO BANCO, sem dizer
// qual havia lido. Capturar o valor antes do `require` faz a recusa dizer a
// verdade: "ausente no ambiente" passa a significar ausente no ambiente.
//
// Em produção o `.env` não existe na imagem (está no `.dockerignore`), mas o
// diagnóstico precisa ser confiável também na máquina de quem investiga.
const URL_DO_AMBIENTE = process.env.DATABASE_URL;

const { PrismaClient } = require('@prisma/client');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const AMARELO = s => `\x1b[33m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

async function principal() {
  if (!URL_DO_AMBIENTE) {
    console.error('DATABASE_URL ausente no ambiente. Rode no mesmo ambiente da aplicação.');
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaClient();
  try {
    // O NOME DO BANCO NA SAÍDA. Nome de banco não é segredo — a credencial é —, e
    // sem ele a evidência guardada não diz de onde veio. Uma saída que não
    // identifica a base é indistinguível de uma saída da base errada.
    const [{ banco }] = await prisma.$queryRaw`SELECT current_database() AS banco`;
    console.log(`banco consultado: ${banco}\n`);

    const todos = await prisma.coach.findMany({
      select: {
        id: true, name: true, status: true, createdAt: true,
        reviewedById: true, reviewedAt: true,
        _count: { select: { teams: true, athletes: true, organizations: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    // O MESMO predicado da migration, palavra por palavra. Se um dia divergirem,
    // o diagnóstico deixa de diagnosticar o que vai acontecer.
    const semRevisor = todos.filter(c =>
      c.status === 'APPROVED' && c.reviewedById === null && c.reviewedAt === null);
    const comRevisor = todos.filter(c => c.status === 'APPROVED' && (c.reviewedById || c.reviewedAt));
    const emUso = semRevisor.filter(c =>
      c._count.teams > 0 || c._count.athletes > 0 || c._count.organizations > 0);

    console.log('=== CADASTROS DE TREINADOR ===\n');
    console.log(`total .......................................... ${todos.length}`);
    console.log(`aprovados ...................................... ${todos.filter(c => c.status === 'APPROVED').length}`);
    console.log(`${VERDE('aprovados COM revisor (não serão tocados)')} ...... ${comRevisor.length}`);
    console.log(`${AMARELO('aprovados SEM revisor (voltam a PENDING)')} ....... ${semRevisor.length}`);
    console.log(`${AMARELO('destes, EM USO (equipe/atleta/federação)')} ....... ${emUso.length}`);
    console.log(`${CINZA('em outros estados')} .............................. ${todos.filter(c => c.status !== 'APPROVED').length}\n`);

    if (semRevisor.length) {
      console.log('--- VOLTAM A PENDING ---');
      for (const c of semRevisor) {
        const uso = [];
        if (c._count.teams) uso.push(`${c._count.teams} equipe(s)`);
        if (c._count.athletes) uso.push(`${c._count.athletes} atleta(s) no catálogo`);
        if (c._count.organizations) uso.push(`${c._count.organizations} autorização(ões)`);
        console.log(`  ${c.id}  ${c.name}`
          + `  criado=${new Date(c.createdAt).toISOString().slice(0, 10)}`
          + `  ${uso.length ? `EM USO: ${uso.join(', ')}` : 'sem uso registrado'}`);
      }
      console.log('');
    }

    if (!semRevisor.length) {
      console.log(VERDE('NENHUM cadastro volta a pendente: a migration 20260927030000 não terá efeito aqui.'));
      return;
    }

    console.log(AMARELO(`${semRevisor.length} cadastro(s) voltam a PENDING quando a migration 20260927030000 subir.`));
    if (emUso.length) {
      console.log(AMARELO(`${emUso.length} deles estão EM USO e param de funcionar até a aprovação formal (R-03).`));
    }
    console.log('Ação: a administração central aprova pela rota `POST /coaches/:id/approve`, com motivo,');
    console.log('depois do deploy. Nada é alterado por este script.');
    // Saída 1: há decisão humana pendente antes de publicar.
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch(erro => {
  console.error(`falha no diagnóstico: ${erro.code ?? erro.name ?? 'erro'}`);
  process.exitCode = 2;
});
