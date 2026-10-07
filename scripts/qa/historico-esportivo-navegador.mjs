#!/usr/bin/env node
// ============================================================================
// O HISTÓRICO ESPORTIVO DO ATLETA, NUM NAVEGADOR DE VERDADE.
//
// POR QUE ESTE ARREIO EXISTE
//
// A ficha pública mostrava, no mesmo bloco, "PONTOS SOMADOS 30" e "RESULTADOS
// PUBLICADOS 0" — com "ainda sem resultados publicados" logo abaixo. Teste de
// API não pega isso: ele chama a rota e confere o JSON. O que estava quebrado
// era o que a PESSOA vê, e é a pessoa que este arreio imita.
//
// Ele sobe tudo: API, build do frontend, semeadura por API e Chromium. Depois
// abre a ficha pública SEM LOGIN — que é como o visitante a abre —, confere o
// número, confere as duas linhas do histórico, clica numa delas e confere que
// a página da etapa abriu. Volta e repete, em desktop e em celular.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/historico-esportivo-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
//
// A senha vem por variável de ambiente, nunca por argumento: argumento aparece
// em `ps` para qualquer usuário da máquina.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { entrar, dispensarAbertura } from './entrar-na-plataforma.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4822));
const PORTA_WEB = Number(arg('porta-web', 5822));
const SAIDA = arg('saida', 'qa-historico-esportivo');
const MODULO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = env.CHROMIUM_PATH || null;
const SENHA = env.QA_PASSWORD;
const BANCO = env.DATABASE_URL;

if (!SENHA || !BANCO) {
  console.error('\n  Falta QA_PASSWORD e/ou DATABASE_URL no ambiente.\n');
  process.exit(1);
}

const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const EMAIL = 'qa.historico@mci.local';

const processos = [];
const encerrar = () => processos.forEach(p => { try { p.kill('SIGTERM'); } catch { /* já morreu */ } });
process.on('exit', encerrar);
process.on('SIGINT', () => { encerrar(); process.exit(130); });

async function esperarPorta(url, tentativas = 90) {
  for (let i = 0; i < tentativas; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* ainda não subiu */ }
    await esperar(1000);
  }
  return false;
}

let token = null;
async function chamar(metodo, rota, corpo) {
  const r = await fetch(BASE_API + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  const texto = await r.text();
  let dado; try { dado = texto ? JSON.parse(texto) : null; } catch { dado = texto; }
  return { status: r.status, dado };
}
const exigir = (r, oque) => {
  if (r.status >= 400) throw new Error(`${oque}: ${r.status} ${JSON.stringify(r.dado).slice(0, 300)}`);
  return r.dado;
};
// CPF válido pelo algoritmo, fictício por construção.
const cpfDeSemente = semente => {
  const n = String(semente).padStart(9, '0').slice(0, 9).split('').map(Number);
  const d = base => {
    let s = 0;
    for (let i = 0; i < base.length; i += 1) s += base[i] * (base.length + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = d(n);
  return [...n, d1, d([...n, d1])].join('');
};

const falhas = [];
const conferir = (condicao, oque) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${oque}`);
  if (!condicao) falhas.push(oque);
};


async function principal() {
  mkdirSync(SAIDA, { recursive: true });

  // ---------------------------------------------------------------- API
  console.log('subindo a API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1',
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-historico-esportivo-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_DIR: './uploads-qa-historico',
      CORS_ORIGINS: `${BASE_WEB},http://localhost:${PORTA_WEB}`,
      RATE_LIMIT_ENABLED: 'false', TRUST_PROXY_HOPS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; });
  api.stderr.on('data', d => { saidaApi += d; });
  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/health`)) {
    throw new Error(`a API não subiu:\n${saidaApi.slice(-1500)}`);
  }

  // ------------------------------------------------------------ semeadura
  console.log('semeando duas etapas importadas para o mesmo atleta…');
  try {
    execSync(`node scripts/criar-admin.js "QA Historico" ${EMAIL}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch { console.log('  (administrador já existia)'); }

  token = exigir(await chamar('POST', '/auth/login', { email: EMAIL, password: SENHA }), 'login').token;

  const marca = Date.now();
  const org = exigir(await chamar('POST', '/organizations',
    { name: `QA Histórico ${marca}`, slug: `qa-hist-${marca}` }), 'organização');
  const npc = exigir(await chamar('POST', '/affiliations',
    { organizationId: org.id, name: 'NPC National Physique Committee', code: 'NPC' }), 'filiação NPC');
  const temporada = exigir(await chamar('POST', '/seasons',
    { organizationId: org.id, name: 'Temporada QA', year: 2026 }), 'temporada');
  exigir(await chamar('PUT', `/seasons/${temporada.id}/points-rules`, {
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  }), 'tabela de pontos');

  const atleta = exigir(await chamar('POST', '/athletes', {
    organizationId: org.id, fullName: 'Lucas Gouveia Lima', cpf: cpfDeSemente(293293293),
    sex: 'MALE', affiliationId: npc.id, affiliationNumber: '2932'
  }), 'atleta');

  // DUAS ETAPAS, dois eventos — exatamente a forma do caso real.
  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
  const etapas = [
    { nome: 'Ipiranga', dia: '2026-06-20T12:00:00.000Z', prefixo: 'IPIRANGA' },
    { nome: 'Razor', dia: '2026-10-03T12:00:00.000Z', prefixo: 'RAZOR' }
  ];
  for (const etapa of etapas) {
    const evento = exigir(await chamar('POST', '/events', {
      organizationId: org.id, name: etapa.nome, slug: `${etapa.prefixo.toLowerCase()}-${marca}`,
      startDate: etapa.dia, seasonId: temporada.id
    }), `evento ${etapa.nome}`);
    // A etapa precisa estar publicamente visível para a linha virar link.
    exigir(await chamar('POST', `/events/${evento.id}/transition`, { status: 'PLANNED' }), 'transição para PLANNED');

    const linha = `${etapa.prefixo}-2932-MBB,,Lucas Gouveia,NPC,2932,MENS_BODYBUILDING,OPEN,1,,${etapa.nome},sim`;
    const lote = exigir(await chamar('POST', '/musclewar/imports', {
      organizationId: org.id, seasonId: temporada.id, eventId: evento.id,
      sourceType: 'CSV', sourceRef: `${etapa.prefixo.toLowerCase()}-qa.csv`,
      content: `${CABECALHO}\n${linha}`
    }), `importação ${etapa.nome}`);
    const importId = lote.import?.id ?? lote.id;
    exigir(await chamar('POST', `/musclewar/imports/${importId}/apply`), `aplicar ${etapa.nome}`);
  }

  // O SERVIDOR, ANTES DA TELA. Se aqui já estiver errado, o navegador só
  // confirmaria o erro — e o diagnóstico ficaria ambíguo.
  const daApi = exigir(await chamar('GET', `/public/athletes/${atleta.id}`), 'ficha pública');
  conferir(daApi.results.length === 2, `servidor: a ficha traz 2 resultados (veio ${daApi.results.length})`);
  conferir(daApi.titles === 2, `servidor: 2 títulos (veio ${daApi.titles})`);
  // O ARQUIVO MARCA OVERALL, então cada etapa vale colocação + bônus. O número
  // exato depende da tabela da temporada e do bônus homologado — o que esta
  // conferência cobra é a COERÊNCIA entre as duas leituras, que é o defeito:
  // a soma do ranking tem de bater com a soma das participações do histórico.
  const somaDoRanking = daApi.rankings.reduce((t, l) => t + l.totalPoints, 0);
  const somaDoHistorico = daApi.results.reduce((t, r) => t + (r.points ?? 0), 0);
  conferir(somaDoRanking === somaDoHistorico,
    `servidor: ranking (${somaDoRanking}) e histórico (${somaDoHistorico}) somam o mesmo`);
  conferir(somaDoRanking > 0, `servidor: a soma não é zero (${somaDoRanking})`);
  conferir(daApi.rankings[0]?.eventCount === 2,
    `servidor: 2 participações no ranking (veio ${daApi.rankings[0]?.eventCount})`);

  // ------------------------------------------------------------- frontend
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  // ------------------------------------------------------------- navegador
  console.log('abrindo o Chromium…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  const pagina = await contexto.newPage();

  const erros = [];
  const falhasExternas = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');
  pagina.on('console', m => { if (m.type() === 'error' && daAplicacao(m.location()?.url)) erros.push(m.text()); });
  pagina.on('pageerror', e => erros.push(String(e)));
  pagina.on('requestfailed', r => {
    const registro = `${r.url()} — ${r.failure()?.errorText ?? '?'}`;
    (daAplicacao(r.url()) ? erros : falhasExternas).push(registro);
  });

  const print = async nome => pagina.screenshot({ path: `${SAIDA}/${nome}.png`, fullPage: false });

  // ANÔNIMO PRIMEIRO — e aqui o ACHADO virou REGRA.
  //
  // Este bloco registrava um defeito: a API da ficha era anônima (`GET
  // /public/athletes/:id` responde 200 sem token, e há suíte provando), mas o
  // CASCO devolvia a tela de entrada para QUALQUER rota — `if (!authenticated)
  // return <Auth />`, antes de olhar qual tela a pessoa pediu, inclusive as
  // marcadas `publico: true`. O visitante não alcançava a vitrine.
  //
  // Isso foi corrigido, então o que era observação passou a ser CONFERÊNCIA: se
  // a ficha voltar a pedir sessão, este arreio reprova. A abertura da marca sai
  // da frente primeiro — ela roda uma vez por sessão do navegador e não é o que
  // se está medindo.
  await pagina.goto(`${BASE_WEB}/#/atletas/${atleta.id}`, { waitUntil: 'networkidle' });
  await esperar(1500);
  await dispensarAbertura(pagina);
  await esperar(900);
  await print('0-anonimo');
  const anonimo = await pagina.content();
  conferir(anonimo.includes('Lucas Gouveia Lima'), 'a vitrine ABRE para o visitante ANÔNIMO');
  conferir(!/type="password"/i.test(anonimo), 'e a tela de entrada não tomou o lugar dela');

  // ENTRA PELA PORTA, como uma pessoa: abertura, vitrine, convite, formulário,
  // senha. Injetar token no armazenamento não serve — o casco decide a sessão
  // por outro caminho, e um atalho aqui mediria o atalho, não a tela.
  await entrar(pagina, BASE_WEB, { email: EMAIL, senha: SENHA });

  await pagina.goto(`${BASE_WEB}/#/atletas/${atleta.id}`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await print('1-ficha-publica');

  const texto = await pagina.content();
  if (!texto.includes('Lucas Gouveia Lima')) {
    const visivel = (await pagina.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400);
    console.log(`  · o que a tela mostrou: "${visivel}"`);
  }
  conferir(texto.includes('Lucas Gouveia Lima'), 'a ficha do atleta abriu');
  conferir(!/ainda sem resultados|sem resultados publicados/i.test(texto),
    'a frase "ainda sem resultados publicados" SUMIU');

  // O CARTÃO. O número tem de ser 2, e não 0 — era este o defeito.
  const cartao = await pagina.locator('.metric, .card, .grid-4 > *').allInnerTexts();
  const blocoDeResultados = cartao.find(t => /resultados publicados/i.test(t)) ?? '';
  conferir(/\b2\b/.test(blocoDeResultados),
    `o cartão RESULTADOS PUBLICADOS mostra 2 (leu: ${blocoDeResultados.replace(/\s+/g, ' ').trim().slice(0, 60)})`);

  // AS DUAS LINHAS DO HISTÓRICO, pelo nome da etapa.
  conferir(texto.includes('Ipiranga'), 'o histórico mostra a etapa Ipiranga');
  conferir(texto.includes('Razor'), 'o histórico mostra a etapa Razor');

  // E O LINK. Teste de API não clica.
  const verEtapa = pagina.getByRole('button', { name: /Ver a etapa/i });
  const quantos = await verEtapa.count();
  conferir(quantos === 2, `as duas linhas são clicáveis (achei ${quantos})`);
  if (!quantos) { await print('2b-sem-link'); throw new Error('nenhuma linha do histórico é clicável'); }

  await verEtapa.first().click();
  await esperar(2000);
  await print('2-etapa-aberta');
  const naEtapa = await pagina.content();
  conferir(/Razor|Ipiranga/.test(naEtapa), 'o clique abriu a página pública da etapa');
  conferir(pagina.url().includes('campeonatos/'), `a URL é a da etapa (${pagina.url().split('#')[1] ?? ''})`);

  // VOLTAR E REPETIR: o fluxo precisa funcionar duas vezes, não uma.
  await pagina.goBack();
  await esperar(1500);
  const voltou = await pagina.getByRole('button', { name: /Ver a etapa/i }).count();
  conferir(voltou === 2, `ao voltar, o histórico continua inteiro (achei ${voltou})`);

  // CELULAR. A linha tem colocação, nome, pontos e botão: é onde ela quebraria.
  await pagina.setViewportSize({ width: 390, height: 844 });
  await esperar(800);
  await print('3-celular');
  const noCelular = await pagina.getByRole('button', { name: /Ver a etapa/i }).first().boundingBox();
  conferir(Boolean(noCelular) && noCelular.x >= 0 && noCelular.x + noCelular.width <= 391,
    `em 390px o botão fica DENTRO da tela (x=${noCelular ? Math.round(noCelular.x) : '?'})`);
  conferir((await pagina.content()).includes('Razor'), 'e o histórico continua legível no celular');

  await pagina.setViewportSize({ width: 1280, height: 900 });
  await esperar(500);
  await print('4-desktop');

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 3).join(' | ').slice(0, 500));
  if (falhasExternas.length) {
    console.log(`  · ${falhasExternas.length} falha(s) de recurso EXTERNO, do ambiente desta máquina:`);
    console.log('   ', falhasExternas.slice(0, 2).join(' | ').slice(0, 300));
  }

  await navegador.close();

  console.log(`\n  prints em ${SAIDA}/`);
  if (falhas.length) {
    console.error(`\n  FALHOU em ${falhas.length}:\n   - ${falhas.join('\n   - ')}\n`);
    encerrar();
    process.exit(1);
  }
  console.log('\n  QA VISUAL: todas as conferências passaram.\n');
  encerrar();
  process.exit(0);
}

principal().catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); encerrar(); process.exit(1); });
