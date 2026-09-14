import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ============================================================================
// O CASO DE ERRO QUE ESTE ARQUIVO EXISTE PARA PEGAR
//
// `animation` é atalho. Duas regras que alcançam O MESMO elemento e declaram
// `animation` não se somam: a de maior especificidade (ou a última, no empate)
// APAGA a outra — sem aviso, sem erro de build, sem falha de teste. O efeito
// perdido vira código morto que parece vivo.
//
// Aconteceu de verdade na FASE 2: `.nav-item.revela` e `.nav-item.is-active`
// declaravam as duas, e a segunda animação nunca rodou.
//
// Um par só é acusado quando NENHUM dos dois é um recorte mais específico do
// outro. `.revela` e `.nav-item.revela` podem coexistir: o segundo é uma
// sobrescrita deliberada do primeiro. Já `.nav-item.revela` e
// `.nav-item.is-active` são dois irmãos disputando o mesmo elemento — e o
// elemento pode ter as duas classes ao mesmo tempo.
// ============================================================================

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

// Fora de qualquer @media/@keyframes, pega `seletor { ... }` e o corpo.
function regrasComAnimacao(fonte) {
  const semKeyframes = fonte.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const regras = [];
  const padrao = /([^{}@]+)\{([^{}]*)\}/g;
  let achado;
  while ((achado = padrao.exec(semKeyframes))) {
    const corpo = achado[2];
    // `animation:` atalho — e não `animation-delay`, `animation-name` etc.,
    // que são declarações independentes e não se apagam entre si.
    if (!/(^|;|\s)animation\s*:/.test(corpo)) continue;
    for (const seletor of achado[1].split(',')) {
      const limpo = seletor.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      if (limpo) regras.push(limpo);
    }
  }
  return regras;
}

// Só sabemos raciocinar com segurança sobre seletor composto: um elemento só,
// sem combinador. `main > *` e afins ficam de fora — declarar o limite é mais
// honesto do que fingir que a varredura é completa.
function composto(seletor) {
  if (/[\s>+~]/.test(seletor)) return null;
  const [alvo, pseudoElemento = ''] = seletor.split('::');
  const classes = alvo.match(/\.[A-Za-z0-9_-]+/g);
  if (!classes) return null;
  return { pseudoElemento, classes: new Set(classes) };
}

const contem = (a, b) => [...b].every(c => a.has(c));

describe('animação no CSS', () => {
  const compostos = regrasComAnimacao(css)
    .map(seletor => ({ seletor, ...(composto(seletor) || {}) }))
    .filter(regra => regra.classes);

  it('a varredura enxerga o CSS de verdade, e não um arquivo vazio', () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(compostos.length).toBeGreaterThan(5);
  });

  it('nenhum par de regras compete pelo atalho `animation` no mesmo elemento', () => {
    const colisoes = [];
    for (let i = 0; i < compostos.length; i += 1) {
      for (let j = i + 1; j < compostos.length; j += 1) {
        const a = compostos[i];
        const b = compostos[j];
        if (a.pseudoElemento !== b.pseudoElemento) continue;      // elementos diferentes
        if (a.seletor === b.seletor) continue;                     // a mesma regra em dois lugares é outro assunto
        const compartilham = [...a.classes].some(c => b.classes.has(c));
        if (!compartilham) continue;
        if (contem(a.classes, b.classes) || contem(b.classes, a.classes)) continue; // sobrescrita deliberada
        colisoes.push(`${a.seletor}  x  ${b.seletor}`);
      }
    }
    expect(colisoes).toEqual([]);
  });
});
