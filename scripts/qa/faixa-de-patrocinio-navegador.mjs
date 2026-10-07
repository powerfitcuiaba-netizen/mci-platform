#!/usr/bin/env node
// ============================================================================
// A FAIXA DE PATROCÍNIO DO RODAPÉ, NUM NAVEGADOR DE VERDADE.
//
// POR QUE ESTE ARREIO EXISTE
//
// Teste de componente prova o DOM: que as marcas estão lá, na ordem certa, com
// os clones fora da árvore de acessibilidade. O que ele não alcança é
// justamente o pedido: que a esteira ANDE, sem salto, sem buraco, sem
// congelar — e que não empurre a largura do documento.
//
// Em jsdom `offsetWidth` é 0, então a esteira nem escolhe uma duração: ela
// fica parada de propósito (há teste disso). A medição só existe com layout
// real. Logo, a afirmação "o movimento é contínuo" SÓ pode ser feita aqui.
//
// O QUE ELE MEDE, e cada um porque já foi um defeito em alguma marquee:
//
//   1. a faixa aparece nas telas da vitrine, e NÃO nas de operação;
//   2. todas as artes do catálogo estão lá e DECODIFICARAM (não é alt quebrado);
//   3. o trilho de fato se move — duas leituras do `transform`, separadas;
//   4. o passo do ciclo é EXATAMENTE a largura de uma cópia (a emenda fecha);
//   5. a esteira cobre a janela com folga: não existe instante com vão;
//   6. a velocidade é a declarada, em pixels por segundo, medida no relógio;
//   7. o hover PARA o movimento, e soltar o mouse retoma;
//   8. o documento NÃO ganha rolagem horizontal, em nenhuma largura;
//   9. nada do conteúdo é coberto: a faixa é irmã do `main`, em fluxo;
//  10. a hierarquia das cotas aparece na tela, medida em pixels, sem inverter;
//  11. `prefers-reduced-motion` desliga a animação e mostra TODAS as marcas.
//
// Uso:
//   DATABASE_URL='...' QA_PASSWORD='...' \
//     node scripts/qa/faixa-de-patrocinio-navegador.mjs \
//       [--playwright playwright-core] [--saida /caminho/para/prints]
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import { dispensarAbertura } from './entrar-na-plataforma.mjs';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4844));
const PORTA_WEB = Number(arg('porta-web', 5844));
const SAIDA = arg('saida', 'qa-faixa-patrocinio');
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
const EMAIL = 'qa.patrocinio@mci.local';

// A VELOCIDADE DECLARADA, em pixels por segundo. O mesmo número vive em
// `frontend/src/lib/patrocinadores.js`; repetido aqui porque este arreio é
// Node puro e não importa o bundle do navegador. Há teste de unidade guardando
// o valor do lado de lá — aqui se mede se a TELA o cumpre.
const PIXELS_POR_SEGUNDO = 42;

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

/** O deslocamento horizontal atual do trilho, lido da matriz de transformação. */
const deslocamentoDoTrilho = pagina => pagina.evaluate(() => {
  const trilho = document.querySelector('.rodape-patro .esteira-trilho');
  if (!trilho) return null;
  const m = new DOMMatrixReadOnly(getComputedStyle(trilho).transform);
  return m.m41;
});

async function principal() {
  mkdirSync(SAIDA, { recursive: true });

  console.log('subindo a API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST: '127.0.0.1',
      LOG_LEVEL: 'error', BCRYPT_ROUNDS: '10',
      JWT_SECRET: 'qa-faixa-patrocinio-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_DIR: './uploads-qa-patrocinio',
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

  // Um administrador, só para alcançar uma tela de OPERAÇÃO e provar que a
  // faixa NÃO entra lá. A vitrine é anônima e não precisa de cenário.
  try {
    execSync(`node scripts/criar-admin.js "QA Patrocinio" ${EMAIL}`,
      { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO, ADMIN_PASSWORD: SENHA } });
  } catch { console.log('  (administrador já existia)'); }

  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });
  const web = spawn('npx', ['vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', '127.0.0.1'],
    { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(BASE_WEB)) throw new Error('o frontend não subiu');

  console.log('abrindo o Chromium…');
  const { chromium } = await import(MODULO_PLAYWRIGHT);
  const navegador = await chromium.launch({ ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 } });
  const pagina = await contexto.newPage();

  const erros = [];
  const falhasExternas = [];
  const daAplicacao = url => !url || url.includes('127.0.0.1') || url.includes('localhost');
  pagina.on('response', r => {
    if (r.status() < 400 || !daAplicacao(r.url())) return;
    erros.push(`HTTP ${r.status()} em ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
  });
  pagina.on('console', m => {
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

  const irPara = async rota => {
    await pagina.goto(`${BASE_WEB}/#/${rota}`, { waitUntil: 'networkidle' });
    await esperar(1500);
    await dispensarAbertura(pagina);
    await esperar(1200);
  };

  // ---------------------------------------------- 1. ONDE ELA APARECE
  console.log('1. onde a faixa aparece…');
  for (const rota of ['ranking', 'inicio', 'campeonatos', 'atletas']) {
    await irPara(rota);
    const tem = await pagina.locator('.rodape-patro').count();
    conferir(tem === 1, `a faixa aparece em #/${rota} (achei ${tem})`);
  }
  await irPara('ranking');
  await print('1-ranking-desktop');

  // ---------------------------------------- 2. AS ARTES DECODIFICARAM
  console.log('2. as artes…');
  const artes = await pagina.evaluate(() => {
    const imagens = [...document.querySelectorAll('.rodape-patro img')];
    const anunciadas = imagens.filter(i => i.getAttribute('alt'));
    return {
      total: imagens.length,
      anunciadas: anunciadas.length,
      carregadas: imagens.filter(i => i.complete && i.naturalWidth > 0).length,
      quebradas: imagens.filter(i => i.complete && i.naturalWidth === 0).map(i => i.src),
      fontes: [...new Set(anunciadas.map(i => new URL(i.src).pathname))].sort()
    };
  });
  conferir(artes.anunciadas === 15, `as 15 marcas do catálogo estão na faixa (achei ${artes.anunciadas})`);
  conferir(artes.quebradas.length === 0,
    `nenhuma arte quebrada (${artes.quebradas.length ? artes.quebradas.join(', ') : 'nenhuma'})`);
  conferir(artes.carregadas === artes.total,
    `todas as ${artes.total} imagens DECODIFICARAM (${artes.carregadas})`);
  conferir(artes.fontes.every(f => f.startsWith('/patrocinadores/')),
    'toda arte vem de /patrocinadores/ — nenhuma fonte estranha');

  // -------------------------------------------- 3. O TRILHO SE MOVE
  console.log('3. o movimento…');
  const antes = await deslocamentoDoTrilho(pagina);
  await esperar(1500);
  const depois = await deslocamentoDoTrilho(pagina);
  conferir(antes !== null && depois !== null && antes !== depois,
    `o trilho ANDOU em 1,5 s (${antes?.toFixed(1)} → ${depois?.toFixed(1)} px)`);
  conferir(depois < antes, 'e anda da direita para a esquerda');

  // --------------------- 4. O PASSO DO CICLO É A LARGURA DE UMA CÓPIA
  const geometria = await pagina.evaluate(() => {
    const janela = document.querySelector('.rodape-patro .esteira');
    const trilho = document.querySelector('.rodape-patro .esteira-trilho');
    const grupo = trilho.querySelector('.esteira-grupo');
    return {
      copias: Number(getComputedStyle(trilho).getPropertyValue('--copias')),
      duracao: parseFloat(getComputedStyle(trilho).animationDuration),
      larguraDoGrupo: grupo.offsetWidth,
      larguraDoTrilho: trilho.offsetWidth,
      larguraDaJanela: janela.clientWidth,
      grupos: trilho.querySelectorAll('.esteira-grupo').length
    };
  });
  const passo = geometria.larguraDoTrilho / geometria.copias;
  conferir(Math.abs(passo - geometria.larguraDoGrupo) < 1.5,
    `o passo do ciclo é a largura de UMA cópia — a emenda fecha `
    + `(passo ${passo.toFixed(1)}px vs grupo ${geometria.larguraDoGrupo}px)`);
  conferir(geometria.grupos === geometria.copias,
    `o trilho tem as ${geometria.copias} cópias que declarou (achei ${geometria.grupos})`);

  // ------------------------------- 5. COBERTURA: NUNCA EXISTE UM VÃO
  conferir(geometria.larguraDoTrilho - passo >= geometria.larguraDaJanela,
    `o que resta depois do passo ainda cobre a janela — nunca há buraco `
    + `(${(geometria.larguraDoTrilho - passo).toFixed(0)}px restando para ${geometria.larguraDaJanela}px de janela)`);

  // -------------------------------------- 6. A VELOCIDADE DECLARADA
  const velocidade = geometria.larguraDoGrupo / geometria.duracao;
  conferir(Math.abs(velocidade - PIXELS_POR_SEGUNDO) < 1,
    `a velocidade é ${PIXELS_POR_SEGUNDO} px/s como declarado (medido ${velocidade.toFixed(1)})`);
  conferir(geometria.duracao >= 20,
    `o ciclo é longo o bastante para não cansar (${geometria.duracao.toFixed(1)} s)`);

  // ------------------------------------------------ 7. HOVER PAUSA
  console.log('4. hover…');
  await pagina.locator('.rodape-patro .esteira').hover();
  await esperar(500);
  const pausadoA = await deslocamentoDoTrilho(pagina);
  await esperar(1200);
  const pausadoB = await deslocamentoDoTrilho(pagina);
  conferir(Math.abs(pausadoA - pausadoB) < 0.5,
    `o movimento PARA com o mouse em cima (${pausadoA.toFixed(1)} → ${pausadoB.toFixed(1)})`);

  await pagina.mouse.move(10, 10);
  await esperar(1200);
  const retomado = await deslocamentoDoTrilho(pagina);
  conferir(Math.abs(retomado - pausadoB) > 0.5,
    `e RETOMA quando o mouse sai (${pausadoB.toFixed(1)} → ${retomado.toFixed(1)})`);

  // ------------------------- 10. A HIERARQUIA NA TELA, EM PIXELS
  console.log('5. hierarquia e layout…');
  const cotas = await pagina.evaluate(() => {
    const area = cota => {
      const no = document.querySelector(`.rodape-patro .esteira-grupo:not([aria-hidden]) .patro.t-${cota}`);
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
  conferir(decrescente,
    `a hierarquia das cotas NÃO inverte na tela `
    + `(${ordem.map(c => `${c} ${cotas[c]}`).join(' > ')})`);

  // --------------------- 8 e 9. SEM ROLAGEM, SEM COBRIR CONTEÚDO
  const layout = await pagina.evaluate(() => {
    const faixa = document.querySelector('.rodape-patro');
    const principal = document.querySelector('main');
    const estilo = getComputedStyle(faixa);
    const r = faixa.getBoundingClientRect();
    const rp = principal.getBoundingClientRect();
    return {
      rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      position: estilo.position,
      zIndex: estilo.zIndex,
      irmaDoMain: faixa.parentElement === principal.parentElement,
      abaixoDoConteudo: r.top >= rp.bottom - 1,
      larguraFaixa: Math.round(r.width),
      larguraJanela: document.documentElement.clientWidth,
      altura: Math.round(r.height)
    };
  });
  conferir(layout.rolagem <= 1, `sem rolagem horizontal em 1440px (sobra ${layout.rolagem}px)`);
  conferir(layout.position === 'static', `a faixa está EM FLUXO (position: ${layout.position})`);
  conferir(layout.zIndex === 'auto', `sem z-index disputando com modal ou menu (${layout.zIndex})`);
  conferir(layout.irmaDoMain, 'a faixa é IRMÃ do conteúdo, não está dentro nem por cima dele');
  conferir(layout.abaixoDoConteudo, 'e fica ABAIXO do conteúdo, sem cobrir nada');
  conferir(layout.larguraFaixa <= layout.larguraJanela + 1,
    `a faixa cabe na largura da tela (${layout.larguraFaixa} <= ${layout.larguraJanela})`);
  console.log(`    · altura reservada pela faixa: ${layout.altura}px`);

  // ------------------------------------- 1b. NÃO INVADE A OPERAÇÃO
  console.log('6. telas de operação…');
  const { entrar } = await import('./entrar-na-plataforma.mjs');
  await entrar(pagina, BASE_WEB, { email: EMAIL, senha: SENHA });
  for (const rota of ['admin', 'admin/atletas', 'messenger', 'meu-painel']) {
    await pagina.goto(`${BASE_WEB}/#/${rota}`, { waitUntil: 'networkidle' });
    await esperar(1600);
    const invadiu = await pagina.locator('.rodape-patro').count();
    conferir(invadiu === 0, `a faixa NÃO invade #/${rota} (achei ${invadiu})`);
  }
  await print('2-admin-sem-faixa');
  // E continua aparecendo para quem está logado, na vitrine.
  await pagina.goto(`${BASE_WEB}/#/ranking`, { waitUntil: 'networkidle' });
  await esperar(1800);
  conferir(await pagina.locator('.rodape-patro').count() === 1,
    'e continua na vitrine para quem ESTÁ logado');
  await print('3-ranking-logado');

  // ------------------------------------------------- LARGURAS
  console.log('7. larguras…');
  for (const largura of [1920, 1440, 1280, 1024, 768, 414, 390]) {
    await pagina.setViewportSize({ width: largura, height: largura < 500 ? 844 : 900 });
    await esperar(1400);
    const medida = await pagina.evaluate(() => {
      const faixa = document.querySelector('.rodape-patro');
      const janela = document.querySelector('.rodape-patro .esteira');
      const trilho = document.querySelector('.rodape-patro .esteira-trilho');
      return {
        rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visivel: Boolean(faixa) && faixa.getBoundingClientRect().height > 0,
        cobre: trilho.offsetWidth >= janela.clientWidth * 2,
        altura: Math.round(faixa.getBoundingClientRect().height)
      };
    });
    conferir(medida.visivel, `${largura}px: a faixa está visível (${medida.altura}px de altura)`);
    conferir(medida.rolagem <= 1, `${largura}px: sem rolagem horizontal (sobra ${medida.rolagem}px)`);
    conferir(medida.cobre, `${largura}px: o trilho cobre a janela com folga`);
    if (largura === 390 || largura === 1920) await print(`4-largura-${largura}`);
  }

  // --------------------------------------- 11. REDUÇÃO DE MOVIMENTO
  console.log('8. prefers-reduced-motion…');
  const parado = await navegador.newContext({
    viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce'
  });
  const paginaParada = await parado.newPage();
  await paginaParada.goto(`${BASE_WEB}/#/ranking`, { waitUntil: 'networkidle' });
  await esperar(1500);
  await dispensarAbertura(paginaParada);
  await esperar(1200);
  await paginaParada.screenshot({ path: `${SAIDA}/5-reduced-motion.png` });

  const semMovimento = await paginaParada.evaluate(() => {
    const trilho = document.querySelector('.rodape-patro .esteira-trilho');
    const anunciadas = document.querySelectorAll('.rodape-patro .esteira-grupo:not([aria-hidden]) img');
    const clones = document.querySelectorAll('.rodape-patro .esteira-grupo[aria-hidden="true"]');
    const escondidos = [...clones].filter(c => getComputedStyle(c).display === 'none');
    return {
      animacao: getComputedStyle(trilho).animationName,
      visiveis: [...anunciadas].filter(i => i.getBoundingClientRect().height > 0).length,
      anunciadas: anunciadas.length,
      clonesEscondidos: escondidos.length === clones.length,
      rolagem: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  conferir(semMovimento.animacao === 'none',
    `com movimento reduzido a animação é desligada (animation-name: ${semMovimento.animacao})`);
  conferir(semMovimento.visiveis === semMovimento.anunciadas && semMovimento.anunciadas === 15,
    `e as 15 marcas continuam VISÍVEIS, não só as que calharam na janela `
    + `(${semMovimento.visiveis}/${semMovimento.anunciadas})`);
  conferir(semMovimento.clonesEscondidos, 'os clones somem — ninguém vê a mesma logo duas vezes parada');
  conferir(semMovimento.rolagem <= 1, `e nem assim há rolagem horizontal (sobra ${semMovimento.rolagem}px)`);
  await parado.close();

  conferir(erros.length === 0, `nenhum erro vindo da aplicação (achados: ${erros.length})`);
  if (erros.length) console.log('   ', erros.slice(0, 6).join(' | ').slice(0, 800));
  if (falhasExternas.length) {
    console.log(`  · ${falhasExternas.length} falha(s) de recurso EXTERNO, do ambiente desta máquina.`);
  }

  await navegador.close();

  writeFileSync(`${SAIDA}/relatorio.txt`, [
    `marcas na faixa: ${artes.anunciadas}`,
    `cópias: ${geometria.copias} · grupo: ${geometria.larguraDoGrupo}px · ciclo: ${geometria.duracao.toFixed(1)}s`,
    `velocidade medida: ${velocidade.toFixed(1)} px/s`,
    `altura reservada: ${layout.altura}px`,
    `conferências com falha: ${falhas.length}`,
    ...falhas.map(f => `  - ${f}`)
  ].join('\n'));

  console.log(`\n  prints em ${SAIDA}/`);
  if (falhas.length) {
    console.error(`\n  FALHOU em ${falhas.length}:\n   - ${falhas.join('\n   - ')}\n`);
    encerrar();
    process.exit(1);
  }
  console.log('\n  QA DA FAIXA: todas as conferências passaram.\n');
  encerrar();
  process.exit(0);
}

principal().catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); encerrar(); process.exit(1); });
