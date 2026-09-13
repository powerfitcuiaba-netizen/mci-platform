import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Achar a folha de estilo sem depender do diretório de execução.
//
// Duas saídas fáceis não servem: sob o Vite o `import.meta.url` é uma URL
// http, e `./styles.css?raw` volta VAZIO porque o plugin de CSS intercepta o
// import. E caminho relativo ao cwd só funciona se alguém chamar a suíte da
// pasta certa — foi assim que um teste deste repositório passou aqui e
// reprovou na CI com MODULE_NOT_FOUND.
//
// Então: sobe a árvore até achar o arquivo. Funciona chamando de frontend/,
// da raiz do repositório ou de qualquer lugar entre os dois.
function acharFolha() {
  const candidatos = ['src/styles.css', 'frontend/src/styles.css'];
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const rel of candidatos) {
      const tentativa = path.join(dir, rel);
      if (existsSync(tentativa)) return tentativa;
    }
    const pai = path.dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
  throw new Error('styles.css não encontrado a partir de ' + process.cwd());
}
const css = readFileSync(acharFolha(), 'utf8');

// ==========================================================================
// A GAVETA DO CELULAR PRECISA ROLAR.
//
// Em telas até 900px a barra lateral vira `position: fixed`, ou seja, sai do
// fluxo da página. A página rolar deixa de resolver: a gaveta precisa rolar
// SOZINHA. Sem isso, o que passa da altura da tela some e não há gesto que
// alcance.
//
// Medido antes da correção, com o menu de administração aberto:
//
//   360x640 .... 1319px de conteúdo, 679px inalcançáveis
//   390x844 .... 1319px de conteúdo, 475px inalcançáveis
//   430x932 .... 1319px de conteúdo, 387px inalcançáveis
//
// O último item da lista é o botão SAIR. Um administrador não conseguia sair
// da própria conta pelo celular. Não era corte estético.
//
// No desktop o defeito não existe e nunca existiu: lá a barra está no fluxo
// e a página inteira rola — conferido em 1440x900, 1366x768 e 1280x720, com
// o Sair alcançável nos três.
//
// Este teste lê o CSS porque é onde a regra vive: o jsdom não aplica folha de
// estilo, então verificar pelo componente renderizado não provaria nada.
// ==========================================================================

function blocoDaMedia(largura) {
  const marca = `@media (max-width: ${largura}px) {`;
  const inicio = css.indexOf(marca);
  if (inicio < 0) return null;
  let nivel = 0;
  for (let i = inicio + marca.length - 1; i < css.length; i++) {
    if (css[i] === '{') nivel++;
    else if (css[i] === '}') { nivel--; if (nivel === 0) return css.slice(inicio, i + 1); }
  }
  return null;
}

const mobile = blocoDaMedia(900);
const regraDaGaveta = (() => {
  const i = mobile.indexOf('.sidebar {');
  return mobile.slice(i, mobile.indexOf('}', i));
})();

describe('barra lateral como gaveta no celular', () => {
  it('a media query de 900px existe e declara a gaveta', () => {
    expect(mobile, 'bloco @media (max-width: 900px) não encontrado').toBeTruthy();
    expect(regraDaGaveta).toContain('position: fixed');
  });

  it('rola sozinha — é fixa, então a rolagem da página não a alcança', () => {
    expect(regraDaGaveta, 'sem overflow-y, o excedente fica inalcançável').toMatch(/overflow-y:\s*auto/);
  });

  it('a rolagem não escapa para a página atrás', () => {
    expect(regraDaGaveta).toMatch(/overscroll-behavior:\s*contain/);
  });

  it('usa altura dinâmica: a barra do navegador do celular entra e sai', () => {
    // 100vh mede a tela cheia mesmo com a barra de endereço visível, e o fim
    // da gaveta fica embaixo dela. dvh acompanha.
    expect(regraDaGaveta).toMatch(/height:\s*100dvh/);
    // e mantém 100vh antes, como reserva para quem não conhece dvh
    const ordem = regraDaGaveta.indexOf('height: 100vh') < regraDaGaveta.indexOf('height: 100dvh');
    expect(ordem, '100vh precisa vir ANTES de 100dvh para servir de reserva').toBe(true);
  });

  it('o rodapé vai para o fim da LISTA, não para o fim da tela', () => {
    // Com a gaveta rolando, `margin-top: auto` deixaria um vão no meio quando
    // a lista é curta.
    expect(mobile).toMatch(/\.sidebar \.sidebar-foot\s*\{[^}]*margin-top:\s*var\(--e\d\)/);
  });

  it('no desktop a barra continua no fluxo, sem rolagem própria', () => {
    const desktop = css.slice(css.indexOf('.sidebar {'), css.indexOf('}', css.indexOf('.sidebar {')));
    expect(desktop).not.toMatch(/position:\s*fixed/);
    expect(desktop).not.toMatch(/overflow-y:\s*auto/);
  });
});
