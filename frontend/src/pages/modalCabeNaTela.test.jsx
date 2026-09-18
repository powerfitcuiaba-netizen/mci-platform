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

describe('o diálogo cabe na viewport', () => {
  it('o modal tem teto de altura e de largura em unidades de viewport', () => {
    const modal = regra('.modal');
    expect(modal, 'sem max-height o diálogo cresce com o conteúdo').toMatch(/max-height:\s*min\(92vh,\s*92dvh\)/);
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

  it('os cards de métricas reorganizam em vez de estourar a largura', () => {
    const cards = regra('.import-summary');
    expect(cards).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/);
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
