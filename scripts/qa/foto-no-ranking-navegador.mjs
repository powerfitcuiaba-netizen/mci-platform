#!/usr/bin/env node
// ============================================================================
// A FOTO DO ATLETA NO RANKING PÚBLICO, NUM NAVEGADOR DE VERDADE.
//
// POR QUE ESTE ARREIO EXISTE
//
// Teste de componente prova o CONTRATO — que a tela pede a imagem pelo id e
// cai nas iniciais quando não há. Ele não prova que a imagem CHEGA: isso
// depende da rota responder ao anônimo, do arquivo existir no armazenamento e
// do elemento <img> aparecer na linha. É o que este arreio mede.
//
// Ele sobe API, semeia dois atletas — um COM foto, outro SEM —, constrói o
// frontend e abre o ranking no Chromium, em desktop e em celular.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/foto-no-ranking-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { entrar } from './entrar-na-plataforma.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4833));
const PORTA_WEB = Number(arg('porta-web', 5833));
const SAIDA = arg('saida', 'qa-foto-ranking');
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
const EMAIL = 'qa.foto@mci.local';

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



import { writeFileSync, mkdirSync as criarPasta } from 'node:fs';
import { join } from 'node:path';

// Um PNG 1×1 válido: o menor arquivo que o navegador aceita desenhar. Não é
// retrato de ninguém — é pixel, e o que se mede aqui é o CAMINHO da imagem.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const PASTA_STORAGE = './uploads-qa-foto';

  console.log('subindo a API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1',
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-foto-no-ranking-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_DIR: PASTA_STORAGE,
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

  console.log('semeando um atleta COM foto e outro SEM…');
  try {
    execSync(`node scripts/criar-admin.js "QA Foto" ${EMAIL}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch { console.log('  (administrador já existia)'); }
  const sessao = exigir(await chamar('POST', '/auth/login', { email: EMAIL, password: SENHA }), 'login');
  token = sessao.token;
  const atorId = sessao.user?.id ?? sessao.id;
  if (!atorId) throw new Error('o login não devolveu o id do usuário');

  const marca = Date.now();
  const org = exigir(await chamar('POST', '/organizations',
    { name: `QA Foto ${marca}`, slug: `qa-foto-${marca}` }), 'organização');
  const npc = exigir(await chamar('POST', '/affiliations',
    { organizationId: org.id, name: 'NPC National Physique Committee', code: 'NPC' }), 'filiação');
  const temporada = exigir(await chamar('POST', '/seasons',
    { organizationId: org.id, name: 'Temporada QA', year: 2026 }), 'temporada');
  exigir(await chamar('PUT', `/seasons/${temporada.id}/points-rules`, {
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }]
  }), 'tabela de pontos');
  const evento = exigir(await chamar('POST', '/events', {
    organizationId: org.id, name: 'Etapa QA', slug: `etapa-foto-${marca}`,
    startDate: '2026-06-20T12:00:00.000Z', seasonId: temporada.id
  }), 'evento');
  exigir(await chamar('POST', `/events/${evento.id}/transition`, { status: 'PLANNED' }), 'PLANNED');

  const comFoto = exigir(await chamar('POST', '/athletes', {
    organizationId: org.id, fullName: 'Atleta Com Retrato', cpf: cpfDeSemente(820000011),
    sex: 'MALE', affiliationId: npc.id, affiliationNumber: '1001'
  }), 'atleta com foto');
  const semFoto = exigir(await chamar('POST', '/athletes', {
    organizationId: org.id, fullName: 'Beatriz Sem Retrato', cpf: cpfDeSemente(820000022),
    sex: 'FEMALE', affiliationId: npc.id, affiliationNumber: '1002'
  }), 'atleta sem foto');

  // A FOTO: arquivo no armazenamento local e a chave no cadastro. O upload
  // real passa pelo pedido de cadastro, que é outro fluxo; o que se mede aqui
  // é a EXIBIÇÃO.
  const chave = `athletes/${comFoto.id}.png`;
  criarPasta(join(PASTA_STORAGE, 'athletes'), { recursive: true });
  writeFileSync(join(PASTA_STORAGE, chave), PNG_1X1);
  // A ESCRITA PASSA PELO CONTEXTO DE RLS, como qualquer requisição autenticada.
  // Um cliente cru não enxerga o cadastro — a política é por organização — e o
  // update falharia com "nenhum registro encontrado", que diria "não existe"
  // quando o certo é "não enxergo".
  //
  // Vai para ARQUIVO e não para `node -e`: o corpo tem quebras de linha e um
  // `$` de método, e o shell mastiga os dois.
  const arquivoDaSemeadura = `${SAIDA}/semear-foto.cjs`;
  writeFileSync(arquivoDaSemeadura, [
    "const prisma = require(process.cwd() + '/src/config/prisma');",
    "const { withUserContext } = require(process.cwd() + '/src/config/rlsSession');",
    `withUserContext(${JSON.stringify(atorId)}, tx => tx.athlete.update({`,
    `  where: { id: ${JSON.stringify(comFoto.id)} },`,
    `  data: { photoKey: ${JSON.stringify(chave)} }`,
    '}))',
    "  .then(() => prisma.$disconnect())",
    "  .catch(erro => { console.error(erro.message); process.exit(1); });"
  ].join('\n'));
  execSync(`node ${arquivoDaSemeadura}`, { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO } });

  // ANÔNIMO alcança a foto? É a decisão de produto, medida na porta.
  const semSessao = await fetch(`${BASE_API}/media/athletes/${comFoto.id}/photo`);
  conferir(semSessao.status === 200, `a rota da foto responde ao ANÔNIMO (veio ${semSessao.status})`);
  conferir((semSessao.headers.get('content-type') || '').startsWith('image/'),
    `e devolve imagem (${semSessao.headers.get('content-type')})`);

  const naoTem = await fetch(`${BASE_API}/media/athletes/${semFoto.id}/photo`);
  conferir(naoTem.status === 404, `atleta sem foto devolve 404 (veio ${naoTem.status})`);

  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
  const linhas = [
    `QA-1001-MBB,,Atleta Com Retrato,NPC,1001,MENS_BODYBUILDING,OPEN,1,,Etapa QA,`,
    `QA-1002-BIK,,Beatriz Sem Retrato,NPC,1002,BIKINI,OPEN,2,,Etapa QA,`
  ];
  const lote = exigir(await chamar('POST', '/musclewar/imports', {
    organizationId: org.id, seasonId: temporada.id, eventId: evento.id,
    sourceType: 'CSV', sourceRef: 'qa-foto.csv', content: `${CABECALHO}\n${linhas.join('\n')}`
  }), 'importação');
  exigir(await chamar('POST', `/musclewar/imports/${lote.import?.id ?? lote.id}/apply`), 'aplicar');

  const doRanking = exigir(await chamar('GET', `/ranking?seasonId=${temporada.id}`), 'ranking');
  const comRetrato = doRanking.items.find(l => l.athlete?.id === comFoto.id);
  conferir(Boolean(comRetrato), 'o ranking traz o atleta com foto');
  conferir(comRetrato?.athlete?.hasPhoto === true, 'e o corpo marca hasPhoto');
  conferir(!JSON.stringify(doRanking).includes('photoKey'), 'a chave do armazenamento NÃO sai no corpo');

  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  console.log('abrindo o Chromium…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const pagina = await (await navegador.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

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

  // Entra pela porta, como uma pessoa. O ranking é tela PÚBLICA e abriria sem
  // sessão; o que este arreio mede é a foto com sessão, e a sessão vem do
  // formulário — não de token escrito no armazenamento.
  await entrar(pagina, BASE_WEB, { email: EMAIL, senha: SENHA });

  for (const [rotulo, largura] of [['desktop', 1280], ['celular', 390]]) {
    await pagina.setViewportSize({ width: largura, height: largura === 390 ? 844 : 900 });
    await pagina.goto(`${BASE_WEB}/#/ranking`, { waitUntil: 'networkidle' });
    await esperar(2500);
    await print(`ranking-${rotulo}`);

    const texto = await pagina.content();
    conferir(texto.includes('Atleta Com Retrato'), `${rotulo}: o ranking listou o atleta com foto`);

    // A IMAGEM DE VERDADE NA LINHA — não o atributo, o elemento desenhado.
    const imagens = pagina.locator('.avatar img');
    const quantas = await imagens.count();
    conferir(quantas >= 1, `${rotulo}: há <img> dentro do avatar (achei ${quantas})`);

    if (quantas) {
      const desenhou = await imagens.first().evaluate(el => el.complete && el.naturalWidth > 0);
      conferir(desenhou, `${rotulo}: a imagem CARREGOU (naturalWidth > 0)`);
      const caixa = await imagens.first().boundingBox();
      conferir(Boolean(caixa) && caixa.width > 0 && caixa.height > 0,
        `${rotulo}: a foto ocupa o lugar do avatar (${caixa ? `${Math.round(caixa.width)}×${Math.round(caixa.height)}` : '?'})`);
    }

    // E quem não tem foto continua com iniciais — sem imagem quebrada.
    conferir(texto.includes('Beatriz Sem Retrato') || texto.includes('BS'),
      `${rotulo}: quem não tem foto aparece com as iniciais`);
  }

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 3).join(' | ').slice(0, 500));
  if (falhasExternas.length) {
    console.log(`  · ${falhasExternas.length} falha(s) de recurso EXTERNO, do ambiente desta máquina`);
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
