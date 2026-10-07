#!/usr/bin/env node
// ============================================================================
// O VISITANTE ANÔNIMO, NUM NAVEGADOR DE VERDADE, DO INÍCIO AO FIM.
//
// POR QUE ESTE ARREIO EXISTE
//
// Duas aberturas na mesma rodada: a foto do atleta deixou de exigir sessão, e o
// casco do frontend deixou de mandar o visitante para a tela de entrada nas
// quatro telas declaradas públicas. Teste de API não alcança nenhuma das duas:
// a primeira é o `optionalAuth` de UMA rota, a segunda é um `if` em `App.jsx`
// que roda ANTES de qualquer rota. Quem prova as duas juntas é um navegador
// sem sessão.
//
// O arreio anterior (`historico-esportivo-navegador.mjs`) registrou o achado
// que faltava: a vitrine NÃO abria para anônimo, e ele entrava pela porta para
// seguir medindo o histórico. Este arreio é o inverso — ele NUNCA faz login, e
// a ausência de login é o objeto da medição.
//
// O CAMINHO, exatamente o do visitante:
//
//   1. contexto novo do navegador — sem cookie, sem localStorage, sem sessão
//   2. nenhum login, em nenhum momento
//   3. a URL pública do atleta, digitada direto
//   4. a página abre
//   5. a FOTO aparece — imagem decodificada, não o monograma de iniciais
//   6. o histórico aparece, com as duas etapas
//   7. os resultados publicados aparecem, e o cartão conta 2
//   8. clica num resultado
//   9. a página pública da etapa abre
//  10. os dados da etapa aparecem
//  11. nenhum dado privado aparece em nenhuma das telas
//
// E OS CASOS NEGATIVOS, que é onde uma abertura mal feita vaza:
//
//   N1. URL pública inexistente — recusa limpa, sem tela branca e sem stack
//   N2. resultado NÃO publicado — invisível ao anônimo
//   N3. resultado de OUTRA federação ainda em rascunho — invisível também
//   N4. rota administrativa sem login — não abre, e o conteúdo não chega
//
// A FOTO É GRAVADA PELO FLUXO REAL, e não semeada no banco: conta nova →
// pedido de autocadastro → upload multipart → conclusão automática. É o único
// caminho de escrita de `Athlete.photoKey`, e medi-lo aqui prova de uma vez o
// que o comentário do schema afirma.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/vitrine-anonima-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
//
// A senha vem por variável de ambiente, nunca por argumento: argumento aparece
// em `ps` para qualquer usuário da máquina.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { setTimeout as esperar } from 'node:timers/promises';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4833));
const PORTA_WEB = Number(arg('porta-web', 5833));
const SAIDA = arg('saida', 'qa-vitrine-anonima');
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
const EMAIL_ADMIN = 'qa.vitrine@mci.local';

// DADO PRIVADO COM VALOR CONHECIDO. A peneira do passo 11 procura ESTES
// literais no HTML servido: é a única forma de afirmar "não vazou" sobre a
// tela, e não sobre o JSON.
const TELEFONE = '65991234567';
const EMAIL_DO_ATLETA = 'privado.naovaza@mci.local';

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
async function chamar(metodo, rota, corpo, comToken = true) {
  const r = await fetch(BASE_API + rota, {
    method: metodo,
    headers: { 'content-type': 'application/json', ...(comToken && token ? { authorization: `Bearer ${token}` } : {}) },
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

// --- um PNG 16x16 real: o sharp precisa DECODIFICAR o arquivo --------------
const crc32 = b => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const pedaco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
function png(lado = 16) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = [];
  for (let y = 0; y < lado; y += 1) {
    const linha = Buffer.alloc(lado * 3);
    for (let x = 0; x < lado; x += 1) { linha[x * 3] = 200; linha[x * 3 + 1] = 40 + y * 8; linha[x * 3 + 2] = 90; }
    linhas.push(Buffer.concat([Buffer.from([0]), linha]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))
  ]);
}

const falhas = [];
const conferir = (condicao, oque) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${oque}`);
  if (!condicao) falhas.push(oque);
};

const CONTATO = {
  password: 'senha-de-qa-123456', birthDate: '1991-02-03',
  phone: TELEFONE, whatsapp: TELEFONE, postalCode: '78000123',
  addressLine: 'Rua Reservada', addressNumber: '42', state: 'MT', city: 'Cuiabá'
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
      JWT_SECRET: 'qa-vitrine-anonima-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_DIR: './uploads-qa-vitrine',
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

  // ------------------------------------------------------- CENÁRIO (por API)
  console.log('montando o cenário pela API…');
  try {
    execSync(`node scripts/criar-admin.js "QA Vitrine" ${EMAIL_ADMIN}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch { console.log('  (administrador já existia)'); }
  token = exigir(await chamar('POST', '/auth/login', { email: EMAIL_ADMIN, password: SENHA }), 'login').token;

  const marca = Date.now();
  const org = exigir(await chamar('POST', '/organizations',
    { name: `QA Vitrine ${marca}`, slug: `qa-vitrine-${marca}` }), 'organização A');
  const orgB = exigir(await chamar('POST', '/organizations',
    { name: `QA Vizinha ${marca}`, slug: `qa-vizinha-${marca}` }), 'organização B');
  const npc = exigir(await chamar('POST', '/affiliations',
    { organizationId: org.id, name: 'NPC National Physique Committee', code: 'NPC' }), 'filiação NPC');
  const temporada = exigir(await chamar('POST', '/seasons',
    { organizationId: org.id, name: 'Temporada QA', year: 2026 }), 'temporada');
  exigir(await chamar('PUT', `/seasons/${temporada.id}/points-rules`, {
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }]
  }), 'tabela de pontos');
  exigir(await chamar('POST', `/organizations/${org.id}/self-registration`, { open: true }), 'abrir autocadastro');

  // ---- O ATLETA NASCE PELO AUTOCADASTRO, COM FOTO, PELO FLUXO REAL --------
  console.log('cadastrando o atleta pelo autocadastro, com foto…');
  const emailDaConta = `qa.atleta.${marca}@mci.local`;
  const conta = exigir(await chamar('POST', '/auth/register',
    { ...CONTATO, name: 'Lucas Gouveia Lima', email: emailDaConta }, false), 'conta nova');
  const tokenDaConta = conta.token;

  const pedido = await fetch(`${BASE_API}/athlete-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenDaConta}` },
    body: JSON.stringify({
      fullName: 'Lucas Gouveia Lima', cpf: cpfDeSemente(293293293), sex: 'MALE',
      birthDate: '1991-02-03', affiliationId: npc.id, affiliationNumber: '2932'
    })
  }).then(async r => ({ status: r.status, dado: await r.json() }));
  if (pedido.status !== 201) throw new Error(`pedido de autocadastro: ${pedido.status} ${JSON.stringify(pedido.dado).slice(0, 300)}`);

  const forma = new FormData();
  forma.append('file', new Blob([png()], { type: 'image/png' }), 'retrato.png');
  const envio = await fetch(`${BASE_API}/athlete-requests/${pedido.dado.id}/photo`, {
    method: 'POST', headers: { authorization: `Bearer ${tokenDaConta}` }, body: forma
  });
  if (!envio.ok) throw new Error(`upload da foto: ${envio.status} ${(await envio.text()).slice(0, 300)}`);

  const meuCadastro = await fetch(`${BASE_API}/me/cadastro`, {
    headers: { authorization: `Bearer ${tokenDaConta}` }
  }).then(r => r.json());
  const atletaId = meuCadastro?.athlete?.id ?? meuCadastro?.id;
  if (!atletaId) throw new Error(`não achei o atleta criado: ${JSON.stringify(meuCadastro).slice(0, 400)}`);
  conferir(Boolean(atletaId), 'a conclusão automática criou o atleta');

  // A chave chegou ao cadastro? É o que `Athlete.photoKey` documenta.
  const semSessao = await fetch(`${BASE_API}/media/athletes/${atletaId}/photo`);
  conferir(semSessao.status === 200, `a foto do atleta responde ao ANÔNIMO (veio ${semSessao.status})`);
  conferir((semSessao.headers.get('content-type') || '').startsWith('image/'),
    `e devolve imagem (${semSessao.headers.get('content-type')})`);
  // A foto do PEDIDO continua fechada — é documento de conferência.
  const fotoDoPedido = await fetch(`${BASE_API}/media/athlete-requests/${pedido.dado.id}/photo`);
  conferir(fotoDoPedido.status === 401, `a foto do PEDIDO segue exigindo sessão (veio ${fotoDoPedido.status})`);

  // ---- DUAS ETAPAS IMPORTADAS, publicadas -------------------------------
  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
  const etapas = [
    { nome: 'Ipiranga Classic', dia: '2026-06-20T12:00:00.000Z', prefixo: 'IPIRANGA' },
    { nome: 'Razor Championship', dia: '2026-10-03T12:00:00.000Z', prefixo: 'RAZOR' }
  ];
  const slugs = [];
  for (const etapa of etapas) {
    const evento = exigir(await chamar('POST', '/events', {
      organizationId: org.id, name: etapa.nome, slug: `${etapa.prefixo.toLowerCase()}-${marca}`,
      startDate: etapa.dia, seasonId: temporada.id
    }), `evento ${etapa.nome}`);
    exigir(await chamar('POST', `/events/${evento.id}/transition`, { status: 'PLANNED' }), 'PLANNED');
    slugs.push(evento.slug);
    const linha = `${etapa.prefixo}-2932-MBB,,Lucas Gouveia,NPC,2932,MENS_BODYBUILDING,OPEN,1,,${etapa.nome},`;
    const lote = exigir(await chamar('POST', '/musclewar/imports', {
      organizationId: org.id, seasonId: temporada.id, eventId: evento.id,
      sourceType: 'CSV', sourceRef: `${etapa.prefixo.toLowerCase()}-qa.csv`,
      content: `${CABECALHO}\n${linha}`
    }), `importação ${etapa.nome}`);
    exigir(await chamar('POST', `/musclewar/imports/${lote.import?.id ?? lote.id}/apply`), `aplicar ${etapa.nome}`);
  }

  // ---- N2: UMA ETAPA COM RESULTADO EM RASCUNHO, na MESMA federação ------
  console.log('montando a etapa de resultado NÃO publicado…');
  const rascunho = exigir(await chamar('POST', '/events', {
    organizationId: org.id, name: 'Etapa Em Revisão', slug: `revisao-${marca}`,
    startDate: '2026-11-20T12:00:00.000Z', seasonId: temporada.id
  }), 'evento em revisão');
  const categorias = exigir(await chamar('GET', '/categories?limit=200'), 'catálogo');
  const bikini = (categorias.items ?? categorias).find(c => c.code === 'BIKINI');
  const ec = exigir(await chamar('POST', `/events/${rascunho.id}/categories`, { categoryId: bikini.id }), 'categoria do evento');
  const divisao = exigir(await chamar('POST', `/event-categories/${ec.id}/divisions`, { name: 'Até 163cm', code: 'ATE163' }), 'divisão');
  const classe = exigir(await chamar('POST', `/divisions/${divisao.id}/classes`, { name: 'Open', code: 'OPEN' }), 'classe');
  for (const estado of ['PLANNED', 'REGISTRATIONS_OPEN']) {
    exigir(await chamar('POST', `/events/${rascunho.id}/transition`, { status: estado }), `transição ${estado}`);
  }
  const inscricao = exigir(await chamar('POST', `/events/${rascunho.id}/registrations`, {
    cpf: cpfDeSemente(760000099), athlete: { fullName: 'Atleta Do Rascunho', sex: 'FEMALE' }, classIds: [classe.id]
  }), 'inscrição no rascunho');
  for (const estado of ['REGISTRATIONS_CLOSED', 'IN_OPERATION']) {
    exigir(await chamar('POST', `/events/${rascunho.id}/transition`, { status: estado }), `transição ${estado}`);
  }
  exigir(await chamar('POST', `/registrations/${inscricao.registration.id}/checkin`, {}), 'check-in');
  exigir(await chamar('POST', `/events/${rascunho.id}/transition`, { status: 'IN_JUDGING' }), 'IN_JUDGING');
  // LANÇADO E NÃO PUBLICADO: é exatamente o estado que o anônimo não pode ver.
  exigir(await chamar('POST', `/classes/${classe.id}/result`, {
    entries: [{ athleteId: inscricao.registration.athlete.id, placing: 1 }]
  }), 'resultado em rascunho');
  const nomeNoRascunho = 'Atleta Do Rascunho';

  // ---- N3: a federação VIZINHA, com a própria etapa, sem publicar ------
  const eventoB = exigir(await chamar('POST', '/events', {
    organizationId: orgB.id, name: 'Etapa Da Vizinha', slug: `vizinha-${marca}`,
    startDate: '2026-12-05T12:00:00.000Z'
  }), 'evento da vizinha');
  exigir(await chamar('POST', `/events/${eventoB.id}/transition`, { status: 'PLANNED' }), 'PLANNED da vizinha');

  // ---- O SERVIDOR, ANTES DA TELA ---------------------------------------
  const daApi = await fetch(`${BASE_API}/public/athletes/${atletaId}`).then(r => r.json());
  conferir(daApi.results?.length === 2, `servidor: a ficha anônima traz 2 resultados (veio ${daApi.results?.length})`);
  conferir(daApi.athlete?.hasPhoto === true, 'servidor: a ficha marca hasPhoto');
  conferir(!JSON.stringify(daApi).includes('photoKey'), 'servidor: a chave do armazenamento NÃO sai no corpo');
  conferir(!JSON.stringify(daApi).includes(TELEFONE), 'servidor: o telefone NÃO sai no corpo');
  conferir(!JSON.stringify(daApi).includes(cpfDeSemente(293293293)), 'servidor: o CPF NÃO sai no corpo');

  // ------------------------------------------------------------- frontend
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  // ------------------------------------------------------------- navegador
  console.log('abrindo o Chromium — PASSO 1: contexto novo, sem sessão…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });

  // CONTEXTO NOVO É A JANELA ANÔNIMA: armazenamento próprio, vazio, descartado
  // no fim. Não há cookie, não há localStorage, não há token de execução
  // anterior — é a única forma de afirmar "sem login" sobre o navegador.
  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 } });
  const pagina = await contexto.newPage();

  const erros = [];
  const falhasExternas = [];
  const recusas = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');

  // 404 ESPERADO NÃO É DEFEITO, e separá-lo exige saber QUAL rota respondeu.
  //
  // O caso N1 pede de propósito um atleta que não existe, e o navegador grava
  // "Failed to load resource: 404" no console — texto sem URL. Contar isso como
  // erro da aplicação reprovaria o arreio justamente por ele ter medido o que
  // foi mandado medir. Então as respostas 4xx são coletadas COM a rota, e as
  // esperadas saem da conta por lista explícita.
  const RECUSA_ESPERADA = [
    /\/public\/athletes\/cmnaoexiste/i,   // N1: id inexistente
    /\/classes\/[^/]+\/result$/i,         // N2: resultado em rascunho
    /\/media\/athletes\/[^/]+\/photo$/i  // atleta sem foto na lista pública
  ];
  pagina.on('response', r => {
    if (r.status() < 400 || !daAplicacao(r.url())) return;
    const caminho = r.url().replace(/^https?:\/\/[^/]+/, '');
    if (RECUSA_ESPERADA.some(padrao => padrao.test(caminho))) { recusas.push(`${r.status()} ${caminho}`); return; }
    erros.push(`HTTP ${r.status()} em ${caminho}`);
  });
  pagina.on('console', m => {
    // O texto do console para falha de rede não traz URL; a recusa já foi
    // classificada pelo ouvinte de `response` acima, com a rota em mãos.
    if (m.type() !== 'error') return;
    if (/Failed to load resource/i.test(m.text())) return;
    if (daAplicacao(m.location()?.url)) erros.push(m.text());
  });
  pagina.on('pageerror', e => erros.push(String(e)));
  pagina.on('requestfailed', r => {
    const registro = `${r.url()} — ${r.failure()?.errorText ?? '?'}`;
    (daAplicacao(r.url()) ? erros : falhasExternas).push(registro);
  });

  const print = async nome => pagina.screenshot({ path: `${SAIDA}/${nome}.png`, fullPage: false });

  // A ABERTURA DA MARCA roda uma vez por sessão do navegador e vem ANTES de
  // qualquer rota. Ela não é o objeto da medição e não se pode medir a vitrine
  // por cima dela, então é dispensada pelo caminho que ela própria oferece —
  // Escape —, e não injetando a marca de "já vista" no armazenamento.
  //
  // Dispensá-la é também o que separa os dois botões de MESMO RÓTULO: o
  // "Entrar agora" da abertura e o da barra lateral. Com a abertura fora da
  // tela, qualquer "Entrar agora" que apareça depois é o da barra.
  const dispensarAbertura = async () => {
    for (let i = 0; i < 3; i += 1) {
      const html = await pagina.content();
      if (!/experiência sonora|experiencia sonora|sound experience/i.test(html)) return;
      await pagina.keyboard.press('Escape');
      await esperar(1200);
    }
  };

  await pagina.goto(BASE_WEB, { waitUntil: 'networkidle' });
  await esperar(1500);
  await dispensarAbertura();

  // PASSO 2 — nenhum login. O que se confere é que NÃO HÁ TOKEN: a marca de
  // "abertura já vista" fica em `sessionStorage` e não é sessão de ninguém.
  const semToken = await pagina.evaluate(() => {
    const procurar = deposito => {
      try { return Object.keys(deposito).some(k => /token|auth|sess[aã]o/i.test(k)); } catch { return false; }
    };
    return !procurar(window.localStorage);
  });
  conferir(semToken, 'PASSO 2: nenhum token de sessão no armazenamento do navegador');

  // PASSO 3 e 4 — a URL pública do atleta, digitada direto.
  await pagina.goto(`${BASE_WEB}/#/atletas/${atletaId}`, { waitUntil: 'networkidle' });
  await esperar(2200);
  await print('1-ficha-anonima');
  const html = await pagina.content();
  const abriu = html.includes('Lucas Gouveia Lima');
  if (!abriu) {
    const visivel = (await pagina.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 500);
    console.log(`  · o que a tela mostrou: "${visivel}"`);
  }
  conferir(abriu, 'PASSOS 3-4: a ficha pública do atleta ABRE sem login');
  conferir(!/type="password"/i.test(html),
    'e a tela de ENTRADA não tomou o lugar da ficha');

  // PASSO 5 — A FOTO. Não basta existir `<img>`: ela tem de ter DECODIFICADO.
  // O `Avatar` cai no monograma de iniciais quando a busca falha, e o
  // monograma é um `<div>` com texto — indistinguível de "sem foto" se a
  // conferência olhar só o DOM.
  const fotoCarregada = await pagina.evaluate(() => {
    const imagens = [...document.querySelectorAll('img')];
    return imagens.some(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  });
  conferir(fotoCarregada, 'PASSO 5: a FOTO do atleta aparece, decodificada (não é o monograma)');

  // PASSO 6 — o histórico, com as duas etapas.
  conferir(html.includes('Ipiranga Classic'), 'PASSO 6: o histórico mostra a etapa Ipiranga Classic');
  conferir(html.includes('Razor Championship'), 'PASSO 6: o histórico mostra a etapa Razor Championship');

  // PASSO 7 — os resultados publicados, e o cartão contando 2.
  const blocos = await pagina.locator('.metric, .card, .grid-4 > *').allInnerTexts();
  const cartao = blocos.find(t => /resultados publicados/i.test(t)) ?? '';
  conferir(/\b2\b/.test(cartao),
    `PASSO 7: o cartão RESULTADOS PUBLICADOS conta 2 (leu: ${cartao.replace(/\s+/g, ' ').trim().slice(0, 70)})`);
  conferir(!/ainda sem resultados|sem resultados publicados/i.test(html),
    'e a frase "ainda sem resultados publicados" não aparece');

  // PASSO 8 — clica num resultado.
  const verEtapa = pagina.getByRole('button', { name: /Ver a etapa/i });
  const clicaveis = await verEtapa.count();
  conferir(clicaveis === 2, `PASSO 8: as duas linhas são clicáveis sem login (achei ${clicaveis})`);
  if (!clicaveis) { await print('1b-sem-link'); throw new Error('nenhuma linha do histórico é clicável para o anônimo'); }
  await verEtapa.first().click();
  await esperar(2200);
  await print('2-etapa-anonima');

  // PASSOS 9 e 10 — a página pública da etapa abriu, com os dados.
  const naEtapa = await pagina.content();
  conferir(/Ipiranga Classic|Razor Championship/.test(naEtapa),
    'PASSO 9: a página pública da etapa ABRIU sem login');
  conferir(pagina.url().includes('campeonatos/'),
    `e a URL é a da etapa (${pagina.url().split('#')[1] ?? ''})`);
  conferir(naEtapa.includes('Lucas Gouveia Lima') || /Lucas/.test(naEtapa),
    'PASSO 10: os dados da etapa aparecem (o atleta está no resultado)');

  // PASSO 11 — NENHUM DADO PRIVADO, nas duas telas.
  const CPF_DO_ATLETA = cpfDeSemente(293293293);
  const PRIVADOS = [
    [CPF_DO_ATLETA, 'o CPF em dígitos'],
    [`${CPF_DO_ATLETA.slice(0, 3)}.${CPF_DO_ATLETA.slice(3, 6)}.${CPF_DO_ATLETA.slice(6, 9)}-${CPF_DO_ATLETA.slice(9)}`, 'o CPF formatado'],
    [TELEFONE, 'o telefone'],
    [EMAIL_DO_ATLETA, 'o e-mail reservado'],
    [emailDaConta, 'o e-mail da conta'],
    ['Rua Reservada', 'o logradouro'],
    ['78000123', 'o CEP'],
    ['photoKey', 'o nome do campo de chave de armazenamento'],
    ['athlete-requests/', 'o prefixo do objeto no bucket']
  ];
  for (const tela of [
    [`${BASE_WEB}/#/atletas/${atletaId}`, 'a ficha do atleta'],
    [`${BASE_WEB}/#/campeonatos/${slugs[1]}`, 'a página da etapa'],
    [`${BASE_WEB}/#/ranking`, 'o ranking'],
    [`${BASE_WEB}/#/atletas`, 'a lista de atletas']
  ]) {
    await pagina.goto(tela[0], { waitUntil: 'networkidle' });
    await esperar(1600);
    const corpo = await pagina.content();
    for (const [valor, oque] of PRIVADOS) {
      conferir(!corpo.includes(valor), `PASSO 11: ${tela[1]} não mostra ${oque}`);
    }
  }
  await print('3-sem-dado-privado');

  // ============================== CASOS NEGATIVOS =========================
  console.log('casos negativos…');

  // N1 — URL pública inexistente.
  await pagina.goto(`${BASE_WEB}/#/atletas/cmnaoexisteestaidnenhum00`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await print('4-n1-inexistente');
  const n1 = await pagina.content();
  const n1Visivel = (await pagina.locator('body').innerText()).replace(/\s+/g, ' ');
  conferir(n1Visivel.trim().length > 0, 'N1: a tela não ficou BRANCA para id inexistente');
  conferir(!/PrismaClient|at Object\.|\.js:\d+:\d+/.test(n1),
    'N1: e não vaza stack trace nem nome de cliente de banco');
  conferir(!n1.includes('Lucas Gouveia Lima'), 'N1: e não mostra o atleta de outro id');

  // N2 — resultado NÃO publicado, na mesma federação.
  await pagina.goto(`${BASE_WEB}/#/campeonatos/${rascunho.slug}`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await print('5-n2-rascunho');
  const n2 = await pagina.content();
  conferir(!n2.includes(nomeNoRascunho),
    `N2: o resultado NÃO publicado é invisível ao anônimo (procurei "${nomeNoRascunho}")`);
  // E a API concorda — para separar "a tela não desenhou" de "o servidor não deu".
  const rascunhoDaApi = await fetch(`${BASE_API}/classes/${classe.id}/result`);
  conferir(rascunhoDaApi.status === 404 || !(await rascunhoDaApi.clone().text()).includes(nomeNoRascunho),
    `N2: e a API também não entrega o rascunho ao anônimo (veio ${rascunhoDaApi.status})`);

  // N3 — etapa da federação VIZINHA: a página abre (etapa é pública), e o que
  // ela NÃO pode trazer é resultado que ninguém publicou.
  await pagina.goto(`${BASE_WEB}/#/campeonatos/${eventoB.slug}`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await print('6-n3-vizinha');
  const n3 = await pagina.content();
  conferir(!n3.includes(nomeNoRascunho) && !n3.includes('Lucas Gouveia Lima'),
    'N3: a etapa da federação vizinha não carrega atleta de outra federação');

  // N4 — rota administrativa sem login.
  const ADMIN = ['admin', 'admin/solicitacoes', 'admin/atletas', 'admin/importacoes', 'admin/resultados'];
  for (const rota of ADMIN) {
    await pagina.goto(`${BASE_WEB}/#/${rota}`, { waitUntil: 'networkidle' });
    await esperar(1400);
    const corpo = await pagina.content();
    const caiuNaEntrada = /type="password"/i.test(corpo);
    conferir(caiuNaEntrada, `N4: #/${rota} sem login cai na tela de ENTRADA`);
    // E o conteúdo administrativo não chegou junto: nem a fila, nem o nome.
    conferir(!/Corrigir filiação|Fila de solicitações|Importações/i.test(corpo),
      `N4: e nenhum conteúdo administrativo de #/${rota} foi desenhado`);
  }
  await print('7-n4-admin');

  // E o menu lateral não oferece o que o anônimo não pode abrir.
  await pagina.goto(`${BASE_WEB}/#/inicio`, { waitUntil: 'networkidle' });
  await esperar(1600);
  await dispensarAbertura();
  await print('8-menu-anonimo');
  const navegacao = pagina.locator('nav').first();
  const menu = await navegacao.innerText();
  for (const fechado of ['Meu painel', 'Meu cadastro', 'Messenger', 'Minha filiação', 'Painel', 'Auditoria']) {
    conferir(!menu.includes(fechado), `o menu do anônimo não oferece "${fechado}"`);
  }
  for (const aberto of ['Início', 'Campeonatos', 'Atletas', 'Ranking']) {
    conferir(menu.includes(aberto), `o menu do anônimo oferece "${aberto}"`);
  }

  // A PORTA DE ENTRADA TEM DE LEVAR AO FORMULÁRIO, e não de volta à vitrine.
  // Ela chamava `setAbertura(true)`: reexibia a abertura da marca e terminava
  // devolvendo a mesma tela. O visitante via um convite que não abria nada.
  const convite = navegacao.getByRole('button', { name: /Entrar agora/i });
  conferir(await convite.count() === 1, 'o anônimo vê o convite "Entrar agora" na barra lateral');
  await convite.first().click();
  await esperar(1800);
  await print('8b-entrada');
  const naEntrada = await pagina.content();
  conferir(/type="password"/i.test(naEntrada), 'o convite "Entrar agora" ABRE o formulário de entrada');
  // E a saída existe: quem desiste volta para a vitrine que estava lendo.
  const voltar = pagina.getByRole('button', { name: /Voltar à vitrine|Back to the showcase/i });
  conferir(await voltar.count() === 1, 'e a entrada oferece "Voltar à vitrine"');
  if (await voltar.count()) {
    await voltar.first().click();
    await esperar(1500);
    conferir(!/type="password"/i.test(await pagina.content()), 'e o retorno devolve a vitrine');
  }

  // CELULAR — 390px, o aparelho mais estreito que o produto atende.
  await pagina.setViewportSize({ width: 390, height: 844 });
  await pagina.goto(`${BASE_WEB}/#/atletas/${atletaId}`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await dispensarAbertura();
  await print('9-celular');
  const rolagem = await pagina.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  conferir(rolagem <= 2, `em 390px não há rolagem horizontal (sobra de ${rolagem}px)`);
  conferir((await pagina.content()).includes('Razor Championship'), 'e o histórico continua legível no celular');
  const fotoNoCelular = await pagina.evaluate(() =>
    [...document.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0));
  conferir(fotoNoCelular, 'e a foto continua aparecendo no celular');

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 6).join(' | ').slice(0, 800));
  if (recusas.length) {
    console.log(`  · ${recusas.length} recusa(s) ESPERADA(S), dos casos negativos:`);
    console.log('   ', [...new Set(recusas)].slice(0, 6).join(' | ').slice(0, 400));
  }
  if (falhasExternas.length) {
    console.log(`  · ${falhasExternas.length} falha(s) de recurso EXTERNO, do ambiente desta máquina:`);
    console.log('   ', falhasExternas.slice(0, 2).join(' | ').slice(0, 300));
  }

  await navegador.close();

  // O relatório vai para arquivo também: o log do terminal se perde.
  writeFileSync(`${SAIDA}/relatorio.txt`, [
    `atleta: ${atletaId}`,
    `etapas: ${slugs.join(', ')}`,
    `conferências com falha: ${falhas.length}`,
    ...falhas.map(f => `  - ${f}`)
  ].join('\n'));

  console.log(`\n  prints em ${SAIDA}/`);
  if (falhas.length) {
    console.error(`\n  FALHOU em ${falhas.length}:\n   - ${falhas.join('\n   - ')}\n`);
    encerrar();
    process.exit(1);
  }
  console.log('\n  QA ANÔNIMO: todas as conferências passaram.\n');
  encerrar();
  process.exit(0);
}

principal().catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); encerrar(); process.exit(1); });
