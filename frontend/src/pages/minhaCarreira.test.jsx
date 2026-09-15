import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

// ==========================================================================
// MINHA FILIAÇÃO E MEU HISTÓRICO — a carreira do atleta, na tela dele.
//
// O backend passou a responder sobre QUEM PEDE (`/me/affiliation`,
// `/me/history`). Aqui prova-se que a tela mostra o que importa e, sobretudo,
// o que ela NÃO pode fazer:
//
//   * somar colocação e bônus num número só — "15 pontos" esconde que 5 foram
//     do pódio e 10 do título, e é exatamente a confusão que a regra vigente
//     existe para impedir;
//   * mostrar "Overall +10" numa participação que não é a absoluta;
//   * exibir a filiação de HOJE ao lado de um resultado de ontem;
//   * inventar filiação quando o ponto não tem snapshot.
// ==========================================================================

const api = { me: { affiliation: vi.fn(), history: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { MinhaFiliacao, MeuHistorico } = await import('./minhaCarreira');

const linha = extras => ({
  id: 'p1',
  event: { id: 'e1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba', startDate: '2026-05-10T12:00:00.000Z' },
  season: { id: 's1', name: 'Temporada 2026', year: 2026 },
  category: { id: 'c1', code: 'BIKINI', name: 'Bikini' },
  competitionClass: { id: 'cl1', code: 'OPEN', name: 'Open' },
  placing: 1,
  placementPoints: 5,
  overallBonus: 10,
  points: 15,
  superOverallPoints: 15,
  superOverallEligible: true,
  isOverallChampion: true,
  affiliation: { id: 'a1', name: 'NPC Mato Grosso', code: 'NPC-MT', state: 'MT' },
  affiliationNumber: '88281',
  source: 'EVENT',
  awardedAt: '2026-05-11T12:00:00.000Z',
  ...extras
});

const historico = (items, totals) => ({
  athlete: { id: 'at1', fullName: 'Yuri Santinelli', stageName: null },
  items,
  total: items.length,
  nextCursor: null,
  totals: totals || {
    participations: items.length,
    placementPoints: items.reduce((t, i) => t + i.placementPoints, 0),
    overallBonus: items.reduce((t, i) => t + i.overallBonus, 0),
    points: items.reduce((t, i) => t + i.points, 0)
  }
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.me.affiliation.mockReset();
  api.me.history.mockReset();
});
afterEach(cleanup);

describe('Minha Filiação', () => {
  it('mostra entidade, código, UF, matrícula e organização', async () => {
    api.me.affiliation.mockResolvedValue({
      athlete: { id: 'at1', fullName: 'Yuri Santinelli', stageName: null },
      organization: { id: 'o1', name: 'MCI Brasil', slug: 'mci' },
      affiliation: { id: 'a1', name: 'NPC Mato Grosso', code: 'NPC-MT', state: 'MT', active: true },
      affiliationNumber: '88281'
    });

    render(<MinhaFiliacao />);

    expect(await screen.findByText('NPC Mato Grosso')).toBeTruthy();
    expect(screen.getByText(/NPC-MT/)).toBeTruthy();
    expect(screen.getByText(/88281/)).toBeTruthy();
    expect(screen.getByText(/MCI Brasil/)).toBeTruthy();
  });

  it('sem perfil de atleta, explica o caminho em vez de mostrar erro', async () => {
    api.me.affiliation.mockResolvedValue({ athlete: null, affiliation: null, affiliationNumber: null, organization: null });

    render(<MinhaFiliacao />);
    expect(await screen.findByText(/ainda não tem perfil de atleta/i)).toBeTruthy();
  });

  it('atleta sem filiação vê isso dito, não um campo em branco', async () => {
    api.me.affiliation.mockResolvedValue({
      athlete: { id: 'at1', fullName: 'Sem Filiação', stageName: null },
      organization: { id: 'o1', name: 'MCI Brasil', slug: 'mci' },
      affiliation: null, affiliationNumber: null
    });

    render(<MinhaFiliacao />);
    expect(await screen.findByText(/sem filiação/i)).toBeTruthy();
  });
});

describe('Meu Histórico', () => {
  it('mostra colocação e bônus SEPARADOS, nunca somados num número só', async () => {
    api.me.history.mockResolvedValue(historico([linha()]));
    render(<MeuHistorico />);

    const tabela = await screen.findByRole('table');
    const celulas = within(tabela).getAllByRole('cell').map(c => c.textContent);

    // 5 de colocação, +10 de bônus, 15 de total — os três visíveis.
    expect(celulas.some(t => t.trim() === '5'), 'a colocação vale 5').toBe(true);
    expect(celulas.some(t => t.includes('+10')), 'o bônus aparece como bônus').toBe(true);
    expect(celulas.some(t => t.trim() === '15'), 'e o total é 15').toBe(true);
  });

  it('participação não absoluta NÃO exibe bônus de Overall', async () => {
    api.me.history.mockResolvedValue(historico([
      linha(),
      linha({
        id: 'p2',
        competitionClass: { id: 'cl2', code: 'NOVICE', name: 'Novice' },
        overallBonus: 0, points: 5, superOverallPoints: 0,
        superOverallEligible: false, isOverallChampion: false
      })
    ]));

    render(<MeuHistorico />);
    const tabela = await screen.findByRole('table');
    const linhas = within(tabela).getAllByRole('row').slice(1);

    const daNovice = linhas.find(l => l.textContent.includes('Novice'));
    // Nem "+10", nem "+0": o sinal de mais é a marca do bônus, e uma
    // participação sem título não pode exibi-la de forma nenhuma.
    expect(daNovice.textContent).not.toContain('+');
    expect(within(daNovice).queryByLabelText(/campeão overall/i), 'sem troféu na Novice').toBeNull();

    const daOpen = linhas.find(l => l.textContent.includes('Open'));
    expect(daOpen.textContent).toContain('+10');
    expect(within(daOpen).getByLabelText(/campeão overall/i)).toBeTruthy();
  });

  it('as três participações do mesmo campeonato aparecem as três', async () => {
    api.me.history.mockResolvedValue(historico([
      linha({ id: 'p1', competitionClass: { id: 'c1', code: 'OPEN', name: 'Open' }, placing: 1, placementPoints: 5, overallBonus: 0, points: 5 }),
      linha({ id: 'p2', competitionClass: { id: 'c2', code: 'NOVICE', name: 'Novice' }, placing: 2, placementPoints: 4, overallBonus: 0, points: 4 }),
      linha({ id: 'p3', competitionClass: { id: 'c3', code: 'MASTER', name: 'Master' }, placing: 1, placementPoints: 5, overallBonus: 0, points: 5 })
    ]));

    render(<MeuHistorico />);
    const tabela = await screen.findByRole('table');
    expect(within(tabela).getAllByRole('row').slice(1)).toHaveLength(3);
    // 5 + 4 + 5 = 14, e o total aparece na tela.
    expect(screen.getAllByText(/14/).length).toBeGreaterThan(0);
  });

  it('cada linha mostra a filiação DA ÉPOCA', async () => {
    api.me.history.mockResolvedValue(historico([
      linha(),
      linha({
        id: 'p2',
        event: { id: 'e2', name: 'Etapa São Paulo', slug: 'sp', startDate: '2027-05-10T12:00:00.000Z' },
        affiliation: { id: 'a2', name: 'NPC São Paulo', code: 'NPC-SP', state: 'SP' },
        affiliationNumber: '99999',
        overallBonus: 0, points: 5
      })
    ]));

    render(<MeuHistorico />);
    expect(await screen.findByText(/NPC Mato Grosso/)).toBeTruthy();
    expect(screen.getByText(/NPC São Paulo/)).toBeTruthy();
    expect(screen.getByText(/88281/)).toBeTruthy();
    expect(screen.getByText(/99999/)).toBeTruthy();
  });

  it('ponto sem snapshot de filiação não inventa uma', async () => {
    api.me.history.mockResolvedValue(historico([
      linha({ affiliation: null, affiliationNumber: null })
    ]));

    render(<MeuHistorico />);
    await screen.findByRole('table');
    expect(screen.queryByText(/NPC Mato Grosso/)).toBeNull();
    expect(screen.queryByText(/88281/)).toBeNull();
  });

  it('sem histórico, diz que ainda não há — e não mostra tabela vazia', async () => {
    api.me.history.mockResolvedValue(historico([]));
    render(<MeuHistorico />);

    expect(await screen.findByText(/ainda não pontuou|nenhuma participação/i)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
