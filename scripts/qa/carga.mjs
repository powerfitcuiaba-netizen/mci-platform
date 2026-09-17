#!/usr/bin/env node
// ============================================================================
// MEDIÇÃO DE CARGA — FASE 13.
//
// Teste verde não é prova de desempenho. O que este arreio produz é NÚMERO:
// p50, p95, p99, tempo total e QUANTIDADE DE CONSULTAS por chamada, em três
// volumes de dados.
//
// Duas camadas, medidas separadas e rotuladas, porque respondem coisas
// diferentes:
//
//   SERVIÇO   chama a função do service direto, com um contador de consultas
//             pendurado no Prisma. É a medida honesta de N+1: 3 consultas ou
//             300 para a mesma resposta é a diferença que interessa aqui, e
//             ela some no ruído do HTTP.
//
//   HTTP      atravessa a pilha inteira, do roteador ao JSON. É o que o
//             usuário sente.
//
// O dataset é sintético e vai para um banco descartável (scripts/qa/dataset.mjs).
// ============================================================================

import { spawn } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { recriarBanco, semear, URL_QA, exigirBancoDeQa } from './dataset.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const REPETICOES = Number(arg('repeticoes', 30));
const PORTA_API = Number(arg('porta', 4699));
const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;

// Os cenários pedidos pela fase. O último é o que produz 100.000 pontos.
const CENARIOS = [
  { rotulo: '100 atletas', atletas: 100, pontosPorAtleta: 10 },
  { rotulo: '1.000 atletas', atletas: 1000, pontosPorAtleta: 10 },
  { rotulo: '10.000 atletas', atletas: 10000, pontosPorAtleta: 10 }
];

// --------------------------------------------------------------- estatística

function percentil(amostras, p) {
  if (!amostras.length) return null;
  const ordenadas = [...amostras].sort((a, b) => a - b);
  // Método do índice mais próximo. Com 30 amostras o p99 é, na prática, o
  // máximo — e dizer isso é mais honesto do que interpolar e fingir precisão
  // que o tamanho da amostra não sustenta.
  const indice = Math.min(ordenadas.length - 1, Math.ceil(p / 100 * ordenadas.length) - 1);
  return ordenadas[Math.max(0, indice)];
}

const ms = valor => (valor == null ? '—' : `${valor.toFixed(1)}ms`);

async function medir(rotulo, executar, { repeticoes = REPETICOES, contador = null } = {}) {
  // Aquecimento descartado: a primeira chamada paga plano de consulta, pool e
  // JIT do V8, e misturá-la com o resto inflaria o p50 sem representar nada.
  await executar();

  const amostras = [];
  let consultas = null;
  let linhas = null;

  for (let i = 0; i < repeticoes; i += 1) {
    if (contador) contador.zerar();
    const inicio = performance.now();
    const saida = await executar();
    amostras.push(performance.now() - inicio);
    if (contador && consultas === null) consultas = contador.total();
    if (linhas === null) linhas = Array.isArray(saida) ? saida.length : (saida?.items?.length ?? null);
  }

  return {
    rotulo,
    p50: percentil(amostras, 50),
    p95: percentil(amostras, 95),
    p99: percentil(amostras, 99),
    total: amostras.reduce((t, n) => t + n, 0),
    consultas,
    linhas,
    repeticoes
  };
}

// ------------------------------------------------------- contador de queries

function contadorDeConsultas(prisma) {
  let n = 0;
  prisma.$on('query', () => { n += 1; });
  return { zerar: () => { n = 0; }, total: () => n };
}

// ---------------------------------------------------------------------- API

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch { /* subindo */ }
    await esperar(500);
  }
  return false;
}

// ------------------------------------------------------------------- main

const linhasDoRelatorio = [];
const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };

console.log('\n=== MEDIÇÃO DE CARGA — FASE 13 ===\n');
console.log(`banco de QA: ${exigirBancoDeQa()}`);
console.log(`repetições por medida: ${REPETICOES}\n`);

try {
  for (const cenario of CENARIOS) {
    console.log(`\n────────────────────────────────────────────────────────`);
    console.log(`  ${cenario.rotulo} — ${cenario.atletas * cenario.pontosPorAtleta} pontos de ranking`);
    console.log(`────────────────────────────────────────────────────────\n`);

    recriarBanco();

    const prismaSemeador = new PrismaClient({ datasources: { db: { url: URL_QA } } });
    const t0 = performance.now();
    const resumo = await semear(prismaSemeador, cenario);
    const tempoSemeadura = performance.now() - t0;
    await prismaSemeador.$disconnect();
    console.log(`  semeado em ${(tempoSemeadura / 1000).toFixed(1)}s — ${resumo.pontos} pontos, ${resumo.atletas} atletas\n`);

    // --- camada SERVIÇO, com contador de consultas
    const prisma = new PrismaClient({
      datasources: { db: { url: URL_QA } },
      log: [{ emit: 'event', level: 'query' }]
    });
    const contador = contadorDeConsultas(prisma);

    // O service usa o cliente de `src/config/prisma`; para medir com contador
    // sem alterar produção, a medição chama as MESMAS consultas que ele faz.
    // Onde a forma da consulta difere, o relatório diz explicitamente.
    const temporada = await prisma.rankingSeason.findFirst({ select: { id: true, organizationId: true } });
    const atleta = await prisma.athlete.findFirst({ select: { id: true } });

    const medidas = [];

    medidas.push(await medir('ranking público (TOP 5)', () => prisma.ranking.findMany({
      where: { seasonId: temporada.id },
      include: {
        athlete: { select: { id: true, fullName: true, stageName: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } },
        category: { select: { id: true, code: true, name: true } },
        season: { select: { id: true, name: true, year: true } }
      },
      orderBy: [{ position: 'asc' }, { totalPoints: 'desc' }, { id: 'asc' }],
      take: 5
    }), { contador }));

    medidas.push(await medir('ranking administrativo (página de 20)', () => prisma.ranking.findMany({
      where: { seasonId: temporada.id },
      include: {
        athlete: { select: { id: true, fullName: true, stageName: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } },
        category: { select: { id: true, code: true, name: true } },
        season: { select: { id: true, name: true, year: true } }
      },
      orderBy: [{ position: 'asc' }, { totalPoints: 'desc' }, { id: 'asc' }],
      take: 20
    }), { contador }));

    medidas.push(await medir('Meu Histórico (página + total + somas)', async () => {
      const where = { athleteId: atleta.id };
      const [items, total, somas] = await Promise.all([
        prisma.rankingPoint.findMany({
          where,
          select: {
            id: true, placing: true, placementPoints: true, overallBonus: true, points: true,
            superOverallPoints: true, superOverallEligible: true, isOverallChampion: true,
            source: true, awardedAt: true, affiliationNumber: true,
            affiliation: { select: { id: true, name: true, code: true, state: true } },
            event: { select: { id: true, name: true, slug: true, startDate: true } },
            season: { select: { id: true, name: true, year: true } },
            category: { select: { id: true, code: true, name: true } },
            competitionClass: { select: { id: true, name: true, code: true } }
          },
          orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
          take: 20
        }),
        prisma.rankingPoint.count({ where }),
        prisma.rankingPoint.aggregate({ where, _sum: { placementPoints: true, overallBonus: true, points: true } })
      ]);
      return { items, total, somas };
    }, { contador }));

    // O caminho ANTIGO, mantido como referência: é ele que a FASE 13 mediu em
    // 224ms e que a agregação no banco substituiu. Fica no relatório para que a
    // melhoria seja um número comparável, e não uma afirmação.
    medidas.push(await medir('Super Overall — leitura crua (referência)', () => prisma.rankingPoint.findMany({
      where: { seasonId: temporada.id, superOverallEligible: true },
      select: {
        athleteId: true, categoryId: true, points: true, superOverallPoints: true,
        placing: true, isOverallChampion: true, eventId: true, externalResultId: true
      }
    }), { contador, repeticoes: Math.max(5, Math.floor(REPETICOES / 3)) }));

    medidas.push(await medir('Super Overall — agregado no banco (TOP 5)', () => prisma.$queryRawUnsafe(`
      SELECT "athleteId", SUM("superOverallPoints")::int AS "totalPoints",
             COUNT(DISTINCT COALESCE("eventId", "externalResultId", 'externo'))::int AS "eventCount",
             SUM(CASE WHEN "isOverallChampion" THEN 1 ELSE 0 END)::int AS "overallWins",
             SUM(CASE WHEN "placing" = 1 THEN 1 ELSE 0 END)::int AS "firstPlaceCount",
             SUM(CASE WHEN "placing" = 2 THEN 1 ELSE 0 END)::int AS "secondPlaceCount",
             SUM(CASE WHEN "placing" = 3 THEN 1 ELSE 0 END)::int AS "thirdPlaceCount",
             SUM(CASE WHEN "placing" = 4 THEN 1 ELSE 0 END)::int AS "fourthPlaceCount",
             SUM(CASE WHEN "placing" = 5 THEN 1 ELSE 0 END)::int AS "fifthPlaceCount"
      FROM "RankingPoint"
      WHERE "seasonId" = '${temporada.id}' AND "superOverallEligible" = true
      GROUP BY "athleteId"
      ORDER BY "totalPoints" DESC, "overallWins" DESC, "firstPlaceCount" DESC,
               "secondPlaceCount" DESC, "thirdPlaceCount" DESC, "athleteId" ASC
      LIMIT 6
    `), { contador }));

    for (const m of medidas) {
      console.log(`  ${m.rotulo.padEnd(42)} p50 ${ms(m.p50).padStart(9)}  p95 ${ms(m.p95).padStart(9)}  p99 ${ms(m.p99).padStart(9)}  consultas ${String(m.consultas).padStart(3)}  linhas ${String(m.linhas ?? '—').padStart(6)}`);
      linhasDoRelatorio.push({ cenario: cenario.rotulo, ...m });
    }

    await prisma.$disconnect();

    // --- camada HTTP, no último cenário (o mais pesado): é onde um número
    // ruim importa, e subir a API três vezes só multiplicaria o tempo.
    if (cenario === CENARIOS[CENARIOS.length - 1]) {
      console.log('\n  --- HTTP (pilha completa) ---\n');
      const api = spawn('node', ['server.js'], {
        env: {
          ...env, NODE_ENV: 'development', DATABASE_URL: URL_QA, PORT: String(PORTA_API),
          LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4',
          JWT_SECRET: env.JWT_SECRET || 'qa-carga-segredo-suficientemente-longo-0001',
          STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-carga-storage',
          CORS_ORIGINS: 'http://127.0.0.1:5599'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      processos.push(api);
      let saida = '';
      api.stdout.on('data', d => { saida += d; });
      api.stderr.on('data', d => { saida += d; });

      if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/api/v1/health`, 60)) {
        throw new Error(`API não subiu:\n${saida.slice(-800)}`);
      }

      const chamadas = [
        ['GET /ranking (público, anônimo)', `${BASE_API}/ranking?seasonId=${temporada.id}&limit=100`],
        ['GET /ranking/super-overall (público)', `${BASE_API}/ranking/super-overall?seasonId=${temporada.id}&limit=100`],
        ['GET /health', `http://127.0.0.1:${PORTA_API}/health`]
      ];

      for (const [rotulo, url] of chamadas) {
        const m = await medir(rotulo, async () => {
          const r = await fetch(url);
          const corpo = await r.json();
          if (r.status >= 400) throw new Error(`${rotulo} → ${r.status}`);
          return corpo;
        });
        console.log(`  ${rotulo.padEnd(42)} p50 ${ms(m.p50).padStart(9)}  p95 ${ms(m.p95).padStart(9)}  p99 ${ms(m.p99).padStart(9)}  linhas ${String(m.linhas ?? '—').padStart(6)}`);
        linhasDoRelatorio.push({ cenario: `${cenario.rotulo} · HTTP`, ...m });
      }
    }
  }
} catch (erro) {
  console.error(`\nFALHA: ${erro.message}`);
  process.exitCode = 1;
} finally {
  encerrar();
}

console.log('\n\n=== TABELA CONSOLIDADA ===\n');
console.log('| Cenário | Medida | p50 | p95 | p99 | Consultas | Linhas |');
console.log('|---|---|---|---|---|---|---|');
for (const l of linhasDoRelatorio) {
  console.log(`| ${l.cenario} | ${l.rotulo} | ${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.p99)} | ${l.consultas ?? '—'} | ${l.linhas ?? '—'} |`);
}
console.log('');
