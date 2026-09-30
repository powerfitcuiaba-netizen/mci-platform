import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ============================================================================
// O DEFEITO QUE ESTE ARQUIVO GUARDA, e por que não bastava o gate visual.
//
// Uma foto de 1280x960 no visualizador de story renderizava 1275px de largura
// dentro de uma viewport de 320px — MEDIDO em Chromium, não suposto. E o gate
// de responsividade aprovava, porque ele mede rolagem horizontal do DOCUMENTO:
// o corpo do modal rola por dentro, então `document.scrollWidth` continuava
// 320. O que a pessoa via era a faixa central de uma foto de retrato.
//
// A correção é uma linha de CSS, e é justamente por ser uma linha que ela
// precisa de guarda: some numa limpeza de reset sem que nada quebre no build,
// nos testes de unidade ou no gate visual.
//
// A MEDIÇÃO DE VERDADE está em `scripts/qa/foto-cabe-na-tela.mjs`, que mede a
// borda direita de cada imagem em 7 telas x 6 larguras num Chromium real. Este
// teste é o guarda BARATO, que roda na CI junto com o resto da suíte — a CI não
// tem Playwright instalado, e instalar navegador em toda execução custaria mais
// do que resolve. Os dois se complementam: aqui a regra existe, lá ela funciona.
// ============================================================================

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('a foto nunca passa da largura do que a contém', () => {
  it('existe a regra de piso para `img` e `video`', () => {
    // O seletor tem de alcançar QUALQUER imagem: é o caso da que não tem classe
    // nenhuma, como a do visualizador de story.
    const regra = semComentarios.match(/(^|\n)\s*img,\s*video\s*\{([^}]*)\}/);
    expect(regra, 'a regra `img, video { … }` saiu de styles.css').toBeTruthy();
    expect(regra[2]).toMatch(/max-width:\s*100%/);
    // `height: auto` acompanha porque, com atributos width/height na marcação,
    // limitar só a largura esmagaria a proporção da foto.
    expect(regra[2]).toMatch(/height:\s*auto/);
  });

  it('a regra está fora de @media — vale em toda largura', () => {
    const antesDoPrimeiroMedia = semComentarios.split('@media')[0];
    expect(antesDoPrimeiroMedia).toMatch(/img,\s*video\s*\{[^}]*max-width:\s*100%/);
  });

  it('nenhuma regra posterior devolve `max-width` ilimitado a imagem', () => {
    // `max-width: none` num seletor de imagem desfaz o piso em silêncio.
    const suspeitas = [];
    const padrao = /([^{}@]+)\{([^{}]*)\}/g;
    let achado;
    while ((achado = padrao.exec(semComentarios))) {
      const seletor = achado[1].trim();
      if (!/\b(img|video)\b/.test(seletor)) continue;
      if (/max-width:\s*(none|unset|initial)/.test(achado[2])) suspeitas.push(seletor);
    }
    expect(suspeitas, `estes seletores soltam a largura da imagem: ${suspeitas.join(' | ')}`).toEqual([]);
  });

  it('o gate de medição continua versionado e citado', () => {
    const gate = readFileSync(resolve(process.cwd(), '../scripts/qa/foto-cabe-na-tela.mjs'), 'utf8');
    // Se alguém apagar o gate, este teste avisa em vez de a medição
    // simplesmente deixar de existir sem que ninguém note.
    expect(gate).toContain('getBoundingClientRect');
    expect(gate).toContain('visualizador de story');
    const raiz = readFileSync(resolve(process.cwd(), '../package.json'), 'utf8');
    expect(raiz).toContain('qa:foto:responsiva');
  });
});
