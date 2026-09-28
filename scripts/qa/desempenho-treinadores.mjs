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
// AS CONTAS DO AMBIENTE, POR ARGUMENTO.
//
// As rotas do treinador exigem papel `COACH` e cadastro aprovado, e promover
// papel é escrita direta no banco — que este script não faz, por desenho. Quem já
// criou essas contas é `visual-treinadores.mjs --manter`, que imprime os
// endereços. Passá-los aqui é o que permite medir o caminho REAL do treinador em
// vez de medir a recusa de uma conta comum.
//
// Sem os argumentos, as rotas correspondentes saem como NÃO MEDIDAS — nomeadas,
// nunca preenchidas com um número que mediria outra coisa.
const EMAIL_TREINADOR = arg('treinador', env.QA_EMAIL_TREINADOR || null);
const EMAIL_CENTRAL = arg('central', env.QA_EMAIL_CENTRAL || null);
// `/health` e `/ready` vivem na RAIZ, e não sob `/api/v1`: são sondas de
// infraestrutura, não recurso da API versionada.
const ORIGEM = BASE_API.replace(/\/api\/v1\/?$/, '');

const VERDE = s => `\x1b[32m${s}\x1b[0m`;
const VERMELHO = s => `\x1b[31m${s}\x1b[0m`;
const CINZA = s => `\x1b[90m${s}\x1b[0m`;

// A FOTO DE QA, obrigatória no autocadastro de treinador desde a decisão da foto.
// PNG minúsculo e de VERDADE: o servidor decodifica os bytes, então buffer
// inventado é recusado — e recusado com razão.
const FOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAA'
  + 'EUlEQVQImWM4YaOBFTEMLQkAdntLAQXW6sIAAAAASUVORK5CYII=',
  'base64'
);

// O autocadastro é MULTIPART: a foto vem na mesma requisição que cria o cadastro.
async function autocadastrarTreinador(token, campos) {
  const forma = new FormData();
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor !== undefined && valor !== null) forma.append(chave, String(valor));
  }
  forma.append('photo', new Blob([FOTO_PNG], { type: 'image/png' }), 'foto.png');

  const resposta = await fetch(`${BASE_API}/coaches/self-register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: forma
  });
  const json = await resposta.json().catch(() => ({}));
  if (resposta.status >= 400) {
    throw new Error(`POST /coaches/self-register → ${resposta.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}


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

// O STATUS ESPERADO É DECLARADO, e não inferido de `>= 400`.
//
// Metade das rotas deste módulo tem a RECUSA como resposta correta: o bloqueio de
// §8.3 é 409, a recusa antienumeração de A-01 é 404, a rota de treinador vista por
// quem não é treinador é 403. Tratar qualquer 4xx como falha mediria o oposto do
// que interessa — e um gate que reprova no comportamento certo é um gate que
// alguém desliga.
async function medir(rotulo, { orcamentoMs, esperado }, executar) {
  for (let i = 0; i < AQUECIMENTO; i += 1) await executar();

  const esperados = Array.isArray(esperado) ? esperado : [esperado];
  const amostras = [];
  let statusRuim = null;
  for (let i = 0; i < REPETICOES; i += 1) {
    const t = process.hrtime.bigint();
    const r = await executar();
    amostras.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (r && !esperados.includes(r.status)) statusRuim = r.status;
  }

  amostras.sort((a, b) => a - b);
  const p50 = percentil(amostras, 50);
  const p95 = percentil(amostras, 95);
  const max = amostras[amostras.length - 1];
  const passou = statusRuim === null && p95 <= orcamentoMs;

  console.log(
    `  ${(passou ? VERDE('PASS  ') : VERMELHO('FALHOU'))}  ${rotulo.padEnd(52)}`
    + ` p50=${p50.toFixed(0).padStart(5)}ms  p95=${p95.toFixed(0).padStart(5)}ms`
    + `  max=${max.toFixed(0).padStart(5)}ms  orçamento=${String(orcamentoMs).padStart(4)}ms`
    + `  esperado=${esperados.join('/')}`
    + (statusRuim ? `  ${VERMELHO(`veio ${statusRuim}`)}` : '')
  );

  return { rotulo, p50, p95, max, orcamentoMs, esperados, statusRuim, passou };
}

async function principal() {
  console.log('\n=== DESEMPENHO — MÓDULO TREINADORES & EQUIPES ===\n');
  console.log(CINZA(`  máquina .... ${hostname()} · ${cpus().length} vCPU · ${(totalmem() / 1024 ** 3).toFixed(1)} GiB`));
  console.log(CINZA(`  API ........ ${BASE_API}`));
  console.log(CINZA(`  amostras ... ${REPETICOES} por rota (+${AQUECIMENTO} de aquecimento)`));
  console.log(CINZA('  orçamentos . deste gate; NÃO são SLA homologado\n'));

  const saude = await fetch(`${ORIGEM}/health`).then(r => ({ status: r.status })).catch(() => null);
  if (!saude || saude.status >= 400) {
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
  const cadastro = await autocadastrarTreinador(tokenTreinador, {
    name: 'PERF Treinadora', registration: `CREF-PERF-${marca}`
  });

  const resultados = [];
  const naoMedidas = [];

  const entrar = async email => {
    const r = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } });
    if (r.status !== 200) throw new Error(`login de ${email} → ${r.status}`);
    return r.corpo.token;
  };

  const tokenDoTreinador = EMAIL_TREINADOR ? await entrar(EMAIL_TREINADOR) : null;
  const tokenDaCentral = EMAIL_CENTRAL ? await entrar(EMAIL_CENTRAL) : null;
  const meuCadastro = tokenDoTreinador
    ? (await chamar('/coaches/me', { token: tokenDoTreinador })).corpo
    : null;

  // --------------------------------------------------------- as medições
  //
  // Cada linha declara o status ESPERADO. Rota cujo estado este script não pode
  // montar sem tocar o banco fica NÃO MEDIDA, e a ausência é nomeada.

  resultados.push(await medir('POST /auth/login', { orcamentoMs: 1500, esperado: 200 },
    () => chamar('/auth/login', { metodo: 'POST', corpo: { email: treinador.user.email, password: SENHA } })));

  resultados.push(await medir('GET /coaches (catálogo)', { orcamentoMs: 600, esperado: 200 },
    () => chamar('/coaches', { token: tokenTreinador })));

  // A conta comum não tem `coaches.read_own`, e por isso a recusa é 403 — ANTES de
  // qualquer consulta de existência de cadastro. Medir isso aqui é medir a
  // conferência de permissão, que é o caminho mais batido da rota.
  resultados.push(await medir('GET /coaches/me (conta comum: recusa por permissão)',
    { orcamentoMs: 600, esperado: 403 },
    () => chamar('/coaches/me', { token: tokenComum })));

  // A-01: a recusa antienumeração é 404, e é o caminho mais batido por quem varre.
  resultados.push(await medir('GET /coaches/:id/ranking/eligibility (recusa de terceiro)',
    { orcamentoMs: 600, esperado: 404 },
    () => chamar(`/coaches/${cadastro.id}/ranking/eligibility?seasonId=inexistente`, { token: tokenComum })));

  // §8.3: o bloqueio é 409, e ele É a resposta correta.
  resultados.push(await medir('GET /ranking/coaches (bloqueio de §8.3)', { orcamentoMs: 400, esperado: 409 },
    () => chamar('/ranking/coaches')));

  resultados.push(await medir('GET /health (raiz)', { orcamentoMs: 300, esperado: 200 },
    () => fetch(`${ORIGEM}/health`).then(r => ({ status: r.status }))));

  // ------------------------------------- o caminho REAL do treinador aprovado
  if (tokenDoTreinador) {
    resultados.push(await medir('GET /coaches/me (dono do cadastro, papel COACH)',
      { orcamentoMs: 600, esperado: 200 },
      () => chamar('/coaches/me', { token: tokenDoTreinador })));

    resultados.push(await medir('GET /coaches/me/teams (treinador do ambiente)',
      { orcamentoMs: 600, esperado: 200 },
      () => chamar('/coaches/me/teams', { token: tokenDoTreinador })));

    // A rota que passa pelos predicados NOVOS de RLS: a leitura de atleta pelo
    // treinador atravessa `mci_treinador_com_equipe_em`, que lê três tabelas.
    resultados.push(await medir('GET /coaches/me/athletes (RLS do treinador)',
      { orcamentoMs: 800, esperado: 200 },
      () => chamar('/coaches/me/athletes', { token: tokenDoTreinador })));

    resultados.push(await medir('GET /team-membership-requests/me',
      { orcamentoMs: 600, esperado: 200 },
      () => chamar('/team-membership-requests/me', { token: tokenDoTreinador })));

    if (meuCadastro?.id) {
      resultados.push(await medir('GET /coaches/:id/ranking/projection (dono, sem temporada)',
        { orcamentoMs: 800, esperado: 422 },
        () => chamar(`/coaches/${meuCadastro.id}/ranking/projection`, { token: tokenDoTreinador })));
    } else {
      naoMedidas.push('GET /coaches/:id/ranking/projection — o cadastro do treinador do ambiente não foi lido');
    }
  } else {
    naoMedidas.push('GET /coaches/me/teams, /coaches/me/athletes, /team-membership-requests/me e '
      + '/coaches/:id/ranking/projection — exigem o treinador APROVADO do ambiente (passe --treinador <e-mail>)');
  }

  // ------------------------------------------------ o caminho da mesa central
  if (tokenDaCentral) {
    resultados.push(await medir('GET /coaches/review (fila da mesa central)',
      { orcamentoMs: 800, esperado: 200 },
      () => chamar('/coaches/review?status=PENDING', { token: tokenDaCentral })));

    resultados.push(await medir('GET /central-authorizations (delegações vivas)',
      { orcamentoMs: 600, esperado: 200 },
      () => chamar('/central-authorizations', { token: tokenDaCentral })));
  } else {
    naoMedidas.push('GET /coaches/review e /central-authorizations — exigem a conta da mesa '
      + 'central do ambiente (passe --central <e-mail>)');
  }

  // ------------------------------------------------------------- resumo
  const falharam = resultados.filter(r => !r.passou);
  console.log('');
  console.log(`  ${resultados.length - falharam.length}/${resultados.length} dentro do orçamento deste gate, com o status esperado`);
  if (naoMedidas.length) {
    console.log(CINZA(`\n  NÃO MEDIDAS (${naoMedidas.length}) — nomeadas, não preenchidas:`));
    for (const n of naoMedidas) console.log(CINZA(`    ${n}`));
  }
  if (falharam.length) {
    console.log(VERMELHO('\n  FORA DO ORÇAMENTO:'));
    for (const r of falharam) {
      console.log(`    ${r.rotulo} — p95=${r.p95.toFixed(0)}ms (orçamento ${r.orcamentoMs}ms)`
        + (r.statusRuim ? `, esperava ${r.esperados.join('/')} e veio ${r.statusRuim}` : ''));
    }
  }
  console.log('');
  process.exitCode = falharam.length ? 1 : 0;
}

principal().catch(erro => {
  console.error(VERMELHO(`\nFALHOU: ${erro.message}\n`));
  process.exitCode = 2;
});
