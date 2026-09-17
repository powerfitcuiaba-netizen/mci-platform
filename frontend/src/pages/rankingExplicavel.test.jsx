import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// ==========================================================================
// O TOTAL DO RANKING PRECISA SE EXPLICAR NA PRÓPRIA TELA.
//
// ORIGEM: teste humano no ambiente de preview. A tabela do ranking do
// campeonato mostrava, para uma atleta, "Etapas: 2 · Pontos: 30". Quem olhou
// fez a conta certa pela regra — 1º vale 5, o Overall vale +10, a participação
// vale 15 — e concluiu que 30 só podia ser 15 contado duas vezes.
//
// O ledger estava correto: eram DOIS títulos de Overall, um por campeonato,
// cada um valendo +10 uma única vez. O que faltava era a tela dizer isso. A
// tabela do Super Overall já trazia a coluna de Overall; a do campeonato, não
// — e era justamente nela que o número aparecia.
//
// Total que não se explica pela própria tela é total em que ninguém confia.
// ==========================================================================

const api = {
  ranking: {
    list: vi.fn(), seasons: vi.fn(), superOverall: vi.fn(),
    teams: vi.fn(), companies: vi.fn(), byCut: vi.fn()
  },
  categories: { list: vi.fn() },
  events: { list: vi.fn() }
};
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { Ranking } = await import('./publicPages');

const linha = extras => ({
  id: 'r1',
  position: 1,
  totalPoints: 30,
  eventCount: 2,
  overallWins: 2,
  state: 'MT',
  athlete: { id: 'a1', fullName: 'QA · DEMO — Atleta Campeã Overall', stageName: null, team: null },
  category: { id: 'c1', code: 'BIKINI', name: 'Bikini' },
  season: { id: 's1', name: 'Temporada 2026', year: 2026 },
  ...extras
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  for (const fn of Object.values(api.ranking)) fn.mockReset();
  api.ranking.seasons.mockResolvedValue({ items: [{ id: 's1', name: 'Temporada 2026', year: 2026 }] });
  api.ranking.superOverall.mockResolvedValue([]);
  api.ranking.teams.mockResolvedValue([]);
  api.ranking.companies.mockResolvedValue([]);
  api.ranking.byCut?.mockResolvedValue?.([]);
  api.categories.list.mockResolvedValue({ items: [] });
  api.events.list.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

describe('a tabela do campeonato explica o total', () => {
  it('mostra quantos títulos de Overall a atleta tem', async () => {
    api.ranking.list.mockResolvedValue({ items: [linha()], total: 1 });

    render(<Ranking />);

    const nome = await screen.findByText(/Atleta Campeã Overall/);
    const tr = nome.closest('tr');

    // Os três números que fecham a conta: 2 etapas, 2 títulos, 30 pontos.
    //
    // `getAllByText`, e não `getByText`: depois da correção existem DOIS "2" na
    // linha — as etapas e os títulos. A primeira versão deste teste usou a
    // forma singular e reprovou por encontrar os dois, ou seja, reprovou
    // justamente por a correção estar lá.
    expect(within(tr).getAllByText('2').length, 'etapas e títulos').toBe(2);
    expect(within(tr).getByText('30'), 'total').toBeTruthy();

    const celulas = [...tr.querySelectorAll('td')].map(c => c.textContent.trim());
    expect(celulas, 'a coluna de Overall traz o número de títulos').toContain('2');
    // Sem a coluna, "Etapas: 2 · Pontos: 30" é 15 × 2 para quem lê — que foi
    // exatamente a conclusão do teste humano.
    expect(celulas.filter(t => t === '2').length,
      'etapas e títulos aparecem como duas informações, não uma').toBeGreaterThanOrEqual(2);
  });

  it('atleta sem título não mostra um zero solto, e sim um traço', async () => {
    api.ranking.list.mockResolvedValue({
      items: [linha({ id: 'r2', overallWins: 0, totalPoints: 10, eventCount: 2 })],
      total: 1
    });

    render(<Ranking />);
    const nome = await screen.findByText(/Atleta Campeã Overall/);
    const celulas = [...nome.closest('tr').querySelectorAll('td')].map(c => c.textContent.trim());
    expect(celulas, 'ausência de título é traço, não zero').toContain('—');
  });

  it('a legenda diz a regra por extenso, com o +10 por campeonato', async () => {
    api.ranking.list.mockResolvedValue({ items: [linha()], total: 1 });

    render(<Ranking />);
    await screen.findByText(/Atleta Campeã Overall/);

    const legenda = await screen.findByText(/uma vez por campeonato/i);

    // VISÍVEL, e não apenas presente no DOM. A consulta por texto encontra
    // elemento escondido também — uma legenda com `hidden` passaria na busca e
    // não ajudaria ninguém. A mutação que escondeu a legenda sobreviveu
    // exatamente por isso.
    expect(legenda.hidden, 'a legenda não pode estar escondida').toBe(false);
    expect(legenda.closest('[hidden]'), 'nem dentro de algo escondido').toBeNull();
    expect(getComputedStyle(legenda).display, 'nem com display none').not.toBe('none');

    expect(legenda.textContent).toMatch(/\+10/);
    expect(legenda.textContent, 'a tabela oficial de colocação aparece').toMatch(/1º\s*=\s*5/);
    // O caso que confundiu, dito com todas as letras.
    expect(legenda.textContent).toMatch(/dois campeonatos soma \+20/i);
  });
});
