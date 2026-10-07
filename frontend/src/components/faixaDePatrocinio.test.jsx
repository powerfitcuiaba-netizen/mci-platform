import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import FaixaDePatrocinio from './faixaDePatrocinio';
import ParedeDePatrocinio from './paredeDePatrocinio';
import {
  CATEGORIAS,
  CATEGORIAS_COM_PASTILHA,
  MARCAS,
  marcasNaOrdemDaHierarquia
} from '../lib/patrocinadores';

// ==========================================================================
// A FAIXA DE PATROCÍNIO DO RODAPÉ.
//
// O QUE ESTE ARQUIVO PROTEGE
//
// Patrocínio é compromisso comercial. Uma marca que some, uma cota que inverte
// de tamanho, ou — pior — uma logo que ninguém contratou aparecendo na tela,
// são prejuízo de contrato, não defeito cosmético. Por isso a conferência mais
// importante aqui não é "a faixa renderiza": é que ela mostra EXATAMENTE o que
// a tela de entrada mostra, e nada além.
//
// A FONTE É UMA SÓ, E É CÓDIGO
//
// Os patrocinadores do produto vivem em `lib/patrocinadores.js`, com as artes
// em `public/patrocinadores/`. Não há tabela, não há rota, não há consulta — e
// por isso não há como esta faixa divergir da parede da entrada por um erro de
// cache, de filtro ou de tenant: as duas leem a mesma constante. O teste de
// equivalência abaixo trava isso.
//
// O QUE NÃO É TESTADO AQUI, E POR QUÊ
//
//   · "patrocinador inativo não aparece" — não existe campo de ativo. Toda
//     marca do catálogo está no ar; tirar do ar é tirar da lista.
//   · "link abre em nova aba", "rel seguro" — não existe campo de site. A
//     ausência de âncora é o que está testado, justamente para que ninguém
//     invente um destino.
//   · "tenant correto", "N+1" — não há requisição. As artes são caminho
//     estático no bundle; não há consulta a escalar nem organização a vazar.
//
// Cada uma dessas três é uma afirmação sobre o produto, e está medida abaixo
// na forma que o produto permite medir.
// ==========================================================================

afterEach(cleanup);

const faixa = () => {
  const { container } = render(<FaixaDePatrocinio />);
  return container.querySelector('.rodape-patro');
};

describe('as marcas que a faixa mostra', () => {
  it('1. mostra TODAS as marcas do catálogo, e cada uma anunciada uma vez', () => {
    // As cópias da esteira existem para cobrir a janela. Anunciar o mesmo
    // patrocinador quatro vezes é ruído para quem usa leitor de tela.
    const dentro = within(faixa());
    for (const marca of MARCAS) {
      expect(dentro.getAllByAltText(marca.nome), `${marca.nome} aparece mais de uma vez`).toHaveLength(1);
    }
  });

  it('2. não mostra NENHUMA marca que não esteja no catálogo', () => {
    // O contrário do caso 1, e é o que impede logo inventada: todo `alt`
    // anunciado tem de existir na lista, e todo `src` tem de ser um arquivo
    // declarado nela.
    const nomes = new Set(MARCAS.map(m => m.nome));
    const arquivos = new Set(MARCAS.map(m => `/patrocinadores/${m.arquivo}`));
    for (const img of faixa().querySelectorAll('img')) {
      const alt = img.getAttribute('alt');
      if (alt) expect(nomes.has(alt), `"${alt}" não está no catálogo`).toBe(true);
      expect(arquivos.has(img.getAttribute('src')), `${img.getAttribute('src')} não é arte do catálogo`).toBe(true);
    }
  });

  it('3. a ordem é a da hierarquia comercial: Global primeiro, Silver por último', () => {
    const anunciadas = [...faixa().querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(img => img.getAttribute('alt'));
    expect(anunciadas).toEqual(marcasNaOrdemDaHierarquia().map(m => m.nome));

    // E a sequência de cotas não volta atrás: nenhuma Global depois de uma Gold.
    const cotas = [...faixa().querySelectorAll('.esteira-grupo:not([aria-hidden]) .patro')]
      .map(no => CATEGORIAS.find(c => no.classList.contains(`t-${c}`)));
    const posicoes = cotas.map(c => CATEGORIAS.indexOf(c));
    expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b));
  });

  it('4. cada marca carrega a classe da PRÓPRIA cota, que é o que define a caixa', () => {
    const dentro = within(faixa());
    for (const marca of MARCAS) {
      const caixa = dentro.getByAltText(marca.nome).closest('.patro');
      expect(caixa.classList.contains(`t-${marca.categoria}`),
        `${marca.nome} não declarou a cota ${marca.categoria}`).toBe(true);
    }
  });

  it('5. a Silver vai sobre pastilha clara; as outras cotas, não', () => {
    const dentro = within(faixa());
    for (const marca of MARCAS) {
      const caixa = dentro.getByAltText(marca.nome).closest('.patro');
      const esperado = CATEGORIAS_COM_PASTILHA.includes(marca.categoria);
      expect(caixa.classList.contains('patro-pastilha'), `${marca.nome}`).toBe(esperado);
    }
  });

  it('6. cada arte aponta para o arquivo real em /patrocinadores/', () => {
    const dentro = within(faixa());
    for (const marca of MARCAS) {
      expect(dentro.getByAltText(marca.nome).getAttribute('src')).toBe(`/patrocinadores/${marca.arquivo}`);
    }
  });
});

describe('a MESMA fonte da tela de entrada', () => {
  it('7. o conjunto de marcas da faixa é idêntico ao da parede da entrada', () => {
    // A conferência que o pedido exige: login e rodapé têm de vir do mesmo
    // lugar. Se alguém criar uma segunda lista para o rodapé, isto reprova.
    const { container: comRodape } = render(<FaixaDePatrocinio />);
    const noRodape = [...comRodape.querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(i => i.getAttribute('src')).sort();

    cleanup();

    const { container: comParede } = render(<ParedeDePatrocinio />);
    const naParede = [...comParede.querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(i => i.getAttribute('src')).sort();

    expect(noRodape).toEqual(naParede);
    expect(noRodape).toHaveLength(MARCAS.length);
  });

  it('8. a duplicação é VISUAL: o catálogo continua com o número original de marcas', () => {
    const quantasAntes = MARCAS.length;
    const alvo = faixa();
    const anunciadas = alvo.querySelectorAll('.esteira-grupo:not([aria-hidden]) img').length;
    const desenhadas = alvo.querySelectorAll('img').length;

    expect(anunciadas).toBe(quantasAntes);
    // Há clone — é o que faz a emenda fechar — e ele é só pintura.
    expect(desenhadas).toBeGreaterThan(anunciadas);
    expect(MARCAS).toHaveLength(quantasAntes);
    expect(marcasNaOrdemDaHierarquia()).toHaveLength(quantasAntes);
  });
});

describe('acessibilidade', () => {
  it('9. os clones ficam fora da árvore de acessibilidade', () => {
    const grupos = faixa().querySelectorAll('.esteira-grupo');
    const clones = [...grupos].filter(g => g.getAttribute('aria-hidden') === 'true');
    expect(clones.length, 'a esteira não gerou nenhuma cópia').toBeGreaterThan(0);
    for (const clone of clones) {
      for (const img of clone.querySelectorAll('img')) expect(img.getAttribute('alt')).toBe('');
    }
  });

  it('10. a faixa é uma região nomeada, e o nome passa pelo dicionário', () => {
    const alvo = faixa();
    expect(alvo.tagName).toBe('FOOTER');
    const nome = alvo.getAttribute('aria-label');
    expect(nome).toBeTruthy();
    // Se `t` não achasse a entrada, devolveria a chave crua.
    expect(nome).not.toMatch(/^patrocinio\./);
  });

  it('11. o título aparece e não compete com as logos', () => {
    const cabecalho = faixa().querySelector('.rodape-patro-cab span');
    expect(cabecalho.textContent).toBeTruthy();
    expect(cabecalho.textContent).not.toMatch(/^patrocinio\./);
  });

  it('12. NÃO existe link: o catálogo não guarda site, e nenhum é inventado', () => {
    // Uma âncora sem destino real prometeria um site ao teclado e ao leitor de
    // tela. Enquanto o catálogo não tiver `site`, a logo é imagem e só.
    expect(faixa().querySelectorAll('a')).toHaveLength(0);
    expect(faixa().querySelectorAll('[href]')).toHaveLength(0);
  });
});

describe('movimento e carga', () => {
  it('13. o trilho declara ao menos duas cópias — é o que fecha a emenda', () => {
    const trilho = faixa().querySelector('.esteira-trilho');
    expect(Number(trilho.style.getPropertyValue('--copias'))).toBeGreaterThanOrEqual(2);
  });

  it('14. sem medida de largura, a esteira fica PARADA em vez de correr num ritmo inventado', () => {
    // Em jsdom `offsetWidth` é 0: não há layout. A esteira não pode escolher
    // uma duração qualquer nesse caso — ela para, e volta a andar quando a
    // medição chegar no navegador de verdade.
    const trilho = faixa().querySelector('.esteira-trilho');
    expect(trilho.style.animation).toBe('none');
    expect(trilho.style.getPropertyValue('--dur')).toBe('');
  });

  it('15. as artes do rodapé entram com prioridade BAIXA, atrás do conteúdo', () => {
    // A faixa não pode disputar banda com o ranking que a pessoa foi ler.
    for (const img of faixa().querySelectorAll('img')) {
      expect(img.getAttribute('fetchpriority')).toBe('low');
    }
  });

  it('16. e as da parede da entrada NÃO: lá a parede é o assunto da tela', () => {
    const { container } = render(<ParedeDePatrocinio />);
    for (const img of container.querySelectorAll('img')) {
      expect(img.getAttribute('fetchpriority')).not.toBe('low');
    }
  });

  it('17. nenhuma imagem é adiada: os clones repetem a MESMA URL do original', () => {
    // `loading="lazy"` não pouparia byte — o navegador serve todos da mesma
    // resposta — e arriscaria clone em branco dentro do `overflow: hidden`.
    for (const img of faixa().querySelectorAll('img')) {
      expect(img.getAttribute('loading')).toBeNull();
      expect(img.getAttribute('decoding')).toBe('async');
    }
  });
});
