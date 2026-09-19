import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O cwd do Vitest é `frontend/`; `import.meta.url` não chega como file:// sob
// o transform, então a leitura é por caminho relativo à raiz do pacote.
const ler = caminho => readFileSync(resolve('src', caminho), 'utf8');

// ==========================================================================
// O DIÁLOGO PRECISA CABER NA TELA — E O RODAPÉ É O QUE SOME PRIMEIRO.
//
// Medido num Chromium real, com a revisão do Ipiranga (191 linhas), ANTES
// desta correção:
//
//   1366x768 .. rodapé em [776..833]  →  65px fora da viewport
//   1280x720 .. rodapé em [776..833]  → 113px fora
//    390x844 .. rodapé em [1002..1115] → 271px fora
//
// O operador não conseguia alcançar "Aplicar" sem rolar dentro do diálogo, e
// o cabeçalho sumia junto. A causa eram três coisas somadas: o modal inteiro
// rolava como uma caixa só, a tabela carregava 340px FIXOS de altura, e não
// havia teto de viewport na largura.
//
// jsdom não calcula layout, então este arquivo NÃO mede pixels: ele tranca o
// CONTRATO de CSS que a medição provou correto. A medição em navegador vive
// em `scripts/qa/modal-na-viewport.mjs` e é executável sob demanda.
// ==========================================================================

const css = ler('styles.css');

const regra = seletor => {
  const i = css.indexOf(`\n${seletor} {`);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i));
};

// `regra` acha o seletor só quando ele abre a linha exatamente como escrito.
// Para os recortes com combinador (`.tabela-em-modal .table td:nth-child(3)`)
// vale a pena procurar pelo seletor escapado, fora de qualquer @media.
const corpoDe = seletor => {
  const escapado = seletor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const achado = new RegExp(`(?:^|\\})\\s*${escapado}\\s*\\{([^{}]*)\\}`, 'm').exec(css);
  return achado ? achado[1] : null;
};

// Recorta o conteúdo de um `@media (...)`, com um nível de aninhamento.
const dentroDaMedia = condicao => {
  const escapado = condicao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const achado = new RegExp(`@media\\s*${escapado}\\s*\\{((?:[^{}]*\\{[^{}]*\\})*)`, 'm').exec(css);
  return achado ? achado[1] : null;
};

describe('o diálogo cabe na viewport', () => {
  it('o modal tem teto de altura e de largura em unidades de viewport', () => {
    const modal = regra('.modal');
    // 88vh, e não mais 92vh: com 92 o diálogo chegava a 8px da borda da tela
    // em cima e embaixo, e a moldura que o distingue da página desaparecia.
    // `dvh` acompanha a barra de endereço do celular que aparece e some; `vh`
    // sozinho mede a tela com a barra recolhida e joga o rodapé para baixo dela.
    expect(modal, 'sem max-height o diálogo cresce com o conteúdo').toMatch(/max-height:\s*min\(88vh,\s*88dvh\)/);
    expect(modal, 'sem max-width o diálogo passa da largura da tela').toMatch(/max-width:\s*96vw/);
  });

  it('o modal rola só na vertical — quem rola na horizontal é a tabela', () => {
    // `overflow: hidden auto` é o que impede uma tabela larga de empurrar o
    // diálogo para fora da viewport lateralmente.
    expect(regra('.modal')).toMatch(/overflow:\s*hidden auto/);
  });

  it('cabeçalho e rodapé ficam grudados, e não rolam com o conteúdo', () => {
    expect(regra('.modal-head'), 'cabeçalho precisa ser sticky').toMatch(/position:\s*sticky/);
    expect(regra('.modal-actions'), 'rodapé precisa ser sticky').toMatch(/position:\s*sticky/);
    // Fundo opaco: sem ele o conteúdo passa por baixo e fica ilegível.
    expect(regra('.modal-head')).toMatch(/background:\s*var\(--superficie-3\)/);
    expect(regra('.modal-actions')).toMatch(/background:\s*var\(--superficie-3\)/);
  });

  it('a tabela do diálogo tem altura proporcional à tela, nunca um número fixo', () => {
    const tabela = regra('.tabela-em-modal');
    expect(tabela).toMatch(/max-height:\s*clamp\([^)]*vh[^)]*\)/);
    expect(tabela).toMatch(/overflow:\s*auto/);
  });

  it('nenhuma tabela de diálogo voltou a usar altura fixa em pixels', () => {
    const pagina = ler('pages/adminPlatform.jsx');
    // Era exatamente esta a forma do defeito: `style={{ maxHeight: 340 }}`.
    expect(pagina, 'altura fixa inline voltou ao diálogo').not.toMatch(/maxHeight:\s*\d+/);
  });

  it('a camada do diálogo prende a rolagem', () => {
    expect(regra('.modal-layer')).toMatch(/overflow:\s*hidden/);
  });

  it('o diálogo largo desconta 48px da viewport e para em 1180px', () => {
    // `min(100%, 1100px)` com `max-width: 96vw` fazia o diálogo encostar quase
    // nas bordas em telas médias: em 1280 sobravam 26px de cada lado, e a
    // revisão parecia uma página, não um diálogo.
    const achado = /width:\s*min\(\s*(\d+)px\s*,\s*calc\(\s*100vw\s*-\s*(\d+)px\s*\)\s*\)/
      .exec(regra('.modal-wide'));
    expect(achado, '.modal-wide não declara min(Xpx, calc(100vw - Ypx))').not.toBeNull();
    expect(Number(achado[1])).toBeLessThanOrEqual(1180);
    expect(Number(achado[2]), 'moldura de 24px de cada lado').toBeGreaterThanOrEqual(48);
  });
});

// ==========================================================================
// O SEGUNDO DEFEITO, QUE A MEDIÇÃO DE CAIXA SOZINHA NÃO PEGAVA.
//
// O modal cabia — e a tabela, não. Ela era mais larga que a área útil do
// diálogo, e a coluna de AÇÃO ("Vincular") ficava fora em TODA viewport,
// alcançável só arrastando a tabela de lado. Medido no mesmo Chromium:
//
//   1920x1080 .. área útil 1128px .. tabela 1254px  → 126px de ação escondida
//
// A prova de pixel deste contrato está em `scripts/qa/modal-na-viewport.mjs`,
// que reprova as quatro viewports de 1280 para cima se ele for desfeito.
// ==========================================================================
describe('as onze colunas cabem, e quem rola de lado é a tabela', () => {
  it('.table-wrap é o contêiner que rola na horizontal', () => {
    expect(regra('.table-wrap')).toMatch(/overflow-x:\s*auto/);
  });

  it('a tabela do diálogo tem régua mínima, e ela não passa da área útil', () => {
    const achado = /min-width:\s*(\d+)px/.exec(corpoDe('.tabela-em-modal .table'));
    expect(achado, 'sem régua o navegador espreme as 11 colunas até o texto virar três linhas').not.toBeNull();
    expect(Number(achado[1])).toBeGreaterThanOrEqual(1000);
    // Passar disto devolve o defeito: a ação da linha sai do diálogo no desktop.
    expect(Number(achado[1])).toBeLessThanOrEqual(1180 - 48);
  });

  it('o cabeçalho dentro do diálogo pode quebrar em duas linhas', () => {
    // "Pts arquivo" numa linha só reservava 104px de largura que as 191 linhas
    // pagavam. O cabeçalho aparece uma vez; as linhas, 191.
    expect(corpoDe('.tabela-em-modal .table th')).toMatch(/white-space:\s*normal/);
  });

  it('nome, classe e situação têm piso E teto de largura', () => {
    // O teto é o que impede um dado mais comprido que o do teste de esticar a
    // coluna e empurrar a ação da linha para fora do diálogo.
    for (const coluna of [3, 7, 10]) {
      const corpo = corpoDe(`.tabela-em-modal .table td:nth-child(${coluna})`);
      expect(corpo, `coluna ${coluna} sem regra de largura`).not.toBeNull();
      expect(corpo).toMatch(/min-width:\s*\d+px/);
      expect(corpo).toMatch(/max-width:\s*\d+px/);
    }
  });

  it('nenhuma célula do diálogo usa -webkit-line-clamp', () => {
    // Tentativa descartada: `display: -webkit-box` briga com o layout de
    // tabela, a altura da linha continua vindo da célula mais alta, e a
    // terceira linha aparecia pela metade — cortada no meio da palavra, sem
    // reticências. Dar largura resolve sem esconder nada.
    for (const trecho of css.match(/\.tabela-em-modal[^{}]*\{[^{}]*\}/g) || []) {
      expect(trecho).not.toMatch(/-webkit-line-clamp/);
    }
  });
});

describe('o resumo de sete métricas muda de forma por viewport, e só por ela', () => {
  it('no desktop as sete ficam em UMA linha', () => {
    const cards = regra('.import-summary');
    expect(cards).toMatch(/grid-template-columns:\s*repeat\(\s*7\s*,/);
    // `auto-fit` com piso de 132px produzia de 4 a 7 colunas conforme a
    // largura, então a mesma tela mudava de forma sem motivo e o operador
    // reaprendia onde cada número ficava. Sete declaradas dão leitura estável.
    expect(cards).not.toMatch(/auto-fit|auto-fill/);
  });

  it('no tablet são 4 + 3', () => {
    expect(dentroDaMedia('(max-width: 1100px)')).toMatch(/\.import-summary\s*\{[^{}]*repeat\(\s*4\s*,/);
  });

  it('no celular são 2 colunas', () => {
    expect(dentroDaMedia('(max-width: 560px)')).toMatch(/\.import-summary\s*\{[^{}]*repeat\(\s*2\s*,/);
  });
});

describe('a nomenclatura visível é MuscleWare', () => {
  const visiveis = [
    ['App.jsx', /rotulo:\s*'MuscleWare'/],
    ['pages/adminPlatform.jsx', /Importar resultados MuscleWare/],
    ['pages/adminPlatform.jsx', /title="MuscleWare"/],
    ['pages/adminPlatform.jsx', /Modal title="Importar resultados MuscleWare"/]
  ];

  it.each(visiveis)('%s traz a grafia oficial', (arquivo, padrao) => {
    expect(ler(arquivo)).toMatch(padrao);
  });

  it('nenhum texto de interface usa a grafia antiga', () => {
    // A busca é pela grafia SEGUIDA DE ASPAS ou de fim de texto visível —
    // identificador (`AdminMuscleWar`) e rota (`admin/musclewar`) são contrato
    // técnico e permanecem, por instrução explícita.
    for (const arquivo of ['App.jsx', 'pages/adminPlatform.jsx', 'pages/adminEvent.jsx']) {
      const fonte = ler(arquivo);
      const visiveis = fonte.match(/(?:rotulo|title|label|hint|description|destino):?\s*=?\s*["'][^"']*MuscleWar(?!e)[^"']*["']/g);
      expect(visiveis, `grafia antiga em texto visível de ${arquivo}`).toBeNull();
    }
  });
});
