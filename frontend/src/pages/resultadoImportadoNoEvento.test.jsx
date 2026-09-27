import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// ==========================================================================
// A PÁGINA DO EVENTO MOSTRAVA "0 ATLETAS" E "RESULTADOS AINDA NÃO PUBLICADOS"
// NUMA ETAPA INTEIRA DE RESULTADOS HOMOLOGADOS.
//
// A plataforma tem dois caminhos de resultado:
//
//   INTERNO     julgamento no MCI  -> `Result` + `ResultEntry`
//               inscrição no MCI   -> `Registration`
//   IMPORTADO   arquivo da origem  -> `ExternalResult` + `RankingPoint`
//                                  -> `PublicRankingEntry`
//
// A tela lia só o primeiro. Num evento cujos resultados entraram por importação
// as duas consultas voltam vazias — e as duas frases da tela dizem a verdade
// sobre as tabelas que consultam, enquanto os resultados existem, homologados,
// nas outras três. A etapa do Ipiranga é exatamente esse caso.
//
// O que estes testes travam não é a existência do bloco novo: é que a tela deixe
// de NEGAR resultado que existe, e que ela continue distinguindo o resultado
// julgado aqui do resultado recebido por arquivo. Juntar os dois num selo só
// apagaria a diferença que a homologação registra.
// ==========================================================================

const api = { publicApi: { events: vi.fn(), event: vi.fn() } };
vi.mock('../services/api', () => ({ default: api, fetchMediaObjectUrl: vi.fn(), releaseMediaObjectUrl: vi.fn() }));

const { CampeonatoDetalhe } = await import('./publicPages');

beforeEach(() => {
  window.matchMedia = consulta => ({
    matches: false, media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const EVENTO = {
  id: 'ev1', slug: 'ipiranga-2026', name: 'Muscle Contest Ipiranga',
  status: 'CLOSED', startDate: '2026-05-10T12:00:00.000Z', endDate: null,
  description: null, venue: null, city: 'Ipiranga', state: 'SP', timezone: 'America/Sao_Paulo',
  organization: { id: 'org1', name: 'Federação', slug: 'fed' }
};

// A forma que `publicService.eventPage` devolve. Os padrões representam o evento
// SEM nada — é sobre eles que cada caso acrescenta só o que quer medir.
const RESPOSTA = (extra = {}) => ({
  event: EVENTO,
  categories: [], schedule: [], athletes: [], results: [], sponsors: [], posts: [],
  importedResults: [], competitorCount: 0,
  ...extra
});

const GRUPO_IMPORTADO = (extra = {}) => ({
  key: 'cat1::cls1',
  category: { id: 'cat1', name: "Men's Physique", code: 'MENS_PHYSIQUE' },
  competitionClass: { id: 'cls1', name: 'Open Class B', code: 'OPEN_B' },
  entries: [
    { id: 'p1', placing: 1, points: 5, isOverallChampion: false, didNotShow: false,
      athleteId: 'a1', name: 'Maycon Rodrigues', team: { id: 't1', name: 'Equipe Alfa' }, city: 'Cuiabá', state: 'MT' },
    { id: 'p2', placing: 2, points: 4, isOverallChampion: false, didNotShow: false,
      athleteId: null, name: 'Tiago Paiva', team: null, city: null, state: null }
  ],
  ...extra
});

const montar = async dados => {
  api.publicApi.event.mockResolvedValue(dados);
  render(<CampeonatoDetalhe slug={EVENTO.slug} navegar={() => {}} />);
  await screen.findByText(EVENTO.name);
};

describe('o evento com resultado importado', () => {
  it('MOSTRA os resultados em vez de dizer que não há', async () => {
    await montar(RESPOSTA({ importedResults: [GRUPO_IMPORTADO()], competitorCount: 2 }));

    expect(screen.queryByText('Resultados ainda não publicados'),
      'negar resultado que existe é o defeito').not.toBeInTheDocument();
    expect(screen.getByText('Maycon Rodrigues')).toBeInTheDocument();
    expect(screen.getByText('Tiago Paiva')).toBeInTheDocument();
  });

  it('agrupa por categoria E classe — "1º lugar" só quer dizer algo dentro de uma classe', async () => {
    await montar(RESPOSTA({ importedResults: [GRUPO_IMPORTADO()], competitorCount: 2 }));

    expect(screen.getByText(/Men's Physique · Open Class B/)).toBeInTheDocument();
  });

  it('marca a origem: importado e homologado NÃO é julgado aqui', async () => {
    await montar(RESPOSTA({ importedResults: [GRUPO_IMPORTADO()], competitorCount: 2 }));

    expect(screen.getByText('Importado e homologado')).toBeInTheDocument();
    expect(screen.queryByText('Publicado'), 'não há resultado julgado no MCI neste evento').not.toBeInTheDocument();
  });

  it('conta competidores, e não inscrições confirmadas', async () => {
    // `athletes` vazio é o estado real de um evento importado: ninguém se
    // inscreveu pelo MCI. Mostrar 0 ao lado de dois resultados era a contradição.
    await montar(RESPOSTA({ importedResults: [GRUPO_IMPORTADO()], competitorCount: 2, athletes: [] }));

    expect(screen.getByText(/2 atletas/)).toBeInTheDocument();
  });

  it('o competidor sem cadastro aparece pelo nome da fonte, sem equipe inventada', async () => {
    await montar(RESPOSTA({ importedResults: [GRUPO_IMPORTADO()], competitorCount: 2 }));

    const linha = screen.getByText('Tiago Paiva').closest('.list-row');
    expect(linha.textContent).toContain('Sem equipe');
  });
});

describe('o evento sem resultado nenhum continua dizendo que não há', () => {
  it('a mensagem de vazio não desapareceu junto com o defeito', async () => {
    await montar(RESPOSTA());

    expect(await screen.findByText('Resultados ainda não publicados')).toBeInTheDocument();
  });

  it('e conta zero atletas, porque zero é a verdade aqui', async () => {
    await montar(RESPOSTA());
    expect(screen.getByText(/0 atletas/)).toBeInTheDocument();
  });
});

describe('os dois caminhos convivem', () => {
  const RESULTADO_INTERNO = {
    id: 'r1', publishedAt: '2026-05-11T12:00:00.000Z',
    competitionClass: {
      id: 'cc1', name: 'Open Class A',
      division: { id: 'd1', name: 'Open', eventCategory: { id: 'ec1', category: { id: 'cat2', name: 'Bikini' } } }
    },
    entries: [
      { id: 'e1', placing: 1, athlete: { id: 'a9', fullName: 'Barbara Dias', stageName: null, state: 'SP', city: 'Ipiranga', team: null } }
    ]
  };

  it('resultado julgado no MCI e resultado importado aparecem juntos, com selos diferentes', async () => {
    await montar(RESPOSTA({
      results: [RESULTADO_INTERNO],
      importedResults: [GRUPO_IMPORTADO()],
      competitorCount: 3
    }));

    expect(screen.getByText('Publicado')).toBeInTheDocument();
    expect(screen.getByText('Importado e homologado')).toBeInTheDocument();
    expect(screen.getByText('Barbara Dias')).toBeInTheDocument();
    expect(screen.getByText('Maycon Rodrigues')).toBeInTheDocument();
  });
});

describe('a tela sobrevive a uma API mais antiga', () => {
  it('sem `importedResults` nem `competitorCount` ela monta e cai no comportamento anterior', async () => {
    // Um deploy do frontend na frente do backend não pode quebrar a página
    // inteira: sem os padrões, `importedResults.length` estouraria na montagem.
    const { importedResults, competitorCount, ...semOsNovos } = RESPOSTA({
      athletes: [{ id: 'a1', fullName: 'Alguém', stageName: null, city: null, state: null, team: null }]
    });
    expect(importedResults).toEqual([]);
    expect(competitorCount).toBe(0);

    await montar(semOsNovos);

    expect(screen.getByText('Resultados ainda não publicados')).toBeInTheDocument();
    expect(screen.getByText(/1 atleta/)).toBeInTheDocument();
  });
});
