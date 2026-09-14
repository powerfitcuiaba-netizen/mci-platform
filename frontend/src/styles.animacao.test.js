import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  // Comentários saem ANTES de qualquer coisa: um comentário com ponto e
  // chaves dentro era lido como seletor, e a varredura acusava uma "classe"
  // que na verdade era prosa.
  const semComentarios = fonte.replace(/\/\*[\s\S]*?\*\//g, '');
  const semKeyframes = semComentarios.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
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

// Um seletor de animação que não casa com nada é efeito que NÃO existe e
// parece existir. Aconteceu aqui: escrevi `.chat-body .bubble` para a bolha de
// mensagem, e a classe real é `.chat-msg` — a regra ficou no arquivo, bonita e
// morta. A varredura confere que cada classe animada aparece de fato no JSX.
describe('classes animadas existem no código', () => {
  const fonte = ['src/pages', 'src/components', 'src/App.jsx']
    .flatMap(alvo => {
      const caminho = resolve(process.cwd(), alvo);
      if (!statSync(caminho).isDirectory()) return [readFileSync(caminho, 'utf8')];
      return readdirSync(caminho)
        .filter(nome => /\.jsx?$/.test(nome) && !nome.includes('.test.'))
        .map(nome => readFileSync(resolve(caminho, nome), 'utf8'));
    })
    .join('\n');

  it('toda classe que recebe `animation` é usada em algum componente', () => {
    const orfas = [];
    for (const seletor of regrasComAnimacao(css)) {
      // Só classes simples; pseudo-elemento e estado não aparecem no JSX.
      const classes = seletor.replace(/::?[a-z-]+(\([^)]*\))?/g, '').match(/\.[A-Za-z0-9_-]+/g);
      if (!classes) continue;
      for (const classe of classes) {
        const nome = classe.slice(1);
        // Classes do próprio motor são montadas em JS a partir de variáveis.
        if (['revela', 'varredura', 'linha-afetada', 'impacto', 'campeao'].some(base => nome.startsWith(base))) continue;
        if (!fonte.includes(nome)) orfas.push(`${seletor} → classe "${nome}" não aparece em nenhum componente`);
      }
    }
    expect([...new Set(orfas)]).toEqual([]);
  });
});

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
