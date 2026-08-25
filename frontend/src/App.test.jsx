import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { mockApi } = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    mockApi: {
      auth: { login: fn(), register: fn(), me: fn() },
      dashboard: { summary: fn() },
      tournaments: { list: fn(), get: fn(), create: fn(), update: fn(), remove: fn(), participants: fn(), enroll: fn(), standings: fn() },
      participants: { list: fn(), create: fn(), update: fn(), remove: fn() },
      teams: { list: fn(), create: fn(), update: fn(), remove: fn() },
      matches: { list: fn(), create: fn(), update: fn(), result: fn(), saveResult: fn(), updateResult: fn() },
      judge: { matches: fn(), assignments: fn(), assign: fn() },
      checkin: { byTournament: fn(), byEnrollment: fn(), register: fn(), cancel: fn() },
      notifications: { list: fn(), markRead: fn(), markAllRead: fn() },
      documents: { list: fn(), get: fn(), create: fn(), remove: fn() },
      coach: { overview: fn(), teams: fn(), athletes: fn(), setTeam: fn() },
      backstage: { overview: fn() },
      reports: { list: fn(), tournament: fn() },
      publicFeed: { summary: fn(), tournaments: fn(), tournament: fn(), live: fn() }
    }
  };
});

vi.mock('./services/api', () => ({
  api: mockApi,
  refreshData: vi.fn(),
  getAuthToken: () => localStorage.getItem('mci-auth-token'),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn()
}));

const EMPTY_DASHBOARD = {
  totals: { activeTournaments: 0, tournaments: 0, participants: 0, teams: 0, enrollments: 0, checkedIn: 0, todayMatches: 0, liveMatches: 0, unreadNotifications: 0 },
  activeTournaments: [], upcomingTournaments: [], todayMatches: [], liveMatches: [], recentResults: []
};

// Zera todos os mocks e devolve respostas vazias válidas, para cada teste
// declarar apenas o que de fato exercita.
function resetApi() {
  for (const group of Object.values(mockApi)) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  mockApi.dashboard.summary.mockResolvedValue(EMPTY_DASHBOARD);
  mockApi.notifications.list.mockResolvedValue({ items: [], unreadCount: 0 });
  mockApi.tournaments.list.mockResolvedValue([]);
  mockApi.matches.list.mockResolvedValue([]);
  mockApi.judge.matches.mockResolvedValue({ items: [] });
  mockApi.documents.list.mockResolvedValue({ items: [] });
  mockApi.checkin.byTournament.mockResolvedValue({ items: [], total: 0, pending: 0, checkedIn: 0, cancelled: 0 });
  mockApi.coach.overview.mockResolvedValue({ teams: [], athletes: [], tournaments: [], matches: [], standings: [], totals: { teams: 0, athletes: 0, tournaments: 0, matches: 0 } });
  mockApi.backstage.overview.mockResolvedValue({ tournaments: [], totals: {}, todayMatches: [], liveMatches: [], pendingResults: [], alerts: [] });
  mockApi.reports.list.mockResolvedValue({ items: [] });
  mockApi.publicFeed.live.mockResolvedValue({ liveMatches: [], upcoming: [], recentResults: [], nextMatch: null });
  mockApi.publicFeed.tournaments.mockResolvedValue({ items: [] });
}

const signIn = (role = 'ORGANIZER') => {
  mockApi.auth.me.mockResolvedValue({ user: { id: 'u1', name: 'Ana Souza', email: 'ana@mci.test', role } });
  localStorage.setItem('mci-auth-token', 'token-de-teste');
};

const openPage = (page, role = 'ORGANIZER') => {
  signIn(role);
  window.location.hash = `#${page}`;
  render(<App />);
};

describe('MCI Campeonatos', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#login';
    resetApi();
  });
  afterEach(() => cleanup());

  describe('Sessão', () => {
    it('exibe a tela de login quando não há sessão', async () => {
      render(<App />);
      expect(await screen.findByRole('heading', { name: /login/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /entrar/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /criar conta/i })).toBeInTheDocument();
    });

    it('não consulta a caixa de notificações sem sessão', async () => {
      render(<App />);
      await screen.findByRole('heading', { name: /login/i });
      expect(mockApi.notifications.list).not.toHaveBeenCalled();
    });

    it('redireciona para dashboard quando o usuário está autenticado', async () => {
      openPage('login');
      expect(await screen.findByRole('heading', { name: /visão geral/i })).toBeInTheDocument();
    });
  });

  describe('Dashboard', () => {
    it('mostra números reais vindos da API', async () => {
      mockApi.dashboard.summary.mockResolvedValue({
        ...EMPTY_DASHBOARD,
        totals: { ...EMPTY_DASHBOARD.totals, activeTournaments: 3, tournaments: 5, enrollments: 42, checkedIn: 17, todayMatches: 4, liveMatches: 2, teams: 8, participants: 30 },
        activeTournaments: [{ id: 't1', name: 'Copa MCI', status: 'ACTIVE', _count: { enrollments: 12, matches: 6 } }],
        liveMatches: [{ id: 'm1', status: 'IN_PROGRESS', participantA: { name: 'Equipe A' }, participantB: { name: 'Equipe B' } }],
        recentResults: [{ id: 'r1', scoreA: 3, scoreB: 1, match: { participantA: { name: 'Equipe A' }, participantB: { name: 'Equipe B' }, tournament: { name: 'Copa MCI' } } }]
      });
      openPage('dashboard');
      expect(await screen.findByRole('heading', { name: /visão geral/i })).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      // O nome aparece no card do campeonato e no rodapé do resultado recente.
      expect(screen.getAllByText('Copa MCI').length).toBeGreaterThan(0);
      expect(screen.getByText('3 - 1')).toBeInTheDocument();
    });

    it('mostra estado vazio quando não há dado algum', async () => {
      openPage('dashboard');
      expect(await screen.findByText(/nenhum campeonato ativo/i)).toBeInTheDocument();
      expect(screen.getByText(/sem partidas hoje/i)).toBeInTheDocument();
    });

    it('mostra erro recuperável quando a API falha', async () => {
      mockApi.dashboard.summary.mockRejectedValue(new Error('Não foi possível conectar à API.'));
      openPage('dashboard');
      expect(await screen.findByText(/não foi possível carregar/i)).toBeInTheDocument();
      expect(screen.getByText(/não foi possível conectar à api/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
    });
  });

  describe('Notificações', () => {
    it('lista, mostra o contador e marca uma como lida', async () => {
      mockApi.notifications.list.mockResolvedValue({
        unreadCount: 2,
        items: [
          { id: 'n1', title: 'Resultado registrado', message: 'Equipe A x Equipe B (2 - 1)', type: 'RESULT', isRead: false, createdAt: '2026-08-24T12:00:00.000Z' },
          { id: 'n2', title: 'Check-in confirmado', message: 'Equipe A', type: 'CHECKIN', isRead: true, createdAt: '2026-08-24T11:00:00.000Z' }
        ]
      });
      mockApi.notifications.markRead.mockResolvedValue({ id: 'n1', isRead: true });

      openPage('notifications');
      expect(await screen.findByRole('heading', { name: /notificações/i })).toBeInTheDocument();
      expect(screen.getByText('Resultado registrado')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /marcar como lida/i }));
      await waitFor(() => expect(mockApi.notifications.markRead).toHaveBeenCalledWith('n1'));
    });

    it('marca todas como lidas', async () => {
      mockApi.notifications.list.mockResolvedValue({ unreadCount: 1, items: [{ id: 'n1', title: 'Nova inscrição', message: 'Equipe A', type: 'ENROLLMENT', isRead: false, createdAt: '2026-08-24T12:00:00.000Z' }] });
      mockApi.notifications.markAllRead.mockResolvedValue({ success: true });

      openPage('notifications');
      await userEvent.click(await screen.findByRole('button', { name: /marcar todas como lidas/i }));
      await waitFor(() => expect(mockApi.notifications.markAllRead).toHaveBeenCalled());
    });

    it('mostra estado vazio sem notificações', async () => {
      openPage('notifications');
      expect(await screen.findByText(/nenhuma notificação/i)).toBeInTheDocument();
    });
  });

  describe('Check-in', () => {
    it('lista inscritos e registra a presença', async () => {
      mockApi.tournaments.list.mockResolvedValue([{ id: 't1', name: 'Copa MCI', status: 'ACTIVE' }]);
      mockApi.checkin.byTournament.mockResolvedValue({
        total: 2, pending: 1, checkedIn: 1, cancelled: 0,
        items: [
          { id: 'e1', status: 'PENDING', participant: { name: 'Equipe A' }, checkedInAt: null, operatorName: null },
          { id: 'e2', status: 'CHECKED_IN', participant: { name: 'Equipe B' }, checkedInAt: '2026-08-24T12:00:00.000Z', operatorName: 'Mesa 1' }
        ]
      });
      mockApi.checkin.register.mockResolvedValue({ id: 'c1', status: 'CHECKED_IN' });

      openPage('checkin');
      expect(await screen.findByRole('heading', { name: /check-in/i })).toBeInTheDocument();
      expect(screen.getByText('Equipe A')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /fazer check-in/i }));
      await waitFor(() => expect(mockApi.checkin.register).toHaveBeenCalledWith('e1', {}));
    });

    it('desfaz um check-in já registrado', async () => {
      mockApi.tournaments.list.mockResolvedValue([{ id: 't1', name: 'Copa MCI', status: 'ACTIVE' }]);
      mockApi.checkin.byTournament.mockResolvedValue({
        total: 1, pending: 0, checkedIn: 1, cancelled: 0,
        items: [{ id: 'e2', status: 'CHECKED_IN', participant: { name: 'Equipe B' }, checkedInAt: '2026-08-24T12:00:00.000Z', operatorName: 'Mesa 1' }]
      });
      mockApi.checkin.cancel.mockResolvedValue({ status: 'CANCELLED' });

      openPage('checkin');
      await userEvent.click(await screen.findByRole('button', { name: /desfazer/i }));
      await waitFor(() => expect(mockApi.checkin.cancel).toHaveBeenCalledWith('e2'));
    });
  });

  describe('Judge Center', () => {
    it('lista as partidas designadas ao juiz', async () => {
      mockApi.judge.matches.mockResolvedValue({
        items: [{ id: 'm1', status: 'IN_PROGRESS', scheduledAt: null, participantA: { name: 'Equipe A' }, participantB: { name: 'Equipe B' }, result: null, tournament: { name: 'Copa MCI' } }]
      });
      openPage('judge', 'JUDGE');
      expect(await screen.findByRole('heading', { name: /painel de arbitragem/i })).toBeInTheDocument();
      expect(screen.getByText('Equipe A')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /registrar resultado/i })).toBeInTheDocument();
    });

    it('mostra estado vazio quando o juiz não tem designação', async () => {
      openPage('judge', 'JUDGE');
      expect(await screen.findByText(/nenhuma partida designada/i)).toBeInTheDocument();
    });
  });

  describe('Backstage', () => {
    it('mostra alertas operacionais reais', async () => {
      mockApi.backstage.overview.mockResolvedValue({
        tournaments: [], todayMatches: [], liveMatches: [], pendingResults: [],
        totals: { tournaments: 2, enrollments: 20, checkedIn: 12, pendingCheckIn: 8, missingResults: 3, liveMatches: 1 },
        alerts: [
          { level: 'WARNING', code: 'MISSING_RESULTS', message: '3 partida(s) sem resultado lançado.' },
          { level: 'INFO', code: 'PENDING_CHECKIN', message: '8 inscrito(s) ainda sem check-in.' }
        ]
      });
      openPage('backstage');
      expect(await screen.findByRole('heading', { name: /operação consolidada/i })).toBeInTheDocument();
      expect(screen.getByText(/3 partida\(s\) sem resultado/i)).toBeInTheDocument();
      expect(screen.getByText(/8 inscrito\(s\) ainda sem check-in/i)).toBeInTheDocument();
    });
  });

  describe('Coach Center', () => {
    it('mostra o elenco do técnico', async () => {
      mockApi.coach.overview.mockResolvedValue({
        totals: { teams: 1, athletes: 2, tournaments: 1, matches: 1 },
        teams: [{ id: 'p1', name: 'Equipe Alfa', identification: 'ALF', type: 'TEAM' }],
        athletes: [{ id: 'p2', name: 'João', identification: 'J1', type: 'PLAYER' }],
        tournaments: [{ id: 't1', name: 'Copa MCI', status: 'ACTIVE', enrolled: 2, checkedIn: 1 }],
        matches: [], standings: []
      });
      openPage('coach', 'COACH');
      expect(await screen.findByRole('heading', { name: /meu elenco/i })).toBeInTheDocument();
      expect(screen.getByText('Equipe Alfa')).toBeInTheDocument();
      expect(screen.getByText('João')).toBeInTheDocument();
    });
  });

  describe('Documentos', () => {
    it('lista documentos e oferece exclusão a quem administra', async () => {
      mockApi.documents.list.mockResolvedValue({
        items: [{ id: 'd1', title: 'Regulamento', fileName: 'reg.pdf', mimeType: 'application/pdf', createdAt: '2026-08-24T12:00:00.000Z', tournament: { name: 'Copa MCI' } }]
      });
      openPage('documents');
      expect(await screen.findByText('Regulamento')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /novo documento/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /excluir/i })).toBeInTheDocument();
    });

    it('não oferece ações de escrita a um atleta', async () => {
      mockApi.documents.list.mockResolvedValue({
        items: [{ id: 'd1', title: 'Regulamento', fileName: 'reg.pdf', mimeType: 'application/pdf', createdAt: '2026-08-24T12:00:00.000Z', tournament: { name: 'Copa MCI' } }]
      });
      openPage('documents', 'ATHLETE');
      expect(await screen.findByText('Regulamento')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /novo documento/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /excluir/i })).not.toBeInTheDocument();
    });
  });

  describe('MCI TV', () => {
    it('mostra a grade ao vivo a partir da API pública', async () => {
      mockApi.publicFeed.live.mockResolvedValue({
        liveMatches: [{ id: 'm1', status: 'IN_PROGRESS', participantA: { name: 'Equipe A' }, participantB: { name: 'Equipe B' }, result: { scoreA: 1, scoreB: 0 }, tournament: { name: 'Copa MCI' } }],
        upcoming: [], recentResults: [], nextMatch: null
      });
      openPage('tv', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /grade ao vivo/i })).toBeInTheDocument();
      expect(screen.getByText('1 - 0')).toBeInTheDocument();
    });

    it('não inventa transmissão quando não há nada no ar', async () => {
      openPage('tv', 'ATHLETE');
      expect(await screen.findByText(/nenhuma transmissão no ar/i)).toBeInTheDocument();
    });
  });

  describe('Permissões de navegação', () => {
    it('bloqueia módulo fora do perfil mesmo com acesso direto pelo hash', async () => {
      openPage('backstage', 'ATHLETE');
      expect(await screen.findByText(/sem acesso a este módulo/i)).toBeInTheDocument();
      expect(mockApi.backstage.overview).not.toHaveBeenCalled();
    });

    it('mostra ao juiz apenas os itens de navegação do seu perfil', async () => {
      openPage('judge', 'JUDGE');
      await screen.findByRole('heading', { name: /painel de arbitragem/i });
      const sidebar = document.querySelector('.sidebar nav');
      expect(within(sidebar).getByRole('button', { name: /judge center/i })).toBeInTheDocument();
      expect(within(sidebar).queryByRole('button', { name: /backstage/i })).not.toBeInTheDocument();
      expect(within(sidebar).queryByRole('button', { name: /check-in/i })).not.toBeInTheDocument();
    });
  });
});
