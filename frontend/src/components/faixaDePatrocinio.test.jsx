import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// A FAIXA DE PATROCÍNIO DO RODAPÉ, LENDO O CATÁLOGO DO BANCO.
//
// O QUE MUDOU DESDE A VERSÃO ANTERIOR DESTE ARQUIVO
//
// Ele media a faixa contra `lib/patrocinadores.js`, a lista versionada que era
// a fonte do produto. A fonte passou a ser `OfficialSponsor`, servido por
// `/public/sponsors` — e as asserções mudaram de lado JUNTO com ela. Nenhuma
// garantia foi abandonada: o que era "mostra as 15 marcas do arquivo" virou
// "mostra exatamente o que o servidor devolveu, e nada além".
//
// O QUE ESTE ARQUIVO PROTEGE
//
// Patrocínio é compromisso comercial. Uma marca que some, um nível que inverte
// de tamanho, ou — pior — uma logo que ninguém contratou aparecendo na tela,
// são prejuízo de contrato, não defeito cosmético.
//
// E A ORDEM É DO SERVIDOR. A tela NÃO reordena: ela desenha na ordem recebida.
// Ordenar aqui criaria a segunda fonte da hierarquia, e as duas divergiriam no
// primeiro nível novo.
// ==========================================================================

const chamadas = vi.hoisted(() => ({ sponsors: 0 }));
const respostas = vi.hoisted(() => ({ items: [] }));

vi.mock('../services/api', () => ({
  api: {
    publicApi: {
      sponsors: vi.fn(() => {
        chamadas.sponsors += 1;
        return Promise.resolve({ items: respostas.items });
      })
    }
  },
  urlDeMidiaPublica: caminho => `http://api.test${caminho}`
}));

const { default: FaixaDePatrocinio } = await import('./faixaDePatrocinio');
const { default: ParedeDePatrocinio } = await import('./paredeDePatrocinio');
const catalogo = await import('../lib/catalogoDePatrocinio');

const patrocinador = (id, name, level, extra = {}) => ({
  id, code: id.toUpperCase(), name, level, sortOrder: 0, active: true,
  siteUrl: null, hasLogo: true, ...extra
});

// Já na ordem em que o servidor devolve: nível primeiro, ordem dentro dele.
const CATALOGO = [
  patrocinador('s1', 'Adaptogen Science', 'GLOBAL', { sortOrder: 0 }),
  patrocinador('s2', 'Max Titanium', 'GLOBAL', { sortOrder: 1 }),
  patrocinador('s3', 'Soldiers Nutrition', 'DIAMANTE', { sortOrder: 0 }),
  patrocinador('s4', 'Black Skull', 'GOLD', { sortOrder: 0 }),
  patrocinador('s5', 'Tan Masters', 'SILVER', { sortOrder: 0 })
];

beforeEach(() => {
  chamadas.sponsors = 0;
  respostas.items = CATALOGO;
  catalogo.invalidar();
});
afterEach(cleanup);

const montarFaixa = async () => {
  const { container } = render(<FaixaDePatrocinio />);
  await waitFor(() => expect(container.querySelector('.rodape-patro')).toBeTruthy());
  return container.querySelector('.rodape-patro');
};

describe('as marcas que a faixa mostra', () => {
  it('1. mostra TODAS as marcas que o servidor devolveu, cada uma anunciada uma vez', async () => {
    // As cópias da esteira existem para cobrir a janela. Anunciar o mesmo
    // patrocinador quatro vezes é ruído para quem usa leitor de tela.
    const dentro = within(await montarFaixa());
    for (const p of CATALOGO) {
      expect(dentro.getAllByAltText(`Logo ${p.name}`), `${p.name} aparece mais de uma vez`).toHaveLength(1);
    }
  });

  it('2. não mostra NENHUMA marca fora do que o servidor devolveu', async () => {
    // O contrário do caso 1, e é o que impede logo inventada: todo `alt`
    // anunciado tem de vir do catálogo, e todo `src` tem de ser a rota de
    // logo de um id do catálogo — nunca um caminho de arquivo.
    const nomes = new Set(CATALOGO.map(p => `Logo ${p.name}`));
    const ids = new Set(CATALOGO.map(p => p.id));
    for (const img of (await montarFaixa()).querySelectorAll('img')) {
      const alt = img.getAttribute('alt');
      if (alt) expect(nomes.has(alt), `"${alt}" não está no catálogo`).toBe(true);
      const achado = /\/media\/sponsors\/([^/]+)\/logo$/.exec(img.getAttribute('src'));
      expect(achado, `${img.getAttribute('src')} não é a rota de logo`).toBeTruthy();
      expect(ids.has(achado[1]), `${achado[1]} não está no catálogo`).toBe(true);
    }
  });

  it('3. desenha na ordem do SERVIDOR, sem reordenar', async () => {
    const anunciadas = [...(await montarFaixa())
      .querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(img => img.getAttribute('alt'));
    expect(anunciadas).toEqual(CATALOGO.map(p => `Logo ${p.name}`));
  });

  it('4. e NÃO reordena nem quando a lista chega fora da hierarquia', async () => {
    // Se a tela ordenasse por conta própria, este caso passaria "consertando"
    // o servidor — e a hierarquia teria duas fontes. Quem ordena é o banco.
    respostas.items = [...CATALOGO].reverse();
    catalogo.invalidar();
    const anunciadas = [...(await montarFaixa())
      .querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(img => img.getAttribute('alt'));
    expect(anunciadas).toEqual([...CATALOGO].reverse().map(p => `Logo ${p.name}`));
  });

  it('5. cada marca carrega a classe do PRÓPRIO nível, que é o que define a caixa', async () => {
    const dentro = within(await montarFaixa());
    for (const p of CATALOGO) {
      const caixa = dentro.getByAltText(`Logo ${p.name}`).closest('.patro');
      expect(caixa.classList.contains(`t-${p.level.toLowerCase()}`),
        `${p.name} não declarou o nível ${p.level}`).toBe(true);
    }
  });

  it('6. a Silver vai sobre pastilha clara; os outros níveis, não', async () => {
    const dentro = within(await montarFaixa());
    for (const p of CATALOGO) {
      const caixa = dentro.getByAltText(`Logo ${p.name}`).closest('.patro');
      expect(caixa.classList.contains('patro-pastilha'), p.name).toBe(p.level === 'SILVER');
    }
  });
});

describe('a MESMA fonte da tela de entrada', () => {
  it('7. a parede da entrada e o rodapé mostram o mesmo conjunto', async () => {
    const noRodape = [...(await montarFaixa())
      .querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(i => i.getAttribute('src')).sort();

    cleanup();
    catalogo.invalidar();

    const { container } = render(<ParedeDePatrocinio />);
    await waitFor(() => expect(container.querySelector('.parede-patro')).toBeTruthy());
    const naParede = [...container.querySelectorAll('.esteira-grupo:not([aria-hidden]) img')]
      .map(i => i.getAttribute('src')).sort();

    expect(noRodape).toEqual(naParede);
    expect(noRodape).toHaveLength(CATALOGO.length);
  });

  it('8. UMA requisição serve as duas telas — o catálogo é buscado uma vez', async () => {
    // Sem o cache seriam duas requisições iguais, e uma a cada navegação.
    await montarFaixa();
    render(<ParedeDePatrocinio />);
    await waitFor(() => expect(screen.getAllByAltText('Logo Max Titanium').length).toBeGreaterThan(0));
    expect(chamadas.sponsors, 'o catálogo foi buscado mais de uma vez').toBe(1);
  });

  it('9. a duplicação é VISUAL: o clone não vira item do catálogo', async () => {
    const alvo = await montarFaixa();
    const anunciadas = alvo.querySelectorAll('.esteira-grupo:not([aria-hidden]) img').length;
    const desenhadas = alvo.querySelectorAll('img').length;
    expect(anunciadas).toBe(CATALOGO.length);
    // Há clone — é o que faz a emenda fechar — e ele é só pintura.
    expect(desenhadas).toBeGreaterThan(anunciadas);
  });
});

describe('o que o servidor esconde, a tela não mostra', () => {
  it('10. catálogo vazio não vira faixa vazia', async () => {
    respostas.items = [];
    catalogo.invalidar();
    const { container } = render(<FaixaDePatrocinio />);
    await waitFor(() => expect(chamadas.sponsors).toBe(1));
    expect(container.querySelector('.rodape-patro')).toBeNull();
  });

  it('11. falha de rede NÃO derruba a tela — a faixa some e o resto segue', async () => {
    const { api } = await import('../services/api');
    api.publicApi.sponsors.mockRejectedValueOnce(new Error('rede fora'));
    catalogo.invalidar();
    const { container } = render(<FaixaDePatrocinio />);
    await waitFor(() => expect(api.publicApi.sponsors).toHaveBeenCalled());
    expect(container.querySelector('.rodape-patro')).toBeNull();
  });

  it('12. a CHAVE do armazenamento nunca aparece — o que a API dá é `hasLogo`', async () => {
    const html = (await montarFaixa()).outerHTML;
    expect(html).not.toMatch(/logoKey/i);
    expect(html).not.toMatch(/sponsors\/[0-9a-f-]{36}\./i);
  });
});

describe('link para o site do patrocinador', () => {
  it('13. SEM site cadastrado, a logo não é link', async () => {
    const alvo = await montarFaixa();
    expect(alvo.querySelectorAll('a')).toHaveLength(0);
  });

  it('14. COM site, a logo vira link seguro, em aba nova', async () => {
    respostas.items = [patrocinador('s9', 'Com Site', 'GLOBAL', { siteUrl: 'https://exemplo.test' })];
    catalogo.invalidar();
    const alvo = await montarFaixa();

    const link = alvo.querySelector('a.patro-link');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://exemplo.test');
    expect(link.getAttribute('target')).toBe('_blank');
    // `noopener` evita que a página aberta alcance a nossa janela.
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('aria-label')).toMatch(/Com Site/);
  });

  it('15. o CLONE do link não vira parada de tabulação', async () => {
    // Ele está fora da árvore de acessibilidade; uma âncora ali devolveria a
    // mesma marca ao teclado tantas vezes quantas cópias a esteira montar.
    respostas.items = [patrocinador('s9', 'Com Site', 'GLOBAL', { siteUrl: 'https://exemplo.test' })];
    catalogo.invalidar();
    const alvo = await montarFaixa();
    const clones = alvo.querySelectorAll('.esteira-grupo[aria-hidden="true"] a');
    expect(clones).toHaveLength(0);
  });
});

describe('acessibilidade e carga', () => {
  it('16. os clones ficam fora da árvore de acessibilidade', async () => {
    const grupos = (await montarFaixa()).querySelectorAll('.esteira-grupo');
    const clones = [...grupos].filter(g => g.getAttribute('aria-hidden') === 'true');
    expect(clones.length, 'a esteira não gerou nenhuma cópia').toBeGreaterThan(0);
    for (const clone of clones) {
      for (const img of clone.querySelectorAll('img')) expect(img.getAttribute('alt')).toBe('');
    }
  });

  it('17. toda logo anunciada diz "Logo <nome>"', async () => {
    const dentro = within(await montarFaixa());
    for (const p of CATALOGO) expect(dentro.getByAltText(`Logo ${p.name}`)).toBeTruthy();
  });

  it('18. a faixa é uma região nomeada, e o nome passa pelo dicionário', async () => {
    const alvo = await montarFaixa();
    expect(alvo.tagName).toBe('FOOTER');
    const nome = alvo.getAttribute('aria-label');
    expect(nome).toBeTruthy();
    expect(nome).not.toMatch(/^patrocinio\./);
  });

  it('19. o trilho declara ao menos duas cópias — é o que fecha a emenda', async () => {
    const trilho = (await montarFaixa()).querySelector('.esteira-trilho');
    expect(Number(trilho.style.getPropertyValue('--copias'))).toBeGreaterThanOrEqual(2);
  });

  it('20. sem medida de largura, a esteira fica PARADA em vez de correr num ritmo inventado', async () => {
    // Em jsdom `offsetWidth` é 0: não há layout. A esteira não pode escolher
    // uma duração qualquer nesse caso.
    const trilho = (await montarFaixa()).querySelector('.esteira-trilho');
    expect(trilho.style.animation).toBe('none');
    expect(trilho.style.getPropertyValue('--dur')).toBe('');
  });

  it('21. as artes do rodapé entram com prioridade BAIXA, atrás do conteúdo', async () => {
    for (const img of (await montarFaixa()).querySelectorAll('img')) {
      expect(img.getAttribute('fetchpriority')).toBe('low');
    }
  });

  it('22. nenhuma imagem é adiada: os clones repetem a MESMA URL do original', async () => {
    for (const img of (await montarFaixa()).querySelectorAll('img')) {
      expect(img.getAttribute('loading')).toBeNull();
      expect(img.getAttribute('decoding')).toBe('async');
    }
  });
});
