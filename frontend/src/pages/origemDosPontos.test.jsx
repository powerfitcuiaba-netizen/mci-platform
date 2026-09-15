import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ==========================================================================
// ORIGEM DOS PONTOS — a filiação da época na tela.
//
// O backend passou a gravar, em cada ponto, a filiação pela qual ele foi
// ganho: a entidade E a matrícula. A tela que responde "por que este atleta
// tem 15 pontos?" precisa mostrar as duas, porque é por esse par que um
// resultado é reconhecido — e porque um atleta que trocou de federação tem, na
// mesma tabela, linhas de duas entidades diferentes.
//
// Mostrar só a federação de hoje ao lado de resultados de ontem seria a mesma
// mentira que o campo no banco existe para impedir.
// ==========================================================================

const api = { ranking: { athletePoints: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, refreshData: vi.fn(), fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AdminRanking, OrigemDosPontos } = await import('./adminPlatform');

const ponto = extras => ({
  id: 'p1',
  event: { id: 'e1', name: 'Etapa Cuiabá' },
  category: { id: 'c1', name: 'Bikini' },
  competitionClass: { id: 'cl1', code: 'OPEN', name: 'Open' },
  placing: 1,
  placementPoints: 5,
  overallBonus: 10,
  points: 15,
  superOverallPoints: 15,
  superOverallEligible: true,
  source: 'EVENT',
  affiliation: { id: 'a1', code: 'NPCMT', name: 'NPC Mato Grosso', state: 'MT' },
  affiliationNumber: '88281',
  ...extras
});

beforeEach(() => {
  window.matchMedia = consulta => ({ matches: false, media: consulta, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  api.ranking.athletePoints.mockReset();
});
afterEach(cleanup);

const montar = itens => {
  api.ranking.athletePoints.mockResolvedValue({ items: itens });
  render(
    <OrigemDosPontos
      atleta={{ id: 'at1', fullName: 'Yuri Santinelli' }}
      temporada={{ id: 't1', name: 'Temporada 2026' }}
      onClose={() => {}}
    />
  );
};

describe('a filiação da época aparece em cada linha', () => {
  it('mostra a entidade e a matrícula do ponto', async () => {
    montar([ponto()]);
    expect(await screen.findByText('NPC Mato Grosso')).toBeTruthy();
    expect(screen.getByText(/88281/)).toBeTruthy();
  });

  it('duas federações no mesmo histórico — cada linha com a sua', async () => {
    montar([
      ponto(),
      ponto({
        id: 'p2',
        event: { id: 'e2', name: 'Etapa São Paulo' },
        overallBonus: 0, points: 5, superOverallPoints: 5,
        affiliation: { id: 'a2', code: 'NPCSP', name: 'NPC São Paulo', state: 'SP' },
        affiliationNumber: '99999'
      })
    ]);

    expect(await screen.findByText('NPC Mato Grosso')).toBeTruthy();
    expect(screen.getByText('NPC São Paulo')).toBeTruthy();
    expect(screen.getByText(/88281/)).toBeTruthy();
    expect(screen.getByText(/99999/)).toBeTruthy();
  });

  it('ponto sem filiação não inventa uma', async () => {
    montar([ponto({ affiliation: null, affiliationNumber: null })]);
    await screen.findByText('Etapa Cuiabá');
    expect(screen.queryByText('NPC Mato Grosso')).toBeNull();
    expect(screen.queryByText(/88281/)).toBeNull();
  });

  it('entidade sem matrícula mostra a entidade e não um número em branco', async () => {
    // Acontece de verdade: o atleta trocou de federação depois de inscrito, e
    // a matrícula não acompanha porque é de outra entidade.
    montar([ponto({ affiliationNumber: null })]);
    expect(await screen.findByText('NPC Mato Grosso')).toBeTruthy();
    expect(screen.queryByText(/nº\s*$/)).toBeNull();
  });
});
