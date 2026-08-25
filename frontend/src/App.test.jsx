import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const { mockApi } = vi.hoisted(() => {
  const fn = () => vi.fn();
  return {
    mockApi: {
      auth: { login: fn(), register: fn(), me: fn() },
      profile: { me: fn(), update: fn(), changePassword: fn() },
      athlete: { overview: fn() },
      admin: { overview: fn(), users: fn(), user: fn(), updateUser: fn() },
      audit: { list: fn() },
      orders: { list: fn(), get: fn(), create: fn(), cancel: fn(), payments: fn(), startPayment: fn(), refund: fn() },
      coupons: { list: fn(), create: fn(), setActive: fn(), preview: fn() },
      refunds: { list: fn() },
      sponsors: { list: fn(), create: fn(), sponsorships: fn(), createSponsorship: fn() },
      dashboard: { summary: fn() },
      tournaments: { list: fn(), get: fn(), create: fn(), update: fn(), remove: fn(), participants: fn(), enroll: fn(), cancelEnrollment: fn(), standings: fn() },
      participants: { list: fn(), create: fn(), update: fn(), remove: fn() },
      teams: { list: fn(), create: fn(), update: fn(), remove: fn() },
      matches: { list: fn(), create: fn(), update: fn(), result: fn(), saveResult: fn(), updateResult: fn() },
      judge: { matches: fn(), assignments: fn(), assign: fn() },
      checkin: { byTournament: fn(), byEnrollment: fn(), register: fn(), cancel: fn() },
      notifications: { list: fn(), markRead: fn(), markAllRead: fn() },
      documents: { list: fn(), get: fn(), create: fn(), upload: fn(), download: fn(), remove: fn() },
      coach: { overview: fn(), teams: fn(), athletes: fn(), setTeam: fn() },
      backstage: { overview: fn() },
      reports: { list: fn(), tournament: fn() },
      publicFeed: { summary: fn(), tournaments: fn(), tournament: fn(), live: fn(), athletes: fn(), athlete: fn(), teams: fn(), team: fn() }
    }
  };
});

vi.mock('./services/api', () => ({
  api: mockApi,
  refreshData: vi.fn(),
  getAuthToken: () => localStorage.getItem('mci-auth-token'),
  apiUpload: vi.fn(),
  apiDownload: vi.fn(),
  setAuthToken: vi.fn(),
  clearAuthToken: vi.fn()
}));

// O dashboard passou a ser específico por perfil: o payload carrega o papel e a
// composição correspondente.
const EMPTY_DASHBOARD = {
  role: 'ORGANIZER',
  totals: { activeTournaments: 0, tournaments: 0, participants: 0, teams: 0, enrollments: 0, checkedIn: 0, judges: 0, todayMatches: 0, liveMatches: 0, pendingResults: 0, unreadNotifications: 0 },
  activeTournaments: [], upcomingTournaments: [], todayMatches: [], liveMatches: [], recentResults: [], judges: [], pendingResults: [], alerts: []
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
  mockApi.publicFeed.athletes.mockResolvedValue({ items: [] });
  mockApi.publicFeed.teams.mockResolvedValue({ items: [] });
  mockApi.orders.list.mockResolvedValue({ items: [] });
  mockApi.coupons.list.mockResolvedValue({ items: [] });
  mockApi.refunds.list.mockResolvedValue({ items: [] });
  mockApi.participants.list.mockResolvedValue([]);
  mockApi.athlete.overview.mockResolvedValue({ semVinculo: true, participant: null, team: null, coach: null, enrollments: [], matches: [], results: [], standings: [], documents: [], totals: { enrollments: 0, checkedIn: 0, matches: 0, wins: 0, unreadNotifications: 0 } });
  mockApi.admin.overview.mockResolvedValue({ users: { total: 0, porPerfil: {} }, tournaments: { total: 0, porStatus: {} }, participants: { total: 0, porTipo: {} }, enrollments: { total: 0, porStatus: {} }, matches: { total: 0, porStatus: {} }, totals: {}, recentAudit: [] });
  mockApi.admin.users.mockResolvedValue({ items: [], total: 0 });
  mockApi.audit.list.mockResolvedValue({ items: [], total: 0 });
  mockApi.profile.update.mockResolvedValue({ user: { id: 'u1', name: 'Ana Souza', email: 'ana@mci.test', role: 'ORGANIZER' } });
  mockApi.profile.changePassword.mockResolvedValue({ success: true });
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
      expect(await screen.findByRole('heading', { name: /painel do organizador/i })).toBeInTheDocument();
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
      expect(await screen.findByRole('heading', { name: /painel do organizador/i })).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      // O nome aparece no card do campeonato e no rodapé do resultado recente.
      expect(screen.getAllByText('Copa MCI').length).toBeGreaterThan(0);
      expect(screen.getByText('3 - 1')).toBeInTheDocument();
    });

    it('mostra estado vazio quando não há dado algum', async () => {
      openPage('dashboard');
      expect(await screen.findByText(/nenhum evento ativo/i)).toBeInTheDocument();
      expect(screen.getByText(/nada pendente/i)).toBeInTheDocument();
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
      expect(screen.getByRole('button', { name: /enviar documento/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /excluir/i })).toBeInTheDocument();
    });

    it('não oferece ações de escrita a um atleta', async () => {
      mockApi.documents.list.mockResolvedValue({
        items: [{ id: 'd1', title: 'Regulamento', fileName: 'reg.pdf', mimeType: 'application/pdf', createdAt: '2026-08-24T12:00:00.000Z', tournament: { name: 'Copa MCI' } }]
      });
      openPage('documents', 'ATHLETE');
      expect(await screen.findByText('Regulamento')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /enviar documento/i })).not.toBeInTheDocument();
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


  describe('Athlete Center', () => {
    it('mostra estado explícito quando a conta não tem participante vinculado', async () => {
      openPage('athlete', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /minha carreira/i })).toBeInTheDocument();
      expect(screen.getByText(/ainda não está vinculada a um participante/i)).toBeInTheDocument();
    });

    it('mostra inscrições, vínculo e desempenho do próprio atleta', async () => {
      mockApi.athlete.overview.mockResolvedValue({
        semVinculo: false,
        participant: { id: 'p1', name: 'Equipe Alfa', identification: 'ALF', type: 'TEAM' },
        team: { id: 'p9', name: 'Equipe Alfa', identification: 'ALF' },
        coach: { id: 'c1', name: 'Marina Duarte', email: 'marina@mci.test' },
        enrollments: [{ id: 'e1', status: 'CONFIRMED', checkInStatus: 'CHECKED_IN', tournament: { id: 't1', name: 'Copa MCI', startDate: null } }],
        matches: [{ id: 'm1', status: 'FINISHED', participantA: { name: 'Equipe Alfa' }, participantB: { name: 'Equipe Beta' }, result: { scoreA: 3, scoreB: 1 } }],
        results: [], standings: [{ points: 3, wins: 1, draws: 0, losses: 0, played: 1, tournament: { id: 't1', name: 'Copa MCI' } }],
        documents: [],
        totals: { enrollments: 1, checkedIn: 1, matches: 1, wins: 1, unreadNotifications: 0 }
      });
      openPage('athlete', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /minha carreira/i })).toBeInTheDocument();
      expect(screen.getByText('Marina Duarte')).toBeInTheDocument();
      expect(screen.getByText('3 pts')).toBeInTheDocument();
      expect(screen.queryByText(/ainda não está vinculada/i)).not.toBeInTheDocument();
    });
  });

  describe('Admin Center', () => {
    it('lista usuários e permite suspender', async () => {
      mockApi.admin.users.mockResolvedValue({
        items: [{ id: 'u2', name: 'Bruno Lima', email: 'bruno@mci.test', role: 'ATHLETE', status: 'ACTIVE', createdAt: '2026-08-01T12:00:00.000Z' }],
        total: 1
      });
      mockApi.admin.updateUser.mockResolvedValue({ id: 'u2', status: 'SUSPENDED' });

      openPage('admin', 'ADMIN');
      expect(await screen.findByRole('heading', { name: /administração global/i })).toBeInTheDocument();
      expect(screen.getByText('Bruno Lima')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /suspender/i }));
      await waitFor(() => expect(mockApi.admin.updateUser).toHaveBeenCalledWith('u2', { status: 'SUSPENDED' }));
    });

    it('fica fora do alcance de quem não é ADMIN', async () => {
      openPage('admin', 'ORGANIZER');
      expect(await screen.findByText(/sem acesso a este módulo/i)).toBeInTheDocument();
      expect(mockApi.admin.overview).not.toHaveBeenCalled();
    });
  });

  describe('Perfil', () => {
    it('salva nome e email', async () => {
      openPage('profile');
      const nome = await screen.findByDisplayValue('Ana Souza');
      await userEvent.clear(nome);
      await userEvent.type(nome, 'Ana Paula');
      await userEvent.click(screen.getByRole('button', { name: /salvar alterações/i }));
      await waitFor(() => expect(mockApi.profile.update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ana Paula' })));
    });

    it('exige que a confirmação bata com a nova senha, sem chamar a API', async () => {
      openPage('profile');
      await screen.findByRole('heading', { name: /alterar senha/i });
      await userEvent.type(screen.getByLabelText(/senha atual/i), 'Senha@123');
      await userEvent.type(screen.getByLabelText(/^nova senha/i), 'NovaSenha@456');
      await userEvent.type(screen.getByLabelText(/confirmar nova senha/i), 'Diferente@789');
      await userEvent.click(screen.getByRole('button', { name: /alterar senha/i }));
      expect(await screen.findByText(/confirmação não confere/i)).toBeInTheDocument();
      expect(mockApi.profile.changePassword).not.toHaveBeenCalled();
    });

    it('troca a senha quando os campos conferem', async () => {
      openPage('profile');
      await screen.findByRole('heading', { name: /alterar senha/i });
      await userEvent.type(screen.getByLabelText(/senha atual/i), 'Senha@123');
      await userEvent.type(screen.getByLabelText(/^nova senha/i), 'NovaSenha@456');
      await userEvent.type(screen.getByLabelText(/confirmar nova senha/i), 'NovaSenha@456');
      await userEvent.click(screen.getByRole('button', { name: /alterar senha/i }));
      await waitFor(() => expect(mockApi.profile.changePassword).toHaveBeenCalledWith({ currentPassword: 'Senha@123', newPassword: 'NovaSenha@456' }));
    });
  });

  describe('Download de documento', () => {
    it('busca o arquivo pela API autenticada em vez de link direto', async () => {
      mockApi.documents.list.mockResolvedValue({
        items: [{ id: 'd1', title: 'Regulamento', fileName: 'reg.pdf', mimeType: 'application/pdf', sizeBytes: 2048, createdAt: '2026-08-24T12:00:00.000Z', tournament: { name: 'Copa MCI' } }]
      });
      mockApi.documents.download.mockResolvedValue(new Blob(['conteudo'], { type: 'application/pdf' }));
      globalThis.URL.createObjectURL = vi.fn(() => 'blob:teste');
      globalThis.URL.revokeObjectURL = vi.fn();

      openPage('documents');
      await screen.findByText('Regulamento');
      await userEvent.click(screen.getByRole('button', { name: /baixar/i }));
      await waitFor(() => expect(mockApi.documents.download).toHaveBeenCalledWith('d1'));
    });
  });

  describe('Dashboards por perfil', () => {
    const painel = (role, extra) => mockApi.dashboard.summary.mockResolvedValue({ ...EMPTY_DASHBOARD, role, ...extra });

    it('ADMIN recebe a visão global', async () => {
      painel('ADMIN', {
        totals: { users: 12, tournaments: 4, enrollments: 30, auditLogs: 87, liveMatches: 0, unreadNotifications: 0 },
        usersByRole: { ADMIN: 1, ORGANIZER: 2, ATHLETE: 9 },
        tournamentsByStatus: { ACTIVE: 2 }, enrollmentsByStatus: { CONFIRMED: 30 },
        liveMatches: [], recentAudit: [{ id: 'a1', action: 'USER_UPDATE', entity: 'User', userEmail: 'admin@mci.test', createdAt: '2026-08-25T10:00:00.000Z' }], alerts: []
      });
      openPage('dashboard', 'ADMIN');
      expect(await screen.findByRole('heading', { name: /visão global/i })).toBeInTheDocument();
      expect(screen.getByText('87')).toBeInTheDocument();
      expect(screen.getByText('USER_UPDATE')).toBeInTheDocument();
    });

    it('JUDGE recebe a agenda de arbitragem separada por momento', async () => {
      painel('JUDGE', {
        totals: { assignments: 2, todayMatches: 1, upcoming: 3, finished: 5, pendingResults: 1, unreadNotifications: 0 },
        tournaments: [{ id: 't1', name: 'Copa MCI', status: 'ACTIVE' }],
        todayMatches: [{ id: 'm1', status: 'SCHEDULED', participantA: { name: 'A' }, participantB: { name: 'B' } }],
        upcomingMatches: [], finishedMatches: [],
        pendingResults: [{ id: 'm9', status: 'FINISHED', participantA: { name: 'C' }, participantB: { name: 'D' } }]
      });
      openPage('dashboard', 'JUDGE');
      expect(await screen.findByRole('heading', { name: /minhas partidas/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /sem resultado lançado/i })).toBeInTheDocument();
    });

    it('COACH recebe elenco e agenda', async () => {
      painel('COACH', {
        totals: { teams: 2, athletes: 5, tournaments: 1, matches: 3, results: 2, unreadNotifications: 0 },
        teams: [{ id: 'p1', name: 'Equipe Alfa', identification: 'ALF', type: 'TEAM' }], athletes: [],
        tournaments: [], upcomingMatches: [], recentMatches: [], standings: []
      });
      openPage('dashboard', 'COACH');
      expect(await screen.findByRole('heading', { name: /meu elenco/i })).toBeInTheDocument();
      expect(screen.getByText('Equipe Alfa')).toBeInTheDocument();
    });

    it('ATHLETE recebe a própria carreira', async () => {
      painel('ATHLETE', {
        semVinculo: false,
        profile: { name: 'Bruno Carvalho', role: 'ATHLETE' },
        participant: { id: 'p1', name: 'Equipe Alfa' },
        team: { id: 'p9', name: 'Equipe Alfa' }, coach: { id: 'c1', name: 'Marina Duarte' },
        totals: { enrollments: 1, checkedIn: 1, matches: 2, wins: 1, unreadNotifications: 3 },
        enrollments: [], upcomingMatches: [], results: [], standings: [], documents: []
      });
      openPage('dashboard', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /olá, bruno/i })).toBeInTheDocument();
      expect(screen.getByText('Marina Duarte')).toBeInTheDocument();
    });
  });

  describe('Organizer Center', () => {
    it('consolida os módulos e navega para eles', async () => {
      openPage('organizer');
      expect(await screen.findByRole('heading', { name: /central de operação/i })).toBeInTheDocument();
      // Os módulos ficam na grade do centro; a sidebar tem itens de mesmo nome.
      const grade = document.querySelector('.module-grid');
      expect(within(grade).getByRole('button', { name: /check-in/i })).toBeInTheDocument();
      expect(within(grade).getByRole('button', { name: /relatórios/i })).toBeInTheDocument();
      expect(within(grade).getByRole('button', { name: /backstage/i })).toBeInTheDocument();
    });

    it('não é oferecido a quem não organiza', async () => {
      openPage('organizer', 'ATHLETE');
      expect(await screen.findByText(/sem acesso a este módulo/i)).toBeInTheDocument();
    });
  });

  describe('Vitrine pública', () => {
    it('abre a lista de atletas sem sessão', async () => {
      mockApi.publicFeed.athletes.mockResolvedValue({ items: [{ id: 'p1', name: 'Bruno Publico', identification: 'PUB-1', type: 'PLAYER', team: { id: 't1', name: 'Equipe Alfa' }, _count: { enrollments: 2 } }] });
      localStorage.clear();
      window.location.hash = '#public/athletes';
      render(<App />);
      expect(await screen.findByText('Bruno Publico')).toBeInTheDocument();
      expect(mockApi.auth.me).not.toHaveBeenCalled();
    });

    it('mostra o perfil público sem exigir login', async () => {
      mockApi.publicFeed.athlete.mockResolvedValue({
        participant: { id: 'p1', name: 'Bruno Publico', identification: 'PUB-1', type: 'PLAYER' },
        team: { id: 't1', name: 'Equipe Alfa' }, members: [],
        tournaments: [{ id: 'c1', name: 'Copa MCI', status: 'ACTIVE', startDate: null }],
        matches: [], results: [], standings: [{ points: 6, wins: 2, draws: 0, losses: 0, played: 2, tournament: { id: 'c1', name: 'Copa MCI' } }],
        totals: { tournaments: 1, matches: 2, played: 2, wins: 2, members: 0 }
      });
      localStorage.clear();
      window.location.hash = '#public/athletes/p1';
      render(<App />);
      expect(await screen.findByRole('heading', { name: /bruno publico/i })).toBeInTheDocument();
      expect(screen.getByText('6 pts')).toBeInTheDocument();
    });

    it('leva o visitante sem sessão à vitrine em vez do login', async () => {
      localStorage.clear();
      window.location.hash = '#dashboard';
      render(<App />);
      await waitFor(() => expect(window.location.hash).toContain('public/tournaments'));
    });
  });



  describe('Financeiro', () => {
    const EVENTO_PAGO = { id: 't1', name: 'Copa Paga', status: 'ACTIVE', entryFeeCents: 15000, currency: 'BRL' };

    it('mostra o valor vindo da API e não recalcula preço na interface', async () => {
      mockApi.tournaments.list.mockResolvedValue([EVENTO_PAGO]);
      mockApi.participants.list.mockResolvedValue([{ id: 'p1', name: 'Bruno Carvalho' }]);
      openPage('checkout', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /checkout/i })).toBeInTheDocument();
      // R$ 150,00 formatado a partir de 15000 centavos.
      expect(screen.getAllByText(/R\$\s*150,00/).length).toBeGreaterThan(0);
    });

    it('aplica o desconto que o servidor calculou', async () => {
      mockApi.tournaments.list.mockResolvedValue([EVENTO_PAGO]);
      mockApi.participants.list.mockResolvedValue([{ id: 'p1', name: 'Bruno Carvalho' }]);
      mockApi.coupons.preview.mockResolvedValue({ code: 'MCI10', description: null, discountCents: 1500 });

      openPage('checkout', 'ATHLETE');
      await screen.findByRole('heading', { name: /checkout/i });
      await userEvent.type(screen.getByPlaceholderText(/MCI10/i), 'MCI10');
      await userEvent.click(screen.getByRole('button', { name: /aplicar/i }));

      await waitFor(() => expect(mockApi.coupons.preview).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MCI10', subtotalCents: 15000 })
      ));
      expect(await screen.findByText(/135,00/)).toBeInTheDocument();
    });

    it('envia chave de idempotência ao gerar o pedido', async () => {
      mockApi.tournaments.list.mockResolvedValue([EVENTO_PAGO]);
      mockApi.participants.list.mockResolvedValue([{ id: 'p1', name: 'Bruno Carvalho' }]);
      mockApi.orders.create.mockResolvedValue({ id: 'o1' });
      // Após criar, a interface navega para o detalhe: o mock precisa cobrir a
      // tela de destino, senão o teste deixa uma promessa pendente para trás.
      mockApi.orders.get.mockResolvedValue({
        id: 'o1', status: 'PENDING', totalCents: 15000, discountCents: 0, currency: 'BRL',
        createdAt: '2026-08-25T10:00:00.000Z', tournament: { id: 't1', name: 'Copa Paga' },
        coupon: null, items: [], payments: [], refunds: []
      });

      openPage('checkout', 'ATHLETE');
      await screen.findByRole('heading', { name: /checkout/i });
      await userEvent.click(screen.getByRole('button', { name: /gerar pedido/i }));

      await waitFor(() => expect(mockApi.orders.create).toHaveBeenCalled());
      const [corpo, chave] = mockApi.orders.create.mock.calls[0];
      expect(corpo).toEqual({ tournamentId: 't1', participantId: 'p1' });
      // Preço, desconto e total não são enviados pela interface.
      expect(corpo).not.toHaveProperty('totalCents');
      expect(chave).toMatch(/^checkout-/);
    });

    it('lista pedidos com a situação de cada um', async () => {
      mockApi.orders.list.mockResolvedValue({
        items: [{ id: 'ordem123456', status: 'PAID', totalCents: 13500, currency: 'BRL', createdAt: '2026-08-25T10:00:00.000Z', tournament: { name: 'Copa Paga' } }]
      });
      openPage('orders', 'ATHLETE');
      expect(await screen.findByRole('heading', { name: /^pedidos$/i })).toBeInTheDocument();
      expect(screen.getByText(/135,00/)).toBeInTheDocument();
      // "Pago" também é opção do filtro; a asserção olha só a linha da tabela.
      const linha = document.querySelector('.table-row');
      expect(within(linha).getByText('Pago')).toBeInTheDocument();
    });

    it('oferece reembolso a quem administra e esconde de quem compra', async () => {
      const pedido = {
        id: 'o1', status: 'PAID', totalCents: 15000, currency: 'BRL', createdAt: '2026-08-25T10:00:00.000Z',
        tournament: { id: 't1', name: 'Copa Paga' }, coupon: null,
        items: [{ id: 'i1', description: 'Inscrição', quantity: 1, unitPriceCents: 15000, totalCents: 15000 }],
        payments: [{ id: 'pg1', status: 'PAID', provider: 'sandbox', amountCents: 15000, createdAt: '2026-08-25T10:05:00.000Z' }],
        refunds: [], discountCents: 0
      };
      mockApi.orders.get.mockResolvedValue(pedido);

      openPage('orders/o1', 'ORGANIZER');
      await screen.findByRole('heading', { name: /150,00/ });
      expect(screen.getByRole('button', { name: /reembolsar/i })).toBeInTheDocument();

      cleanup();
      resetApi();
      mockApi.orders.get.mockResolvedValue(pedido);
      openPage('orders/o1', 'ATHLETE');
      await screen.findByRole('heading', { name: /150,00/ });
      expect(screen.queryByRole('button', { name: /reembolsar/i })).not.toBeInTheDocument();
    });

    it('não oferece cupons a quem não administra', async () => {
      openPage('coupons', 'ATHLETE');
      expect(await screen.findByText(/sem acesso a este módulo/i)).toBeInTheDocument();
      expect(mockApi.coupons.list).not.toHaveBeenCalled();
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
