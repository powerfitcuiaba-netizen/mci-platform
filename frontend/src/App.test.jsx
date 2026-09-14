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
    dashboard: { admin: vi.fn(() => Promise.resolve({ events: { active: 1, total: 2 }, athletes: { total: 10, pro: 2 }, registrations: 8, checkIns: 4, weighIns: 3, batches: 2, publishedResults: 0, muscleWarImports: 0, alerts: [] })), athlete: vi.fn() },
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
    // Mesmo nome do evento real: o AuthContext escuta por ele para levar a
    // aplicação de volta à entrada quando o servidor recusa a sessão.
    SESSAO_EXPIRADA: 'mci-sessao-expirada',
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
// A abertura roda uma vez por sessão do navegador e é a PRIMEIRA tela. Estes
// testes são sobre a casca do sistema, então ela entra marcada como já vista —
// como numa segunda navegação. A abertura tem arquivo de teste próprio.
beforeEach(() => {
  try { sessionStorage.setItem('mci-abertura-vista', 'true'); } catch { /* aba anônima */ }
});

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
    for (const rotulo of ['Eventos', 'Inscrições', 'Check-in', 'Pesagem', 'Resultados', 'MuscleWar']) {
      expect(within(navegacao).getByRole('button', { name: new RegExp(rotulo, 'i') }), rotulo).toBeInTheDocument();
    }
    // Auditoria é permissão de administrador da plataforma.
    expect(within(navegacao).queryByRole('button', { name: /^Auditoria$/i })).not.toBeInTheDocument();
  });

  // O julgamento é EXTERNO: não existe tela de julgamento no MCI, e o juiz não
  // alcança resultado nem importação.
  it('dá ao juiz apenas o que ele opera, e julgamento não é uma tela daqui', async () => {
    montarComo(JUIZ);
    const navegacao = await screen.findByRole('navigation', { name: /navegação principal/i });

    expect(within(navegacao).queryByRole('button', { name: /Julgamento/i })).not.toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /^Resultados$/i })).not.toBeInTheDocument();
    expect(within(navegacao).queryByRole('button', { name: /MuscleWar/i })).not.toBeInTheDocument();
    expect(within(navegacao).getByRole('button', { name: /Inscrições/i })).toBeInTheDocument();
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

describe('a gaveta do celular', () => {
  it('fecha ao tocar num item, mesmo sendo o da tela atual', async () => {
    const usuario = userEvent.setup();
    montarComo(ATLETA);
    await screen.findByRole('navigation', { name: /navegação principal/i });

    await usuario.click(screen.getByRole('button', { name: /abrir menu/i }));
    expect(document.querySelector('.sidebar.is-open')).toBeTruthy();

    // "Início" já é a tela atual: não há troca de rota, e fechar só na troca
    // deixava a gaveta aberta — no celular isso parece toque não registrado.
    await usuario.click(within(screen.getByRole('navigation', { name: /navegação principal/i }))
      .getByRole('button', { name: 'Início' }));
    await waitFor(() => expect(document.querySelector('.sidebar.is-open')).toBeNull());
  });

  it('fecha também quando a rota muda de verdade', async () => {
    const usuario = userEvent.setup();
    montarComo(ATLETA);
    await screen.findByRole('navigation', { name: /navegação principal/i });

    await usuario.click(screen.getByRole('button', { name: /abrir menu/i }));
    await usuario.click(within(screen.getByRole('navigation', { name: /navegação principal/i }))
      .getByRole('button', { name: 'Atletas' }));
    await waitFor(() => expect(document.querySelector('.sidebar.is-open')).toBeNull());
  });
});

describe('a abertura precede o sistema', () => {
  it('numa sessão nova a abertura aparece antes de qualquer tela', async () => {
    sessionStorage.removeItem('mci-abertura-vista');
    montarComo(ATLETA);

    expect(await screen.findByRole('dialog', { name: /abertura do mci/i })).toBeInTheDocument();
    // E o sistema ainda não está montado por trás dela.
    expect(screen.queryByRole('navigation', { name: /navegação principal/i })).not.toBeInTheDocument();
  });

  it('quem ACABOU de ver a abertura entra com continuidade; quem recarregou, não', async () => {
    // São duas coisas diferentes: entrar no sistema e recarregar uma página.
    // O corte seco fazia as duas parecerem iguais.
    sessionStorage.removeItem('mci-abertura-vista');
    const usuario = userEvent.setup();
    montarComo(ATLETA);
    await usuario.click(await screen.findByRole('button', { name: /entrar agora/i }));
    await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(document.querySelector('.shell.entrada-continua')).toBeTruthy();

    cleanup();

    // Segunda montagem: a abertura já foi vista, então é recarga — entrada
    // normal, sem alongar nada.
    sessionStorage.setItem('mci-abertura-vista', 'true');
    montarComo(ATLETA);
    await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(document.querySelector('.shell.entrada-continua')).toBeNull();
  });

  it('a continuidade sai sozinha — não alonga a navegação pelo resto da sessão', async () => {
    // Relógio REAL aqui. Com relógio falso o teste media o adiantamento do
    // tempo, não o comportamento: o que importa é que a marca some sem
    // ninguém tirar — senão toda navegação do resto do dia ficaria lenta.
    sessionStorage.removeItem('mci-abertura-vista');
    const usuario = userEvent.setup();
    montarComo(ATLETA);
    await usuario.click(await screen.findByRole('button', { name: /entrar agora/i }));
    await screen.findByRole('navigation', { name: /navegação principal/i });
    expect(document.querySelector('.shell.entrada-continua')).toBeTruthy();

    await waitFor(
      () => expect(document.querySelector('.shell.entrada-continua')).toBeNull(),
      { timeout: 4000 }
    );
  });

  it('depois de "Entrar agora", o sistema aparece', async () => {
    sessionStorage.removeItem('mci-abertura-vista');
    const usuario = userEvent.setup();
    montarComo(ATLETA);

    await usuario.click(await screen.findByRole('button', { name: /entrar agora/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /abertura do mci/i })).not.toBeInTheDocument());
    expect(await screen.findByRole('navigation', { name: /navegação principal/i })).toBeInTheDocument();
  });
});
