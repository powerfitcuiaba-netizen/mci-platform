import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// A superfície de rede é substituída por um duplo controlado: o que se testa
// aqui é a interface — navegação, permissões e render — e não o servidor.
const respostas = vi.hoisted(() => ({}));

vi.mock('./services/api', () => {
  const vazio = { items: [], nextCursor: null };
  const api = {
    auth: { me: vi.fn(() => Promise.resolve({ user: respostas.user })), login: vi.fn(), register: vi.fn(), updateProfile: vi.fn(), changePassword: vi.fn() },
    publicApi: {
      summary: vi.fn(() => Promise.resolve({ events: 3, athletes: 42, proAthletes: 5, publishedResults: 7, openSeasons: 1, upcoming: [{ id: 'e1', name: 'Etapa Cuiabá', slug: 'etapa-cuiaba', startDate: '2026-11-20T12:00:00.000Z', city: 'Cuiabá', state: 'MT' }] })),
      events: vi.fn(() => Promise.resolve(vazio)),
      event: vi.fn(),
      athletes: vi.fn(() => Promise.resolve(vazio)),
      athlete: vi.fn()
    },
    ranking: { list: vi.fn(() => Promise.resolve({ items: [], season: null, nextCursor: null })), seasons: vi.fn(() => Promise.resolve(vazio)) },
    categories: { list: vi.fn(() => Promise.resolve(vazio)) },
    notifications: { list: vi.fn(() => Promise.resolve({ items: [], unreadCount: 3 })), markRead: vi.fn(), markAllRead: vi.fn() },
    messenger: { conversations: vi.fn(() => Promise.resolve({ items: [], totalUnread: 2 })) },
    social: { feed: vi.fn(() => Promise.resolve(vazio)), stories: vi.fn(() => Promise.resolve({ items: [] })), me: vi.fn() },
    communities: { list: vi.fn(() => Promise.resolve(vazio)) },
    events: { list: vi.fn(() => Promise.resolve(vazio)) },
    dashboard: { admin: vi.fn(() => Promise.resolve({ events: { active: 1, total: 2 }, athletes: { total: 10, pro: 2 }, registrations: 8, checkIns: 4, weighIns: 3, batches: 2, openJudgingSessions: 1, publishedResults: 0, muscleWarImports: 0, alerts: [] })), athlete: vi.fn() },
    search: vi.fn(() => Promise.resolve({ query: '', results: {} })),
    audit: vi.fn(() => Promise.resolve(vazio))
  };

  return {
    default: api,
    api,
    getAuthToken: () => 'token-de-teste',
    setAuthToken: vi.fn(),
    clearAuthToken: vi.fn(),
    refreshData: vi.fn(),
    fetchMediaObjectUrl: vi.fn(() => Promise.reject(new Error('sem mídia'))),
    releaseMediaObjectUrl: vi.fn()
  };
});

const { default: App } = await import('./App');

const montarComo = usuario => {
  respostas.user = usuario;
  window.location.hash = '#/inicio';
  return render(<App />);
};

const ATLETA = { id: 'u1', name: 'Ana Atleta', email: 'ana@mci.test', role: 'ATHLETE', status: 'ACTIVE', organizations: [] };
const DIRETOR = { id: 'u2', name: 'Dora Diretora', email: 'dora@mci.test', role: 'ATHLETE', status: 'ACTIVE', organizations: [{ organizationId: 'org1', role: 'EVENT_DIRECTOR', name: 'Federação A', slug: 'fed-a' }] };
const JUIZ = { id: 'u3', name: 'João Juiz', email: 'joao@mci.test', role: 'JUDGE', status: 'ACTIVE', organizations: [] };

// Sem `globals: true`, a limpeza automática do testing-library não roda: sem
// isto, cada render acumularia no DOM e as consultas achariam vários nós.
afterEach(cleanup);

describe('estrutura da aplicação', () => {
  beforeEach(() => { window.location.hash = ''; });

  it('mostra a navegação principal para qualquer usuário autenticado', async () => {
    montarComo(ATLETA);
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    for (const rotulo of ['Início', 'Campeonatos', 'Atletas', 'Ranking', 'Social', 'Messenger', 'Comunidades', 'Meu painel']) {
      expect(within(navegacao).getByRole('button', { name: new RegExp(rotulo, 'i') })).toBeInTheDocument();
    }
  });

  it('não oferece área administrativa a quem não tem permissão', async () => {
    montarComo(ATLETA);
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    expect(within(navegacao).queryByText(/Administração/i)).not.toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /Auditoria/i })).not.toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /MuscleWar/i })).not.toBeInTheDocument();
  });

  it('oferece ao diretor de evento exatamente o que a permissão dele alcança', async () => {
    montarComo(DIRETOR);
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    expect(within(navegacao).getByText(/Administração/i)).toBeInTheDocument();
    for (const rotulo of ['Eventos', 'Inscrições', 'Check-in', 'Pesagem', 'Julgamento', 'Resultados', 'MuscleWar']) {
      expect(within(navegacao).getByRole('button', { name: new RegExp(rotulo, 'i') }), rotulo).toBeInTheDocument();
    }
    // Auditoria é permissão de administrador da plataforma.
    expect(within(navegacao).queryByRole('button', { name: /^Auditoria$/i })).not.toBeInTheDocument();
  });

  it('dá ao juiz apenas o que ele opera', async () => {
    montarComo(JUIZ);
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    expect(within(navegacao).getByRole('button', { name: /Julgamento/i })).toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /^Resultados$/i })).not.toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /MuscleWar/i })).not.toBeInTheDocument();
  });

  it('mostra os contadores de não lidas vindos da API', async () => {
    montarComo(ATLETA);

    await waitFor(() => expect(screen.getByRole('button', { name: /3 não lidas/i })).toBeInTheDocument());
    const navegacao = screen.getByRole('navigation', { name: /navegação principal/i });
    expect(within(navegacao).getByRole('button', { name: /Messenger/i })).toHaveTextContent('2');
  });

  it('navega entre seções pelo menu', async () => {
    const usuario = userEvent.setup();
    montarComo(ATLETA);

    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });
    await usuario.click(within(navegacao).getByRole('button', { name: /Ranking/i }));

    await waitFor(() => expect(window.location.hash).toBe('#/ranking'));
    expect(await screen.findByRole('heading', { level: 1, name: /^Ranking$/i })).toBeInTheDocument();
  });

  it('rota administrativa alcançada sem permissão cai no início, sem tela quebrada', async () => {
    respostas.user = ATLETA;
    window.location.hash = '#/admin/auditoria';
    render(<App />);

    expect(await screen.findByRole('heading', { name: /Campeonato Brasileiro Muscle Contest/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /^Auditoria$/i })).not.toBeInTheDocument();
  });

  it('renderiza a home com os números reais devolvidos pela API', async () => {
    montarComo(ATLETA);

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(await screen.findByText('Etapa Cuiabá')).toBeInTheDocument();
  });
});

describe('sem sessão', () => {
  it('apresenta a tela de acesso quando não há usuário', async () => {
    respostas.user = null;
    const { api } = await import('./services/api');
    api.auth.me.mockRejectedValueOnce(new Error('sem sessão'));

    render(<App />);
    expect(await screen.findByRole('heading', { name: /Entrar/i })).toBeInTheDocument();
  });
});
