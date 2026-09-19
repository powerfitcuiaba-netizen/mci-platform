#!/usr/bin/env node
// ============================================================================
// O DIÁLOGO CABE NA TELA? — MEDIÇÃO EM NAVEGADOR DE VERDADE.
//
// Teste de unidade prova o contrato de CSS. Não prova que a caixa cabe: jsdom
// não calcula layout, então `getBoundingClientRect` devolve zero para tudo e
// qualquer asserção de pixel passaria mentindo.
//
// Este script abre a revisão da importação com 191 linhas — o tamanho do
// Ipiranga — num Chromium real e mede, nas OITO viewports homologadas, se o
// modal cabe, se o rodapé continua alcançável, se as onze colunas estão todas
// desenhadas e se a rolagem horizontal fica presa à tabela.
//
// Foi assim que o defeito original apareceu com número em vez de impressão:
//   1366x768 .. rodapé em [776..833] .. 65px fora da viewport
//   1280x720 .. rodapé em [776..833] .. 113px fora
//    390x844 .. rodapé em [1002..1115] .. 271px fora
//
// E foi assim que o segundo defeito apareceu — este a MEDIÇÃO DE CAIXA sozinha
// não pegava, porque o modal cabia: a tabela era mais larga que a área útil do
// diálogo, e a coluna de AÇÃO ("Vincular") ficava fora, alcançável só arrastando
// de lado. Daí a conferência de `tabelaMaisLargaQueODialogo` a partir de 1280:
// no desktop a linha inteira tem de caber sem arrastar.
//
// USO (playwright-core e o Chromium do ambiente não são dependências do
// repositório; o script é opt-in, como `responsividade.mjs`):
//
//   npm i playwright-core
//   node scripts/qa/modal-na-viewport.mjs [pasta-de-trabalho]
//
// A página de medição é gerada por `fixture-revisao.mjs` — dados de QA, nunca
// de atleta real. Sai com código 1 se qualquer viewport reprovar.
// ============================================================================

import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { gerarFixture } from './fixture-revisao.mjs';

// As oito larguras homologadas: dois celulares, um tablet, quatro notebooks e
// um desktop. 768x1024 entrou porque é onde o resumo troca de 7 para 4 colunas.
const VIEWPORTS = [
  [390, 844, 'mobile'], [412, 915, 'mobile'], [768, 1024, 'tablet'],
  [1024, 768, 'notebook'], [1280, 720, 'notebook'], [1366, 768, 'notebook'],
  [1440, 900, 'notebook'], [1920, 1080, 'desktop']
];

// A partir desta largura o diálogo atinge o teto de 1180px e a linha inteira
// tem de caber: abaixo dela, arrastar a tabela de lado é o comportamento certo.
const LARGURA_SEM_ARRASTO = 1280;

const PASTA = resolve(process.env.M || process.argv[2] || 'tmp/qa-revisao');
gerarFixture(PASTA);

const navegador = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const linhas = [];
let reprovou = false;

for (const [w, h, tipo] of VIEWPORTS) {
  const pagina = await navegador.newPage({ viewport: { width: w, height: h } });
  await pagina.goto(`file://${PASTA}/revisao.html`);
  await pagina.waitForTimeout(250);

  const m = await pagina.evaluate(() => {
    const modal = document.querySelector('.modal');
    const head = document.querySelector('.modal-head');
    const acoes = document.querySelector('.modal-actions');
    const tabela = document.querySelector('.tabela-em-modal');
    const principal = document.querySelector('.modal-actions .button-primary');
    const cards = document.querySelector('.import-summary');
    const cartoes = [...document.querySelectorAll('.import-summary .metric')];
    const th = document.querySelector('.tabela-em-modal thead th');
    const celulas = [...document.querySelector('.tabela-em-modal tbody tr').querySelectorAll('td')];
    const paginacao = document.querySelector('.import-paginacao');
    const busca = document.querySelector('.import-busca');
    const exportar = [...document.querySelectorAll('.import-filtros button')]
      .find(b => /exportar/i.test(b.textContent));
    const r = e => e.getBoundingClientRect();

    // O cabeçalho só prova que grudou DEPOIS de rolar. Medir antes da rolagem
    // e chamar de "sticky" seria conferir a propriedade, não o efeito.
    // A ORDEM DAS DUAS MEDIÇÕES IMPORTA, e descobri isso pelo resultado
    // intermitente: rolar o DIÁLOGO desloca o cabeçalho grudado da tabela em
    // relação à viewport, então medir "o th ficou parado?" depois de mexer no
    // diálogo comparava duas posições de layouts diferentes e acusava falha
    // onde não havia. Primeiro o cabeçalho, com o diálogo parado; só então a
    // rolagem do diálogo para conferir a paginação.
    const topoAntes = Math.round(r(th).top);
    tabela.scrollTop = 400;
    return new Promise(pronto => requestAnimationFrame(() => setTimeout(() => {
      const topoDepois = Math.round(r(th).top);
      tabela.scrollTop = 0;
      // Até a direita: é onde mora a coluna de ação.
      tabela.scrollLeft = tabela.scrollWidth;

      // O DIÁLOGO ROLADO ATÉ O FIM: o requisito da paginação é ser
      // ALCANÇÁVEL, não estar sempre à vista. No celular o conteúdo não cabe
      // de jeito nenhum, e exigir que caiba seria exigir que alguma coluna
      // sumisse. No desktop ela aparece sem rolar, e é o desconto de altura da
      // tabela que garante isso.
      modal.scrollTop = modal.scrollHeight;

      pronto({
        vw: innerWidth, vh: innerHeight,
        modal: { w: Math.round(r(modal).width), h: Math.round(r(modal).height),
                 top: Math.round(r(modal).top), bottom: Math.round(r(modal).bottom),
                 left: Math.round(r(modal).left), right: Math.round(r(modal).right) },
        rodape: { top: Math.round(r(acoes).top), bottom: Math.round(r(acoes).bottom) },
        cabecalho: { top: Math.round(r(head).top), bottom: Math.round(r(head).bottom) },
        principal: { largura: Math.round(r(principal).width), base: Math.round(r(principal).bottom) },
        tabelaAltura: Math.round(r(tabela).height),
        tabelaRolaSozinha: tabela.scrollHeight > tabela.clientHeight + 1,
        tabelaRolaHorizontal: tabela.scrollWidth > tabela.clientWidth + 1,
        cardsLargura: Math.round(r(cards).width),
        cartoes: cartoes.length,
        cartaoAltura: Math.round(r(cartoes[0]).height),
        cabecalhoGrudou: Math.abs(topoAntes - topoDepois) <= 1,
        colunas: celulas.length,
        colunasDesenhadas: celulas.filter(td => r(td).width > 0 && r(td).height > 0).length,
        // CABER NA VIEWPORT NÃO É ESTAR VISÍVEL. O rodapé é `sticky` e cobre o
        // que passa por baixo dele: a primeira versão desta conferência dava
        // verde com a faixa de paginação escondida atrás do rodapé, e a
        // captura de tela é que denunciou. A régua certa é o topo do rodapé.
        paginacaoVisivel: Boolean(paginacao) && r(paginacao).height > 0
          && r(paginacao).bottom <= Math.min(innerHeight, r(acoes).top) + 1,
        buscaVisivel: Boolean(busca) && r(busca).width > 0,
        exportarVisivel: Boolean(exportar) && r(exportar).width > 0
          && r(exportar).bottom <= innerHeight + 1,
        // A AÇÃO DA LINHA TEM DE SER ALCANÇÁVEL — medida com a tabela rolada
        // até a direita, e não no estado inicial. A primeira versão desta
        // conferência exigia vê-la sem rolar, e reprovava as viewports
        // estreitas onde a própria especificação MANDA a tabela rolar de lado.
        // Exigir o contrário ali seria exigir que alguma coluna sumisse.
        //
        // Nas viewports onde a linha inteira cabe (de 1280 para cima), quem
        // garante a visibilidade sem arrasto é `linhaInteiraCabe`, que continua
        // conferido à parte.
        acaoDaLinhaVisivel: (() => {
          const acao = document.querySelector('.tabela-em-modal tbody .icon-button');
          if (!acao) return false;
          const caixa = r(acao);
          const janela = r(tabela);
          return caixa.width > 0 && caixa.right <= janela.right + 1;
        })(),
        linhasVisiveis: [...document.querySelectorAll('.tabela-em-modal tbody tr')]
          .filter(tr => r(tr).top >= r(tabela).top - 1 && r(tr).bottom <= r(tabela).bottom + 1).length,
        overflowGlobalX: document.documentElement.scrollWidth > innerWidth + 1
      });
    }, 60)));
  });

  const margem = Math.min(m.modal.left, m.vw - m.modal.right);
  const cabe = m.modal.h <= m.vh && m.modal.w <= m.vw
    && m.modal.top >= -1 && m.modal.bottom <= m.vh + 1;
  const rodapeVisivel = m.rodape.top >= 0 && m.rodape.bottom <= m.vh + 1;
  const cabecalhoVisivel = m.cabecalho.top >= -1 && m.cabecalho.bottom <= m.vh + 1;
  // O rodapé pode estar dentro da viewport e o botão que decide, não: é ele
  // que precisa estar alcançável, não a faixa em volta dele.
  const botaoVisivel = m.principal.largura > 0 && m.principal.base <= m.vh + 1;
  const semOverflowX = !m.overflowGlobalX;
  const cardsCabem = m.cardsLargura <= m.modal.w;
  const todasColunas = m.colunasDesenhadas === m.colunas && m.colunas === 11;
  // Moldura: o diálogo não pode encostar na borda da tela.
  const naoEncosta = margem >= 12;
  const linhaInteiraCabe = w < LARGURA_SEM_ARRASTO || !m.tabelaRolaHorizontal;

  const ok = cabe && rodapeVisivel && cabecalhoVisivel && botaoVisivel && semOverflowX
    && cardsCabem && todasColunas && m.cabecalhoGrudou && naoEncosta && linhaInteiraCabe
    && m.paginacaoVisivel && m.buscaVisivel && m.acaoDaLinhaVisivel && m.exportarVisivel;
  if (!ok) reprovou = true;

  linhas.push(
    `${ok ? 'PASS' : 'FALHA'} ${String(w).padStart(4)}x${String(h).padStart(4)} ${tipo.padEnd(8)}` +
    ` | modal ${String(m.modal.w).padStart(4)}x${String(m.modal.h).padStart(4)} margem ${String(margem).padStart(3)}px` +
    ` | rodape[${String(m.rodape.top).padStart(4)}..${String(m.rodape.bottom).padStart(4)}]` +
    ` | tabela ${String(m.tabelaAltura).padStart(3)}px rolaV=${m.tabelaRolaSozinha?'sim':'nao'} rolaH=${m.tabelaRolaHorizontal?'sim':'nao'}` +
    ` | th_grudou=${m.cabecalhoGrudou?'sim':'NAO'}` +
    ` | cards ${m.cartoes}x${m.cartaoAltura}px | colunas ${m.colunasDesenhadas}/${m.colunas}` +
    ` | linhas ${m.linhasVisiveis} | pag=${m.paginacaoVisivel?'sim':'NAO'} busca=${m.buscaVisivel?'sim':'NAO'}` +
    ` acao=${m.acaoDaLinhaVisivel?'sim':'NAO'} exportar=${m.exportarVisivel?'sim':'NAO'}` +
    ` | overflowX_global=${m.overflowGlobalX?'SIM':'nao'}`);

  await pagina.screenshot({ path: `${PASTA}/tela-${w}x${h}.png` });
  await pagina.close();
}

await navegador.close();
console.log(linhas.join('\n'));
console.log(`\n(páginas e capturas em ${PASTA})`);
console.log(reprovou ? '\nRESULTADO: REPROVOU' : '\nRESULTADO: TODAS AS VIEWPORTS PASSARAM');
process.exit(reprovou ? 1 : 0);
