#!/usr/bin/env node
// ============================================================================
// FASE 13.6 — O IMPORTADOR SOB CARGA.
//
// A planilha do MuscleWar não chega com doze linhas. Uma temporada inteira
// chega de uma vez, e o que este arreio produz é NÚMERO: tempo de cada etapa,
// tamanho da resposta, consultas ao banco e memória do processo da API, em
// três volumes.
//
// As três etapas medidas são as três que o operador percorre:
//
//   CRIAR     POST /musclewar/imports — analisa cada linha, reconhece o
//             atleta e grava os itens para revisão.
//   REVISAR   GET  /musclewar/imports/:id — a tela de conferência.
//   APLICAR   POST /musclewar/imports/:id/apply — vira pontuação.
//
// Dados sintéticos, marcados QA, em banco descartável. Nada aqui toca em
// produção, e nenhum dado real é usado.
// ============================================================================

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { recriarBanco, semear, cpfSintetico, URL_QA, exigirBancoDeQa } from './dataset.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const VOLUMES = String(arg('linhas', '1000,10000,100000')).split(',').map(Number);
const PORTA = Number(arg('porta', 4711));
const BASE = `http://127.0.0.1:${PORTA}/api/v1`;

// Atletas semeados: é contra eles que o reconhecimento por CPF acontece. O
// número é pequeno de propósito — o que está sob medição é o custo POR LINHA
// DO ARQUIVO, e não o tamanho do cadastro.
const ATLETAS = Number(arg('atletas', 500));

const OPERADOR = { id: 'qausr0000000900', email: 'qa.importador@mci.local', senha: 'QaImportador#2026' };

const ms = v => (v == null ? '—' : `${v.toFixed(0)}ms`);
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ------------------------------------------------------------------ memória
//
// RSS lido do /proc do processo da API, não do processo deste arreio: quem
// carrega o arquivo inteiro na memória é o servidor.
function rssDaApi(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const linha = status.split('\n').find(l => l.startsWith('VmRSS:'));
    return linha ? Number(linha.replace(/\D+/g, '')) * 1024 : null;
  } catch {
    return null;
  }
}

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

// ----------------------------------------------------------------- o arquivo
//
// Metade das linhas traz o CPF de um atleta semeado (reconhecimento por
// identidade), a outra metade traz filiação + matrícula (reconhecimento pelo
// par) e um décimo não traz nem um nem outro — vira MATCH_PENDING, que é o
// caso que o operador precisa revisar à mão. A mistura importa: um arquivo
// 100% reconhecido mediria o caminho mais barato e chamaria isso de carga.
function gerarCsv(linhas, { codigoDaFiliacao, codigoDaCategoria }) {
  const partes = [
    'external_result_id,cpf,athlete_name,affiliation_code,member_number,category_code,division,class,placing,points,event_name,event_date\n'
  ];
  for (let i = 0; i < linhas; i += 1) {
    const atleta = i % ATLETAS;
    const colocacao = (i % 5) + 1;
    const pontos = [5, 4, 3, 2, 1][colocacao - 1];
    const modo = i % 10;

    const cpf = modo < 5 ? cpfSintetico(atleta + 1000) : '';
    const filiacao = modo >= 5 && modo < 9 ? codigoDaFiliacao : '';
    const matricula = modo >= 5 && modo < 9 ? `QA-${atleta}` : '';

    partes.push(
      `QA-IMP-${i},${cpf},QA Atleta ${atleta},${filiacao},${matricula},`
      + `${codigoDaCategoria},QA Divisão,Open,${colocacao},${pontos},QA Etapa Importada,2026-03-15\n`
    );
  }
  return partes.join('');
}

// --------------------------------------------------------------------- main

const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };
const relatorio = [];

console.log('\n=== CARGA DO IMPORTADOR — FASE 13.6 ===\n');
console.log(`banco de QA: ${exigirBancoDeQa()}`);
console.log(`volumes: ${VOLUMES.join(', ')} linhas`);
console.log(`cadastro semeado: ${ATLETAS} atletas\n`);

try {
  recriarBanco();

  const prisma = new PrismaClient({ datasources: { db: { url: URL_QA } } });
  await semear(prisma, { atletas: ATLETAS, pontosPorAtleta: 2, organizacoes: 1, categorias: 2 });

  const org = await prisma.organization.findFirst({ select: { id: true } });
  const temporada = await prisma.rankingSeason.findFirst({ where: { organizationId: org.id }, select: { id: true } });
  const filiacao = await prisma.affiliation.findFirst({ where: { organizationId: org.id }, select: { code: true } });
  const categoria = await prisma.category.findFirst({ select: { code: true } });

  // Tabela de pontuação da temporada. Sem ela toda linha vira CONFLICT
  // ("Temporada sem tabela de pontuação definida") e o APLICAR não tem o que
  // aplicar — a medição da etapa mais cara não aconteceria.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RankingPointsRule" (id, "seasonId", "placing", "points", "createdAt")
    VALUES ${[5, 4, 3, 2, 1].map((pontos, i) => `('qarul000000090${i}','${temporada.id}',${i + 1},${pontos},now())`).join(',')}
    ON CONFLICT DO NOTHING
  `);

  // Operador de verdade: senha com hash real, para que a medição atravesse a
  // autenticação como qualquer requisição atravessa.
  const hash = await bcrypt.hash(OPERADOR.senha, 4);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "User" (id, name, email, "passwordHash", role, status, "createdAt", "updatedAt")
    VALUES ('${OPERADOR.id}','QA Importador','${OPERADOR.email}','${hash}','SUPER_ADMIN','ACTIVE',now(),now())
    ON CONFLICT (id) DO NOTHING
  `);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "OrganizationMember" (id, "organizationId", "userId", role, "createdAt", "updatedAt")
    VALUES ('qambr0000000900','${org.id}','${OPERADOR.id}','RANKING_MANAGER',now(),now())
    ON CONFLICT (id) DO NOTHING
  `);
  await prisma.$disconnect();

  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: URL_QA, PORT: String(PORTA),
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'qa-importador-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-importador-storage',
      CORS_ORIGINS: 'http://127.0.0.1:5599',
      // Explícito, e não herdado: o limite de importação é 10/min e este
      // arreio dispara em sequência. Fora de produção o padrão já é
      // desligado, mas deixar isso implícito faria a medição depender de um
      // default. Quem mede o limitador LIGADO é a FASE 13.15, à parte.
      RATE_LIMIT_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaDaApi = '';
  api.stdout.on('data', d => { saidaDaApi += d; });
  api.stderr.on('data', d => { saidaDaApi += d; });

  if (!await esperarPorta(`http://127.0.0.1:${PORTA}/api/v1/health`, 60)) {
    throw new Error(`API não subiu:\n${saidaDaApi.slice(-1200)}`);
  }

  const entrada = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OPERADOR.email, password: OPERADOR.senha })
  });
  const corpoDaEntrada = await entrada.json();
  if (!entrada.ok) throw new Error(`login falhou: ${entrada.status} ${JSON.stringify(corpoDaEntrada)}`);
  const token = corpoDaEntrada.token || corpoDaEntrada.accessToken;
  if (!token) throw new Error(`login sem token: ${JSON.stringify(corpoDaEntrada).slice(0, 300)}`);

  const autenticado = extra => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra });

  const rssInicial = rssDaApi(api.pid);
  console.log(`  RSS da API ao subir: ${mb(rssInicial)}\n`);

  for (const linhas of VOLUMES) {
    console.log(`────────────────────────────────────────────────────────`);
    console.log(`  ${linhas.toLocaleString('pt-BR')} linhas`);
    console.log(`────────────────────────────────────────────────────────`);

    const csv = gerarCsv(linhas, { codigoDaFiliacao: filiacao.code, codigoDaCategoria: categoria.code });
    const bytes = Buffer.byteLength(csv, 'utf8');
    console.log(`  arquivo: ${mb(bytes)}`);

    const medida = { linhas, bytes };

    // --- CRIAR
    let t = performance.now();
    const criacao = await fetch(`${BASE}/musclewar/imports`, {
      method: 'POST',
      headers: autenticado(),
      body: JSON.stringify({
        organizationId: org.id, seasonId: temporada.id,
        sourceType: 'CSV', sourceRef: `QA carga ${linhas} linhas`, content: csv
      })
    });
    const corpoDaCriacao = await criacao.text();
    medida.criar = { ms: performance.now() - t, status: criacao.status, bytesDaResposta: Buffer.byteLength(corpoDaCriacao) };
    medida.rssDepoisDeCriar = rssDaApi(api.pid);

    console.log(`  CRIAR    ${String(criacao.status).padStart(3)}  ${ms(medida.criar.ms).padStart(9)}`
      + `  resposta ${mb(medida.criar.bytesDaResposta).padStart(9)}`
      + `  RSS ${mb(medida.rssDepoisDeCriar).padStart(9)}`);

    if (!criacao.ok) {
      let motivo;
      try {
        const erro = JSON.parse(corpoDaCriacao).error;
        motivo = `${erro?.code} — ${erro?.message}`
          + (erro?.details ? ` ${JSON.stringify(erro.details).slice(0, 220)}` : '');
      } catch { motivo = corpoDaCriacao.slice(0, 220); }
      medida.criar.recusa = motivo;
      console.log(`           recusado: ${motivo}`);
      // 500 não diz nada ao cliente de propósito (o errorHandler não publica a
      // taxonomia interna). Para MEDIR é preciso a causa, e ela está no log do
      // servidor — que este arreio está capturando.
      if (criacao.status >= 500) {
        const doLog = saidaDaApi.split('\n').filter(l => l.includes('erro') || l.includes('Error') || l.includes('P20')).slice(-4);
        for (const l of doLog) console.log(`           log: ${l.slice(0, 300)}`);
      }
      console.log(`           (a recusa é o resultado desta medida, e vai ao relatório como tal)\n`);
      relatorio.push(medida);
      continue;
    }

    const importId = JSON.parse(corpoDaCriacao).import.id;

    // --- REVISAR
    t = performance.now();
    const revisao = await fetch(`${BASE}/musclewar/imports/${importId}`, { headers: autenticado() });
    const corpoDaRevisao = await revisao.text();
    medida.revisar = { ms: performance.now() - t, status: revisao.status, bytesDaResposta: Buffer.byteLength(corpoDaRevisao) };
    console.log(`  REVISAR  ${String(revisao.status).padStart(3)}  ${ms(medida.revisar.ms).padStart(9)}`
      + `  resposta ${mb(medida.revisar.bytesDaResposta).padStart(9)}`);

    // --- APLICAR
    t = performance.now();
    const aplicacao = await fetch(`${BASE}/musclewar/imports/${importId}/apply`, {
      method: 'POST', headers: autenticado(), body: JSON.stringify({})
    });
    const corpoDaAplicacao = await aplicacao.text();
    medida.aplicar = { ms: performance.now() - t, status: aplicacao.status, bytesDaResposta: Buffer.byteLength(corpoDaAplicacao) };
    medida.rssDepoisDeAplicar = rssDaApi(api.pid);
    console.log(`  APLICAR  ${String(aplicacao.status).padStart(3)}  ${ms(medida.aplicar.ms).padStart(9)}`
      + `  resposta ${mb(medida.aplicar.bytesDaResposta).padStart(9)}`
      + `  RSS ${mb(medida.rssDepoisDeAplicar).padStart(9)}`);

    if (!aplicacao.ok) {
      console.log(`           recusado: ${corpoDaAplicacao.slice(0, 200)}`);
    }

    const porLinha = medida.criar.ms / linhas;
    console.log(`  → ${porLinha.toFixed(2)}ms por linha na criação`
      + `, ${(linhas / (medida.criar.ms / 1000)).toFixed(0)} linhas/s\n`);
    medida.msPorLinha = porLinha;

    relatorio.push(medida);
  }

  console.log('\n=== RESUMO ===\n');
  for (const m of relatorio) {
    const cabeca = `${String(m.linhas).padStart(7)} linhas (${mb(m.bytes)})`;
    if (m.criar.recusa) {
      console.log(`  ${cabeca}  CRIAR ${m.criar.status} ${m.criar.recusa}`);
      continue;
    }
    console.log(`  ${cabeca}  criar ${ms(m.criar.ms).padStart(9)}`
      + `  revisar ${ms(m.revisar.ms).padStart(9)} (${mb(m.revisar.bytesDaResposta)})`
      + `  aplicar ${ms(m.aplicar.ms).padStart(9)}`);
  }
  console.log('');
} finally {
  encerrar();
}
