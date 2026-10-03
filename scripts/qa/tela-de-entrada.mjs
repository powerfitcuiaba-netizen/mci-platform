#!/usr/bin/env node
// ============================================================================
// GATE VISUAL — A TELA DE ENTRADA E A PAREDE DE PATROCÍNIO.
//
// Teste de unidade prova que a regra está certa. Não prova que a tela CABE,
// nem que a esteira anda no ritmo certo, nem que a arte de um patrocinador não
// estourou a caixa do vizinho. Isso só aparece num navegador de verdade.
//
// Este script serve o BUILD DE PRODUÇÃO e mede, em nove larguras:
//
//   * rolagem horizontal do documento;
//   * elementos que ultrapassam a janela;
//   * alvos de toque abaixo de 40px nas larguras de telefone;
//   * caixa IGUAL dentro de cada faixa, arte inteira e sem deformação;
//   * hierarquia ESTRITAMENTE decrescente entre as categorias;
//   * emenda exata da esteira, velocidade em px/s e sentidos alternados;
//   * cada patrocinador anunciado uma vez só para leitor de tela;
//   * erros de página.
//
// NÃO precisa de banco nem de API: a tela de entrada é o que o visitante vê
// antes de qualquer requisição. A chamada de sessão que falha é esperada, e
// está filtrada pelo que ela é — não por silenciar o console inteiro.
//
// Reprovar aqui é reprovar a entrega.
// ============================================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const RAIZ = resolve(import.meta.dirname, '..', '..');
const DIST = resolve(RAIZ, 'frontend', 'dist');
const PORTA = Number(arg('porta', 5699));
const CAMINHO_PLAYWRIGHT = arg('playwright', env.PLAYWRIGHT_MODULE || 'playwright');
const CHROMIUM = arg('chromium', env.PLAYWRIGHT_CHROMIUM || undefined);

const LARGURAS = [
  [375, 812], [390, 844], [430, 932],
  [768, 1024], [1024, 768],
  [1280, 800], [1366, 768], [1440, 900], [1920, 1080]
];
const TELEFONE = 560;
const ALVO_MINIMO = 40;
const PIXELS_POR_SEGUNDO = 42;

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.ico': 'image/x-icon'
};

// ------------------------------------------------------------- servidor
// Um servidor estático de dez linhas em vez de uma dependência nova. O caminho
// é normalizado antes de tocar o disco: sem isso, `/../../etc/passwd` sairia da
// pasta do build — num script de QA isso não derruba produção, mas o hábito de
// montar caminho com texto do pedido é exatamente o que derruba.
const servidor = createServer(async (req, res) => {
  const pedido = decodeURIComponent((req.url || '/').split('?')[0]);
  const seguro = normalize(pedido).replace(/^(\.\.(\/|\\|$))+/, '');
  let alvo = join(DIST, seguro);
  try {
    const info = await stat(alvo);
    if (info.isDirectory()) alvo = join(alvo, 'index.html');
  } catch {
    alvo = join(DIST, 'index.html'); // rota da aplicação
  }
  try {
    const corpo = await readFile(alvo);
    res.writeHead(200, { 'content-type': TIPOS[extname(alvo)] || 'application/octet-stream' });
    res.end(corpo);
  } catch (erro) {
    res.writeHead(404).end('nao encontrado');
  }
});

const falhas = [];
const reprovar = (onde, motivo) => { falhas.push(`${onde}: ${motivo}`); };

try {
  await stat(join(DIST, 'index.html'));
} catch {
  console.error('Build ausente. Rode `npm run build` dentro de frontend/ antes do gate.');
  process.exit(1);
}

await new Promise(ok => servidor.listen(PORTA, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${PORTA}`;

const { chromium } = await import(CAMINHO_PLAYWRIGHT);
const navegador = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });

try {
  for (const [largura, altura] of LARGURAS) {
    const pagina = await navegador.newPage({ viewport: { width: largura, height: altura } });
    const erros = [];
    pagina.on('pageerror', e => erros.push(`pageerror: ${e.message}`));
    pagina.on('console', m => {
      if (m.type() !== 'error') return;
      const texto = m.text();
      // A chamada de sessão falha porque não há API — é o estado normal de quem
      // ainda não entrou, e é por isso que a tela de entrada aparece.
      if (/Failed to load resource|net::ERR_|\/api\/v1\//.test(texto)) return;
      erros.push(`console: ${texto}`);
    });

    await pagina.goto(BASE, { waitUntil: 'networkidle' });
    await pagina.waitForSelector('.parede-patro .esteira-grupo', { timeout: 15000 });
    await pagina.waitForTimeout(400);

    const onde = `${largura}px`;
    const medida = await pagina.evaluate(({ alvoMinimo, ehTelefone }) => {
      const doc = document.documentElement;
      const fora = [];
      for (const elemento of document.querySelectorAll('body *')) {
        // Quem está dentro de um recorte não "estoura a tela": a esteira corre
        // por baixo de `overflow: hidden` de propósito.
        let pai = elemento.parentElement, recortado = false;
        while (pai && pai !== document.body) {
          if (getComputedStyle(pai).overflow !== 'visible') { recortado = true; break; }
          pai = pai.parentElement;
        }
        if (recortado) continue;
        const r = elemento.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > doc.clientWidth + 1 || r.left < -1) {
          fora.push(`${elemento.tagName.toLowerCase()}.${elemento.className || ''}`.slice(0, 60));
        }
      }

      const pequenos = [];
      if (ehTelefone) {
        for (const alvo of document.querySelectorAll('button, a, input[type="checkbox"]')) {
          // A caixa dentro de um rótulo não é o alvo: o alvo é o rótulo.
          if (alvo.type === 'checkbox' && alvo.closest('label')) continue;
          const r = alvo.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.height < alvoMinimo) pequenos.push(`${alvo.tagName.toLowerCase()} ${Math.round(r.height)}px`);
        }
      }

      const faixas = [...document.querySelectorAll('.faixa-patro')].map(faixa => {
        const categoria = (faixa.className.match(/t-([a-z]+)/) || [])[1];
        const grupo = faixa.querySelector('.esteira-grupo:not([aria-hidden="true"])');
        const caixas = [...grupo.querySelectorAll('.patro')].map(c => {
          const rc = c.getBoundingClientRect();
          const img = c.querySelector('img');
          const ri = img.getBoundingClientRect();
          return {
            nome: img.alt, cl: rc.width, ca: rc.height, il: ri.width, ia: ri.height,
            nat: img.naturalWidth / img.naturalHeight, carregou: img.naturalWidth > 0
          };
        });
        const janela = faixa.querySelector('.esteira');
        const trilho = faixa.querySelector('.esteira-trilho');
        const copias = Number(getComputedStyle(trilho).getPropertyValue('--copias')) || 0;
        const dur = parseFloat(getComputedStyle(trilho).getPropertyValue('--dur')) || 0;
        const anunciadas = [...faixa.querySelectorAll('img')].filter(i => i.alt).length;
        return {
          categoria, caixas, copias, dur, sentido: janela.dataset.sentido,
          larguraDoGrupo: grupo.offsetWidth, larguraDaJanela: janela.clientWidth,
          larguraDoTrilho: trilho.offsetWidth, anunciadas
        };
      });

      return {
        rolagem: doc.scrollWidth, janela: doc.clientWidth, fora, pequenos, faixas
      };
    }, { alvoMinimo: ALVO_MINIMO, ehTelefone: largura <= TELEFONE });

    if (medida.rolagem > medida.janela + 1) reprovar(onde, `rolagem horizontal ${medida.rolagem} > ${medida.janela}`);
    if (medida.fora.length) reprovar(onde, `${medida.fora.length} fora da tela: ${medida.fora.slice(0, 3).join(', ')}`);
    if (medida.pequenos.length) reprovar(onde, `alvo de toque pequeno: ${medida.pequenos.slice(0, 3).join(', ')}`);
    if (erros.length) reprovar(onde, `erro de página: ${erros.slice(0, 2).join(' | ')}`);
    if (medida.faixas.length < 2) reprovar(onde, `só ${medida.faixas.length} faixa(s) de patrocínio`);

    const areas = [];
    for (const faixa of medida.faixas) {
      const alvo = `${onde} ${faixa.categoria}`;
      const [primeira] = faixa.caixas;
      if (!primeira) { reprovar(alvo, 'faixa sem marcas'); continue; }

      for (const c of faixa.caixas) {
        if (!c.carregou) reprovar(alvo, `${c.nome || 'clone'}: a arte não carregou`);
        if (Math.abs(c.cl - primeira.cl) > 0.6 || Math.abs(c.ca - primeira.ca) > 0.6) {
          reprovar(alvo, `caixas desiguais: ${c.nome} ${c.cl.toFixed(0)}x${c.ca.toFixed(0)} vs ${primeira.cl.toFixed(0)}x${primeira.ca.toFixed(0)}`);
        }
        if (c.il > c.cl + 0.6 || c.ia > c.ca + 0.6) {
          reprovar(alvo, `${c.nome} estoura a caixa: arte ${c.il.toFixed(0)}x${c.ia.toFixed(0)} em ${c.cl.toFixed(0)}x${c.ca.toFixed(0)}`);
        }
        if (c.carregou && Math.abs((c.il / c.ia) - c.nat) / c.nat > 0.02) {
          reprovar(alvo, `${c.nome} deformada: ${(c.il / c.ia).toFixed(2)} contra ${c.nat.toFixed(2)} do arquivo`);
        }
      }

      if (faixa.anunciadas !== faixa.caixas.length) {
        reprovar(alvo, `${faixa.anunciadas} marcas anunciadas para ${faixa.caixas.length} do grupo — clone falando`);
      }
      if (faixa.copias < 2) reprovar(alvo, `${faixa.copias} cópia(s): a esteira abre buraco`);
      if (faixa.larguraDoTrilho < faixa.larguraDaJanela * 2 - 1) {
        reprovar(alvo, `fita ${faixa.larguraDoTrilho}px não cobre duas janelas de ${faixa.larguraDaJanela}px`);
      }
      // A emenda só é invisível se o passo do ciclo for a largura de UMA cópia.
      const passo = faixa.larguraDoTrilho / faixa.copias;
      if (Math.abs(passo - faixa.larguraDoGrupo) > 1) {
        reprovar(alvo, `emenda visível: passo ${passo.toFixed(0)}px, grupo ${faixa.larguraDoGrupo}px`);
      }
      const velocidade = faixa.dur ? faixa.larguraDoGrupo / faixa.dur : 0;
      if (Math.abs(velocidade - PIXELS_POR_SEGUNDO) > 1.5) {
        reprovar(alvo, `velocidade ${velocidade.toFixed(1)} px/s, esperado ${PIXELS_POR_SEGUNDO}`);
      }
      areas.push({ categoria: faixa.categoria, area: primeira.cl * primeira.ca, sentido: faixa.sentido });
    }

    for (let i = 1; i < areas.length; i += 1) {
      if (!(areas[i].area < areas[i - 1].area - 1)) {
        reprovar(onde, `hierarquia quebrada: ${areas[i].categoria} não é menor que ${areas[i - 1].categoria}`);
      }
      if (areas[i].sentido === areas[i - 1].sentido) {
        reprovar(onde, `${areas[i].categoria} corre no mesmo sentido de ${areas[i - 1].categoria}`);
      }
    }

    const resumo = areas.map(a => `${a.categoria} ${Math.round(a.area)}`).join(' > ');
    console.log(`${String(largura).padStart(5)}px  rolagem ${String(medida.rolagem).padStart(4)}/${String(medida.janela).padStart(4)}  fora ${medida.fora.length}  alvos ${medida.pequenos.length}  faixas: ${resumo}`);
    await pagina.close();
  }
} finally {
  await navegador.close();
  servidor.close();
}

console.log('');
if (falhas.length) {
  console.error(`REPROVADO — ${falhas.length} problema(s):`);
  for (const f of falhas) console.error(`  ${f}`);
  process.exit(1);
}
console.log('APROVADO — 9 larguras: sem rolagem horizontal, caixas iguais por faixa, artes inteiras, hierarquia decrescente, esteiras com emenda exata a 42 px/s e cada marca anunciada uma vez.');
