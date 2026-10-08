#!/usr/bin/env node
// ============================================================================
// O CATÁLOGO DE PATROCINADORES OFICIAIS, NUM NAVEGADOR DE VERDADE.
//
// POR QUE ESTE ARREIO EXISTE
//
// Teste de componente prova o DOM com um duplo da API; teste de backend prova
// a API sem tela. O que nenhum dos dois alcança é o CICLO: o super admin abre
// Configurações, envia um arquivo pelo seletor do sistema, salva, e a marca
// aparece na vitrine pública — que é outra tela, de outra sessão.
//
// E há uma coisa que SÓ aqui se prova: o clique no botão de salvar com um
// arquivo escolhido. No jsdom o `required` de um campo de arquivo olha
// `value`, que `userEvent.upload` não preenche, e o formulário fica inválido
// por limitação do ambiente. No navegador, escolher o arquivo preenche os
// dois.
//
// O QUE ELE PERCORRE, na ordem do pedido:
//
//   1. entra como SUPER_ADMIN
//   2. abre Configurações → Patrocinadores
//   3. vê o catálogo das 15 marcas provisionadas, agrupado por nível
//   4. adiciona um patrocinador de teste, com upload real
//   5. confere que ele aparece na vitrine pública, ANÔNIMA
//   6. muda o nível e a ordem, e confere a vitrine de novo
//   7. desativa, e confere que SUMIU do público
//   8. reativa, e confere que VOLTOU
//   9. troca a logo, e confere que a nova é servida
//  10. remove o patrocinador de teste — não deixa lixo
//  11. confere a hierarquia de tamanho na tela, em pixels
//  12. confere a tela de administração no celular
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/patrocinadores-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
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

const PORTA_API = Number(arg('porta-api', 4855));
const PORTA_WEB = Number(arg('porta-web', 5855));
const SAIDA = arg('saida', 'qa-patrocinadores');
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
const EMAIL = 'qa.patrocinio.admin@mci.local';
const NOME_DE_TESTE = 'Patrocinador De Verificacao QA';

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

const falhas = [];
const conferir = (condicao, oque) => {
  console.log(`  ${condicao ? '✓' : '✗'} ${oque}`);
  if (!condicao) falhas.push(oque);
};

// --- PNGs reais, de cores distintas, para dar para distinguir a troca ------
const crc32 = b => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const pedaco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
function png(lado, [r, g, b]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = [];
  for (let y = 0; y < lado; y += 1) {
    const linha = Buffer.alloc(lado * 3);
    for (let x = 0; x < lado; x += 1) { linha[x * 3] = r; linha[x * 3 + 1] = g; linha[x * 3 + 2] = b; }
    linhas.push(Buffer.concat([Buffer.from([0]), linha]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))
  ]);
}

/** A vitrine, lida SEM sessão — é o que o visitante recebe. */
const vitrine = () => fetch(`${BASE_API}/public/sponsors`).then(r => r.json()).then(c => c.items || []);
const naVitrine = async nome => (await vitrine()).some(p => p.name === nome);

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const arteA = join(SAIDA, 'arte-a.png');
  const arteB = join(SAIDA, 'arte-b.png');
  writeFileSync(arteA, png(24, [220, 40, 60]));
  writeFileSync(arteB, png(24, [40, 160, 220]));

  console.log('subindo a API…');
  const pastaDeArquivos = `./uploads-qa-patrocinio-${Date.now()}`;
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1',
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-patrocinadores-segredo-suficientemente-longo-001',
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

  // ------------------------------------------------- cenário: as 15 marcas
  console.log('provisionando as 15 marcas, como o deploy faz…');
  // A CONTA DE QA PRECISA DE SENHA CONHECIDA — E A PRIMEIRA VERSÃO DISTO
  // ENGOLIA A FALHA.
  //
  // `criar-admin.js` cria o PRIMEIRO administrador e recusa rodar quando já
  // existe um. Ele deve recusar: conceder o papel é operação de administração,
  // com registro de quem concedeu, e não script de terminal. O efeito aqui era
  // outro — na SEGUNDA execução deste roteiro contra o mesmo banco a senha que
  // valia era a da primeira, e o login respondia 401. O `catch` imprimia
  // "administrador já existia" e seguia adiante, então a falha só aparecia 30
  // segundos depois, como uma aba que "não existe" em Configurações.
  //
  // Quando o bootstrap recusa, a senha é redefinida por aqui. É banco de
  // verificação, a conta é deste roteiro, e só o hash da senha é escrito: o
  // papel e a situação são CONFERIDOS, não concedidos.
  try {
    execSync(`node scripts/criar-admin.js "QA Patrocinio" ${EMAIL}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch {
    const requerer = createRequire(import.meta.url);
    const bcrypt = requerer('bcryptjs');
    const prisma = requerer('../../src/config/prisma');
    const { withUserContext } = requerer('../../src/config/rlsSession');

    const conta = await prisma.user.findUnique({
      where: { email: EMAIL }, select: { id: true, role: true, status: true }
    });
    if (!conta) {
      await prisma.$disconnect();
      throw new Error(`o bootstrap recusou criar e a conta ${EMAIL} não existe neste banco`);
    }
    if (conta.role !== 'SUPER_ADMIN' || conta.status !== 'ACTIVE') {
      await prisma.$disconnect();
      throw new Error(`a conta ${EMAIL} está ${conta.role}/${conta.status} — este roteiro precisa de SUPER_ADMIN ativo`);
    }

    const passwordHash = await bcrypt.hash(SENHA, 10);
    await withUserContext(conta.id, tx => tx.user.update({ where: { id: conta.id }, data: { passwordHash } }));
    await prisma.$disconnect();
    console.log('  (a conta de QA já existia — senha redefinida para esta execução)');
  }

  execSync('node scripts/provisionar-patrocinadores-oficiais.js', {
    stdio: 'pipe',
    env: { ...env, DATABASE_URL: BANCO, STORAGE_DIR: pastaDeArquivos, PROVISIONAR_ADMIN_EMAIL: EMAIL }
  });

  const migradas = await vitrine();
  conferir(migradas.length === 15, `as 15 marcas migradas estão na vitrine pública (achei ${migradas.length})`);
  conferir(migradas[0]?.level === 'GLOBAL' && migradas.at(-1)?.level === 'SILVER',
    `a vitrine vem na ordem da hierarquia (${migradas[0]?.level} … ${migradas.at(-1)?.level})`);
  conferir(!JSON.stringify(migradas).includes('logoKey'), 'a chave do armazenamento NÃO sai no corpo');

  // ------------------------------------------------------------- frontend
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  console.log('abrindo o Chromium…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 950 } });
  const pagina = await contexto.newPage();

  const erros = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');
  pagina.on('response', r => {
    if (r.status() < 400 || !daAplicacao(r.url())) return;
    erros.push(`HTTP ${r.status()} em ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  pagina.on('pageerror', e => erros.push(String(e)));

  const print = async nome => pagina.screenshot({ path: `${SAIDA}/${nome}.png`, fullPage: false });

  // ------------------------------------- 1 e 2. entrar e abrir a aba
  console.log('1-2. entrando como SUPER_ADMIN e abrindo Configurações…');
  await entrar(pagina, BASE_WEB, { email: EMAIL, senha: SENHA });
  await pagina.goto(`${BASE_WEB}/#/admin/configuracoes`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await dispensarAbertura(pagina);

  // DIAGNÓSTICO ANTES DA PRIMEIRA CONFERÊNCIA DE TELA. Sem isto, "a aba não
  // apareceu" chega como um timeout de 30s e nada mais — e a causa (tela que
  // nem montou, requisição em 500, erro de runtime) fica invisível.
  await print('0-configuracoes');
  const abas = await pagina.evaluate(() =>
    [...document.querySelectorAll('.chip')].map(c => c.textContent.trim()));
  if (erros.length) console.log(`  erros de página até aqui:\n   ${erros.join('\n   ')}`);

  const aba = pagina.getByRole('button', { name: /^Patrocinadores$/ });
  conferir(await aba.count() === 1,
    `a aba "Patrocinadores" existe em Configurações (abas na tela: ${abas.join(' | ') || '(nenhuma)'})`);
  await aba.first().click();
  await esperar(2000);
  await print('1-catalogo');

  // ------------------------------------------- 3. o catálogo agrupado
  const grupos = await pagina.evaluate(() =>
    [...document.querySelectorAll('.panel-head h2')].map(h => h.textContent.trim()));
  conferir(
    JSON.stringify(grupos) === JSON.stringify(['Global', 'Diamante', 'Gold', 'Silver — apoio e parceiros']),
    `os quatro níveis, na ordem da hierarquia (${grupos.join(' | ')})`
  );
  const linhas = await pagina.locator('.patro-linha').count();
  conferir(linhas === 15, `as 15 marcas aparecem no painel (achei ${linhas})`);

  // Espera as artes chegarem antes de afirmar que elas não chegaram: elas
  // entram em prioridade baixa, atrás do conteúdo da tela.
  await pagina.waitForFunction(
    () => [...document.querySelectorAll('.patro-linha .patro-previa img')].every(i => i.complete),
    null, { timeout: 15000 }
  ).catch(() => {});
  const previas = await pagina.evaluate(() => {
    const imagens = [...document.querySelectorAll('.patro-linha .patro-previa img')];
    return {
      total: imagens.length,
      ok: imagens.filter(i => i.complete && i.naturalWidth > 0).length,
      exemplo: imagens[0]?.getAttribute('src') ?? '(nenhuma)'
    };
  });
  conferir(previas.ok === 15,
    `as 15 prévias DECODIFICARAM de verdade (achei ${previas.ok} de ${previas.total}; ex.: ${previas.exemplo})`);

  // -------------------------------------------- 4. adicionar, com upload
  console.log('4. adicionando um patrocinador, com upload real…');
  await pagina.getByRole('button', { name: /Adicionar patrocinador/i }).click();
  await esperar(900);
  await pagina.getByRole('dialog').locator('input[type="text"]').first().fill(NOME_DE_TESTE);
  await pagina.getByRole('dialog').locator('select').selectOption('SILVER');
  await pagina.getByRole('dialog').locator('input[type="file"]').setInputFiles(arteA);
  await esperar(600);

  const temPrevia = await pagina.evaluate(() => {
    const no = document.querySelector('[role="dialog"] .patro-previa img');
    return Boolean(no) && no.getAttribute('src').startsWith('blob:');
  });
  conferir(temPrevia, 'a prévia da logo escolhida aparece ANTES de salvar, sem subir nada');
  await print('2-adicionar');

  // O CLIQUE NO BOTÃO — o que o jsdom não alcança.
  await pagina.getByRole('dialog').getByRole('button', { name: /Salvar patrocinador/i }).click();
  await esperar(2500);

  conferir(await naVitrine(NOME_DE_TESTE), 'o patrocinador novo aparece na VITRINE PÚBLICA, sem sessão');
  const criado = (await vitrine()).find(p => p.name === NOME_DE_TESTE);
  conferir(criado?.level === 'SILVER', `e no nível escolhido (${criado?.level})`);
  conferir(criado?.hasLogo === true, 'e com logo');

  const logo = await fetch(`${BASE_API}/media/sponsors/${criado.id}/logo`);
  conferir(logo.status === 200 && (logo.headers.get('content-type') || '').startsWith('image/'),
    `a logo é servida ao anônimo (${logo.status} ${logo.headers.get('content-type')})`);

  // ----------------------------------------- 6. mudar o nível e a ordem
  console.log('6. mudando nível e ordem…');
  const linhaDoTeste = pagina.locator('.patro-linha', { hasText: NOME_DE_TESTE });
  await linhaDoTeste.getByRole('button', { name: /Editar/i }).click();
  await esperar(900);
  await pagina.getByRole('dialog').locator('select').selectOption('GLOBAL');
  await pagina.getByRole('dialog').locator('input[type="number"]').fill('0');
  await pagina.getByRole('dialog').getByRole('button', { name: /^Salvar$/ }).click();
  await esperar(2200);

  const depoisDaTroca = await vitrine();
  const posicao = depoisDaTroca.findIndex(p => p.name === NOME_DE_TESTE);
  conferir(depoisDaTroca[posicao]?.level === 'GLOBAL', 'o nível mudou para GLOBAL');
  conferir(depoisDaTroca.slice(0, 6).some(p => p.name === NOME_DE_TESTE),
    `e ele subiu para o topo da vitrine (posição ${posicao + 1} de ${depoisDaTroca.length})`);

  // ------------------------------------------- 7 e 8. desativar e reativar
  console.log('7-8. desativando e reativando…');
  await linhaDoTeste.getByRole('button', { name: /Desativar/i }).click();
  await esperar(900);
  const avisa = await pagina.getByRole('dialog').textContent();
  conferir(/permanecerá no catálogo/i.test(avisa), 'a confirmação explica que o registro é preservado');
  await print('3-confirmar-desativar');
  await pagina.getByRole('dialog').getByRole('button', { name: /^Desativar$/ }).click();
  await esperar(2200);

  conferir(!(await naVitrine(NOME_DE_TESTE)), 'desativado, ele SUMIU da vitrine pública');
  const logoInativa = await fetch(`${BASE_API}/media/sponsors/${criado.id}/logo`);
  conferir(logoInativa.status === 404, `e a logo dele também (${logoInativa.status})`);
  conferir(await pagina.locator('.patro-linha', { hasText: NOME_DE_TESTE }).count() === 1,
    'mas ele CONTINUA no painel administrativo, para ser reativado');

  await pagina.locator('.patro-linha', { hasText: NOME_DE_TESTE })
    .getByRole('button', { name: /Reativar/i }).click();
  await esperar(2200);
  conferir(await naVitrine(NOME_DE_TESTE), 'reativado, ele VOLTOU para a vitrine');

  // ------------------------------------------------- 9. trocar a logo
  console.log('9. trocando a logo…');
  const antesDaTroca = await (await fetch(`${BASE_API}/media/sponsors/${criado.id}/logo`)).arrayBuffer();
  await pagina.locator('.patro-linha', { hasText: NOME_DE_TESTE })
    .getByRole('button', { name: /Editar/i }).click();
  await esperar(900);
  conferir(await pagina.getByRole('dialog').locator('.patro-previa img').count() >= 1,
    'a tela de edição mostra a LOGO ATUAL');
  await pagina.getByRole('dialog').locator('input[type="file"]').setInputFiles(arteB);
  await esperar(500);
  await pagina.getByRole('dialog').getByRole('button', { name: /^Salvar$/ }).click();
  await esperar(2500);

  const depoisDoTroca = await (await fetch(`${BASE_API}/media/sponsors/${criado.id}/logo`)).arrayBuffer();
  conferir(Buffer.compare(Buffer.from(antesDaTroca), Buffer.from(depoisDoTroca)) !== 0,
    'a logo servida MUDOU — os bytes são outros');
  conferir(depoisDoTroca.byteLength > 0, 'e a nova não veio vazia');

  // ------------------------------- 11. a hierarquia na vitrine, em pixels
  console.log('11. hierarquia de tamanho na vitrine…');
  await pagina.goto(`${BASE_WEB}/#/ranking`, { waitUntil: 'networkidle' });
  await esperar(2500);
  await print('4-vitrine-com-catalogo');

  const cotas = await pagina.evaluate(() => {
    const area = nivel => {
      const no = document.querySelector(`.rodape-patro .esteira-grupo:not([aria-hidden]) .patro.t-${nivel}`);
      if (!no) return null;
      const r = no.getBoundingClientRect();
      return Math.round(r.width * r.height);
    };
    return { global: area('global'), diamante: area('diamante'), gold: area('gold'), silver: area('silver') };
  });
  const ordem = ['global', 'diamante', 'gold', 'silver'];
  let decrescente = true;
  for (let i = 1; i < ordem.length; i += 1) {
    if (!(cotas[ordem[i]] < cotas[ordem[i - 1]])) decrescente = false;
  }
  conferir(decrescente, `a hierarquia de tamanho NÃO inverte (${ordem.map(c => `${c} ${cotas[c]}`).join(' > ')})`);

  const naFaixa = await pagina.evaluate(() => {
    const imagens = [...document.querySelectorAll('.rodape-patro img')];
    return {
      anunciadas: imagens.filter(i => i.getAttribute('alt')).length,
      carregadas: imagens.filter(i => i.complete && i.naturalWidth > 0).length,
      total: imagens.length,
      rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  conferir(naFaixa.anunciadas === 16, `a faixa mostra as 16 marcas do catálogo (achei ${naFaixa.anunciadas})`);
  conferir(naFaixa.carregadas === naFaixa.total, `todas as artes decodificaram (${naFaixa.carregadas}/${naFaixa.total})`);
  conferir(naFaixa.rolagem <= 1, `sem rolagem horizontal (sobra ${naFaixa.rolagem}px)`);

  // A TELA DE ENTRADA usa o mesmo catálogo.
  const semSessao = await navegador.newContext({ viewport: { width: 1440, height: 1100 } });
  const paginaAnonima = await semSessao.newPage();
  await paginaAnonima.goto(`${BASE_WEB}/#/meu-painel`, { waitUntil: 'networkidle' });
  await esperar(2200);
  await dispensarAbertura(paginaAnonima);
  await esperar(1500);
  await paginaAnonima.screenshot({ path: `${SAIDA}/5-tela-de-entrada.png` });
  const naEntrada = await paginaAnonima.evaluate(() => ({
    temParede: Boolean(document.querySelector('.parede-patro')),
    faixas: document.querySelectorAll('.parede-patro .faixa-patro').length,
    anunciadas: [...document.querySelectorAll('.parede-patro img')].filter(i => i.getAttribute('alt')).length,
    carregadas: [...document.querySelectorAll('.parede-patro img')].filter(i => i.complete && i.naturalWidth > 0).length
  }));
  conferir(naEntrada.temParede, 'a TELA DE ENTRADA monta a parede a partir do catálogo');
  conferir(naEntrada.faixas === 4, `com as quatro faixas (achei ${naEntrada.faixas})`);
  conferir(naEntrada.anunciadas === 16, `e as 16 marcas (achei ${naEntrada.anunciadas})`);
  conferir(naEntrada.carregadas > 0, 'com as artes decodificando');
  await semSessao.close();

  // -------------------------------------------------- 12. celular do admin
  console.log('12. a tela de administração no celular…');
  await pagina.setViewportSize({ width: 390, height: 844 });
  await pagina.goto(`${BASE_WEB}/#/admin/configuracoes`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await pagina.getByRole('button', { name: /^Patrocinadores$/ }).first().click();
  await esperar(1800);
  await print('6-admin-celular');
  const noCelular = await pagina.evaluate(() => ({
    rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    linhas: document.querySelectorAll('.patro-linha').length
  }));
  conferir(noCelular.rolagem <= 1, `390px: sem rolagem horizontal (sobra ${noCelular.rolagem}px)`);
  conferir(noCelular.linhas === 16, `390px: as 16 linhas continuam legíveis (achei ${noCelular.linhas})`);

  // ------------------------------------------- 10. não deixar lixo de teste
  console.log('10. removendo o patrocinador de verificação…');
  await pagina.setViewportSize({ width: 1440, height: 950 });
  await pagina.goto(`${BASE_WEB}/#/admin/configuracoes`, { waitUntil: 'networkidle' });
  await esperar(1800);
  await pagina.getByRole('button', { name: /^Patrocinadores$/ }).first().click();
  await esperar(1800);
  await pagina.locator('.patro-linha', { hasText: NOME_DE_TESTE })
    .getByRole('button', { name: /Remover/i }).click();
  await esperar(900);
  await pagina.getByRole('dialog').locator('input[type="text"]').first()
    .fill('patrocinador criado pela verificacao automatizada');
  await pagina.getByRole('dialog').getByRole('button', { name: /Remover definitivamente/i }).click();
  await esperar(2500);

  conferir(!(await naVitrine(NOME_DE_TESTE)), 'o patrocinador de teste saiu da vitrine');
  const restantes = await vitrine();
  conferir(restantes.length === 15, `e o catálogo voltou às 15 marcas reais (achei ${restantes.length})`);
  conferir(!restantes.some(p => p.name === NOME_DE_TESTE), 'nenhum lixo de teste ficou para trás');

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 6).join(' | ').slice(0, 800));

  await navegador.close();

  writeFileSync(`${SAIDA}/relatorio.txt`, [
    `marcas migradas: ${migradas.length}`,
    `catálogo ao final: ${restantes.length}`,
    `hierarquia: ${ordem.map(c => `${c}=${cotas[c]}`).join(' ')}`,
    `conferências com falha: ${falhas.length}`,
    ...falhas.map(f => `  - ${f}`)
  ].join('\n'));

  console.log(`\n  prints em ${SAIDA}/`);
  if (falhas.length) {
    console.error(`\n  FALHOU em ${falhas.length}:\n   - ${falhas.join('\n   - ')}\n`);
    encerrar();
    process.exit(1);
  }
  console.log('\n  QA DO CATÁLOGO: todas as conferências passaram.\n');
  encerrar();
  process.exit(0);
}

principal().catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); encerrar(); process.exit(1); });
