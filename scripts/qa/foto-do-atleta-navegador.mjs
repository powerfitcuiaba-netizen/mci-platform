#!/usr/bin/env node
// ============================================================================
// A FOTO DO ATLETA, MEDIDA NO NAVEGADOR.
//
// POR QUE ESTE ROTEIRO EXISTE
//
// O defeito que originou este trabalho era INVISÍVEL para a suíte: o diretório
// público montava o avatar sem `mediaPath`, e nenhum teste de unidade acusa
// uma imagem que simplesmente não foi pedida. A API devolvia `hasPhoto`, os
// testes liam `hasPhoto`, e a tela mostrava monograma. Só o navegador vê a
// diferença entre "o dado chegou" e "a imagem apareceu".
//
// É por isso que a conferência central daqui não é "a resposta traz a foto", e
// sim `naturalWidth > 0` — o pixel decodificado. Foi assim que o
// `Cross-Origin-Resource-Policy` apareceu na parede de patrocinadores, com
// `fetch` respondendo 200 e zero imagens na tela.
//
// O roteiro é NÃO DESTRUTIVO: cria o que usa e apaga o que criou.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/foto-do-atleta-navegador.mjs [--saida /caminho]
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { setTimeout as esperar } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { dispensarAbertura, entrar } from './entrar-na-plataforma.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4866));
const PORTA_WEB = Number(arg('porta-web', 5866));
const SAIDA = arg('saida', 'qa-foto-do-atleta');
const CHROMIUM = env.CHROMIUM_PATH || null;
const SENHA = env.QA_PASSWORD;
const BANCO = env.DATABASE_URL;

if (!SENHA || !BANCO) {
  console.error('\n  Falta QA_PASSWORD e/ou DATABASE_URL no ambiente.\n');
  process.exit(1);
}

const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const BASE_WEB = `http://127.0.0.1:${PORTA_WEB}`;
const EMAIL_ADMIN = 'qa.foto.admin@mci.local';
const NOME_DO_ATLETA = 'Atleta Da Verificacao De Foto';

const processos = [];
const encerrar = () => processos.forEach(p => { try { p.kill('SIGTERM'); } catch { /* já morreu */ } });

let falhas = 0;
const conferir = (condicao, descricao) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${descricao}`);
  if (!condicao) falhas += 1;
};

async function esperarPorta(url, tentativas = 90) {
  for (let i = 0; i < tentativas; i += 1) {
    try { await fetch(url); return true; } catch { await esperar(1000); }
  }
  return false;
}

// PNG de verdade, gerado aqui: cabeçalho, IHDR, IDAT deflatado e IEND com CRC.
// Um PNG "mínimo" de 1×1 não serve — o libvips o recusa, e o serviço normaliza
// a imagem antes de gravar.
function png(lado, [r, g, b]) {
  const crc = (() => {
    const tabela = [...Array(256)].map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    return buffer => {
      let c = 0xFFFFFFFF;
      for (const byte of buffer) c = tabela[(c ^ byte) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
  })();

  const pedaco = (tipo, dados) => {
    const nome = Buffer.from(tipo, 'ascii');
    const tamanho = Buffer.alloc(4);
    tamanho.writeUInt32BE(dados.length);
    const soma = Buffer.alloc(4);
    soma.writeUInt32BE(crc(Buffer.concat([nome, dados])));
    return Buffer.concat([tamanho, nome, dados, soma]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; ihdr[9] = 2;

  const linhas = [];
  for (let y = 0; y < lado; y += 1) {
    const linha = Buffer.alloc(1 + lado * 3);
    for (let x = 0; x < lado; x += 1) {
      linha[1 + x * 3] = r; linha[2 + x * 3] = g; linha[3 + x * 3] = b;
    }
    linhas.push(linha);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))
  ]);
}

const vitrine = termo =>
  fetch(`${BASE_API}/public/athletes?limit=50${termo ? `&search=${encodeURIComponent(termo)}` : ''}`)
    .then(r => r.json()).then(c => c.items || []);

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const arte = join(SAIDA, 'retrato.png');
  writeFileSync(arte, png(64, [210, 60, 70]));

  console.log('subindo a API…');
  const pastaDeArquivos = './uploads-qa-foto-atleta';
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1', LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-foto-do-atleta-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_DIR: pastaDeArquivos,
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

  // ------------------------------------------------- o administrador de QA
  try {
    execSync(`node scripts/criar-admin.js "QA Foto" ${EMAIL_ADMIN}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch {
    // Já existe administrador neste banco — e `criar-admin.js` só cria o
    // primeiro, com razão. A senha da conta de QA é redefinida para esta
    // execução; papel e situação são CONFERIDOS, não concedidos.
    const requerer = createRequire(import.meta.url);
    const bcrypt = requerer('bcryptjs');
    const prisma = requerer('../../src/config/prisma');
    const { withUserContext } = requerer('../../src/config/rlsSession');

    const conta = await prisma.user.findFirst({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }, select: { id: true, email: true }
    });
    if (!conta) { await prisma.$disconnect(); throw new Error('nenhum SUPER_ADMIN ativo neste banco'); }
    const passwordHash = await bcrypt.hash(SENHA, 10);
    await withUserContext(conta.id, tx => tx.user.update({ where: { id: conta.id }, data: { passwordHash } }));
    await prisma.$disconnect();
    console.log(`  (usando o administrador existente: ${conta.email})`);
    process.env.QA_EMAIL_ADMIN = conta.email;
  }
  const emailAdmin = process.env.QA_EMAIL_ADMIN || EMAIL_ADMIN;

  // --------------------------------------------------------------- frontend
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  console.log('abrindo o Chromium…');
  const requerer = createRequire(import.meta.url);
  const { chromium } = requerer('playwright-core');
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 1000 } });
  const pagina = await contexto.newPage();

  const erros = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');
  pagina.on('response', r => {
    if (r.status() < 400 || !daAplicacao(r.url())) return;
    erros.push(`HTTP ${r.status()} em ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  pagina.on('pageerror', e => erros.push(String(e)));
  const print = nome => pagina.screenshot({ path: `${SAIDA}/${nome}.png`, fullPage: false });

  // ================================================= 1. entrar e achar o atleta
  console.log('1. entrando e preparando um atleta de verificação…');
  await entrar(pagina, BASE_WEB, { email: emailAdmin, senha: SENHA });
  await dispensarAbertura(pagina);

  // O atleta é criado pela API, com a sessão do navegador — é o mesmo caminho
  // do operador, e nasce SEM foto, que é o estado que origina o problema.
  const criado = await pagina.evaluate(async ({ base, nome }) => {
    // O TOKEN PODE ESTAR NOS DOIS COFRES. Sem "lembrar de mim" marcado ele vai
    // para `sessionStorage`, e procurar só no `localStorage` devolvia
    // requisição anônima — que responde 401 e parece "banco sem organização".
    const CHAVE = 'mci-auth-token';
    const token = (localStorage.getItem(CHAVE) || sessionStorage.getItem(CHAVE) || '').replace(/^"|"$/g, '');
    const cabecalho = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };

    // O ROTEIRO CRIA A FEDERAÇÃO QUE PRECISA, se não houver nenhuma.
    //
    // Depender de dado pré-semeado é o que fez este arreio falhar duas vezes
    // contra um banco que só tinha o catálogo de patrocinadores — e falhar
    // dizendo "nenhuma organização neste banco", que parece defeito do
    // ambiente de quem lê. Autossuficiente, ele roda contra banco migrado e
    // vazio, que é a condição mais barata de reproduzir.
    const respostaDasOrgs = await fetch(`${base}/organizations`, { headers: cabecalho });
    const orgs = await respostaDasOrgs.json();
    let organizationId = orgs.items?.[0]?.id ?? orgs?.[0]?.id;

    if (!organizationId) {
      const sufixoDaOrg = String(Date.now()).slice(-6);
      const criada = await fetch(`${base}/organizations`, {
        method: 'POST',
        headers: cabecalho,
        body: JSON.stringify({ name: `Federacao QA Foto ${sufixoDaOrg}`, slug: `qa-foto-${sufixoDaOrg}` })
      });
      const corpoDaOrg = await criada.json();
      organizationId = corpoDaOrg?.id;
      if (!organizationId) {
        return { erro: `não consegui criar a federação (HTTP ${criada.status}, token ${token ? 'presente' : 'AUSENTE'}): ${JSON.stringify(corpoDaOrg).slice(0, 200)}` };
      }
    }

    const sufixo = String(Date.now()).slice(-9);
    const resposta = await fetch(`${base}/athletes`, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({
        organizationId, fullName: nome, sex: 'MALE',
        birthDate: '1995-02-10', state: 'MT', city: 'Cuiabá',
        cpf: sufixo.padStart(11, '1')
      })
    });
    return { status: resposta.status, corpo: await resposta.json() };
  }, { base: BASE_API, nome: NOME_DO_ATLETA });

  conferir(criado.status === 201, `o atleta de verificação foi criado (${criado.status ?? criado.erro})`);
  const atletaId = criado.corpo?.id;
  if (!atletaId) throw new Error(`sem id do atleta: ${JSON.stringify(criado).slice(0, 300)}`);

  conferir(criado.corpo.hasPhoto === false, 'ele nasce SEM foto — que é o estado do print');

  // ============================== 2. o diretório ANTES: monograma, não imagem
  console.log('2. o diretório público, antes da foto…');
  await pagina.goto(`${BASE_WEB}/#/atletas`, { waitUntil: 'networkidle' });
  await esperar(2500);
  await print('1-diretorio-sem-foto');

  const antes = await pagina.evaluate(() => {
    const cartoes = [...document.querySelectorAll('.grid-3 .avatar')];
    return { cartoes: cartoes.length, comImagem: cartoes.filter(a => a.querySelector('img')).length };
  });
  conferir(antes.cartoes > 0, `o diretório listou atletas (achei ${antes.cartoes})`);

  // ================================================ 3. a federação envia a foto
  console.log('3. a federação enviando a foto pela ficha do atleta…');
  await pagina.goto(`${BASE_WEB}/#/admin/atletas/${atletaId}`, { waitUntil: 'networkidle' });
  await esperar(2000);
  await pagina.getByRole('button', { name: /^Cadastro$/ }).first().click();
  await esperar(1200);
  await print('2-ficha-sem-foto');

  const avisoDeCobranca = await pagina.getByText(/ainda não tem foto/i).count();
  conferir(avisoDeCobranca > 0, 'a ficha COBRA a foto de quem está sem');

  await pagina.locator('input[type="file"]').first().setInputFiles(arte);
  await esperar(3500);
  await print('3-ficha-com-foto');

  const naFicha = await pagina.evaluate(() => {
    const img = document.querySelector('img.foto-do-atleta');
    return { existe: Boolean(img), decodificou: Boolean(img?.complete && img.naturalWidth > 0) };
  });
  conferir(naFicha.existe, 'a foto enviada aparece na ficha');
  conferir(naFicha.decodificou, 'e DECODIFICOU de verdade — não é um retângulo vazio');

  // ======================================= 4. o diretório DEPOIS: imagem na tela
  console.log('4. o diretório público, depois da foto…');
  const naVitrine = (await vitrine(NOME_DO_ATLETA)).find(a => a.id === atletaId);
  conferir(naVitrine?.hasPhoto === true, 'a vitrine pública passou a dizer que ele tem foto');

  const semSessao = await contexto.browser().newContext({ viewport: { width: 1440, height: 1000 } });
  const anonimo = await semSessao.newPage();
  await anonimo.goto(`${BASE_WEB}/#/atletas`, { waitUntil: 'networkidle' });
  await esperar(1200);
  await anonimo.fill('input[type="search"], input[placeholder*="uscar" i]', NOME_DO_ATLETA).catch(() => {});
  await esperar(3000);
  await anonimo.waitForFunction(
    () => [...document.querySelectorAll('.grid-3 .avatar img')].some(i => i.complete),
    null, { timeout: 15000 }
  ).catch(() => {});
  await anonimo.screenshot({ path: `${SAIDA}/4-diretorio-com-foto.png`, fullPage: false });

  const depois = await anonimo.evaluate(() => {
    const imagens = [...document.querySelectorAll('.grid-3 .avatar img')];
    return {
      total: imagens.length,
      ok: imagens.filter(i => i.complete && i.naturalWidth > 0).length,
      exemplo: imagens[0]?.getAttribute('src') ?? '(nenhuma)'
    };
  });
  conferir(depois.total > 0, `o diretório passou a PEDIR a imagem (achei ${depois.total} <img>)`);
  conferir(depois.total > 0 && depois.ok === depois.total,
    `e todas DECODIFICARAM (${depois.ok} de ${depois.total}; ex.: ${depois.exemplo})`);

  // A MEDIDA QUE IMPORTA: antes não havia <img> nenhuma no diretório, porque a
  // tela nem pedia a foto. É exatamente o defeito do print.
  conferir(depois.total > antes.comImagem,
    `o diretório mostrava ${antes.comImagem} imagem(ns) e passou a mostrar ${depois.total}`);

  await semSessao.close();

  // ================================================ 5. a limpeza do que criei
  console.log('5. removendo o atleta de verificação…');
  const removido = await pagina.evaluate(async ({ base, id }) => {
    const CHAVE = 'mci-auth-token';
    const token = (localStorage.getItem(CHAVE) || sessionStorage.getItem(CHAVE) || '').replace(/^"|"$/g, '');
    const r = await fetch(`${base}/athletes/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    });
    return r.status;
  }, { base: BASE_API, id: atletaId });
  conferir([200, 204].includes(removido), `o atleta de verificação saiu do catálogo (${removido})`);

  const sobrou = (await vitrine(NOME_DO_ATLETA)).some(a => a.id === atletaId);
  conferir(!sobrou, 'nenhum lixo de teste ficou para trás');

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length}${erros.length ? ` — ${erros.join(' | ')}` : ''})`);

  await navegador.close();
  console.log(`\n  prints em ${SAIDA}/\n`);
  if (falhas) {
    console.error(`  FALHOU em ${falhas}.\n`);
    process.exitCode = 1;
  } else {
    console.log('  QA DA FOTO DO ATLETA: todas as conferências passaram.\n');
  }
}

principal()
  .catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); process.exitCode = 1; })
  .finally(encerrar);
