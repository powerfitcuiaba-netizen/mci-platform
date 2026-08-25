import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, Bell, Wallet, CalendarDays, ChevronRight, CirclePlus, ClipboardList, Clock, Dumbbell, FileText, LayoutDashboard, LogOut, Menu, Medal, MessageSquare, MoreHorizontal, Radio, Search, Shield, Trophy, UserCheck, Users, X } from 'lucide-react';
import { AuthProvider, useAuth } from './AuthContext';
import { api, refreshData } from './services/api';

const baseNav = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['tournaments', 'Eventos', Trophy],
  ['people', 'Atletas', Users],
  ['teams', 'Equipes', Shield],
  ['matches', 'Partidas', CalendarDays],
  ['standings', 'Ranking', Medal],
  ['checkin', 'Check-in', UserCheck],
  ['athlete', 'Minha carreira', Medal],
  ['judge', 'Judge Center', Activity],
  ['coach', 'Coach Center', Dumbbell],
  ['organizer', 'Organizer Center', LayoutDashboard],
  ['backstage', 'Backstage', Radio],
  ['reports', 'Relatórios', BarChart3],
  ['tv', 'MCI TV', MessageSquare],
  ['notifications', 'Notificações', Bell],
  ['documents', 'Documentos', FileText],
  ['orders', 'Pedidos', Wallet],
  ['coupons', 'Cupons', BarChart3],
  ['admin', 'Admin Center', Shield]
];

const roleNav = {
  ADMIN: ['dashboard', 'organizer', 'tournaments', 'people', 'teams', 'matches', 'standings', 'checkin', 'judge', 'coach', 'athlete', 'backstage', 'reports', 'orders', 'coupons', 'tv', 'notifications', 'documents', 'admin'],
  ORGANIZER: ['dashboard', 'organizer', 'tournaments', 'people', 'teams', 'matches', 'standings', 'checkin', 'backstage', 'reports', 'orders', 'coupons', 'tv', 'notifications', 'documents'],
  JUDGE: ['dashboard', 'judge', 'matches', 'standings', 'tv', 'notifications'],
  COACH: ['dashboard', 'coach', 'tournaments', 'matches', 'standings', 'orders', 'checkout', 'tv', 'notifications', 'documents'],
  ATHLETE: ['dashboard', 'athlete', 'tournaments', 'standings', 'orders', 'checkout', 'tv', 'notifications', 'documents']
};

// Rotas alcançáveis que não ocupam espaço na navegação lateral ainda precisam
// de nome próprio no breadcrumb.
const TITULOS_FORA_DO_MENU = { checkout: 'Checkout', profile: 'Meu perfil' };

const statusLabel = { PLANNED: 'Planejado', ACTIVE: 'Em andamento', FINISHED: 'Encerrado', CANCELLED: 'Cancelado', SCHEDULED: 'Agendada', IN_PROGRESS: 'Ao vivo', PENDING: 'Pendente', CHECKED_IN: 'Presente' };
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Sem data';
const initials = value => (value || '?').split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase();

function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || 'login');
  useEffect(() => { const onHash = () => setRoute(window.location.hash.slice(1) || 'login'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  return [route, value => { window.location.hash = value; }];
}

function useFetch(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  // Cada disparo recebe um número de ordem. Só a resposta do disparo mais
  // recente pode escrever no estado: sem isso, uma requisição lenta iniciada
  // antes sobrescreve o resultado de outra iniciada depois — visível ao digitar
  // na busca, onde cada tecla dispara uma consulta.
  const ticket = useRef(0);
  const load = () => {
    const current = ++ticket.current;
    setState(previous => ({ ...previous, loading: true, error: '' }));
    // Promise.resolve envolve o retorno: um fetcher que devolva algo que não é
    // promessa vira estado de erro visível, em vez de estourar sem tratamento.
    Promise.resolve()
      .then(() => fetcher())
      .then(data => { if (current === ticket.current) setState({ data, loading: false, error: '' }); })
      .catch(error => { if (current === ticket.current) setState({ data: null, loading: false, error: error?.message || 'Falha ao carregar os dados.' }); });
  };
  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener('mci-data-changed', refresh);
    // Ao desmontar ou trocar de dependência, invalida o que estiver em voo.
    return () => { ticket.current++; window.removeEventListener('mci-data-changed', refresh); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load };
}

// Espera o usuário parar de digitar antes de consultar a API.
function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}

function AppShell() {
  const { user, authenticated, loading, logout, refreshSession } = useAuth();
  const [route, navigate] = useHashRoute();
  // A caixa só é consultada com sessão ativa: nas telas de login o fetch é dispensado.
  const inbox = useFetch(() => (authenticated ? api.notifications.list() : Promise.resolve({ items: [], unreadCount: 0 })), [authenticated]);
  const unread = inbox.data?.unreadCount || 0;
  // "Online" precisa significar algo: o indicador segue o resultado real da
  // última consulta à API, em vez de afirmar disponibilidade incondicionalmente.
  const apiOnline = !inbox.error;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const [flash, setFlash] = useState('');
  const page = route.split('/')[0];
  const detailId = route.split('/')[1];
  const go = value => { navigate(value); setMobileOpen(false); };
  const notify = message => { setFlash(message); setTimeout(() => setFlash(''), 3200); };

  // 'checkout' e o detalhe de pedido são alcançáveis por quem pode comprar,
  // ainda que não ocupem espaço próprio na navegação lateral.
  const availableRoutes = [...(roleNav[user?.role] || ['dashboard']), 'checkout'];
  const nav = baseNav.filter(([id]) => availableRoutes.includes(id));

  if (loading) return <div className="auth-shell"><div className="auth-card"><h1>Carregando...</h1></div></div>;
  // A vitrine pública não exige sessão: quem chega sem token vai para ela em
  // vez de ser empurrado ao login.
  if (page === 'public') return <PublicShell route={route} navigate={go} />;

  if (!authenticated && route !== 'login' && route !== 'register') {
    window.location.hash = 'public/tournaments';
    return null;
  }

  if (authenticated && (route === 'login' || route === 'register')) {
    window.location.hash = 'dashboard';
    return null;
  }

  if (route === 'login') return <LoginScreen navigate={go} />;
  if (route === 'register') return <RegisterScreen navigate={go} />;
  if (route === 'profile') return <div className="app-shell"><main className="main-content"><div className="page-wrap"><ProfileScreen user={user} onLogout={logout} navigate={go} notify={notify} refreshSession={refreshSession} /></div></main></div>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Trophy size={19} /></div><span>MCI <b>International</b></span></div>
      <div className="workspace-label">MUSCLE CONTEST PLATFORM</div>
      <nav>{nav.map(([id, label, Icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => go(id)}><Icon size={18} /><span>{label}</span>{page === id && <i />}</button>)}</nav>
      <div className="sidebar-foot"><div className={`season ${apiOnline ? '' : 'is-offline'}`}><span className="live-dot" /> {apiOnline ? 'Plataforma online' : 'Sem conexão'} <ChevronRight size={14} /></div><button className="profile" onClick={() => go('profile')}><div className="avatar">{initials(user?.name)}</div><div><strong>{user?.name || 'Usuário'}</strong><small>{user?.role || 'ATHLETE'}</small></div><MoreHorizontal size={17} /></button><button className="top-icon" aria-label="Logout" onClick={logout}><LogOut size={17} /></button></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu /></button><div className="breadcrumb"><span>MCI PLATFORM</span><ChevronRight size={14} /><strong>{nav.find(item => item[0] === page)?.[1] || TITULOS_FORA_DO_MENU[page] || 'Detalhes'}</strong></div><div className="top-actions">{availableRoutes.includes('people') && <button className="top-icon" aria-label="Buscar atletas" onClick={() => go('people')}><Search size={17} /></button>}<button className="top-icon notification-icon" aria-label="Notificações" onClick={() => go('notifications')}><Bell size={17} />{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</button><div className={`api-status ${apiOnline ? '' : 'is-offline'}`}><span className="live-dot" /> {apiOnline ? 'Sistema online' : 'API indisponível'}</div><div className="top-avatar">{initials(user?.name)}</div></div></header>
      <div className="page-wrap">{flash && <div className="toast"><Activity size={17} /> {flash}</div>}
        {!availableRoutes.includes(page) ? <EmptyState title="Sem acesso a este módulo" description="Seu perfil não tem permissão para abrir esta área." /> : <>
          {page === 'dashboard' && <Dashboard navigate={go} openModal={setModal} />}
          {page === 'tournaments' && (detailId ? <TournamentDetail id={detailId} navigate={go} notify={notify} openModal={setModal} /> : <Events navigate={go} openModal={setModal} notify={notify} />)}
          {page === 'people' && <People openModal={setModal} notify={notify} />}
          {page === 'teams' && <People openModal={setModal} notify={notify} teamOnly />}
          {page === 'matches' && <Matches openModal={setModal} notify={notify} />}
          {page === 'standings' && <Standings />}
          {page === 'checkin' && <CheckInCenter notify={notify} />}
          {page === 'judge' && <JudgeCenter openModal={setModal} />}
          {page === 'coach' && <CoachCenter navigate={go} />}
          {page === 'athlete' && <AthleteCenter navigate={go} />}
          {page === 'admin' && <AdminCenter notify={notify} />}
          {page === 'orders' && (detailId
            ? <OrderDetail id={detailId} navigate={go} notify={notify} podeReembolsar={['ADMIN', 'ORGANIZER'].includes(user?.role)} />
            : <MyOrders navigate={go} />)}
          {page === 'checkout' && <Checkout navigate={go} notify={notify} />}
          {page === 'coupons' && <CouponsCenter notify={notify} />}
          {page === 'organizer' && <OrganizerCenter navigate={go} openModal={setModal} />}
          {page === 'backstage' && <Backstage navigate={go} />}
          {page === 'reports' && <ReportsCenter />}
          {page === 'tv' && <MciTv />}
          {page === 'notifications' && <NotificationsCenter notify={notify} />}
          {page === 'documents' && <DocumentsCenter openModal={setModal} notify={notify} canManage={['ADMIN', 'ORGANIZER'].includes(user?.role)} />}
        </>}
      </div>
    </main>
    {modal === 'tournament' && <TournamentModal close={() => setModal(null)} notify={notify} />}
    {modal === 'participant' && <ParticipantModal close={() => setModal(null)} notify={notify} />}
    {modal === 'match' && <MatchModal close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'tournament-edit' && <TournamentEditModal tournament={modal.item} close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'participant-edit' && <ParticipantEditModal participant={modal.item} close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'result' && <ResultModal match={modal.item} close={() => setModal(null)} notify={notify} />}
    {modal === 'document' && <DocumentModal close={() => setModal(null)} notify={notify} />}
    {modal === 'document-upload' && <DocumentUploadModal close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'match-edit' && <MatchEditModal match={modal.item} close={() => setModal(null)} notify={notify} />}
  </div>;
}

function LoginScreen({ navigate }) {
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(form);
      window.location.hash = '#dashboard';
    } catch (err) {
      setError(err.message || 'Credenciais inválidas');
    } finally {
      setLoading(false);
    }
  };

  return <div className="auth-shell"><div className="auth-card"><span className="eyebrow">MCI PLATFORM</span><h1>Login</h1><p>Entre para acessar o painel</p><form onSubmit={handleSubmit} className="auth-form"><label><span>Email</span><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} type="email" placeholder="voce@exemplo.com" required /></label><label><span>Senha</span><input value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} type="password" placeholder="Sua senha" required /></label>{error && <div className="error-box">{error}</div>}<button type="submit" className="button button-primary" disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</button></form><div className="auth-footer"><span>Não tem conta?</span><button type="button" className="text-button" onClick={() => navigate('register')}>Criar conta</button></div></div></div>;
}

function RegisterScreen({ navigate }) {
  const { register } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'ATHLETE' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async e => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await register(form);
      window.location.hash = '#dashboard';
    } catch (err) {
      setError(err.message || 'Não foi possível criar a conta');
    } finally {
      setLoading(false);
    }
  };

  return <div className="auth-shell"><div className="auth-card"><span className="eyebrow">MCI PLATFORM</span><h1>Registro</h1><p>Crie sua conta para continuar</p><form onSubmit={handleSubmit} className="auth-form"><label><span>Nome</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></label><label><span>Email</span><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></label><label><span>Senha</span><input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} minLength="8" required /></label><label><span>Perfil</span><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="ADMIN">ADMIN</option><option value="ORGANIZER">ORGANIZER</option><option value="JUDGE">JUDGE</option><option value="COACH">COACH</option><option value="ATHLETE">ATHLETE</option></select></label>{error && <div className="error-box">{error}</div>}<button type="submit" className="button button-primary" disabled={loading}>{loading ? 'Criando...' : 'Criar conta'}</button></form><div className="auth-footer"><span>Já tem conta?</span><button type="button" className="text-button" onClick={() => navigate('login')}>Fazer login</button></div></div></div>;
}

function AthleteCenter({ navigate }) {
  const state = useFetch(api.athlete.overview, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {}; const totals = data.totals || {};
  return <><PageHeading eyebrow="ATHLETE CENTER" title="Minha carreira" description="Sua situação nas competições, do check-in ao resultado." />
    {data.semVinculo && <div className="alert-stack"><div className="alert-row level-info"><AlertTriangle size={17} /><span>Sua conta ainda não está vinculada a um participante. Peça ao organizador para fazer o vínculo e seus eventos aparecerão aqui.</span></div></div>}
    <section className="metric-grid"><Metric label="Inscrições" value={totals.enrollments ?? 0} trend="ativas" icon={Trophy} accent="mint" /><Metric label="Check-ins" value={totals.checkedIn ?? 0} trend="presenças confirmadas" icon={UserCheck} accent="blue" /><Metric label="Partidas" value={totals.matches ?? 0} trend={`${totals.wins ?? 0} vitórias`} icon={CalendarDays} accent="yellow" /><Metric label="Avisos" value={totals.unreadNotifications ?? 0} trend="não lidos" icon={Bell} accent="coral" /></section>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MINHAS INSCRIÇÕES</span><h2>Competições</h2></div></div>{(data.enrollments || []).length ? <div className="inscription-list">{data.enrollments.map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={17} /></div><div className="row-main"><strong>{item.tournament.name}</strong><small>{formatDate(item.tournament.startDate)}</small></div><StatusBadge status={item.status === 'CANCELLED' ? 'CANCELLED' : item.checkInStatus} /></div>)}</div> : <EmptyState title="Nenhuma inscrição" description="Suas competições aparecerão aqui." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">VÍNCULO</span><h2>Equipe e técnico</h2></div></div>{data.participant ? <div className="inscription-list"><div className="inscription-row"><div className="avatar avatar-teal">{initials(data.participant.name)}</div><div className="row-main"><strong>{data.participant.name}</strong><small>{data.participant.identification}</small></div></div>{data.team && <div className="inscription-row"><div className="sport-icon"><Shield size={17} /></div><div className="row-main"><strong>{data.team.name}</strong><small>Equipe</small></div></div>}{data.coach && <div className="inscription-row"><div className="avatar avatar-gold">{initials(data.coach.name)}</div><div className="row-main"><strong>{data.coach.name}</strong><small>Técnico</small></div></div>}</div> : <EmptyState title="Sem vínculo" description="Nenhum participante associado a esta conta." />}</section>
    </div>
    <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">AGENDA</span><h2>Minhas partidas</h2></div></div>{(data.matches || []).length ? data.matches.map(game => <GameRow key={game.id} game={game} expanded />) : <EmptyState title="Sem partidas" description="Sua agenda está vazia." />}</section>
    {(data.standings || []).length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DESEMPENHO</span><h2>Minha classificação</h2></div></div><div className="inscription-list">{data.standings.map((row, i) => <div className="inscription-row" key={i}><div className="row-main"><strong>{row.tournament.name}</strong><small>{row.played} jogos · {row.wins}V {row.draws}E {row.losses}D</small></div><b className="points">{row.points} pts</b></div>)}</div></section>}
    {(data.documents || []).length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DOCUMENTOS</span><h2>Autorizados a você</h2></div><button className="text-button" onClick={() => navigate('documents')}>Abrir <ArrowUpRight size={15} /></button></div><div className="inscription-list">{data.documents.map(doc => <div className="inscription-row" key={doc.id}><div className="doc-icon"><FileText size={16} /></div><div className="row-main"><strong>{doc.title}</strong><small>{doc.tournament.name}</small></div></div>)}</div></section>}
  </>;
}

function AdminCenter({ notify }) {
  const overview = useFetch(api.admin.overview, []);
  const [busca, setBusca] = useState('');
  const [perfil, setPerfil] = useState('');
  const buscaAdiada = useDebounced(busca);
  const users = useFetch(() => api.admin.users({ search: buscaAdiada, role: perfil }), [buscaAdiada, perfil]);
  const audit = useFetch(() => api.audit.list({ limit: 15 }), []);

  const alterar = async (usuario, campo, valor) => {
    try { await api.admin.updateUser(usuario.id, { [campo]: valor }); users.reload(); overview.reload(); audit.reload(); notify('Usuário atualizado.'); }
    catch (error) { alert(error.message); }
  };

  const d = overview.data || {};
  return <><PageHeading eyebrow="ADMIN CENTER" title="Administração global" description="Contas, operação e trilha de auditoria da plataforma." />
    {overview.error && <ErrorState message={overview.error} retry={overview.reload} />}
    {!overview.loading && <section className="metric-grid"><Metric label="Usuários" value={d.users?.total ?? 0} trend={`${d.users?.porPerfil?.ADMIN ?? 0} administradores`} icon={Users} accent="mint" /><Metric label="Campeonatos" value={d.tournaments?.total ?? 0} trend={`${d.tournaments?.porStatus?.ACTIVE ?? 0} em andamento`} icon={Trophy} accent="blue" /><Metric label="Inscrições" value={d.enrollments?.total ?? 0} trend={`${d.enrollments?.porStatus?.CANCELLED ?? 0} canceladas`} icon={ClipboardList} accent="yellow" /><Metric label="Auditoria" value={d.totals?.auditLogs ?? 0} trend="ações registradas" icon={Shield} accent="coral" /></section>}

    <section className="panel table-panel admin-users">
      <div className="panel-heading" style={{ padding: '20px 20px 0' }}><div><span className="eyebrow">CONTAS</span><h2>Usuários</h2></div></div>
      <div className="toolbar" style={{ padding: '14px 20px 0' }}><label className="search-box"><Search size={17} /><input aria-label="Buscar usuário" value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar por nome ou email..." /></label><select aria-label="Filtrar por perfil" className="select-control" value={perfil} onChange={e => setPerfil(e.target.value)}><option value="">Todos os perfis</option>{['ADMIN', 'ORGANIZER', 'JUDGE', 'COACH', 'ATHLETE'].map(r => <option key={r} value={r}>{r}</option>)}</select></div>
      {users.loading ? <SkeletonRows count={5} /> : users.error ? <ErrorState message={users.error} retry={users.reload} /> : (users.data?.items || []).length ? <>
        <div className="table-head" style={{ marginTop: 14 }}><span>Usuário</span><span>Perfil</span><span>Situação</span><span>Desde</span></div>
        {users.data.items.map(u => <div className="table-row" key={u.id}>
          <div className="person-cell"><div className="avatar avatar-teal">{initials(u.name)}</div><div className="row-main"><strong>{u.name}</strong><small className="muted">{u.email}</small></div></div>
          <span><select aria-label={`Perfil de ${u.name}`} className="select-control" value={u.role} onChange={e => alterar(u, 'role', e.target.value)}>{['ADMIN', 'ORGANIZER', 'JUDGE', 'COACH', 'ATHLETE'].map(r => <option key={r} value={r}>{r}</option>)}</select></span>
          <span><span className={`badge ${u.status === 'ACTIVE' ? 'badge-active' : 'badge-cancelled'}`}>{u.status === 'ACTIVE' ? 'Ativa' : 'Suspensa'}</span></span>
          <span className="muted">{formatDate(u.createdAt)}</span>
          <span className="row-actions">{u.status === 'ACTIVE' ? <button onClick={() => alterar(u, 'status', 'SUSPENDED')}>Suspender</button> : <button onClick={() => alterar(u, 'status', 'ACTIVE')}>Reativar</button>}</span>
        </div>)}
      </> : <EmptyState title="Nenhum usuário encontrado" description="Ajuste a busca ou o filtro." />}
    </section>

    <section className="panel" style={{ marginTop: 18 }}><div className="panel-heading"><div><span className="eyebrow">AUDITORIA</span><h2>Ações recentes</h2></div></div>{(audit.data?.items || []).length ? <div className="inscription-list">{audit.data.items.map(log => <div className="inscription-row" key={log.id}><div className="row-main"><strong>{log.action}</strong><small>{log.entity}{log.entityId ? ` · ${log.entityId.slice(0, 8)}` : ''} — {log.userEmail || 'sistema'}</small></div><small className="muted">{formatDate(log.createdAt)}</small></div>)}</div> : <EmptyState title="Sem registros" description="Ações administrativas aparecerão aqui." />}</section>
  </>;
}

function ProfileScreen({ user, onLogout, navigate, notify, refreshSession }) {
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [senha, setSenha] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [salvando, setSalvando] = useState(false);
  const [trocando, setTrocando] = useState(false);
  const [erro, setErro] = useState('');
  const [erroSenha, setErroSenha] = useState('');

  const salvar = async e => {
    e.preventDefault(); setSalvando(true); setErro('');
    try { await api.profile.update(form); notify('Perfil atualizado.'); await refreshSession?.(); }
    catch (error) { setErro(error.message); }
    finally { setSalvando(false); }
  };

  const trocarSenha = async e => {
    e.preventDefault(); setErroSenha('');
    if (senha.newPassword !== senha.confirm) { setErroSenha('A confirmação não confere com a nova senha.'); return; }
    setTrocando(true);
    try {
      await api.profile.changePassword({ currentPassword: senha.currentPassword, newPassword: senha.newPassword });
      setSenha({ currentPassword: '', newPassword: '', confirm: '' });
      notify('Senha alterada.');
    } catch (error) { setErroSenha(error.message); }
    finally { setTrocando(false); }
  };

  return <><PageHeading eyebrow="USUÁRIO" title="Meu perfil" description="Dados da conta e segurança de acesso." action={<button className="button button-secondary" onClick={() => navigate('dashboard')}>Voltar</button>} />
    <div className="content-grid">
      <section className="panel">
        <div className="profile-card"><div className="avatar large">{initials(user?.name)}</div><div><h2>{user?.name}</h2><p className="muted">{user?.email}</p><span className="badge badge-active">{user?.role}</span></div></div>
        <form onSubmit={salvar} style={{ marginTop: 22 }}>
          <Field label="Nome" required><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} minLength="2" required /></Field>
          <Field label="Email" required><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /></Field>
          {erro && <div className="error-box">{erro}</div>}
          <div className="modal-actions"><button type="submit" className="button button-primary" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar alterações'}</button></div>
        </form>
        <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>Perfil de acesso e situação da conta são definidos pela administração.</p>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="eyebrow">SEGURANÇA</span><h2>Alterar senha</h2></div></div>
        <form onSubmit={trocarSenha}>
          <Field label="Senha atual" required><input type="password" autoComplete="current-password" value={senha.currentPassword} onChange={e => setSenha({ ...senha, currentPassword: e.target.value })} required /></Field>
          <Field label="Nova senha" required><input type="password" autoComplete="new-password" minLength="8" value={senha.newPassword} onChange={e => setSenha({ ...senha, newPassword: e.target.value })} required /></Field>
          <Field label="Confirmar nova senha" required><input type="password" autoComplete="new-password" minLength="8" value={senha.confirm} onChange={e => setSenha({ ...senha, confirm: e.target.value })} required /></Field>
          {erroSenha && <div className="error-box">{erroSenha}</div>}
          <div className="modal-actions"><button type="submit" className="button button-primary" disabled={trocando}>{trocando ? 'Alterando...' : 'Alterar senha'}</button></div>
        </form>
        <div className="modal-actions" style={{ borderTop: 0, marginTop: 6 }}><button className="button button-secondary" onClick={onLogout}>Sair da conta</button></div>
      </section>
    </div>
  </>;
}

function DocumentsCenter({ openModal, notify, canManage }) {
  const state = useFetch(() => api.documents.list(), []);
  const [baixando, setBaixando] = useState('');
  const items = state.data?.items || [];

  const remove = async item => {
    if (!window.confirm(`Excluir "${item.title}"? Esta ação não pode ser desfeita.`)) return;
    try { await api.documents.remove(item.id); refreshData(); state.reload(); notify('Documento excluído.'); }
    catch (error) { alert(error.message); }
  };

  // O download precisa do header Authorization, então o arquivo é buscado por
  // fetch e entregue ao navegador como blob.
  const baixar = async item => {
    setBaixando(item.id);
    try {
      const blob = await api.documents.download(item.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = item.fileName || 'documento';
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (error) { alert(error.message); }
    finally { setBaixando(''); }
  };

  const tamanho = bytes => !bytes ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  return <><PageHeading eyebrow="DOCUMENTOS & REGULAMENTOS" title="Biblioteca oficial" description="Regulamentos, fichas e documentos por campeonato." action={canManage ? <button className="button button-primary" onClick={() => openModal('document-upload')}><CirclePlus size={17} /> Enviar documento</button> : null} />
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel table-panel"><div className="table-head"><span>Documento</span><span>Campeonato</span><span>Tamanho</span><span>Adicionado</span></div>{items.map(item => <div className="table-row" key={item.id}>
      <div className="person-cell"><div className="doc-icon"><FileText size={17} /></div><div className="row-main"><strong>{item.title}</strong><small className="muted">{item.fileName}</small></div></div>
      <span className="muted">{item.tournament?.name}</span>
      <span className="muted">{tamanho(item.sizeBytes)}</span>
      <span className="muted">{formatDate(item.createdAt)}</span>
      <span className="row-actions">
        {item.sizeBytes > 0 && <button onClick={() => baixar(item)} disabled={baixando === item.id}>{baixando === item.id ? 'Baixando...' : 'Baixar'}</button>}
        {canManage && <button onClick={() => remove(item)}>Excluir</button>}
      </span>
    </div>)}</section> : <EmptyState title="Nenhum documento" description="Envie o regulamento do campeonato." action={canManage ? 'Enviar documento' : null} onAction={() => openModal('document-upload')} />}
  </>;
}

function DocumentUploadModal({ close, notify }) {
  const tournaments = useFetch(api.tournaments.list, []);
  const [form, setForm] = useState({ tournamentId: '', title: '' });
  const [arquivo, setArquivo] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const list = tournaments.data || [];

  const submit = async e => {
    e.preventDefault(); setErro('');
    if (!arquivo) { setErro('Escolha um arquivo para enviar.'); return; }
    setEnviando(true);
    const dados = new FormData();
    dados.append('tournamentId', form.tournamentId || list[0]?.id || '');
    if (form.title) dados.append('title', form.title);
    dados.append('fileName', arquivo.name);
    dados.append('file', arquivo);
    try { await api.documents.upload(dados); refreshData(); notify('Documento enviado.'); close(); }
    catch (error) { setErro(error.message); setEnviando(false); }
  };

  return <Modal title="Enviar documento" close={close}><form onSubmit={submit}>
    <Field label="Campeonato" required><select value={form.tournamentId || list[0]?.id || ''} onChange={e => setForm({ ...form, tournamentId: e.target.value })}>{list.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field label="Título"><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Usa o nome do arquivo se vazio" /></Field>
    <Field label="Arquivo" required><input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv" onChange={e => setArquivo(e.target.files?.[0] || null)} required /></Field>
    <p className="muted" style={{ fontSize: 11, marginTop: -8 }}>PDF, imagem, texto ou CSV, até 10 MB.</p>
    {erro && <div className="error-box">{erro}</div>}
    <ModalActions close={close} saving={enviando} /></form></Modal>;
}

// O servidor decide o que cada perfil vê; aqui a rota apenas escolhe a
// composição correspondente. Todos compartilham shell, tipografia e componentes:
// muda a hierarquia do conteúdo, não a identidade.
// Valores chegam da API em centavos inteiros e só viram texto aqui. A interface
// nunca calcula preço: o que ela mostra é o que o servidor decidiu.
const formatarCentavos = (cents, moeda = 'BRL') =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: moeda }).format((cents || 0) / 100);

const ROTULO_PEDIDO = {
  PENDING: 'Aguardando pagamento', PAID: 'Pago', CANCELLED: 'Cancelado',
  EXPIRED: 'Expirado', REFUNDED: 'Reembolsado'
};
const ROTULO_PAGAMENTO = {
  PENDING: 'Aguardando', PROCESSING: 'Processando', AUTHORIZED: 'Autorizado',
  PAID: 'Pago', FAILED: 'Recusado', CANCELLED: 'Cancelado', REFUNDED: 'Reembolsado'
};

function OrderStatusBadge({ status }) {
  const classe = status === 'PAID' ? 'badge-active'
    : status === 'PENDING' || status === 'PROCESSING' || status === 'AUTHORIZED' ? 'badge-planned'
      : status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED' ? 'badge-cancelled'
        : 'badge-finished';
  return <span className={`badge ${classe}`}>{ROTULO_PEDIDO[status] || ROTULO_PAGAMENTO[status] || status}</span>;
}

function Checkout({ navigate, notify }) {
  const tournaments = useFetch(api.tournaments.list, []);
  const participants = useFetch(api.participants.list, []);
  const [form, setForm] = useState({ tournamentId: '', participantId: '', couponCode: '' });
  const [previa, setPrevia] = useState(null);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  // Gerada uma vez por tentativa de compra e reenviada em qualquer repetição.
  const [chave] = useState(() => `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  const pagos = (tournaments.data || []).filter(item => item.entryFeeCents > 0 && !['FINISHED', 'CANCELLED'].includes(item.status));
  const evento = pagos.find(item => item.id === form.tournamentId) || pagos[0] || null;
  const subtotal = evento?.entryFeeCents || 0;
  const desconto = previa?.discountCents || 0;

  const aplicarCupom = async () => {
    setErro(''); setPrevia(null);
    if (!form.couponCode || !evento) return;
    try {
      const resultado = await api.coupons.preview({ code: form.couponCode, tournamentId: evento.id, subtotalCents: subtotal });
      setPrevia(resultado);
      notify(`Cupom ${resultado.code} aplicado.`);
    } catch (error) { setErro(error.message); }
  };

  const finalizar = async e => {
    e.preventDefault(); setErro(''); setEnviando(true);
    try {
      const pedido = await api.orders.create({
        tournamentId: evento.id,
        participantId: form.participantId || participants.data?.[0]?.id,
        ...(previa ? { couponCode: form.couponCode } : {})
      }, chave);
      refreshData();
      notify('Pedido criado.');
      navigate(`orders/${pedido.id}`);
    } catch (error) { setErro(error.message); setEnviando(false); }
  };

  if (tournaments.loading || participants.loading) return <SkeletonRows count={4} />;

  return <><PageHeading eyebrow="INSCRIÇÃO PAGA" title="Checkout" description="Confirme os dados, aplique cupom e gere o pedido." />
    {!pagos.length ? <EmptyState title="Nenhum campeonato pago disponível" description="Eventos com inscrição paga aparecem aqui." /> : <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PEDIDO</span><h2>Dados da inscrição</h2></div></div>
        <form onSubmit={finalizar}>
          <Field label="Campeonato" required><select value={evento?.id || ''} onChange={e => { setForm({ ...form, tournamentId: e.target.value }); setPrevia(null); }}>{pagos.map(item => <option key={item.id} value={item.id}>{item.name} — {formatarCentavos(item.entryFeeCents, item.currency)}</option>)}</select></Field>
          <Field label="Participante" required><select value={form.participantId || participants.data?.[0]?.id || ''} onChange={e => setForm({ ...form, participantId: e.target.value })}>{(participants.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Cupom de desconto"><div className="inscription-box"><input value={form.couponCode} onChange={e => setForm({ ...form, couponCode: e.target.value.toUpperCase() })} placeholder="Ex: MCI10" /><button type="button" className="button button-secondary" onClick={aplicarCupom}>Aplicar</button></div></Field>
          {erro && <div className="error-box">{erro}</div>}
          <div className="modal-actions"><button type="submit" className="button button-primary" disabled={enviando || !participants.data?.length}>{enviando ? 'Gerando pedido...' : 'Gerar pedido'}</button></div>
        </form>
      </section>

      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RESUMO</span><h2>Valores</h2></div></div>
        <div className="order-summary">
          <div className="order-line"><span>Inscrição</span><b>{formatarCentavos(subtotal, evento?.currency)}</b></div>
          {desconto > 0 && <div className="order-line is-discount"><span>Desconto {previa?.code ? `(${previa.code})` : ''}</span><b>− {formatarCentavos(desconto, evento?.currency)}</b></div>}
          <div className="order-line is-total"><span>Total</span><b>{formatarCentavos(Math.max(subtotal - desconto, 0), evento?.currency)}</b></div>
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 14 }}>O valor final é calculado e confirmado pelo servidor no momento de gerar o pedido.</p>
      </section>
    </div>}
  </>;
}

function MyOrders({ navigate }) {
  const [status, setStatus] = useState('');
  const state = useFetch(() => api.orders.list(status ? { status } : {}), [status]);
  const items = state.data?.items || [];

  return <><PageHeading eyebrow="FINANCEIRO" title="Pedidos" description="Suas inscrições pagas e o estado de cada pagamento." action={<button className="button button-primary" onClick={() => navigate('checkout')}><CirclePlus size={17} /> Nova inscrição paga</button>} />
    <div className="toolbar"><select aria-label="Filtrar por situação" className="select-control" value={status} onChange={e => setStatus(e.target.value)}><option value="">Todas as situações</option>{Object.entries(ROTULO_PEDIDO).map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}</select></div>
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel table-panel"><div className="table-head"><span>Pedido</span><span>Campeonato</span><span>Total</span><span>Situação</span></div>{items.map(item => <div className="table-row" key={item.id}>
      <div className="person-cell"><div className="doc-icon"><ClipboardList size={17} /></div><div className="row-main"><strong>#{item.id.slice(0, 8)}</strong><small className="muted">{formatDate(item.createdAt)}</small></div></div>
      <span className="muted">{item.tournament?.name}</span>
      <span><b className="points">{formatarCentavos(item.totalCents, item.currency)}</b></span>
      <span><OrderStatusBadge status={item.status} /></span>
      <span className="row-actions"><button onClick={() => navigate(`orders/${item.id}`)}>Abrir</button></span>
    </div>)}</section> : <EmptyState title="Nenhum pedido" description="Suas inscrições pagas aparecerão aqui." action="Nova inscrição paga" onAction={() => navigate('checkout')} />}
  </>;
}

function OrderDetail({ id, navigate, notify, podeReembolsar }) {
  const state = useFetch(() => api.orders.get(id), [id]);
  const [processando, setProcessando] = useState('');
  const [chave] = useState(() => `pag-${id}-${Math.random().toString(36).slice(2, 10)}`);

  const pedido = state.data;

  const pagar = async () => {
    setProcessando('pagar');
    try {
      const resultado = await api.orders.startPayment(id, chave);
      state.reload(); refreshData();
      notify(resultado.isRealProvider === false
        ? 'Pagamento aberto no provedor de desenvolvimento. A confirmação chega por webhook.'
        : 'Pagamento iniciado.');
    } catch (error) { alert(error.message); }
    finally { setProcessando(''); }
  };

  const cancelar = async () => {
    if (!window.confirm('Cancelar este pedido? A inscrição deixará de estar reservada.')) return;
    setProcessando('cancelar');
    try { await api.orders.cancel(id); state.reload(); refreshData(); notify('Pedido cancelado.'); }
    catch (error) { alert(error.message); }
    finally { setProcessando(''); }
  };

  const reembolsar = async () => {
    const motivo = window.prompt('Motivo do reembolso (opcional):') ?? null;
    if (motivo === null) return;
    setProcessando('reembolsar');
    try { await api.orders.refund(id, motivo ? { reason: motivo } : {}); state.reload(); refreshData(); notify('Reembolso concluído.'); }
    catch (error) { alert(error.message); }
    finally { setProcessando(''); }
  };

  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;

  return <><button className="back-link" onClick={() => navigate('orders')}><ChevronRight size={16} className="back-arrow" /> Pedidos</button>
    <div className="detail-hero"><div><span className="eyebrow">PEDIDO #{pedido.id.slice(0, 8)}</span><h1>{formatarCentavos(pedido.totalCents, pedido.currency)}</h1><p>{pedido.tournament?.name}</p></div><OrderStatusBadge status={pedido.status} /></div>

    <div className="content-grid" style={{ marginTop: 22 }}>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RESUMO</span><h2>Valores</h2></div></div>
        <div className="order-summary">
          {pedido.items.map(item => <div className="order-line" key={item.id}><span>{item.description}</span><b>{formatarCentavos(item.totalCents, pedido.currency)}</b></div>)}
          {pedido.discountCents > 0 && <div className="order-line is-discount"><span>Desconto {pedido.coupon?.code ? `(${pedido.coupon.code})` : ''}</span><b>− {formatarCentavos(pedido.discountCents, pedido.currency)}</b></div>}
          <div className="order-line is-total"><span>Total</span><b>{formatarCentavos(pedido.totalCents, pedido.currency)}</b></div>
        </div>
        <div className="modal-actions">
          {pedido.status === 'PENDING' && <><button className="button button-secondary" onClick={cancelar} disabled={!!processando}>Cancelar pedido</button><button className="button button-primary" onClick={pagar} disabled={!!processando}>{processando === 'pagar' ? 'Abrindo...' : 'Pagar agora'}</button></>}
          {pedido.status === 'PAID' && podeReembolsar && <button className="button button-secondary" onClick={reembolsar} disabled={!!processando}>{processando === 'reembolsar' ? 'Estornando...' : 'Reembolsar'}</button>}
        </div>
      </section>

      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PAGAMENTOS</span><h2>Histórico</h2></div></div>
        {(pedido.payments || []).length ? <div className="inscription-list">{pedido.payments.map(p => <div className="inscription-row" key={p.id}><div className="row-main"><strong>{formatarCentavos(p.amountCents, pedido.currency)}</strong><small>{p.provider} · {formatDate(p.createdAt)}{p.failureReason ? ` · ${p.failureReason}` : ''}</small></div><OrderStatusBadge status={p.status} /></div>)}</div> : <EmptyState title="Nenhuma tentativa" description="O histórico aparece após iniciar o pagamento." />}
        {(pedido.refunds || []).length > 0 && <><div className="panel-heading" style={{ marginTop: 20 }}><div><span className="eyebrow">REEMBOLSOS</span><h2>Estornos</h2></div></div><div className="inscription-list">{pedido.refunds.map(r => <div className="inscription-row" key={r.id}><div className="row-main"><strong>{formatarCentavos(r.amountCents, pedido.currency)}</strong><small>{r.reason || 'sem motivo informado'}</small></div><OrderStatusBadge status={r.status === 'COMPLETED' ? 'REFUNDED' : r.status} /></div>)}</div></>}
      </section>
    </div>
  </>;
}

function CouponsCenter({ notify }) {
  const state = useFetch(api.coupons.list, []);
  const tournaments = useFetch(api.tournaments.list, []);
  const [form, setForm] = useState({ code: '', tipo: 'percent', percentOff: 10, amountOffCents: 1000, tournamentId: '', maxRedemptions: '', maxPerUser: 1 });
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const items = state.data?.items || [];

  const criar = async e => {
    e.preventDefault(); setErro(''); setSalvando(true);
    const base = {
      code: form.code,
      tournamentId: form.tournamentId || tournaments.data?.[0]?.id,
      maxPerUser: Number(form.maxPerUser) || 1,
      ...(form.maxRedemptions ? { maxRedemptions: Number(form.maxRedemptions) } : {}),
      ...(form.tipo === 'percent' ? { percentOff: Number(form.percentOff) } : { amountOffCents: Math.round(Number(form.amountOffCents)) })
    };
    try { await api.coupons.create(base); setForm({ ...form, code: '' }); state.reload(); notify('Cupom criado.'); }
    catch (error) { setErro(error.message); }
    finally { setSalvando(false); }
  };

  const alternar = async cupom => {
    try { await api.coupons.setActive(cupom.id, !cupom.active); state.reload(); notify(cupom.active ? 'Cupom desativado.' : 'Cupom reativado.'); }
    catch (error) { alert(error.message); }
  };

  return <><PageHeading eyebrow="FINANCEIRO" title="Cupons" description="Descontos aplicados na inscrição, com limite e validade." />
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">NOVO</span><h2>Criar cupom</h2></div></div>
        <form onSubmit={criar}>
          <Field label="Código" required><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} minLength="3" required placeholder="MCI10" /></Field>
          <Field label="Campeonato" required><select value={form.tournamentId || tournaments.data?.[0]?.id || ''} onChange={e => setForm({ ...form, tournamentId: e.target.value })}>{(tournaments.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Tipo de desconto"><select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })}><option value="percent">Percentual</option><option value="amount">Valor fixo</option></select></Field>
          {form.tipo === 'percent'
            ? <Field label="Percentual (%)" required><input type="number" min="1" max="100" value={form.percentOff} onChange={e => setForm({ ...form, percentOff: e.target.value })} /></Field>
            : <Field label="Valor em centavos" required><input type="number" min="1" value={form.amountOffCents} onChange={e => setForm({ ...form, amountOffCents: e.target.value })} /></Field>}
          <div className="form-grid">
            <Field label="Limite total"><input type="number" min="1" value={form.maxRedemptions} onChange={e => setForm({ ...form, maxRedemptions: e.target.value })} placeholder="ilimitado" /></Field>
            <Field label="Por usuário"><input type="number" min="1" value={form.maxPerUser} onChange={e => setForm({ ...form, maxPerUser: e.target.value })} /></Field>
          </div>
          {erro && <div className="error-box">{erro}</div>}
          <div className="modal-actions"><button type="submit" className="button button-primary" disabled={salvando}>{salvando ? 'Criando...' : 'Criar cupom'}</button></div>
        </form>
      </section>

      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ATIVOS</span><h2>Cupons</h2></div></div>
        {state.loading ? <SkeletonRows count={3} /> : items.length ? <div className="inscription-list">{items.map(c => <div className="inscription-row" key={c.id}>
          <div className="row-main"><strong>{c.code}</strong><small>{c.percentOff ? `${c.percentOff}% de desconto` : formatarCentavos(c.amountOffCents)} · {c.redeemedCount}{c.maxRedemptions ? `/${c.maxRedemptions}` : ''} usos</small></div>
          <span className={`badge ${c.active ? 'badge-active' : 'badge-cancelled'}`}>{c.active ? 'Ativo' : 'Inativo'}</span>
          <button className="row-action" onClick={() => alternar(c)}>{c.active ? 'Desativar' : 'Reativar'}</button>
        </div>)}</div> : <EmptyState title="Nenhum cupom" description="Crie um cupom ao lado." />}
      </section>
    </div>
  </>;
}

function Dashboard({ navigate, openModal }) {
  const state = useFetch(api.dashboard.summary, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {};
  const props = { data, navigate, openModal };
  if (data.role === 'ADMIN') return <AdminDashboard {...props} />;
  if (data.role === 'JUDGE') return <JudgeDashboard {...props} />;
  if (data.role === 'COACH') return <CoachDashboard {...props} />;
  if (data.role === 'ATHLETE') return <AthleteDashboard {...props} />;
  return <OrganizerDashboard {...props} />;
}

function AdminDashboard({ data, navigate }) {
  const t = data.totals || {};
  return <><PageHeading eyebrow="ADMINISTRAÇÃO" title="Visão global" description="O estado da plataforma inteira, em números reais." action={<button className="button button-primary" onClick={() => navigate('admin')}><Shield size={17} /> Admin Center</button>} />
    {(data.alerts || []).length > 0 && <section className="alert-stack">{data.alerts.map(a => <div className={`alert-row level-${a.level.toLowerCase()}`} key={a.code}><AlertTriangle size={17} /><span>{a.message}</span></div>)}</section>}
    <section className="metric-grid"><Metric label="Usuários" value={t.users ?? 0} trend={`${data.usersByRole?.ADMIN ?? 0} administradores`} icon={Users} accent="mint" /><Metric label="Campeonatos" value={t.tournaments ?? 0} trend={`${data.tournamentsByStatus?.ACTIVE ?? 0} em andamento`} icon={Trophy} accent="blue" /><Metric label="Inscrições" value={t.enrollments ?? 0} trend={`${data.enrollmentsByStatus?.CANCELLED ?? 0} canceladas`} icon={ClipboardList} accent="yellow" /><Metric label="Auditoria" value={t.auditLogs ?? 0} trend="ações registradas" icon={Activity} accent="coral" /></section>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">CONTAS</span><h2>Distribuição por perfil</h2></div><button className="text-button" onClick={() => navigate('admin')}>Gerenciar <ArrowUpRight size={15} /></button></div><div className="inscription-list">{Object.entries(data.usersByRole || {}).map(([perfil, total]) => <div className="inscription-row" key={perfil}><div className="row-main"><strong>{perfil}</strong></div><b className="points">{total}</b></div>)}{!Object.keys(data.usersByRole || {}).length && <EmptyState title="Nenhum usuário" />}</div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">AO VIVO</span><h2>Acontecendo agora</h2></div>{(data.liveMatches || []).length > 0 && <span className="live-dot" />}</div>{(data.liveMatches || []).length ? data.liveMatches.map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Nada ao vivo" description="Partidas em andamento aparecem aqui." />}</section>
    </div>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">AUDITORIA</span><h2>Ações recentes</h2></div></div>{(data.recentAudit || []).length ? <div className="inscription-list">{data.recentAudit.map(log => <div className="inscription-row" key={log.id}><div className="row-main"><strong>{log.action}</strong><small>{log.entity} — {log.userEmail || 'sistema'}</small></div><small className="muted">{formatDate(log.createdAt)}</small></div>)}</div> : <EmptyState title="Sem registros" />}</section>
  </>;
}

function OrganizerDashboard({ data, navigate, openModal }) {
  const t = data.totals || {};
  return <><PageHeading eyebrow="MINHA OPERAÇÃO" title="Painel do organizador" description="Seus eventos, sua gente e o que precisa de atenção hoje." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Novo campeonato</button>} />
    {(data.alerts || []).length > 0 && <section className="alert-stack">{data.alerts.map(a => <div className={`alert-row level-${a.level.toLowerCase()}`} key={a.code}><AlertTriangle size={17} /><span>{a.message}</span></div>)}</section>}
    <section className="metric-grid"><Metric label="Meus eventos" value={t.tournaments ?? 0} trend={`${t.activeTournaments ?? 0} em andamento`} icon={Trophy} accent="mint" /><Metric label="Inscrições" value={t.enrollments ?? 0} trend={`${t.checkedIn ?? 0} com check-in`} icon={Users} accent="blue" /><Metric label="Partidas hoje" value={t.todayMatches ?? 0} trend={`${t.liveMatches ?? 0} ao vivo`} icon={CalendarDays} accent="yellow" /><Metric label="Sem resultado" value={t.pendingResults ?? 0} trend={`${t.judges ?? 0} juiz(es) designado(s)`} icon={ClipboardList} accent="coral" /></section>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MEUS EVENTOS</span><h2>Em andamento</h2></div><button className="text-button" onClick={() => navigate('organizer')}>Organizer Center <ArrowUpRight size={15} /></button></div>{(data.activeTournaments || []).length ? <div className="tournament-list">{data.activeTournaments.map(item => <TournamentRow key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} />)}</div> : <EmptyState title="Nenhum evento ativo" action="Criar campeonato" onAction={() => openModal('tournament')} />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PENDÊNCIAS</span><h2>Sem resultado</h2></div></div>{(data.pendingResults || []).length ? data.pendingResults.slice(0, 5).map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Nada pendente" description="Todos os resultados foram lançados." />}</section>
    </div>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">HOJE</span><h2>Agenda do dia</h2></div><CalendarDays size={19} className="muted-icon" /></div>{(data.todayMatches || []).length ? data.todayMatches.slice(0, 5).map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Sem partidas hoje" />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ARBITRAGEM</span><h2>Juízes designados</h2></div></div>{(data.judges || []).length ? <div className="inscription-list">{data.judges.map(j => <div className="inscription-row" key={j.id}><div className="avatar avatar-gold">{initials(j.judge.name)}</div><div className="row-main"><strong>{j.judge.name}</strong><small>{j.tournament.name}</small></div></div>)}</div> : <EmptyState title="Nenhum juiz designado" description="Designe um juiz para liberar o lançamento de resultados." />}</section>
    </div>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RESULTADOS</span><h2>Últimos lançamentos</h2></div><button className="text-button" onClick={() => navigate('reports')}>Relatórios <ArrowUpRight size={15} /></button></div>{(data.recentResults || []).length ? <div className="result-feed">{data.recentResults.map(row => <div className="result-line" key={row.id}><strong>{row.match?.participantA?.name} x {row.match?.participantB?.name}</strong><b className="score">{row.scoreA} - {row.scoreB}</b><small>{row.match?.tournament?.name}</small></div>)}</div> : <EmptyState title="Sem resultados" description="Resultados lançados aparecem aqui." />}</section>
  </>;
}

function JudgeDashboard({ data, navigate, openModal }) {
  const t = data.totals || {};
  return <><PageHeading eyebrow="ARBITRAGEM" title="Minhas partidas" description="A sua agenda de julgamento, do que é hoje ao que ficou pendente." action={<button className="button button-secondary" onClick={() => navigate('judge')}>Abrir Judge Center</button>} />
    <section className="metric-grid"><Metric label="Hoje" value={t.todayMatches ?? 0} trend="para julgar" icon={CalendarDays} accent="mint" /><Metric label="Próximas" value={t.upcoming ?? 0} trend="agendadas" icon={Clock} accent="blue" /><Metric label="Concluídas" value={t.finished ?? 0} trend="com resultado" icon={ClipboardList} accent="yellow" /><Metric label="Pendentes" value={t.pendingResults ?? 0} trend="sem lançamento" icon={AlertTriangle} accent="coral" /></section>
    {(data.pendingResults || []).length > 0 && <section className="panel matches-panel" style={{ borderLeft: '3px solid var(--red)' }}><div className="panel-heading"><div><span className="eyebrow">EXIGE AÇÃO</span><h2>Sem resultado lançado</h2></div></div>{data.pendingResults.map(g => <GameRow key={g.id} game={g} expanded onResult={() => openModal({ type: 'result', item: g })} />)}</section>}
    <div className="content-grid">
      <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">HOJE</span><h2>Agenda do dia</h2></div></div>{(data.todayMatches || []).length ? data.todayMatches.map(g => <GameRow key={g.id} game={g} onResult={() => openModal({ type: 'result', item: g })} />) : <EmptyState title="Sem partidas hoje" description="Nada designado para hoje." />}</section>
      <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">A SEGUIR</span><h2>Próximas</h2></div></div>{(data.upcomingMatches || []).length ? data.upcomingMatches.map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Sem próximas" />}</section>
    </div>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DESIGNAÇÕES</span><h2>Meus campeonatos</h2></div></div>{(data.tournaments || []).length ? <div className="inscription-list">{data.tournaments.map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={17} /></div><div className="row-main"><strong>{item.name}</strong></div><StatusBadge status={item.status} /></div>)}</div> : <EmptyState title="Nenhuma designação" description="Você aparecerá aqui ao ser designado a um campeonato." />}</section>
  </>;
}

function CoachDashboard({ data, navigate }) {
  const t = data.totals || {};
  return <><PageHeading eyebrow="COMISSÃO TÉCNICA" title="Meu elenco" description="Suas equipes, seus atletas e a agenda de quem você treina." action={<button className="button button-secondary" onClick={() => navigate('coach')}>Abrir Coach Center</button>} />
    <section className="metric-grid"><Metric label="Equipes" value={t.teams ?? 0} trend="sob sua gestão" icon={Shield} accent="mint" /><Metric label="Atletas" value={t.athletes ?? 0} trend="no elenco" icon={Users} accent="blue" /><Metric label="Competições" value={t.tournaments ?? 0} trend="com inscrição" icon={Trophy} accent="yellow" /><Metric label="Resultados" value={t.results ?? 0} trend={`${t.matches ?? 0} partidas`} icon={ClipboardList} accent="coral" /></section>
    <div className="content-grid">
      <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">A SEGUIR</span><h2>Próximas partidas</h2></div></div>{(data.upcomingMatches || []).length ? data.upcomingMatches.map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Sem partidas agendadas" />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">COMPETIÇÕES</span><h2>Onde você compete</h2></div></div>{(data.tournaments || []).length ? <div className="inscription-list">{data.tournaments.map(item => <button className="tournament-row" key={item.id} onClick={() => navigate(`tournaments/${item.id}`)}><div className="sport-icon"><Trophy size={17} /></div><div className="row-main"><strong>{item.name}</strong><small>{item.enrolled} inscrito(s) · {item.checkedIn} com check-in</small></div><ChevronRight size={16} className="row-chevron" /></button>)}</div> : <EmptyState title="Nenhuma competição" description="Este participante ainda não tem inscrição confirmada." />}</section>
    </div>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ELENCO</span><h2>Equipes e atletas</h2></div></div>{[...(data.teams || []), ...(data.athletes || [])].length ? <div className="inscription-list">{[...(data.teams || []), ...(data.athletes || [])].slice(0, 8).map(item => <div className="inscription-row" key={item.id}><div className="avatar avatar-teal">{initials(item.name)}</div><div className="row-main"><strong>{item.name}</strong><small>{item.identification}</small></div><StatusBadge status={item.type === 'TEAM' ? 'Equipe' : 'Participante'} /></div>)}</div> : <EmptyState title="Elenco vazio" />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DESEMPENHO</span><h2>Classificação</h2></div></div>{(data.standings || []).length ? <div className="inscription-list">{data.standings.slice(0, 8).map((row, i) => <div className="inscription-row" key={i}><div className="row-main"><strong>{row.participant?.name}</strong><small>{row.tournament?.name}</small></div><b className="points">{row.points} pts</b></div>)}</div> : <EmptyState title="Sem classificação" />}</section>
    </div>
  </>;
}

function AthleteDashboard({ data, navigate }) {
  const t = data.totals || {};
  return <><PageHeading eyebrow="MINHA CARREIRA" title={`Olá, ${(data.profile?.name || '').split(' ')[0] || 'atleta'}`} description="Suas competições, sua agenda e seus resultados." action={<button className="button button-secondary" onClick={() => navigate('athlete')}>Ver carreira completa</button>} />
    {data.semVinculo && <div className="alert-stack"><div className="alert-row level-info"><AlertTriangle size={17} /><span>Sua conta ainda não está vinculada a um participante. Peça ao organizador para fazer o vínculo.</span></div></div>}
    <section className="metric-grid"><Metric label="Competições" value={t.enrollments ?? 0} trend="inscrições ativas" icon={Trophy} accent="mint" /><Metric label="Check-ins" value={t.checkedIn ?? 0} trend="presenças" icon={UserCheck} accent="blue" /><Metric label="Partidas" value={t.matches ?? 0} trend={`${t.wins ?? 0} vitórias`} icon={CalendarDays} accent="yellow" /><Metric label="Avisos" value={t.unreadNotifications ?? 0} trend="não lidos" icon={Bell} accent="coral" /></section>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MINHAS INSCRIÇÕES</span><h2>Competições</h2></div></div>{(data.enrollments || []).length ? <div className="inscription-list">{data.enrollments.slice(0, 6).map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={17} /></div><div className="row-main"><strong>{item.tournament.name}</strong><small>{formatDate(item.tournament.startDate)}</small></div><StatusBadge status={item.status === 'CANCELLED' ? 'CANCELLED' : item.checkInStatus} /></div>)}</div> : <EmptyState title="Nenhuma inscrição" description="Suas competições aparecerão aqui." />}</section>
      <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">A SEGUIR</span><h2>Próximas partidas</h2></div></div>{(data.upcomingMatches || []).length ? data.upcomingMatches.map(g => <GameRow key={g.id} game={g} />) : <EmptyState title="Sem partidas agendadas" />}</section>
    </div>
    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">VÍNCULO</span><h2>Equipe e técnico</h2></div></div><div className="inscription-list">{data.team && <div className="inscription-row"><div className="sport-icon"><Shield size={17} /></div><div className="row-main"><strong>{data.team.name}</strong><small>Equipe</small></div></div>}{data.coach && <div className="inscription-row"><div className="avatar avatar-gold">{initials(data.coach.name)}</div><div className="row-main"><strong>{data.coach.name}</strong><small>Técnico</small></div></div>}{!data.team && !data.coach && <EmptyState title="Sem vínculo" description="Nenhuma equipe ou técnico associado." />}</div></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MEU RANKING</span><h2>Desempenho</h2></div></div>{(data.standings || []).length ? <div className="inscription-list">{data.standings.map((row, i) => <div className="inscription-row" key={i}><div className="row-main"><strong>{row.tournament.name}</strong><small>{row.played} jogos · {row.wins}V {row.draws}E {row.losses}D</small></div><b className="points">{row.points} pts</b></div>)}</div> : <EmptyState title="Sem classificação" description="Seus pontos aparecem após o primeiro resultado." />}</section>
    </div>
  </>;
}

// Camada de operação do organizador: consolida os módulos que já existem em um
// ponto de partida único. Nenhuma regra de negócio nova — os números vêm do
// mesmo dashboard e a navegação leva às telas existentes.
function OrganizerCenter({ navigate, openModal }) {
  const state = useFetch(api.dashboard.summary, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {}; const t = data.totals || {};

  const modulos = [
    ['tournaments', 'Eventos', Trophy, `${t.tournaments ?? 0} no total`],
    ['people', 'Participantes', Users, `${t.participants ?? 0} cadastrados`],
    ['teams', 'Equipes', Shield, `${t.teams ?? 0} cadastradas`],
    ['checkin', 'Check-in', UserCheck, `${t.checkedIn ?? 0} de ${t.enrollments ?? 0}`],
    ['matches', 'Partidas', CalendarDays, `${t.todayMatches ?? 0} hoje`],
    ['standings', 'Resultados e ranking', Medal, `${t.pendingResults ?? 0} sem resultado`],
    ['backstage', 'Backstage', Radio, `${t.liveMatches ?? 0} ao vivo`],
    ['reports', 'Relatórios', BarChart3, 'consolidado por evento'],
    ['documents', 'Documentos', FileText, 'regulamentos e fichas']
  ];

  return <><PageHeading eyebrow="ORGANIZER CENTER" title="Central de operação" description="Tudo o que você administra, a partir de um lugar só." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Novo campeonato</button>} />
    {(data.alerts || []).length > 0 && <section className="alert-stack">{data.alerts.map(a => <div className={`alert-row level-${a.level.toLowerCase()}`} key={a.code}><AlertTriangle size={17} /><span>{a.message}</span></div>)}</section>}
    <section className="metric-grid"><Metric label="Meus eventos" value={t.tournaments ?? 0} trend={`${t.activeTournaments ?? 0} em andamento`} icon={Trophy} accent="mint" /><Metric label="Inscrições" value={t.enrollments ?? 0} trend={`${t.checkedIn ?? 0} com check-in`} icon={Users} accent="blue" /><Metric label="Juízes" value={t.judges ?? 0} trend="designados" icon={Activity} accent="yellow" /><Metric label="Pendências" value={t.pendingResults ?? 0} trend="partidas sem resultado" icon={AlertTriangle} accent="coral" /></section>

    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MÓDULOS</span><h2>Operação</h2></div></div>
      <div className="module-grid">{modulos.map(([rota, titulo, Icone, detalhe]) => <button className="module-card" key={rota} onClick={() => navigate(rota)}><div className="sport-icon"><Icone size={19} /></div><div className="row-main"><strong>{titulo}</strong><small>{detalhe}</small></div><ChevronRight size={16} className="row-chevron" /></button>)}</div>
    </section>

    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">MEUS EVENTOS</span><h2>Em andamento</h2></div><button className="text-button" onClick={() => navigate('tournaments')}>Ver todos <ArrowUpRight size={15} /></button></div>{(data.activeTournaments || []).length ? <div className="tournament-list">{data.activeTournaments.map(item => <TournamentRow key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} />)}</div> : <EmptyState title="Nenhum evento ativo" action="Criar campeonato" onAction={() => openModal('tournament')} />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ARBITRAGEM</span><h2>Juízes designados</h2></div></div>{(data.judges || []).length ? <div className="inscription-list">{data.judges.map(j => <div className="inscription-row" key={j.id}><div className="avatar avatar-gold">{initials(j.judge.name)}</div><div className="row-main"><strong>{j.judge.name}</strong><small>{j.tournament.name}</small></div></div>)}</div> : <EmptyState title="Nenhum juiz designado" description="Designe um juiz para liberar o lançamento de resultados." />}</section>
    </div>
  </>;
}

// Vitrine pública: sem sessão, sem sidebar, apenas o que é aberto a qualquer um.
function PublicShell({ route, navigate }) {
  const [, alvo, id] = route.split('/');
  const aba = alvo || 'tournaments';
  return <div className="public-shell">
    <header className="public-topbar">
      <button className="brand" onClick={() => navigate('public/tournaments')}><div className="brand-mark"><Trophy size={19} /></div><span>MCI <b>International</b></span></button>
      <nav className="public-nav">
        <button className={aba === 'tournaments' ? 'active' : ''} onClick={() => navigate('public/tournaments')}>Competições</button>
        <button className={aba === 'athletes' ? 'active' : ''} onClick={() => navigate('public/athletes')}>Atletas</button>
        <button className={aba === 'teams' ? 'active' : ''} onClick={() => navigate('public/teams')}>Equipes</button>
        <button className={aba === 'tv' ? 'active' : ''} onClick={() => navigate('public/tv')}>MCI TV</button>
      </nav>
      <button className="button button-secondary" onClick={() => navigate('login')}>Entrar</button>
    </header>
    <div className="page-wrap">
      {aba === 'athletes' && (id ? <PublicProfile id={id} tipo="athlete" navigate={navigate} /> : <PublicRoster tipo="athlete" navigate={navigate} />)}
      {aba === 'teams' && (id ? <PublicProfile id={id} tipo="team" navigate={navigate} /> : <PublicRoster tipo="team" navigate={navigate} />)}
      {aba === 'tv' && <MciTv />}
      {aba === 'tournaments' && <PublicTournaments navigate={navigate} />}
    </div>
  </div>;
}

function PublicTournaments() {
  const state = useFetch(api.publicFeed.tournaments, []);
  const items = state.data?.items || [];
  return <><PageHeading eyebrow="MCI PLATFORM" title="Competições" description="A grade oficial de campeonatos do MCI." />
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel"><div className="tournament-list">{items.map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={19} /></div><div className="row-main"><strong>{item.name}</strong><small>{item._count?.enrollments || 0} participantes · {item._count?.matches || 0} partidas</small></div><StatusBadge status={item.status} /></div>)}</div></section> : <EmptyState title="Nenhuma competição pública" description="Campeonatos aparecem aqui quando publicados." />}
  </>;
}

function PublicRoster({ tipo, navigate }) {
  const carregar = tipo === 'team' ? api.publicFeed.teams : api.publicFeed.athletes;
  const state = useFetch(carregar, [tipo]);
  const [busca, setBusca] = useState('');
  const termo = busca.trim().toLowerCase();
  const items = (state.data?.items || []).filter(item => !termo || `${item.name} ${item.identification}`.toLowerCase().includes(termo));
  const rotulo = tipo === 'team' ? 'Equipes' : 'Atletas';

  return <><PageHeading eyebrow="MCI PLATFORM" title={rotulo} description={tipo === 'team' ? 'As equipes que competem no circuito.' : 'Os atletas que competem no circuito.'} />
    <div className="toolbar"><label className="search-box"><Search size={17} /><input aria-label={`Buscar ${rotulo.toLowerCase()}`} value={busca} onChange={e => setBusca(e.target.value)} placeholder={`Buscar ${rotulo.toLowerCase()}...`} /></label></div>
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={5} /> : items.length ? <section className="panel"><div className="tournament-list">{items.map(item => <button className="tournament-row" key={item.id} onClick={() => navigate(`public/${tipo === 'team' ? 'teams' : 'athletes'}/${item.id}`)}>
      <div className="avatar avatar-teal">{initials(item.name)}</div>
      <div className="row-main"><strong>{item.name}</strong><small>{item.identification}{item.team ? ` · ${item.team.name}` : ''}</small></div>
      <span className="badge badge-equipe">{item._count?.enrollments || 0} competição(ões)</span>
      <ChevronRight size={16} className="row-chevron" />
    </button>)}</div></section> : <EmptyState title={`Nenhum${tipo === 'team' ? 'a equipe' : ' atleta'} em competição`} description="Só aparecem aqui quem tem inscrição confirmada." />}
  </>;
}

function PublicProfile({ id, tipo, navigate }) {
  const carregar = tipo === 'team' ? api.publicFeed.team : api.publicFeed.athlete;
  const state = useFetch(() => carregar(id), [id, tipo]);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const d = state.data || {}; const p = d.participant || {}; const t = d.totals || {};

  return <><button className="back-link" onClick={() => navigate(`public/${tipo === 'team' ? 'teams' : 'athletes'}`)}><ChevronRight size={16} className="back-arrow" /> {tipo === 'team' ? 'Equipes' : 'Atletas'}</button>
    <div className="detail-hero"><div><span className="eyebrow">{tipo === 'team' ? 'EQUIPE' : 'ATLETA'}</span><h1>{p.name}</h1><p>{p.identification}{d.team ? ` · ${d.team.name}` : ''}</p></div><StatusBadge status={p.type === 'TEAM' ? 'Equipe' : 'Participante'} /></div>
    <section className="metric-grid" style={{ marginTop: 22 }}><Metric label="Competições" value={t.tournaments ?? 0} trend="inscrições" icon={Trophy} accent="mint" /><Metric label="Partidas" value={t.matches ?? 0} trend={`${t.played ?? 0} disputadas`} icon={CalendarDays} accent="blue" /><Metric label="Vitórias" value={t.wins ?? 0} trend="no circuito" icon={Medal} accent="yellow" />{tipo === 'team' ? <Metric label="Elenco" value={t.members ?? 0} trend="atletas" icon={Users} accent="coral" /> : <Metric label="Equipe" value={d.team ? 1 : 0} trend={d.team?.name || 'sem equipe'} icon={Shield} accent="coral" />}</section>

    <div className="content-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">CLASSIFICAÇÃO</span><h2>Desempenho</h2></div></div>{(d.standings || []).length ? <div className="inscription-list">{d.standings.map((row, i) => <div className="inscription-row" key={i}><div className="row-main"><strong>{row.tournament.name}</strong><small>{row.played} jogos · {row.wins}V {row.draws}E {row.losses}D</small></div><b className="points">{row.points} pts</b></div>)}</div> : <EmptyState title="Sem classificação" description="Os pontos aparecem após o primeiro resultado." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">COMPETIÇÕES</span><h2>Onde compete</h2></div></div>{(d.tournaments || []).length ? <div className="inscription-list">{d.tournaments.map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={17} /></div><div className="row-main"><strong>{item.name}</strong><small>{formatDate(item.startDate)}</small></div><StatusBadge status={item.status} /></div>)}</div> : <EmptyState title="Nenhuma competição" />}</section>
    </div>

    {tipo === 'team' && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ELENCO</span><h2>Atletas</h2></div></div>{(d.members || []).length ? <div className="inscription-list">{d.members.map(m => <button className="tournament-row" key={m.id} onClick={() => navigate(`public/athletes/${m.id}`)}><div className="avatar avatar-teal">{initials(m.name)}</div><div className="row-main"><strong>{m.name}</strong><small>{m.identification}</small></div><ChevronRight size={16} className="row-chevron" /></button>)}</div> : <EmptyState title="Elenco não divulgado" description="Esta equipe ainda não tem atletas vinculados publicamente." />}</section>}

    <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">HISTÓRICO</span><h2>Partidas</h2></div></div>{(d.matches || []).length ? d.matches.map(g => <GameRow key={g.id} game={g} expanded />) : <EmptyState title="Sem partidas" description="O histórico aparece quando a primeira partida for disputada." />}</section>
  </>;
}

function JudgeCenter({ openModal }) {
  const state = useFetch(api.judge.matches, []);
  const [filter, setFilter] = useState('');
  const items = (state.data?.items || []).filter(item => !filter || item.status === filter);
  return <><PageHeading eyebrow="JUDGE CENTER" title="Painel de arbitragem" description="As partidas dos campeonatos em que você está designado." />
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    <div className="toolbar"><select aria-label="Filtrar por status" className="select-control" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Todos os status</option><option value="SCHEDULED">Agendadas</option><option value="IN_PROGRESS">Ao vivo</option><option value="FINISHED">Encerradas</option></select></div>
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel matches-panel">{items.map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />)}</section> : <EmptyState title="Nenhuma partida designada" description="Você aparecerá aqui assim que for designado a um campeonato." />}
  </>;
}

function CheckInCenter({ notify }) {
  const tournaments = useFetch(api.tournaments.list, []);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const list = tournaments.data || [];
  // A lista vem por data de criação decrescente, então o primeiro item costuma
  // ser o evento mais novo — muitas vezes já encerrado. O credenciamento abre
  // no campeonato em andamento, que é onde há gente para receber.
  const active = selected || list.find(item => item.status === 'ACTIVE')?.id || list[0]?.id || '';
  const state = useFetch(() => (active ? api.checkin.byTournament(active, debouncedSearch) : Promise.resolve(null)), [active, debouncedSearch]);
  const data = state.data;
  const act = async (row, cancel) => {
    try { await (cancel ? api.checkin.cancel(row.id) : api.checkin.register(row.id, {})); refreshData(); state.reload(); notify(cancel ? 'Check-in cancelado.' : 'Check-in confirmado.'); }
    catch (error) { alert(error.message); }
  };
  return <><PageHeading eyebrow="CREDENCIAMENTO" title="Check-in" description="Confirme a presença dos inscritos no dia da competição." />
    <div className="toolbar"><select aria-label="Selecionar campeonato" className="select-control" value={active} onChange={e => setSelected(e.target.value)}>{list.length ? list.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Nenhum campeonato</option>}</select><label className="search-box"><Search size={17} /><input aria-label="Buscar inscrito" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar inscrito..." /></label></div>
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {data && <section className="metric-grid"><Metric label="Inscritos" value={data.total} trend="no campeonato" icon={Users} accent="blue" /><Metric label="Check-in feito" value={data.checkedIn} trend="presentes" icon={UserCheck} accent="mint" /><Metric label="Pendentes" value={data.pending} trend="ainda não chegaram" icon={Clock} accent="yellow" /><Metric label="Cancelados" value={data.cancelled} trend="baixas" icon={AlertTriangle} accent="coral" /></section>}
    {state.loading ? <SkeletonRows count={5} /> : data?.items?.length ? <section className="panel table-panel"><div className="table-head"><span>Inscrito</span><span>Situação</span><span>Horário</span><span>Operador</span></div>{data.items.map(row => <div className="table-row" key={row.id}><div className="person-cell"><div className="avatar avatar-teal">{initials(row.participant?.name)}</div><strong>{row.participant?.name}</strong></div><span><StatusBadge status={row.status} /></span><span className="muted">{row.checkedInAt ? new Date(row.checkedInAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}</span><span className="muted">{row.operatorName || '—'}</span><span className="row-actions">{row.status === 'CHECKED_IN' ? <button onClick={() => act(row, true)}>Desfazer</button> : <button onClick={() => act(row, false)}>Fazer check-in</button>}</span></div>)}</section> : <EmptyState title="Nenhum inscrito encontrado" description={search ? 'Ajuste a busca.' : 'Inscreva participantes neste campeonato.'} />}
  </>;
}

function NotificationsCenter({ notify }) {
  const state = useFetch(api.notifications.list, []);
  const items = state.data?.items || [];
  const unread = state.data?.unreadCount || 0;
  const readOne = async id => { try { await api.notifications.markRead(id); state.reload(); refreshData(); } catch (error) { alert(error.message); } };
  const readAll = async () => { try { await api.notifications.markAllRead(); state.reload(); refreshData(); notify('Todas marcadas como lidas.'); } catch (error) { alert(error.message); } };
  return <><PageHeading eyebrow="CENTRAL DE NOTIFICAÇÕES" title="Notificações" description={unread ? `${unread} não lida(s).` : 'Tudo em dia por aqui.'} action={unread ? <button className="button button-secondary" onClick={readAll}>Marcar todas como lidas</button> : null} />
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel">{items.map(item => <div className={`notification-row ${item.isRead ? '' : 'is-unread'}`} key={item.id}><div className={`notification-dot type-${String(item.type).toLowerCase()}`} /><div className="notification-body"><strong>{item.title}</strong><p>{item.message}</p><small>{formatDate(item.createdAt)}</small></div>{!item.isRead && <button className="row-action" onClick={() => readOne(item.id)}>Marcar como lida</button>}</div>)}</section> : <EmptyState title="Nenhuma notificação" description="Inscrições, check-ins e resultados aparecem aqui." />}
  </>;
}

function CoachCenter({ navigate }) {
  const state = useFetch(api.coach.overview, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {}; const totals = data.totals || {};
  return <><PageHeading eyebrow="COACH CENTER" title="Meu elenco" description="Equipes, atletas e a agenda de quem você treina." />
    <section className="metric-grid"><Metric label="Equipes" value={totals.teams ?? 0} trend="sob sua gestão" icon={Shield} accent="mint" /><Metric label="Atletas" value={totals.athletes ?? 0} trend="no elenco" icon={Users} accent="blue" /><Metric label="Campeonatos" value={totals.tournaments ?? 0} trend="com inscrição" icon={Trophy} accent="yellow" /><Metric label="Partidas" value={totals.matches ?? 0} trend="na agenda" icon={CalendarDays} accent="coral" /></section>
    <div className="content-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">ELENCO</span><h2>Equipes e atletas</h2></div></div>{[...(data.teams || []), ...(data.athletes || [])].length ? <div className="tournament-list">{[...(data.teams || []), ...(data.athletes || [])].map(item => <div className="inscription-row" key={item.id}><div className="avatar avatar-teal">{initials(item.name)}</div><div className="row-main"><strong>{item.name}</strong><small>{item.identification}</small></div><StatusBadge status={item.type === 'TEAM' ? 'Equipe' : 'Participante'} /></div>)}</div> : <EmptyState title="Elenco vazio" description="Cadastre suas equipes e atletas em Participantes." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">COMPETIÇÕES</span><h2>Onde você compete</h2></div></div>{(data.tournaments || []).length ? <div className="tournament-list">{data.tournaments.map(item => <button className="tournament-row" key={item.id} onClick={() => navigate(`tournaments/${item.id}`)}><div className="sport-icon"><Trophy size={19} /></div><div className="row-main"><strong>{item.name}</strong><small>{item.enrolled} inscrito(s) · {item.checkedIn} com check-in</small></div><StatusBadge status={item.status} /><ChevronRight size={17} className="row-chevron" /></button>)}</div> : <EmptyState title="Nenhuma competição" description="Inscreva seu elenco em um campeonato." />}</section></div>
    <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">AGENDA</span><h2>Partidas do elenco</h2></div></div>{(data.matches || []).length ? data.matches.map(game => <GameRow key={game.id} game={game} expanded />) : <EmptyState title="Sem partidas" description="A agenda do seu elenco está vazia." />}</section>
  </>;
}

function Backstage({ navigate }) {
  const state = useFetch(api.backstage.overview, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {}; const totals = data.totals || {};
  return <><PageHeading eyebrow="BACKSTAGE" title="Operação consolidada" description="O estado real da sua operação, com o que exige atenção primeiro." />
    {(data.alerts || []).length > 0 && <section className="alert-stack">{data.alerts.map(alert => <div className={`alert-row level-${alert.level.toLowerCase()}`} key={alert.code}><AlertTriangle size={17} /><span>{alert.message}</span></div>)}</section>}
    <section className="metric-grid"><Metric label="Campeonatos" value={totals.tournaments ?? 0} trend="sob sua gestão" icon={Trophy} accent="mint" /><Metric label="Inscrições" value={totals.enrollments ?? 0} trend={`${totals.checkedIn ?? 0} confirmadas`} icon={Users} accent="blue" /><Metric label="Sem resultado" value={totals.missingResults ?? 0} trend="partidas pendentes" icon={ClipboardList} accent="coral" /><Metric label="Ao vivo" value={totals.liveMatches ?? 0} trend="acontecendo agora" icon={Radio} accent="yellow" /></section>
    <div className="content-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">PENDÊNCIAS</span><h2>Partidas sem resultado</h2></div></div>{(data.pendingResults || []).length ? data.pendingResults.map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Nada pendente" description="Todos os resultados foram lançados." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">HOJE</span><h2>Agenda do dia</h2></div></div>{(data.todayMatches || []).length ? data.todayMatches.map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Sem partidas hoje" description="A agenda de hoje está livre." />}</section></div>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">CAMPEONATOS</span><h2>Situação por evento</h2></div></div>{(data.tournaments || []).length ? <div className="tournament-list">{data.tournaments.map(item => <button className="tournament-row" key={item.id} onClick={() => navigate(`tournaments/${item.id}`)}><div className="sport-icon"><Trophy size={19} /></div><div className="row-main"><strong>{item.name}</strong><small>{item._count?.enrollments || 0} inscritos · {item._count?.matches || 0} partidas · {item._count?.judgeAssignments || 0} juiz(es)</small></div><StatusBadge status={item.status} /><ChevronRight size={17} className="row-chevron" /></button>)}</div> : <EmptyState title="Nenhum campeonato" description="Crie um campeonato para começar." />}</section>
  </>;
}

function ReportsCenter() {
  const available = useFetch(api.reports.list, []);
  const [selected, setSelected] = useState('');
  const list = available.data?.items || [];
  const active = selected || list.find(item => item.status === 'ACTIVE')?.id || list[0]?.id || '';
  const state = useFetch(() => (active ? api.reports.tournament(active) : Promise.resolve(null)), [active]);
  const report = state.data;
  return <><PageHeading eyebrow="RELATÓRIOS" title="Relatório do campeonato" description="Números consolidados de inscrição, presença e resultados." />
    <div className="toolbar"><select aria-label="Selecionar campeonato" className="select-control" value={active} onChange={e => setSelected(e.target.value)}>{list.length ? list.map(item => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Nenhum campeonato</option>}</select></div>
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={5} /> : report ? <>
      <section className="metric-grid"><Metric label="Inscritos" value={report.summary.enrollments} trend={`${report.summary.teams} equipes · ${report.summary.athletes} atletas`} icon={Users} accent="blue" /><Metric label="Presentes" value={report.summary.checkedIn} trend={`${report.summary.pendingCheckIn} pendentes`} icon={UserCheck} accent="mint" /><Metric label="Partidas" value={report.summary.matches} trend={`${report.summary.matchesWithResult} com resultado`} icon={CalendarDays} accent="yellow" /><Metric label="Em aberto" value={report.summary.matchesPending} trend="sem resultado" icon={ClipboardList} accent="coral" /></section>
      <div className="content-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">CLASSIFICAÇÃO</span><h2>{report.tournament.name}</h2></div></div><StandingsTable data={report.standings.map(row => ({ ...row, participant: row.participant, participantId: row.participant.id }))} loading={false} /></section>
        <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PRESENÇA</span><h2>Inscritos</h2></div></div><div className="inscription-list">{report.enrollments.map(row => <div className="inscription-row" key={row.enrollmentId}><strong>{row.participant.name}</strong><StatusBadge status={row.checkInStatus} /></div>)}</div></section></div>
      <section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">PARTIDAS</span><h2>Resultados</h2></div></div>{report.matches.length ? report.matches.map(game => <GameRow key={game.id} game={game} expanded />) : <EmptyState title="Sem partidas" />}</section>
    </> : <EmptyState title="Nenhum relatório disponível" description="Crie um campeonato para gerar relatórios." />}
  </>;
}

function MciTv() {
  const feed = useFetch(api.publicFeed.live, []);
  const events = useFetch(api.publicFeed.tournaments, []);
  const data = feed.data || {};
  return <><PageHeading eyebrow="MCI TV" title="Grade ao vivo" description="Acompanhamento público das competições, sem login." />
    {feed.error && <ErrorState message={feed.error} retry={feed.reload} />}
    {feed.loading ? <SkeletonRows count={4} /> : <>
      <section className="panel tv-live"><div className="panel-heading"><div><span className="eyebrow">AO VIVO AGORA</span><h2>{(data.liveMatches || []).length ? 'Acontecendo' : 'Fora do ar'}</h2></div>{(data.liveMatches || []).length > 0 && <span className="live-dot" />}</div>{(data.liveMatches || []).length ? data.liveMatches.map(game => <GameRow key={game.id} game={game} expanded />) : <EmptyState title="Nenhuma transmissão no ar" description="Quando uma partida entrar em andamento, ela aparece aqui." />}</section>
      <div className="content-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">A SEGUIR</span><h2>Próximas partidas</h2></div></div>{(data.upcoming || []).length ? data.upcoming.map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Sem agenda" description="Nenhuma partida programada." />}</section>
        <section className="panel"><div className="panel-heading"><div><span className="eyebrow">ÚLTIMOS RESULTADOS</span><h2>Encerradas</h2></div></div>{(data.recentResults || []).length ? data.recentResults.map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Sem resultados" description="Resultados aparecem aqui após o lançamento." />}</section></div>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">COMPETIÇÕES</span><h2>Na grade</h2></div></div>{(events.data?.items || []).length ? <div className="tournament-list">{events.data.items.map(item => <div className="inscription-row" key={item.id}><div className="sport-icon"><Trophy size={19} /></div><div className="row-main"><strong>{item.name}</strong><small>{item._count?.enrollments || 0} participantes · {item._count?.matches || 0} partidas</small></div><StatusBadge status={item.status} /></div>)}</div> : <EmptyState title="Nenhuma competição pública" />}</section>
    </>}
  </>;
}

function DocumentModal({ close, notify }) {
  const tournaments = useFetch(api.tournaments.list, []);
  const [form, setForm] = useState({ tournamentId: '', title: '', fileName: '', mimeType: 'application/pdf' });
  const [saving, setSaving] = useState(false);
  const list = tournaments.data || [];
  const submit = async e => {
    e.preventDefault(); setSaving(true);
    try { await api.documents.create({ ...form, tournamentId: form.tournamentId || list[0]?.id }); refreshData(); notify('Documento adicionado.'); close(); }
    catch (error) { setSaving(false); alert(error.message); }
  };
  return <Modal title="Novo documento" close={close}><form onSubmit={submit}>
    <Field label="Campeonato" required><select value={form.tournamentId || list[0]?.id || ''} onChange={e => setForm({ ...form, tournamentId: e.target.value })}>{list.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    <Field label="Título" required><input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} minLength="2" required /></Field>
    <Field label="Nome do arquivo" required><input value={form.fileName} onChange={e => setForm({ ...form, fileName: e.target.value })} placeholder="regulamento.pdf" required /></Field>
    <Field label="Tipo"><select value={form.mimeType} onChange={e => setForm({ ...form, mimeType: e.target.value })}><option value="application/pdf">PDF</option><option value="image/jpeg">Imagem JPEG</option><option value="image/png">Imagem PNG</option><option value="application/octet-stream">Outro</option></select></Field>
    <ModalActions close={close} saving={saving} /></form></Modal>;
}

function Events({ navigate, openModal, notify }) {
  const state = useFetch(api.tournaments.list, []);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const remove = async item => { if (!window.confirm(`Excluir o campeonato "${item.name}"?`)) return; try { await api.tournaments.remove(item.id); refreshData(); notify('Campeonato excluído.'); } catch (error) { alert(error.message); } };
  const list = (state.data || []).filter(item => item.name.toLowerCase().includes(search.toLowerCase()) && (!status || item.status === status));
  return <><PageHeading eyebrow="COMPETIÇÕES" title="Eventos" description="Organize temporadas, equipes e disputas com clareza." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Criar evento</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input aria-label="Buscar evento" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar evento..." /></label><select className="filter-button" aria-label="Filtrar eventos por status" value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos os status</option><option value="PLANNED">Planejados</option><option value="ACTIVE">Em andamento</option><option value="FINISHED">Encerrados</option><option value="CANCELLED">Cancelados</option></select></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="cards-grid">{list.map(item => <TournamentCard key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} onEdit={() => openModal({ type: 'tournament-edit', item })} onDelete={() => remove(item)} />)}{!list.length && <EmptyState title="Nenhum evento encontrado" action="Limpar filtros" onAction={() => { setSearch(''); setStatus(''); }} />}</section>}</>;
}

function Tournaments({ navigate, openModal, notify }) { const state = useFetch(api.tournaments.list, []); const [search, setSearch] = useState(''); const list = (state.data || []).filter(x => x.name.toLowerCase().includes(search.toLowerCase())); const remove = async item => { if (!window.confirm(`Excluir o campeonato "${item.name}"?`)) return; try { await api.tournaments.remove(item.id); refreshData(); notify('Campeonato excluído.'); } catch (error) { alert(error.message); } }; return <><PageHeading eyebrow="COMPETIÇÕES" title="Campeonatos" description="Organize temporadas, equipes e disputas com clareza." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Criar campeonato</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input aria-label="Buscar campeonato" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar campeonato..." /></label><button className="filter-button">Todos os status <ChevronRight size={15} /></button></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="cards-grid">{list.map(item => <TournamentCard key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} onEdit={() => openModal({ type: 'tournament-edit', item })} onDelete={() => remove(item)} />)}{!list.length && <EmptyState title="Nenhum campeonato encontrado" action="Limpar busca" onAction={() => setSearch('')} />}</section>}</> }

function TournamentDetail({ id, navigate, notify, openModal }) { const state = useFetch(() => api.tournaments.get(id), [id]); const standing = useFetch(() => api.tournaments.standings(id), [id]); const matches = useFetch(() => api.matches.list(id), [id]); const enrolled = useFetch(() => api.tournaments.participants(id), [id]); const people = useFetch(api.participants.list, []); const [selected, setSelected] = useState(''); if (state.loading) return <SkeletonRows count={5} />; if (state.error) return <ErrorState message={state.error} retry={state.reload} />; const item = state.data; const enrolledIds = new Set((enrolled.data || []).map(row => row.participantId)); const available = (people.data || []).filter(person => !enrolledIds.has(person.id)); const enroll = async () => { if (!selected) return; try { await api.tournaments.enroll(id, selected); setSelected(''); refreshData(); notify('Participante inscrito.'); } catch (error) { alert(error.message); } }; return <><button className="back-link" onClick={() => navigate('tournaments')}><ChevronRight size={16} className="back-arrow" /> Campeonatos</button><div className="detail-hero"><div><span className="eyebrow">CAMPEONATO</span><h1>{item.name}</h1><p>{item.description || 'Nenhuma descrição adicionada.'}</p></div><StatusBadge status={item.status} /></div><div className="detail-meta"><span><CalendarDays size={17} /> {formatDate(item.startDate)} — {formatDate(item.endDate)}</span><span><Users size={17} /> {item._count?.enrollments || 0} participantes</span><span><Dumbbell size={17} /> {item._count?.matches || 0} partidas</span></div><div className="detail-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">RANKING</span><h2>Classificação</h2></div><button className="text-button" onClick={() => navigate('standings')}>Abrir tabela <ArrowUpRight size={15} /></button></div><StandingsTable data={standing.data || []} loading={standing.loading} /></section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">PARTICIPANTES</span><h2>Inscrições</h2></div></div>{available.length ? <div className="inscription-box"><select aria-label="Selecionar participante para inscrever" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Selecione um participante</option>{available.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><button className="button button-primary" onClick={enroll}>Inscrever</button></div> : <EmptyState title="Não há participantes disponíveis" description="Cadastre mais atletas ou equipes." />}<div className="inscription-list">{(enrolled.data || []).map(row => <div key={row.id} className="inscription-row"><strong>{row.participant?.name}</strong><small>{row.participant?.type}</small></div>)}</div></section></div><section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">AGENDA</span><h2>Partidas</h2></div></div>{matches.loading ? <SkeletonRows count={2} /> : (matches.data || []).length ? (matches.data || []).map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />) : <EmptyState title="Nenhuma partida neste evento" description="Cadastre a primeira partida." />}</section></> }

function People({ openModal, notify, teamOnly = false }) { const state = useFetch(teamOnly ? api.teams.list : api.participants.list, []); const [search, setSearch] = useState(''); const list = (state.data || []).filter(x => `${x.name} ${x.identification}`.toLowerCase().includes(search.toLowerCase())); const remove = async person => { if (!window.confirm(`Excluir "${person.name}"?`)) return; try { await (teamOnly ? api.teams.remove(person.id) : api.participants.remove(person.id)); refreshData(); notify('Registro excluído.'); } catch (error) { alert(error.message); } }; return <><PageHeading eyebrow={teamOnly ? 'EQUIPES' : 'ELENCO'} title={teamOnly ? 'Equipes' : 'Participantes & equipes'} description={teamOnly ? 'Organize as equipes que competem na plataforma.' : 'Gerencie quem entra em campo nas suas competições.'} action={<button className="button button-primary" onClick={() => openModal('participant')}><CirclePlus size={17} /> Novo {teamOnly ? 'equipe' : 'participante'}</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input aria-label="Buscar por nome ou identificação" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nome ou identificação..." /></label></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="panel table-panel"><div className="table-head"><span>{teamOnly ? 'Equipe' : 'Participante'}</span><span>Tipo</span><span>Identificação</span><span>Cadastro</span></div>{list.map(person => <div className="table-row" key={person.id}><div className="person-cell"><div className="avatar avatar-teal">{initials(person.name)}</div><strong>{person.name}</strong></div><span><StatusBadge status={person.type === 'TEAM' ? 'Equipe' : 'Participante'} /></span><span className="muted">{person.identification}</span><span className="muted">{formatDate(person.createdAt)}</span><span className="row-actions"><button onClick={() => openModal({ type: 'participant-edit', item: person })}>Editar</button><button onClick={() => remove(person)}>Excluir</button></span></div>)}{!list.length && <EmptyState title="Nenhum registro encontrado" description="Experimente ajustar a busca." />}</section>}</> }

function Matches({ openModal }) { const state = useFetch(() => api.matches.list(), []); return <><PageHeading eyebrow="COMPETIÇÃO" title="Partidas" description="Acompanhe a agenda e os resultados em tempo real." action={<button className="button button-primary" onClick={() => openModal('match')}><CirclePlus size={17} /> Nova partida</button>} />{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="panel matches-panel">{state.data?.length ? state.data.map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />) : <EmptyState title="Nenhuma partida cadastrada" description="Crie a primeira partida para começar a agenda." action="Nova partida" onAction={() => openModal('match')} />}</section>}</> }

function Standings() { const tournaments = useFetch(api.tournaments.list, []); const [selected, setSelected] = useState(''); useEffect(() => { if (!selected && tournaments.data?.[0]) setSelected(tournaments.data[0].id); }, [tournaments.data, selected]); const state = useFetch(() => selected ? api.tournaments.standings(selected) : Promise.resolve([]), [selected]); return <><PageHeading eyebrow="PERFORMANCE" title="Classificação" description="A tabela vive dos resultados registrados em cada campeonato." action={<select aria-label="Selecionar campeonato" className="select-control" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Selecione um campeonato</option>{(tournaments.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>} />{state.loading ? <SkeletonRows count={5} /> : <section className="panel table-panel standings-panel"><div className="table-head standings-head"><span>#</span><span>Equipe</span><span>J</span><span>V</span><span>E</span><span>D</span><span>PTS</span></div><StandingsTable data={state.data || []} loading={false} /></section>}</> }

function StandingsTable({ data, loading }) { if (loading) return <SkeletonRows count={3} />; return <div className="standing-table">{data.map((row, index) => <div className="standing-row" key={row.id}><b className={`rank rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</b><div className="person-cell"><div className="avatar avatar-gold">{initials(row.participant?.name)}</div><strong>{row.participant?.name}</strong></div><span>{row.played}</span><span>{row.wins}</span><span>{row.draws}</span><span>{row.losses}</span><b className="points">{row.points}</b></div>)}{!data.length && <EmptyState title="Classificação vazia" description="Inscreva participantes e registre resultados para gerar a tabela." />}</div> }

function TournamentModal({ close, notify }) { const [form, setForm] = useState({ name: '', description: '', startDate: '', endDate: '', status: 'PLANNED' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); if (form.endDate && form.startDate && form.endDate < form.startDate) return; setSaving(true); try { await api.tournaments.create({ ...form, startDate: form.startDate || undefined, endDate: form.endDate || undefined }); refreshData(); notify('Campeonato criado com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Criar campeonato" close={close}><form onSubmit={submit}><Field label="Nome do campeonato" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex: Copa MCI 2026" /></Field><Field label="Descrição"><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Uma breve descrição da competição" /></Field><div className="form-grid"><Field label="Data inicial"><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field><Field label="Data final"><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field></div><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="PLANNED">Planejado</option><option value="ACTIVE">Em andamento</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ParticipantModal({ close, notify }) { const [form, setForm] = useState({ name: '', identification: '', type: 'TEAM' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.participants.create(form); refreshData(); notify('Participante criado com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Novo participante" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Nome da equipe ou pessoa" /></Field><Field label="Identificação" required><input required value={form.identification} onChange={e => setForm({ ...form, identification: e.target.value })} placeholder="Ex: MCI-001" /></Field><Field label="Tipo"><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option value="TEAM">Equipe</option><option value="PLAYER">Participante</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function MatchModal({ close, notify }) { const tournaments = useFetch(api.tournaments.list, []); const people = useFetch(api.participants.list, []); const [form, setForm] = useState({ tournamentId: '', participantAId: '', participantBId: '', scheduledAt: '' }); const [saving, setSaving] = useState(false); const teams = people.data || []; const submit = async e => { e.preventDefault(); if (form.participantAId === form.participantBId) return; setSaving(true); try { await api.matches.create({ ...form, scheduledAt: form.scheduledAt || undefined }); refreshData(); notify('Partida criada com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Nova partida" close={close}><form onSubmit={submit}><Field label="Campeonato" required><select required value={form.tournamentId} onChange={e => setForm({ ...form, tournamentId: e.target.value })}><option value="">Selecione um campeonato</option>{(tournaments.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><div className="form-grid"><Field label="Participante A" required><select required value={form.participantAId} onChange={e => setForm({ ...form, participantAId: e.target.value })}><option value="">Selecione</option>{teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Participante B" required><select required value={form.participantBId} onChange={e => setForm({ ...form, participantBId: e.target.value })}><option value="">Selecione</option>{teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><Field label="Data e hora"><input type="datetime-local" value={form.scheduledAt} onChange={e => setForm({ ...form, scheduledAt: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function TournamentEditModal({ tournament, close, notify }) { const [form, setForm] = useState({ name: tournament.name, description: tournament.description || '', status: tournament.status }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.tournaments.update(tournament.id, form); refreshData(); notify('Campeonato atualizado.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar campeonato" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Descrição"><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="PLANNED">Planejado</option><option value="ACTIVE">Em andamento</option><option value="FINISHED">Encerrado</option><option value="CANCELLED">Cancelado</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ParticipantEditModal({ participant, close, notify }) { const [form, setForm] = useState({ name: participant.name, identification: participant.identification }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.participants.update(participant.id, form); refreshData(); notify('Participante atualizado.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar participante" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Identificação" required><input required value={form.identification} onChange={e => setForm({ ...form, identification: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ResultModal({ match, close, notify }) { const [form, setForm] = useState({ scoreA: match.result?.scoreA ?? '', scoreB: match.result?.scoreB ?? '', winnerParticipantId: match.result?.winnerParticipantId || '' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); if (form.scoreA === '' || form.scoreB === '' || Number(form.scoreA) < 0 || Number(form.scoreB) < 0) return; setSaving(true); try { const data = { scoreA: Number(form.scoreA), scoreB: Number(form.scoreB), winnerParticipantId: form.scoreA === form.scoreB ? null : form.winnerParticipantId }; if (match.result) await api.matches.updateResult(match.id, data); else await api.matches.saveResult(match.id, data); refreshData(); notify('Resultado salvo e classificação atualizada.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title={match.result ? 'Editar resultado' : 'Registrar resultado'} close={close}><form onSubmit={submit}><div className="score-form"><Field label={match.participantA?.name || 'Participante A'} required><input type="number" min="0" required value={form.scoreA} onChange={e => setForm({ ...form, scoreA: e.target.value })} /></Field><strong>×</strong><Field label={match.participantB?.name || 'Participante B'} required><input type="number" min="0" required value={form.scoreB} onChange={e => setForm({ ...form, scoreB: e.target.value })} /></Field></div><Field label="Vencedor"><select value={form.winnerParticipantId} onChange={e => setForm({ ...form, winnerParticipantId: e.target.value })}><option value="">Empate</option><option value={match.participantAId}>{match.participantA?.name}</option><option value={match.participantBId}>{match.participantB?.name}</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function MatchEditModal({ match, close, notify }) { const [form, setForm] = useState({ status: match.status, scheduledAt: match.scheduledAt ? new Date(match.scheduledAt).toISOString().slice(0, 16) : '' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.matches.update(match.id, { status: form.status, scheduledAt: form.scheduledAt || undefined }); refreshData(); notify('Partida atualizada.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar partida" close={close}><form onSubmit={submit}><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="SCHEDULED">Agendada</option><option value="IN_PROGRESS">Ao vivo</option><option value="FINISHED">Encerrada</option><option value="CANCELLED">Cancelada</option></select></Field><Field label="Data e hora"><input type="datetime-local" value={form.scheduledAt} onChange={e => setForm({ ...form, scheduledAt: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }

function Modal({ title, close, children }) { return <div className="modal-layer"><button className="modal-scrim" onClick={close} aria-label="Fechar modal" /><div className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><div><span className="eyebrow">MCI CAMPEONATOS</span><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Fechar"><X size={19} /></button></div>{children}</div></div> }
function ModalActions({ close, saving }) { return <div className="modal-actions"><button type="button" className="button button-secondary" onClick={close}>Cancelar</button><button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Salvando...' : 'Salvar'}</button></div> }
function Field({ label, required, children }) { return <label className="field"><span>{label}{required && <em> *</em>}</span>{children}</label> }
function PageHeading({ eyebrow, title, description, action }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div> }
function Metric({ label, value, trend, icon: Icon, accent }) { return <div className="metric"><div className={`metric-icon ${accent}`}><Icon size={20} /></div><div><span>{label}</span><strong>{value}</strong><small>{trend}</small></div></div> }
function TournamentRow({ tournament, onClick }) { return <button className="tournament-row" onClick={onClick}><div className="sport-icon"><Trophy size={19} /></div><div className="row-main"><strong>{tournament.name}</strong><small>{tournament._count?.enrollments || 0} participantes · {tournament._count?.matches || 0} partidas</small></div><StatusBadge status={tournament.status} /><ChevronRight size={17} className="row-chevron" /></button> }
function TournamentCard({ tournament, onClick, onEdit, onDelete }) { return <div className="tournament-card" role="button" tabIndex="0" onClick={onClick} onKeyDown={e => e.key === 'Enter' && onClick()}><div className="card-top"><div className="sport-icon large"><Trophy size={22} /></div><StatusBadge status={tournament.status} /></div><h3>{tournament.name}</h3><p>{tournament.description || 'Sem descrição'}</p><div className="card-foot"><span><CalendarDays size={14} /> {formatDate(tournament.startDate)}</span><div className="card-actions"><button aria-label={`Editar ${tournament.name}`} onClick={e => { e.stopPropagation(); onEdit(); }}>Editar</button><button aria-label={`Excluir ${tournament.name}`} onClick={e => { e.stopPropagation(); onDelete(); }}>Excluir</button></div></div></div> }
function GameRow({ game, expanded, onResult, onEdit }) { return <div className={`game-row ${expanded ? 'game-expanded' : ''}`}><div className="game-date"><strong>{game.scheduledAt ? formatDate(game.scheduledAt).split(' ')[0] : '—'}</strong><small>{game.phase || 'Partida'}</small></div><div className="teams"><span>{game.participantA?.name || 'Participante A'}</span><b className="score">{game.result ? `${game.result.scoreA} - ${game.result.scoreB}` : 'vs'}</b><span>{game.participantB?.name || 'Participante B'}</span></div><StatusBadge status={game.status} />{onEdit && <button className="row-action" onClick={onEdit}>Editar partida</button>}{onResult && <button className="row-action" onClick={onResult}>{game.result ? 'Editar resultado' : 'Registrar resultado'}</button>}</div> }
function StatusBadge({ status }) { return <span className={`badge badge-${String(status).toLowerCase().replace('_', '-')}`}>{statusLabel[status] || status}</span> }
function EmptyState({ title, description = 'Comece adicionando um novo registro.', action, onAction }) { return <div className="empty-state"><div className="empty-icon"><ClipboardList size={22} /></div><h3>{title}</h3><p>{description}</p>{action && <button className="button button-secondary" onClick={onAction}>{action}</button>}</div> }
function ErrorState({ message, retry }) { return <div className="error-state"><Activity size={22} /><div><strong>Não foi possível carregar</strong><p>{message}</p></div><button className="button button-secondary" onClick={retry}>Tentar novamente</button></div> }
function SkeletonRows({ count = 4 }) { return <div className="skeleton-list">{Array.from({ length: count }).map((_, index) => <div className="skeleton-row" key={index}><i /><span /><b /></div>)}</div> }

export default App;
