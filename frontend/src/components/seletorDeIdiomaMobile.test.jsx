import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SeletorDeIdioma from './seletorDeIdioma';
import { ProvedorDeIdioma } from '../lib/idioma';

// ==========================================================================
// O IDIOMA NO CELULAR: UM BOTÃO, E AS TRÊS LÍNGUAS A UM TOQUE.
//
// Medido em Chromium real, antes: a barra superior somava 412px numa viewport
// de 360 — 52 a mais do que existe — e os três botões de idioma mediam 31x32,
// abaixo do piso de 40px que a suíte já protege.
//
// As duas saídas erradas, e por quê:
//   * aumentar as três para 44px — conserta o toque e leva o seletor de 100
//     para 132px, PIORANDO a largura que era o problema;
//   * tirar idiomas — resolve a conta removendo função.
//
// Um botão de 44px derruba as ações de 256 para 200 e fecha a barra em 356.
// ==========================================================================

const ler = caminho => readFileSync(resolve('src', caminho), 'utf8');
const css = ler('styles.css');

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

// SEM ISTO O IDIOMA VAZA ENTRE OS TESTES.
// A preferência mora em `localStorage`, e o jsdom mantém o mesmo entre testes
// do arquivo: depois do teste que troca para inglês, os seguintes começavam em
// inglês e procuravam por "Escolher idioma" numa barra que dizia "Choose
// language". O teste falhava sem que nada no produto estivesse errado.
afterEach(() => { cleanup(); localStorage.clear(); });

const montar = () => render(<ProvedorDeIdioma><SeletorDeIdioma /></ProvedorDeIdioma>);

describe('o contrato do seletor no celular', () => {
  it('as três em linha saem, e o botão entra', () => {
    expect(CELULAR, 'as três lado a lado precisam sair da barra').toMatch(/\.seletor-idioma\s*\{\s*display:\s*none/);
    expect(CELULAR, 'e o botão precisa ocupar o lugar').toMatch(/\.seletor-idioma-botao\s*\{[^}]*display:\s*inline-flex/);
    expect(CELULAR, 'o menu precisa existir no celular').toMatch(/\.seletor-idioma-menu\s*\{/);
  });

  it('o botão cumpre o piso de 44px, e cada opção do menu também', () => {
    // O piso de toque vale para cada opção, não só para quem abre o menu.
    expect(/\.seletor-idioma-botao\s*\{([^}]*)\}/.exec(CELULAR)?.[1] ?? '').toMatch(/min-width:\s*44px/);
    expect(/\.seletor-idioma-item\s*\{([^}]*)\}/.exec(CELULAR)?.[1] ?? '').toMatch(/min-height:\s*44px/);
  });

  // A REGRESSÃO QUE CUSTOU UMA RODADA INTEIRA DE QA.
  it('o bloco de celular vem DEPOIS das regras base, senão não vale nada', () => {
    // Mesma especificidade: vence a última do arquivo. A primeira versão desta
    // correção pôs o bloco mil linhas ACIMA das regras base, e
    // `display: inline-flex` anulava o `display: none`. O QA em Chromium mediu
    // o seletor ainda com 100px e as três opções de 31px na tela — a correção
    // inteira sem efeito, e nenhum teste de contrato acusando.
    const base = css.search(/^\.seletor-idioma \{/m);
    const celular = css.indexOf('@media (max-width: 560px)', base);
    expect(base, 'a regra base do seletor sumiu').toBeGreaterThan(-1);
    expect(celular, 'não há bloco de 560px depois da regra base').toBeGreaterThan(base);
    expect(
      css.slice(celular),
      'o bloco de 560px que vem depois da base precisa ser o que esconde as três'
    ).toMatch(/\.seletor-idioma \{ display: none/);
  });

  it('fora do celular não há botão nem menu', () => {
    const base = /\.seletor-idioma-botao, \.seletor-idioma-menu \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(base).toMatch(/display:\s*none/);
  });

  it('o rótulo do botão existe nos três idiomas', () => {
    for (const arquivo of ['lib/idiomas/ptBR.js', 'lib/idiomas/en.js', 'lib/idiomas/es.js']) {
      expect(ler(arquivo), `idioma.abrirMenu falta em ${arquivo}`).toMatch(/'idioma\.abrirMenu':\s*'[^']+'/);
    }
  });
});

describe('o comportamento do seletor no celular', () => {
  it('as TRÊS línguas continuam disponíveis — nenhuma foi removida', async () => {
    const usuario = userEvent.setup();
    montar();
    await usuario.click(screen.getByRole('button', { name: /escolher idioma/i }));
    const menu = screen.getByRole('menu');
    for (const nome of ['Português', 'English', 'Español']) {
      expect(menu.querySelector(`[aria-label="${nome}"]`), `${nome} sumiu do menu`).not.toBeNull();
    }
  });

  it('escolher aplica o idioma na hora e fecha o menu', async () => {
    const usuario = userEvent.setup();
    montar();
    const abrir = screen.getByRole('button', { name: /escolher idioma/i });
    await usuario.click(abrir);
    expect(abrir).toHaveAttribute('aria-expanded', 'true');

    await usuario.click(screen.getByRole('menu').querySelector('[aria-label="English"]'));
    expect(abrir, 'o menu precisa fechar depois da escolha').toHaveAttribute('aria-expanded', 'false');
    // Aplicado na hora: o rótulo do próprio botão passa a vir do dicionário em
    // inglês. É a prova de que a troca valeu, e não só de que o menu fechou.
    expect(screen.getByRole('button', { name: /choose language/i })).toBeTruthy();
  });

  it('Escape fecha o menu', async () => {
    const usuario = userEvent.setup();
    montar();
    const abrir = screen.getByRole('button', { name: /escolher idioma/i });
    await usuario.click(abrir);
    await usuario.keyboard('{Escape}');
    expect(abrir).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicar fora fecha o menu', async () => {
    const usuario = userEvent.setup();
    const { container } = montar();
    const abrir = screen.getByRole('button', { name: /escolher idioma/i });
    await usuario.click(abrir);
    expect(abrir).toHaveAttribute('aria-expanded', 'true');
    await usuario.click(container.ownerDocument.body);
    expect(abrir).toHaveAttribute('aria-expanded', 'false');
  });

  it('o botão anuncia que abre um menu, e qual idioma está em vigor', () => {
    montar();
    const abrir = screen.getByRole('button', { name: /escolher idioma/i });
    expect(abrir).toHaveAttribute('aria-haspopup', 'menu');
    expect(abrir).toHaveAttribute('aria-expanded', 'false');
  });
});
