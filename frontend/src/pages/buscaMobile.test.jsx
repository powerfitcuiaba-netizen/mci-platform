import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BuscaGlobal } from '../App.jsx';
import { ProvedorDeIdioma } from '../lib/idioma';

// ==========================================================================
// A BUSCA GLOBAL NO CELULAR: BOTÃO PRIMEIRO, CAMPO QUANDO PEDIREM.
//
// A barra superior tem 356px de custo fixo numa viewport de 360: padding 32,
// botão de menu 44, vãos 24 e as ações 256. Medido em Chromium real, o
// documento ganhava 33px de rolagem horizontal em 360x800 e 19px em 390x844.
//
// As saídas descartadas, e por quê:
//   * encolher os botões — quebra o piso de 40px de alvo de toque que a suíte
//     já protege;
//   * `display: none` na busca — resolve a conta e tira uma função de quem usa
//     telefone.
//
// O botão custa os mesmos 44px dos vizinhos, e aberto a busca cobre a barra.
//
// A medição de pixel vive no QA em navegador; aqui fica o CONTRATO: o botão
// existe, abre, foca, fecha, e o estilo que decide tudo isso não voltou para
// dentro de um `style` inline — que foi a causa de nenhuma faixa de tela
// conseguir alcançar o item flex da barra.
// ==========================================================================

const ler = caminho => readFileSync(resolve('src', caminho), 'utf8');
const app = ler('App.jsx');
const css = ler('styles.css');

// Recorta um `@media` CONTANDO CHAVES. A primeira versão parava no primeiro
// `}` em início de linha e devolvia só as duas regras iniciais do bloco — as
// asserções seguintes procuravam num texto que já tinha acabado.
// TODOS os blocos daquela condição, e não só o primeiro.
// A folha tem mais de um `@media (max-width: 560px)` — um perto do topo e
// outro no fim, junto das regras que ele precisa vencer. Ler só o primeiro
// fazia a asserção procurar num texto onde a regra nunca esteve.
const dentroDaMedia = condicao => {
  const partes = [];
  let de = 0;
  for (;;) {
    const inicio = css.indexOf(`@media ${condicao}`, de);
    if (inicio < 0) break;
    const abre = css.indexOf('{', inicio);
    let nivel = 0;
    for (let i = abre; i < css.length; i += 1) {
      if (css[i] === '{') nivel += 1;
      else if (css[i] === '}') {
        nivel -= 1;
        if (nivel === 0) { partes.push(css.slice(abre + 1, i)); de = i + 1; break; }
      }
    }
    if (nivel !== 0) break;
  }
  return partes.join('\n');
};
const CELULAR = dentroDaMedia('(max-width: 560px)');

afterEach(cleanup);

describe('o contrato da busca no celular', () => {
  it('o estilo do item flex mora no CSS, nunca num style inline', () => {
    // `flex: '1 1 260px'` inline vencia qualquer @media: foi assim que a busca
    // recusou encolher e empurrou a barra de ações para fora da viewport.
    expect(app, 'o wrapper da busca voltou a ter estilo inline').not.toMatch(/style=\{\{\s*position:\s*'relative',\s*flex:/);
    expect(css, 'sem a classe não há como a faixa de tela agir').toMatch(/\.busca-global\s*\{/);
  });

  it('abaixo de 560px a busca vira botão, e o campo só aparece expandido', () => {
    expect(CELULAR, 'a busca precisa sair da barra no celular').toMatch(/\.busca-global\s*\{\s*display:\s*none/);
    expect(CELULAR, 'e o botão precisa entrar no lugar dela').toMatch(/\.busca-abrir\s*\{\s*display:\s*grid/);
    expect(CELULAR, 'expandida, a busca reaparece').toMatch(/\.busca-global\.is-expandida\s*\{/);
    expect(CELULAR, 'e traz por onde fechar').toMatch(/\.busca-global\.is-expandida \.busca-fechar\s*\{\s*display:\s*grid/);
  });

  it('a busca expandida nunca passa da barra', () => {
    const regra = /\.busca-global\.is-expandida\s*\{([^}]*)\}/.exec(CELULAR)?.[1] ?? '';
    expect(regra, 'sem inset preso à barra ela volta a estourar').toMatch(/inset:\s*0/);
    expect(regra, '`max-width: 420px` herdado espremeria a busca aberta').toMatch(/max-width:\s*none/);
  });

  it('fora do celular não há botão de abrir nem de fechar', () => {
    // Um botão para abrir o que já está aberto é ruído para o leitor de tela.
    const base = /\.busca-abrir, \.busca-fechar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(base).toMatch(/display:\s*none/);
  });

  it('os rótulos existem nos três idiomas', () => {
    for (const arquivo of ['lib/idiomas/ptBR.js', 'lib/idiomas/en.js', 'lib/idiomas/es.js']) {
      const fonte = ler(arquivo);
      expect(fonte, `busca.abrir falta em ${arquivo}`).toMatch(/'busca\.abrir':\s*'[^']+'/);
      expect(fonte, `busca.fechar falta em ${arquivo}`).toMatch(/'busca\.fechar':\s*'[^']+'/);
    }
  });
});

describe('o comportamento da busca no celular', () => {
  const montar = () => render(<ProvedorDeIdioma><BuscaGlobal navegar={vi.fn()} /></ProvedorDeIdioma>);

  it('o botão abre a busca, leva o foco ao campo, e o X fecha', async () => {
    const usuario = userEvent.setup();
    montar();

    const abrir = screen.getByRole('button', { name: /abrir busca/i });
    expect(abrir).toHaveAttribute('aria-expanded', 'false');

    await usuario.click(abrir);
    expect(abrir).toHaveAttribute('aria-expanded', 'true');
    expect(document.activeElement, 'o foco precisa ir para o campo').toBe(screen.getByLabelText(/busca global/i));

    await usuario.click(screen.getByRole('button', { name: /fechar busca/i }));
    expect(abrir).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape fecha a busca expandida', async () => {
    const usuario = userEvent.setup();
    montar();

    const abrir = screen.getByRole('button', { name: /abrir busca/i });
    await usuario.click(abrir);
    expect(abrir).toHaveAttribute('aria-expanded', 'true');

    await usuario.keyboard('{Escape}');
    expect(abrir, 'Escape precisa fechar quando o foco está no campo').toHaveAttribute('aria-expanded', 'false');
  });

  it('o campo continua funcionando: o que se digita fica', async () => {
    const usuario = userEvent.setup();
    montar();
    await usuario.click(screen.getByRole('button', { name: /abrir busca/i }));
    const campo = screen.getByLabelText(/busca global/i);
    await usuario.type(campo, 'Ipiranga');
    expect(campo).toHaveValue('Ipiranga');
  });
});
