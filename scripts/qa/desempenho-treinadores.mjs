#!/usr/bin/env node
// ============================================================================
// DESEMPENHO MEDIDO — ROTAS DO MÓDULO TREINADORES & EQUIPES.
//
// POR QUE ESTE SCRIPT EXISTE
//
// "Parece rápido" não é medição, e "deve aguentar" não é resultado. O módulo
// acrescentou rotas que rodam em cima de RLS com predicados novos — três funções
// SQL que leem `Coach`, `CoachOrganization` e `Team` por LINHA de `Athlete` —, e
// predicado de política é o tipo de custo que não aparece em teste funcional e
// aparece no ginásio, com a federação inteira cadastrada.
//
// O que este script faz: bate em cada rota do módulo N vezes contra uma pilha JÁ
// NO AR, e reporta p50, p95 e máximo. Ele NÃO sobe o ambiente — quem sobe é
// `visual-treinadores.mjs --manter`, e separar as duas coisas é o que permite
// medir sem o custo de construir o frontend a cada rodada.
//
// USO
//   node scripts/qa/visual-treinadores.mjs --manter        # em outro terminal
//   node scripts/qa/desempenho-treinadores.mjs --api http://127.0.0.1:4611/api/v1
//
// SOBRE OS ORÇAMENTOS. Os limites abaixo são DESTE GATE, escolhidos aqui, e NÃO
// são SLA homologado pela MuscleContest. Eles existem para que uma regressão de
// uma ordem de grandeza reprove em vez de passar — não para certificar
// desempenho. A máquina, o banco e a rede da medição ficam registrados na saída,
// porque número sem ambiente não se compara com nada.
//
// O script cria as PRÓPRIAS contas sintéticas pelas rotas reais. Não lê, não
// escreve e não mede nada de produção.
// ============================================================================

import { argv, env } from 'node:process';
import { cpus, totalmem, hostname } from 'node:os';

const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const BASE_API = arg('api', env.QA_API_BASE || 'http://127.0.0.1:4611/api/v1');
const REPETICOES = Number(arg('repeticoes', 30));
const AQUECIMENTO = Number(arg('aquecimento', 5));
const SENHA = env.QA_PASSWORD || 'senha-de-qa-123';

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const VERMELHO = s => `\x1b[31m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const r = await fetch(`${BASE_API}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, corpo: json };
}

async function exigir(caminho, opcoes) {
  const r = await chamar(caminho, opcoes);
  if (r.status >= 400) {
    throw new Error(`${opcoes?.metodo ?? 'GET'} ${caminho} → ${r.status} ${JSON.stringify(r.corpo).slice(0, 200)}`);
  }
  return r.corpo;
}

// CPF sintético válido, igual ao do gate visual. Dado de QA, e só de QA.
function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const d1bruto = (base.reduce((t, n, i) => t + n * (10 - i), 0) * 10) % 11;
  const d1 = d1bruto === 10 ? 0 : d1bruto;
  const comD1 = base.concat([d1]);
  const d2bruto = (comD1.reduce((t, n, i) => t + n * (11 - i), 0) * 10) % 11;
  const d2 = d2bruto === 10 ? 0 : d2bruto;
  return base.join('') + d1 + d2;
}

const marca = Date.now().toString(36);
const conta = sufixo => ({
  name: `PERF ${sufixo}`,
  email: `perf.${sufixo}.${marca}@mci.local`,
  password: SENHA,
  birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
  state: 'MT', city: 'Cuiabá'
});

const percentil = (ordenado, p) => ordenado[Math.min(ordenado.length - 1, Math.ceil((p / 100) * ordenado.length) - 1)];

async function medir(rotulo, orcamentoMs, executar) {
  for (let i = 0; i < AQUECIMENTO; i += 1) await executar();

  const amostras = [];
  let statusRuim = null;
  for (let i = 0; i < REPETICOES; i += 1) {
    const t = process.hrtime.bigint();
    const r = await executar();
    amostras.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (r && r.status >= 400) statusRuim = r.status;
  }

  amostras.sort((a, b) => a - b);
  const p50 = percentil(amostras, 50);
  const p95 = percentil(amostras, 95);
  const max = amostras[amostras.length - 1];
  const passou = statusRuim === null && p95 <= orcamentoMs;

  console.log(
    `  ${(passou ? VERDE('PASS') : VERMELHO('FALHOU'))}  ${rotulo.padEnd(46)}`
    + ` p50=${p50.toFixed(0).padStart(5)}ms  p95=${p95.toFixed(0).padStart(5)}ms`
    + `  max=${max.toFixed(0).padStart(5)}ms  orçamento=${orcamentoMs}ms`
    + (statusRuim ? `  ${VERMELHO(`status ${statusRuim}`)}` : '')
  );

  return { rotulo, p50, p95, max, orcamentoMs, statusRuim, passou };
}

async function principal() {
  console.log('\n=== DESEMPENHO — MÓDULO TREINADORES & EQUIPES ===\n');
  console.log(CINZA(`  máquina .... ${hostname()} · ${cpus().length} vCPU · ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`));
  console.log(CINZA(`  API ........ ${BASE_API}`));
  console.log(CINZA(`  amostras ... ${REPETICOES} por rota (+${AQUECIMENTO} de aquecimento)`));
  console.log(CINZA('  orçamentos . deste gate; NÃO são SLA homologado\n'));

  const saude = await chamar('/health').catch(() => null);
  if (!saude || saude.status >= 500) {
    console.error(VERMELHO('  A API não respondeu. Suba a pilha primeiro:'));
    console.error('    node scripts/qa/visual-treinadores.mjs --manter\n');
    process.exitCode = 2;
    return;
  }

  // ------------------------------------------------------------- semeadura
  console.log('  preparando dados sintéticos…\n');
  const admin = await exigir('/auth/register', { metodo: 'POST', corpo: conta('central') });
  // A promoção a SUPER_ADMIN não é autoatribuível pela rota aberta, e este script
  // NÃO toca o banco. Então a medição das rotas da MESA CENTRAL usa a conta que o
  // ambiente do gate já criou; aqui medimos o que uma conta comum e a conta do
  // treinador alcançam. É menos abrangente e é honesto: inventar um caminho de
  // promoção só para medir seria criar superfície que não existe.
  const tokenComum = (await exigir('/auth/login', { metodo: 'POST', corpo: { email: admin.user.email, password: SENHA } })).token;

  const treinador = await exigir('/auth/register', { metodo: 'POST', corpo: conta('treinador') });
  const tokenTreinador = (await exigir('/auth/login', { metodo: 'POST', corpo: { email: treinador.user.email, password: SENHA } })).token;
  const cadastro = await exigir('/coaches/self-register', {
    metodo: 'POST', token: tokenTreinador,
    corpo: { name: 'PERF Treinadora', registration: `CREF-PERF-${marca}` }
  });

  const resultados = [];

  // --------------------------------------------------------- as medições
  //
  // Cada rota mede o caminho que uma pessoa real percorre, com a sessão que ela
  // teria. Rota que exige estado que este script não pode criar sem tocar o banco
  // fica de fora, e a ausência é declarada no relatório — não preenchida com um
  // número que mediria outra coisa.
  resultados.push(await medir('POST /auth/login', 1500,
    () => chamar('/auth/login', { metodo: 'POST', corpo: { email: treinador.user.email, password: SENHA } })));

  resultados.push(await medir('GET /coaches (catálogo)', 600,
    () => chamar('/coaches', { token: tokenTreinador })));

  resultados.push(await medir('GET /coaches/me', 600,
    () => chamar('/coaches/me', { token: tokenTreinador })));

  resultados.push(await medir('GET /coaches/me/teams', 600,
    () => chamar('/coaches/me/teams', { token: tokenTreinador })));

  resultados.push(await medir('GET /coaches/me/athletes', 800,
    () => chamar('/coaches/me/athletes', { token: tokenTreinador })));

  resultados.push(await medir('GET /team-membership-requests/mine', 600,
    () => chamar('/team-membership-requests/mine', { token: tokenTreinador })));

  // A busca por matrícula é a rota com teto de requisições próprio: medir com
  // `REPETICOES` alto esbarraria no limitador e mediria o 429, não a busca.
  resultados.push(await medir('POST /athletes/lookup-affiliation (recusa por estado)', 800,
    () => chamar('/athletes/lookup-affiliation', {
      metodo: 'POST', token: tokenTreinador,
      corpo: { organizationId: 'org-inexistente-perf', affiliationNumber: '5001' }
    })));

  // A-01: a recusa também tem custo, e é o caminho mais batido por quem varre.
  resultados.push(await medir('GET /coaches/:id/ranking/eligibility (recusa de terceiro)', 600,
    () => chamar(`/coaches/${cadastro.id}/ranking/eligibility?seasonId=inexistente`, { token: tokenComum })));

  resultados.push(await medir('GET /ranking/coaches (bloqueio de §8.3)', 400,
    () => chamar('/ranking/coaches')));

  resultados.push(await medir('GET /health', 300, () => chamar('/health')));

  // ------------------------------------------------------------- resumo
  const falharam = resultados.filter(r => !r.passou);
  console.log('');
  console.log(`  ${resultados.length - falharam.length}/${resultados.length} dentro do orçamento deste gate`);
  if (falharam.length) {
    console.log(VERMELHO('\n  FORA DO ORÇAMENTO:'));
    for (const r of falharam) {
      console.log(`    ${r.rotulo} — p95=${r.p95.toFixed(0)}ms (orçamento ${r.orcamentoMs}ms)`
        + (r.statusRuim ? `, status ${r.statusRuim}` : ''));
    }
  }
  console.log('');
  process.exitCode = falharam.length ? 1 : 0;
}

principal().catch(erro => {
  console.error(VERMELHO(`\nFALHOU: ${erro.message}\n`));
  process.exitCode = 2;
});
