import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

// ==========================================================================
// O VISITANTE ANÔNIMO ALCANÇA A VITRINE — E SÓ ELA.
//
// O casco devolvia a tela de entrada para QUALQUER rota, inclusive as quatro
// marcadas `publico: true` em `NAVEGACAO_PRINCIPAL`. A API nunca exigiu sessão
// nelas — `/api/v1/public/...`, `/ranking`, `/events` respondem 200 ao anônimo,
// e há suíte de backend provando isso. Quem barrava era só a interface, e o
// efeito era um resultado "público" que pedia senha.
//
// O que estes testes travam são as DUAS metades do requisito:
//
//   1. a vitrine abre sem login;
//   2. e NADA além dela abre.
//
// A segunda metade é a que importa: abrir demais seria trocar um defeito de
// usabilidade por um de segurança. A lista de rotas públicas não é inventada
// aqui — ela sai da bandeira `publico: true` que já existia na navegação.
// ==========================================================================

const respostas = vi.hoisted(() => ({}));

vi.mock('./services/api', () => {
  const vazio = { items: [], nextCursor: null };
  const api = {
    // `me` REJEITA: é o que acontece quando não há token. É assim que o
    // AuthContext conclui que a sessão não existe.
    auth: { me: vi.fn(() => Promise.reject(new Error('sem sessão'))), login: vi.fn(), register: vi.fn() },
    publicApi: {
      summary: vi.fn(() => Promise.resolve({ events: 3, athletes: 42, proAthletes: 5, publishedResults: 7, openSeasons: 1, upcoming: [] })),
      events: vi.fn(() => Promise.resolve(vazio)),
      event: vi.fn(() => Promise.resolve(null)),
      athletes: vi.fn(() => Promise.resolve(vazio)),
      athlete: vi.fn(() => Promise.resolve({
        athlete: {
          id: 'atl1', fullName: 'Lucas Gouveia Lima', stageName: null, sex: 'MALE',
          country: 'BR', state: 'SP', city: 'São Paulo', hasPhoto: false,
          proStatus: 'AMATEUR', team: null, coach: null, affiliation: null, socialProfile: null
        },
        results: [], titles: 0, rankings: []
      }))
    },
    ranking: {
      list: vi.fn(() => Promise.resolve({ items: [], season: null, nextCursor: null, publicView: true, publicLimit: 5 })),
      seasons: vi.fn(() => Promise.resolve(vazio)),
      classes: vi.fn(() => Promise.resolve(vazio)),
      superOverall: vi.fn(() => Promise.resolve(vazio)),
      teams: vi.fn(() => Promise.resolve(vazio)),
      companies: vi.fn(() => Promise.resolve(vazio))
    },
    categories: { list: vi.fn(() => Promise.resolve(vazio)) },
    notifications: { list: vi.fn(() => Promise.resolve({ items: [], unreadCount: 0 })) },
    messenger: { conversations: vi.fn(() => Promise.resolve({ items: [], totalUnread: 0 })) },
    social: { feed: vi.fn(() => Promise.resolve(vazio)), stories: vi.fn(() => Promise.resolve({ items: [] })), me: vi.fn() },
    events: { list: vi.fn(() => Promise.resolve(vazio)) },
    search: vi.fn(() => Promise.resolve({ query: '', results: {} }))
  };
  return {
    default: api, api,
    getAuthToken: () => null,
    setAuthToken: vi.fn(), clearAuthToken: vi.fn(), refreshData: vi.fn(),
    SESSAO_EXPIRADA: 'mci-sessao-expirada',
    fetchMediaObjectUrl: vi.fn(() => Promise.reject(new Error('sem mídia'))),
    releaseMediaObjectUrl: vi.fn()
  };
});

const { default: App } = await import('./App');

const visitar = rota => {
  window.location.hash = `#/${rota}`;
  return render(<App />);
};

beforeEach(() => {
  try { sessionStorage.setItem('mci-abertura-vista', 'true'); } catch { /* aba anônima */ }
  window.matchMedia = consulta => ({
    matches: false, media: consulta, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false
  });
  respostas.user = null;
});
afterEach(cleanup);

const naEntrada = () => Boolean(document.querySelector('.auth-shell, .auth-card'));

describe('as superfícies PÚBLICAS abrem sem login', () => {
  it.each(['inicio', 'campeonatos', 'atletas', 'ranking'])(
    '%s abre para o visitante anônimo',
    async rota => {
      visitar(rota);
      await waitFor(() => expect(screen.getByRole('navigation', { name: /navegação principal/i })).toBeTruthy());
      expect(naEntrada(), `${rota} caiu na tela de entrada`).toBe(false);
    }
  );

  it('a ficha pública do atleta abre sem login, com nome e tudo', async () => {
    visitar('atletas/atl1');
    expect(await screen.findByText('Lucas Gouveia Lima')).toBeTruthy();
    expect(naEntrada()).toBe(false);
  });
});

describe('o que NÃO abre sem login', () => {
  // Uma por área: social, mensagens, comunidades, painel do atleta, conta,
  // treinador e o guarda-chuva administrativo.
  it.each([
    'social', 'messenger', 'comunidades', 'meu-painel', 'meu-cadastro',
    'minha-conta', 'minha-filiacao', 'meu-historico', 'treinador',
    'notificacoes', 'perfil', 'salvos', 'minha-equipe', 'minha-solicitacao'
  ])('%s continua pedindo sessão', async rota => {
    visitar(rota);
    await waitFor(() => expect(naEntrada()).toBe(true));
  });

  it.each([
    'admin', 'admin/atletas', 'admin/musclewar', 'admin/eventos',
    'admin/resultados', 'admin/auditoria', 'admin/lancamentos'
  ])('%s continua pedindo sessão', async rota => {
    visitar(rota);
    await waitFor(() => expect(naEntrada()).toBe(true));
  });

  it('rota inexistente não vira porta dos fundos', async () => {
    visitar('rota-que-nao-existe');
    await waitFor(() => expect(naEntrada()).toBe(true));
  });
});

describe('o casco do visitante', () => {
  it('o menu oferece só as quatro telas públicas', async () => {
    visitar('inicio');
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    for (const rotulo of ['Início', 'Campeonatos', 'Atletas', 'Ranking']) {
      expect(within(navegacao).getByRole('button', { name: new RegExp(rotulo, 'i') })).toBeTruthy();
    }
    for (const privado of ['Social', 'Messenger', 'Comunidades', 'Meu painel', 'Meu cadastro']) {
      expect(within(navegacao).queryByRole('button', { name: new RegExp(privado, 'i') }),
        `${privado} não pode aparecer para quem não tem sessão`).toBeNull();
    }
  });

  it('não há grupo de administração para o visitante', async () => {
    visitar('inicio');
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(within(navegacao).queryByText(/Administração/i)).toBeNull();
  });

  it('o visitante encontra a porta de entrada', async () => {
    visitar('inicio');
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(within(navegacao).getByRole('button', { name: /Entrar agora/i })).toBeTruthy();
  });

  it('notificações e perfil somem — levariam à tela de entrada', async () => {
    visitar('inicio');
    await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(screen.queryByRole('button', { name: /notificaç/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /meu perfil/i })).toBeNull();
  });

  it('nem o cartão de sessão, nem o botão de sair', async () => {
    visitar('inicio');
    await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(screen.queryByRole('button', { name: /sair/i })).toBeNull();
  });
});
