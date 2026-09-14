import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ==========================================================================
// EVENTOS — a identidade do módulo é EXPECTATIVA.
//
// Duas coisas podem mentir aqui, e as duas importam para quem vai viajar:
//  - "ao vivo" numa etapa que não está acontecendo;
//  - "próxima etapa" apontando para uma que já passou.
// ==========================================================================

const api = { publicApi: { events: vi.fn(), event: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { Campeonatos } = await import('./publicPages');

function aparelho({ movimentoReduzido = false } = {}) {
  window.matchMedia = consulta => ({
    matches: consulta.includes('prefers-reduced-motion') ? movimentoReduzido : false,
    media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
}

const dia = ms => new Date(Date.now() + ms).toISOString();
const ETAPA = (extra = {}) => ({
  id: 'e1', slug: 'etapa-1', name: 'Muscle Contest Curitiba',
  status: 'PLANNED', startDate: dia(7 * 86400000), endDate: null,
  description: null, _count: { registrations: 12 }, ...extra
});

beforeEach(() => aparelho());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const montar = async itens => {
  api.publicApi.events.mockResolvedValue({ items: itens, nextCursor: null });
  render(<Campeonatos navegar={() => {}} />);
  await screen.findByText(itens[0].name);
};

describe('a próxima etapa', () => {
  it('é a primeira que AINDA NÃO aconteceu, não a primeira da lista', async () => {
    await montar([
      ETAPA({ id: 'passada', name: 'Etapa que já passou', startDate: dia(-30 * 86400000), status: 'CLOSED' }),
      ETAPA({ id: 'futura', name: 'Etapa que vem aí', startDate: dia(10 * 86400000) })
    ]);
    const marcados = [...document.querySelectorAll('.etapa-proxima')];
    expect(marcados).toHaveLength(1);
    expect(marcados[0].textContent).toContain('Etapa que vem aí');
  });

  it('sem nenhuma etapa futura, nada é marcado como próxima', async () => {
    await montar([ETAPA({ name: 'Só passado', startDate: dia(-5 * 86400000), status: 'CLOSED' })]);
    expect(document.querySelector('.etapa-proxima')).toBeNull();
  });

  it('o destaque não se move sozinho — é borda, não animação', async () => {
    await montar([ETAPA({ name: 'Etapa que vem aí' })]);
    const cartao = document.querySelector('.etapa-proxima');
    expect(cartao).toBeTruthy();
    // Sem partícula e sem pulso: a expectativa vem do lugar que a etapa
    // ocupa, não de algo piscando.
    expect(cartao.querySelector('.pulso-ponto')).toBeNull();
    expect(cartao.querySelector('.campeao-particulas')).toBeNull();
  });
});

describe('ao vivo só quando está mesmo ao vivo', () => {
  it('etapa em operação HOJE pulsa', async () => {
    await montar([ETAPA({ name: 'Acontecendo agora', status: 'IN_OPERATION', startDate: new Date().toISOString() })]);
    expect(document.querySelector('.pulso-ponto')).toBeTruthy();
  });

  it('etapa planejada para daqui a uma semana NÃO pulsa', async () => {
    await montar([ETAPA()]);
    expect(document.querySelector('.pulso-ponto')).toBeNull();
  });

  it('etapa encerrada NÃO pulsa', async () => {
    await montar([ETAPA({ name: 'Encerrada', status: 'CLOSED', startDate: dia(-2 * 86400000) })]);
    expect(document.querySelector('.pulso-ponto')).toBeNull();
  });
});

describe('a grade entra em sequência com teto', () => {
  it('o atraso do último cartão não passa do teto do motor', async () => {
    await montar(Array.from({ length: 24 }, (_, i) => ETAPA({ id: `e${i}`, slug: `s${i}`, name: `Etapa ${i}` })));
    const cartoes = [...document.querySelectorAll('.cartao-clicavel')];
    expect(cartoes).toHaveLength(24);
    // `el.style.animationDelay` já vem em milissegundos ("45ms"); multiplicar
    // por 1000 daria 45000. O primeiro cartão não tem atraso (índice 0 devolve
    // estilo vazio), e string vazia conta como 0 — não como NaN, que
    // envenenaria o máximo.
    const atrasos = cartoes.map(c => parseFloat(c.style.animationDelay) || 0);
    expect(atrasos[0]).toBe(0);
    expect(atrasos[1]).toBe(45);
    expect(Math.max(...atrasos)).toBe(360);
  });

  it('com movimento reduzido os cartões nascem no lugar', async () => {
    aparelho({ movimentoReduzido: true });
    await montar([ETAPA()]);
    const cartao = document.querySelector('.cartao-clicavel');
    expect(cartao.className).not.toContain('revela');
    expect(cartao.style.animationDelay).toBe('');
  });
});
