import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ==========================================================================
// A FICHA DO ATLETA DIZIA "AINDA SEM RESULTADOS PUBLICADOS" PARA QUEM TINHA
// DOIS CAMPEONATOS E 30 PONTOS NO RANKING — NA MESMA TELA.
//
// É o mesmo defeito que a página do EVENTO já tinha, e que
// `resultadoImportadoNoEvento.test.jsx` travou: a plataforma tem dois caminhos
// de resultado, e a leitura via só o primeiro.
//
//   RECEBIDO    apuração entregue ao MCI  -> `Result` + `ResultEntry`
//   IMPORTADO   arquivo da origem         -> `ExternalResult` + `RankingPoint`
//                                         -> `PublicRankingEntry`
//
// O cartão "Pontos somados" lê `Ranking`, que nasce do ledger — e por isso
// enxergava. O histórico lia `ResultEntry` — e por isso negava. As duas
// metades diziam a verdade sobre as suas tabelas, e a tela se contradizia.
//
// O que estes testes travam: que a linha do histórico sirva às DUAS origens,
// que ela não invente texto quando o arquivo histórico não trouxe categoria ou
// classe, e que o link só apareça quando existe página pública para abrir.
// ==========================================================================

const api = { publicApi: { athlete: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { AtletaDetalhe } = await import('./publicPages');

beforeEach(() => {
  window.matchMedia = consulta => ({
    matches: false, media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ATLETA = {
  id: 'atl1', fullName: 'Lucas Gouveia Lima', stageName: null, sex: 'MALE',
  country: 'BR', state: 'SP', city: 'São Paulo', hasPhoto: false,
  athleteNumber: null, proStatus: 'AMATEUR', proSince: null,
  team: null, coach: null, gym: null,
  affiliation: { id: 'af1', name: 'NPC - National Physique Committee', code: 'NPC' }
};

const RESPOSTA = (extra = {}) => ({
  athlete: { ...ATLETA, socialProfile: null },
  results: [], titles: 0, rankings: [],
  ...extra
});

const IMPORTADO = (extra = {}) => ({
  key: 'importado:rp1',
  origin: 'IMPORTADO',
  placing: 1,
  status: null,
  points: 15,
  isOverallChampion: true,
  event: { id: 'ev1', name: 'Razor', slug: 'razor-2026', startDate: '2026-10-03T12:00:00.000Z' },
  eventNavigable: true,
  categoryName: "Men's Bodybuilding",
  className: 'Open Heavyweight',
  publishedAt: '2026-10-03T12:00:00.000Z',
  ...extra
});

const montar = resposta => {
  api.publicApi.athlete.mockResolvedValue(resposta);
  return render(<AtletaDetalhe id="atl1" navegar={() => {}} />);
};

describe('o histórico esportivo na ficha pública', () => {
  it('resultado IMPORTADO aparece no histórico e conta no cartão', async () => {
    montar(RESPOSTA({
      results: [IMPORTADO()],
      titles: 1,
      rankings: [{
        id: 'r1', position: 1, totalPoints: 30, eventCount: 2,
        season: { id: 's1', name: 'Temporada 2026', year: 2026 },
        category: { id: 'c1', name: "Men's Bodybuilding", code: 'MBB' }
      }]
    }));

    // A FRASE QUE O DEFEITO MOSTRAVA some, e a etapa aparece pelo nome.
    expect(await screen.findByText('Razor')).toBeTruthy();
    expect(screen.queryByText(/ainda sem resultados/i)).toBeNull();

    // A linha traz categoria, classe e data — e os pontos da participação.
    expect(screen.getByText(/Men's Bodybuilding · Open Heavyweight/)).toBeTruthy();
    expect(screen.getByText('15')).toBeTruthy();
  });

  it('duas origens na mesma lista, sem a tela precisar saber de onde veio cada uma', async () => {
    montar(RESPOSTA({
      results: [
        IMPORTADO(),
        {
          key: 'recebido:re9', origin: 'RECEBIDO', placing: 2, status: 'OK',
          points: null, isOverallChampion: false,
          event: { id: 'ev2', name: 'Ipiranga', slug: 'ipiranga-2026', startDate: '2026-05-10T12:00:00.000Z' },
          eventNavigable: true,
          categoryName: "Men's Physique", className: 'Open Class B',
          publishedAt: '2026-05-11T12:00:00.000Z'
        }
      ],
      titles: 1
    }));

    expect(await screen.findByText('Razor')).toBeTruthy();
    expect(screen.getByText('Ipiranga')).toBeTruthy();
    // Dois botões de etapa: as duas linhas são navegáveis.
    expect(screen.getAllByRole('button', { name: /Ver a etapa/i }).length).toBe(2);
  });

  it('arquivo histórico sem categoria nem classe não vira "undefined" na tela', async () => {
    montar(RESPOSTA({
      results: [IMPORTADO({ categoryName: null, className: null, publishedAt: null })],
      titles: 1
    }));

    expect(await screen.findByText('Razor')).toBeTruthy();
    expect(screen.queryByText(/undefined|null/i)).toBeNull();
  });

  it('etapa sem página pública: a linha fica, o link não', async () => {
    montar(RESPOSTA({
      results: [IMPORTADO({ eventNavigable: false })],
      titles: 1
    }));

    expect(await screen.findByText('Razor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ver a etapa/i })).toBeNull();
    expect(screen.getByText(/Sem página pública/i)).toBeTruthy();
  });

  it('resultado sem evento identificado não quebra a linha', async () => {
    montar(RESPOSTA({
      results: [IMPORTADO({ event: null, eventNavigable: false })],
      titles: 0
    }));

    expect(await screen.findByText(/Etapa não informada/i)).toBeTruthy();
  });

  it('sem resultado nenhum, a frase de vazio continua existindo', async () => {
    montar(RESPOSTA());
    expect(await screen.findByText(/ainda sem resultados|sem resultados/i)).toBeTruthy();
  });
});
