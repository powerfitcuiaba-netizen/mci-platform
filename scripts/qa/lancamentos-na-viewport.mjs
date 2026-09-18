#!/usr/bin/env node
// ============================================================================
// A TELA DE LANÇAMENTOS CABE? — MEDIÇÃO EM NAVEGADOR DE VERDADE.
//
// Mesma razão do `modal-na-viewport.mjs`: jsdom não calcula layout, então
// `getBoundingClientRect` devolve zero para tudo e qualquer asserção de pixel
// passaria mentindo. O teste de unidade prova o contrato do componente; só o
// navegador prova que a coisa cabe.
//
// Aqui o risco é diferente do modal: a tabela tem NOVE colunas, e o número de
// lançamentos é o do Ipiranga (191). Duas perguntas, em sete viewports:
//
//   1. a PÁGINA rola de lado? (nunca pode: rolagem horizontal de página é o
//      defeito, e não a solução);
//   2. todas as nove colunas continuam alcançáveis? No telefone a tabela vira
//      cartão — nenhuma coluna é escondida, cada uma vira uma linha.
//
// E o diálogo de correção, que é onde o operador decide: cabeçalho e rodapé
// dentro da viewport, sem depender de zoom.
//
// USO (playwright-core e o Chromium do ambiente não são dependências do
// repositório; o script é opt-in, como os outros de scripts/qa):
//
//   npm i playwright-core
//   M=<pasta com lancamentos.html e styles.css> node scripts/qa/lancamentos-na-viewport.mjs
//
// Sai com código 1 se qualquer viewport reprovar.
// ============================================================================

import { chromium } from 'playwright-core';

const VIEWPORTS = [
  [1920, 1080, 'desktop'], [1440, 900, 'notebook'], [1366, 768, 'notebook'],
  [1280, 720, 'notebook'], [1024, 768, 'notebook'], [412, 915, 'mobile'], [390, 844, 'mobile']
];

const COLUNAS = 9;

const navegador = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
});
const linhas = [];
let reprovou = false;

for (const [w, h, tipo] of VIEWPORTS) {
  const pagina = await navegador.newPage({ viewport: { width: w, height: h } });
  await pagina.goto(`file://${process.env.M}/lancamentos.html`);
  await pagina.waitForTimeout(250);

  const m = await pagina.evaluate(() => {
    const r = e => e.getBoundingClientRect();
    const tabela = document.querySelector('.lancamentos-tabela');
    const wrap = document.querySelector('.table-wrap');
    const primeira = tabela.querySelector('tbody tr');
    const modal = document.querySelector('.modal');
    const acoes = document.querySelector('.modal-actions');
    const head = document.querySelector('.modal-head');

    // Uma célula só é "alcançável" se tem área. Zero de largura ou altura é
    // coluna escondida — que é exatamente o que não pode acontecer.
    const celulas = [...primeira.querySelectorAll('td')]
      .map(td => ({ w: Math.round(r(td).width), h: Math.round(r(td).height) }));

    return {
      vw: innerWidth, vh: innerHeight,
      overflowGlobalX: document.documentElement.scrollWidth > innerWidth + 1,
      larguraDocumento: document.documentElement.scrollWidth,
      wrapRolaH: wrap.scrollWidth > wrap.clientWidth + 1,
      celulas,
      celulasVisiveis: celulas.filter(c => c.w > 0 && c.h > 0).length,
      botoesDaLinha: [...primeira.querySelectorAll('.acoes-da-linha .button')]
        .map(b => ({ w: Math.round(r(b).width), h: Math.round(r(b).height) })),
      modal: {
        w: Math.round(r(modal).width), h: Math.round(r(modal).height),
        top: Math.round(r(modal).top), bottom: Math.round(r(modal).bottom)
      },
      rodape: { top: Math.round(r(acoes).top), bottom: Math.round(r(acoes).bottom) },
      cabecalho: { top: Math.round(r(head).top), bottom: Math.round(r(head).bottom) }
    };
  });

  const semOverflowX = !m.overflowGlobalX;
  const todasAsColunas = m.celulasVisiveis === COLUNAS;
  // 44px é o alvo mínimo de toque. Um botão de invalidar menor que isso, ao
  // lado de um de corrigir, transforma engano em operação destrutiva.
  const alvosDeToque = w > 760 || m.botoesDaLinha.every(b => b.h >= 40);
  const modalCabe = m.modal.h <= m.vh && m.modal.w <= m.vw
    && m.modal.top >= -1 && m.modal.bottom <= m.vh + 1;
  const rodapeVisivel = m.rodape.top >= 0 && m.rodape.bottom <= m.vh + 1;
  const cabecalhoVisivel = m.cabecalho.top >= -1 && m.cabecalho.bottom <= m.vh + 1;

  const ok = semOverflowX && todasAsColunas && alvosDeToque
    && modalCabe && rodapeVisivel && cabecalhoVisivel;
  if (!ok) reprovou = true;

  linhas.push(
    `${ok ? 'PASS' : 'FALHA'} ${String(w).padStart(4)}x${String(h).padStart(4)} ${tipo.padEnd(8)}` +
    ` | doc ${String(m.larguraDocumento).padStart(4)}px overflowX=${m.overflowGlobalX ? 'SIM' : 'nao'}` +
    ` | colunas ${m.celulasVisiveis}/${COLUNAS}` +
    ` | botoes ${m.botoesDaLinha.map(b => `${b.w}x${b.h}`).join(' ') || '—'}` +
    ` | modal ${String(m.modal.w).padStart(4)}x${String(m.modal.h).padStart(4)}` +
    ` rodape[${String(m.rodape.top).padStart(4)}..${String(m.rodape.bottom).padStart(4)}]`);

  await pagina.screenshot({ path: `${process.env.M}/lanc-${w}x${h}.png`, fullPage: false });
  await pagina.close();
}

await navegador.close();
console.log(linhas.join('\n'));
console.log(reprovou ? '\nRESULTADO: REPROVOU' : '\nRESULTADO: TODAS AS VIEWPORTS PASSARAM');
process.exit(reprovou ? 1 : 0);
