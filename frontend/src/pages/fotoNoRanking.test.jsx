import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

// ==========================================================================
// A FOTO DO ATLETA NO RANKING PÚBLICO.
//
// O ranking mostrava só iniciais, mesmo para quem tinha foto no cadastro. A
// foto existia (`Athlete.photoKey`, gravada no autocadastro) e a rota que a
// serve existia — ela é que exigia sessão, e o ranking é página pública.
//
// O que estes testes travam é o CONTRATO da tela, não a decisão de produto:
//
//   com foto      -> pede a imagem pela rota do atleta, por ID
//   sem foto      -> não pede nada, e mostra as iniciais
//   foto quebrada -> cai nas iniciais, sem imagem quebrada na linha
//
// E a identidade da foto é o CADASTRO: dois atletas homônimos pedem caminhos
// diferentes, porque o que entra na URL é o `id`. Competidor da fonte ainda
// sem cadastro não tem `id` — e não pode pedir foto nenhuma.
// ==========================================================================

// O componente `Ranking` busca em QUATRO lugares além da lista: temporadas,
// categorias, classes, super overall, equipes e empresas. Todas precisam
// responder, senão a tela fica no estado de erro e nenhuma linha é desenhada.
const api = {
  ranking: {
    list: vi.fn(), seasons: vi.fn(), classes: vi.fn(),
    superOverall: vi.fn(), teams: vi.fn(), companies: vi.fn()
  },
  categories: { list: vi.fn() }
};
const fetchMediaObjectUrl = vi.fn();
const releaseMediaObjectUrl = vi.fn();
vi.mock('../services/api', () => ({ default: api, fetchMediaObjectUrl, releaseMediaObjectUrl }));

const { Ranking } = await import('./publicPages');

beforeEach(() => {
  window.matchMedia = consulta => ({
    matches: false, media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
  fetchMediaObjectUrl.mockResolvedValue('blob:foto');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const LINHA = (extra = {}) => ({
  id: 'rk1', position: 1, totalPoints: 30, eventCount: 2,
  overallWins: 1, firstPlaceCount: 2, tieUnresolved: false, state: 'SP',
  category: { id: 'c1', code: 'MBB', name: "Men's Bodybuilding" },
  season: { id: 's1', name: 'Temporada 2026', year: 2026 },
  athlete: {
    id: 'atl1', fullName: 'Lucas Gouveia Lima', stageName: null,
    hasPhoto: true, team: null
  },
  ...extra
});

const montar = (items, extra = {}) => {
  api.ranking.list.mockResolvedValue({
    items, season: { id: 's1', name: 'Temporada 2026', year: 2026 },
    nextCursor: null, publicView: true, publicLimit: 5, ...extra
  });
  api.ranking.seasons.mockResolvedValue({ items: [{ id: 's1', name: 'Temporada 2026', year: 2026 }] });
  api.ranking.classes.mockResolvedValue({ items: [] });
  api.ranking.superOverall.mockResolvedValue({ items: [] });
  api.ranking.teams.mockResolvedValue({ items: [] });
  api.ranking.companies.mockResolvedValue({ items: [] });
  api.categories.list.mockResolvedValue({ items: [] });
  return render(<Ranking />);
};

describe('a foto no ranking público', () => {
  it('1. atleta COM foto: a imagem é pedida pela rota do atleta, por id', async () => {
    montar([LINHA()]);
    await screen.findByText('Lucas Gouveia Lima');
    await waitFor(() => expect(fetchMediaObjectUrl).toHaveBeenCalledWith('/media/athletes/atl1/photo'));
  });

  it('2. atleta SEM foto: nada é pedido, e as iniciais ficam', async () => {
    montar([LINHA({ athlete: { id: 'atl2', fullName: 'Sem Retrato', stageName: null, hasPhoto: false, team: null } })]);
    await screen.findByText('Sem Retrato');
    expect(fetchMediaObjectUrl).not.toHaveBeenCalled();
    // `iniciais` do Avatar: duas letras do nome.
    expect(screen.getByText('SR')).toBeTruthy();
  });

  it('3. foto indisponível: cai nas iniciais, sem imagem quebrada', async () => {
    fetchMediaObjectUrl.mockRejectedValue(new Error('404'));
    montar([LINHA()]);
    await screen.findByText('Lucas Gouveia Lima');
    await waitFor(() => expect(fetchMediaObjectUrl).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('LG')).toBeTruthy());
    expect(document.querySelector('.avatar img')).toBeNull();
  });

  it('4. dois atletas, duas fotos: cada linha pede o SEU caminho', async () => {
    montar([
      LINHA(),
      LINHA({
        id: 'rk2', position: 2,
        athlete: { id: 'atl9', fullName: 'Outro Atleta', stageName: null, hasPhoto: true, team: null }
      })
    ]);
    await screen.findByText('Outro Atleta');
    await waitFor(() => {
      expect(fetchMediaObjectUrl).toHaveBeenCalledWith('/media/athletes/atl1/photo');
      expect(fetchMediaObjectUrl).toHaveBeenCalledWith('/media/athletes/atl9/photo');
    });
  });

  it('5. homônimos NÃO compartilham foto: o caminho sai do id, não do nome', async () => {
    montar([
      LINHA({ athlete: { id: 'atlA', fullName: 'Jose Da Silva', stageName: null, hasPhoto: true, team: null } }),
      LINHA({ id: 'rk2', position: 2, athlete: { id: 'atlB', fullName: 'Jose Da Silva', stageName: null, hasPhoto: false, team: null } })
    ]);
    await waitFor(() => expect(fetchMediaObjectUrl).toHaveBeenCalledWith('/media/athletes/atlA/photo'));
    // O segundo não tem foto: nenhuma chamada com o id dele.
    expect(fetchMediaObjectUrl).not.toHaveBeenCalledWith('/media/athletes/atlB/photo');
    expect(fetchMediaObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('6. competidor da fonte, ainda sem cadastro: não pede foto nenhuma', async () => {
    montar([LINHA({ athlete: { id: null, fullName: 'COMPETIDOR DA FONTE', stageName: null, hasPhoto: false, team: null } })]);
    await screen.findByText('COMPETIDOR DA FONTE');
    expect(fetchMediaObjectUrl).not.toHaveBeenCalled();
  });

  it('7. uma requisição por atleta com foto, e não mais: sem N+1 na tela', async () => {
    montar([
      LINHA(),
      LINHA({ id: 'rk2', position: 2, athlete: { id: 'atl2', fullName: 'Dois', stageName: null, hasPhoto: true, team: null } }),
      LINHA({ id: 'rk3', position: 3, athlete: { id: 'atl3', fullName: 'Tres', stageName: null, hasPhoto: false, team: null } })
    ]);
    await screen.findByText('Tres');
    await waitFor(() => expect(fetchMediaObjectUrl).toHaveBeenCalledTimes(2));
  });
});
