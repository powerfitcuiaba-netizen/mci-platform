#!/usr/bin/env node
// ============================================================================
// O DIÁLOGO CABE NA TELA? — MEDIÇÃO EM NAVEGADOR DE VERDADE.
//
// Teste de unidade prova o contrato de CSS. Não prova que a caixa cabe: jsdom
// não calcula layout, então `getBoundingClientRect` devolve zero para tudo e
// qualquer asserção de pixel passaria mentindo.
//
// Este script abre a revisão da importação com 191 linhas — o tamanho do
// Ipiranga — num Chromium real e mede, em sete viewports, se o modal cabe, se
// o rodapé continua alcançável e se a rolagem horizontal fica presa à tabela.
//
// Foi assim que o defeito original apareceu com número em vez de impressão:
//   1366x768 .. rodapé em [776..833] .. 65px fora da viewport
//   1280x720 .. rodapé em [776..833] .. 113px fora
//    390x844 .. rodapé em [1002..1115] .. 271px fora
//
// USO (playwright-core e o Chromium do ambiente não são dependências do
// repositório; o script é opt-in, como `responsividade.mjs`):
//
//   npm i playwright-core
//   M=<pasta com revisao.html e styles.css> node scripts/qa/modal-na-viewport.mjs
//
// Sai com código 1 se qualquer viewport reprovar.
// ============================================================================

import { chromium } from 'playwright-core';

const VIEWPORTS = [
  [1920,1080,'desktop'], [1440,900,'notebook'], [1366,768,'notebook'],
  [1280,720,'notebook'], [1024,768,'notebook'], [412,915,'mobile'], [390,844,'mobile']
];

const navegador = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const linhas = [];
let reprovou = false;

for (const [w, h, tipo] of VIEWPORTS) {
  const pagina = await navegador.newPage({ viewport: { width: w, height: h } });
  await pagina.goto(`file://${process.env.M}/revisao.html`);
  await pagina.waitForTimeout(250);

  const m = await pagina.evaluate(() => {
    const modal = document.querySelector('.modal');
    const head = document.querySelector('.modal-head');
    const acoes = document.querySelector('.modal-actions');
    const tabela = document.querySelector('.tabela-em-modal');
    const cards = document.querySelector('.import-summary');
    const r = e => e.getBoundingClientRect();
    return {
      vw: innerWidth, vh: innerHeight,
      modal: { w: Math.round(r(modal).width), h: Math.round(r(modal).height),
               top: Math.round(r(modal).top), bottom: Math.round(r(modal).bottom) },
      rodape: { top: Math.round(r(acoes).top), bottom: Math.round(r(acoes).bottom) },
      cabecalho: { top: Math.round(r(head).top), bottom: Math.round(r(head).bottom) },
      tabelaAltura: Math.round(r(tabela).height),
      tabelaRolaSozinha: tabela.scrollHeight > tabela.clientHeight + 1,
      tabelaRolaHorizontal: tabela.scrollWidth > tabela.clientWidth + 1,
      cardsLargura: Math.round(r(cards).width),
      overflowGlobalX: document.documentElement.scrollWidth > innerWidth + 1,
      overflowGlobalY: document.documentElement.scrollHeight > innerHeight + 1,
      modalRolaSozinho: modal.scrollHeight > modal.clientHeight + 1
    };
  });

  const cabe = m.modal.h <= m.vh && m.modal.w <= m.vw
    && m.modal.top >= -1 && m.modal.bottom <= m.vh + 1;
  const rodapeVisivel = m.rodape.top >= 0 && m.rodape.bottom <= m.vh + 1;
  const cabecalhoVisivel = m.cabecalho.top >= -1 && m.cabecalho.bottom <= m.vh + 1;
  const semOverflowX = !m.overflowGlobalX;
  const cardsCabem = m.cardsLargura <= m.modal.w;
  const ok = cabe && rodapeVisivel && cabecalhoVisivel && semOverflowX && cardsCabem;
  if (!ok) reprovou = true;

  linhas.push(
    `${ok ? 'PASS' : 'FALHA'} ${String(w).padStart(4)}x${String(h).padStart(4)} ${tipo.padEnd(8)}` +
    ` | modal ${String(m.modal.w).padStart(4)}x${String(m.modal.h).padStart(4)}` +
    ` | rodape[${String(m.rodape.top).padStart(4)}..${String(m.rodape.bottom).padStart(4)}]` +
    ` | tabela ${String(m.tabelaAltura).padStart(3)}px rolaV=${m.tabelaRolaSozinha?'sim':'nao'} rolaH=${m.tabelaRolaHorizontal?'sim':'nao'}` +
    ` | overflowX_global=${m.overflowGlobalX?'SIM':'nao'} | cards ${m.cardsLargura}px`);

  await pagina.screenshot({ path: `${process.env.M}/tela-${w}x${h}.png` });
  await pagina.close();
}

await navegador.close();
console.log(linhas.join('\n'));
console.log(reprovou ? '\nRESULTADO: REPROVOU' : '\nRESULTADO: TODAS AS VIEWPORTS PASSARAM');
process.exit(reprovou ? 1 : 0);
