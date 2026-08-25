import { useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, ArrowUpRight, BarChart3, Bell, CalendarDays, ChevronRight, CirclePlus, ClipboardList, Clock, Dumbbell, FileText, LayoutDashboard, LogOut, Menu, Medal, MessageSquare, MoreHorizontal, Radio, Search, Shield, Trophy, UserCheck, Users, X } from 'lucide-react';
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
  ['judge', 'Judge Center', Activity],
  ['coach', 'Coach Center', Dumbbell],
  ['backstage', 'Backstage', Radio],
  ['reports', 'Relatórios', BarChart3],
  ['tv', 'MCI TV', MessageSquare],
  ['notifications', 'Notificações', Bell],
  ['documents', 'Documentos', FileText]
];

const roleNav = {
  ADMIN: ['dashboard', 'tournaments', 'people', 'teams', 'matches', 'standings', 'checkin', 'judge', 'coach', 'backstage', 'reports', 'tv', 'notifications', 'documents'],
  ORGANIZER: ['dashboard', 'tournaments', 'people', 'teams', 'matches', 'standings', 'checkin', 'backstage', 'reports', 'tv', 'notifications', 'documents'],
  JUDGE: ['dashboard', 'judge', 'matches', 'standings', 'tv', 'notifications'],
  COACH: ['dashboard', 'coach', 'tournaments', 'matches', 'standings', 'tv', 'notifications', 'documents'],
  ATHLETE: ['dashboard', 'tournaments', 'standings', 'tv', 'notifications', 'documents']
};

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
    fetcher()
      .then(data => { if (current === ticket.current) setState({ data, loading: false, error: '' }); })
      .catch(error => { if (current === ticket.current) setState({ data: null, loading: false, error: error.message }); });
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
  const { user, authenticated, loading, logout } = useAuth();
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

  const availableRoutes = roleNav[user?.role] || ['dashboard'];
  const nav = baseNav.filter(([id]) => availableRoutes.includes(id));

  if (loading) return <div className="auth-shell"><div className="auth-card"><h1>Carregando...</h1></div></div>;
  if (!authenticated && route !== 'login' && route !== 'register') {
    window.location.hash = 'login';
    return null;
  }

  if (authenticated && (route === 'login' || route === 'register')) {
    window.location.hash = 'dashboard';
    return null;
  }

  if (route === 'login') return <LoginScreen navigate={go} />;
  if (route === 'register') return <RegisterScreen navigate={go} />;
  if (route === 'profile') return <ProfileScreen user={user} onLogout={logout} navigate={go} />;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'is-open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Trophy size={19} /></div><span>MCI <b>International</b></span></div>
      <div className="workspace-label">MUSCLE CONTEST PLATFORM</div>
      <nav>{nav.map(([id, label, Icon]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => go(id)}><Icon size={18} /><span>{label}</span>{page === id && <i />}</button>)}</nav>
      <div className="sidebar-foot"><div className={`season ${apiOnline ? '' : 'is-offline'}`}><span className="live-dot" /> {apiOnline ? 'Plataforma online' : 'Sem conexão'} <ChevronRight size={14} /></div><button className="profile" onClick={() => go('profile')}><div className="avatar">{initials(user?.name)}</div><div><strong>{user?.name || 'Usuário'}</strong><small>{user?.role || 'ATHLETE'}</small></div><MoreHorizontal size={17} /></button><button className="top-icon" aria-label="Logout" onClick={logout}><LogOut size={17} /></button></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu /></button><div className="breadcrumb"><span>MCI PLATFORM</span><ChevronRight size={14} /><strong>{nav.find(item => item[0] === page)?.[1] || 'Detalhes'}</strong></div><div className="top-actions">{availableRoutes.includes('people') && <button className="top-icon" aria-label="Buscar atletas" onClick={() => go('people')}><Search size={17} /></button>}<button className="top-icon notification-icon" aria-label="Notificações" onClick={() => go('notifications')}><Bell size={17} />{unread > 0 && <b>{unread > 9 ? '9+' : unread}</b>}</button><div className={`api-status ${apiOnline ? '' : 'is-offline'}`}><span className="live-dot" /> {apiOnline ? 'Sistema online' : 'API indisponível'}</div><div className="top-avatar">{initials(user?.name)}</div></div></header>
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

function ProfileScreen({ user, onLogout, navigate }) {
  return <div className="page-wrap"><div className="page-heading"><div><span className="eyebrow">USUÁRIO</span><h1>Meu perfil</h1><p>Dados da conta e vínculo com os recursos.</p></div><button className="button button-secondary" onClick={() => navigate('dashboard')}>Voltar</button></div><section className="panel"><div className="profile-card"><div className="avatar large">{initials(user?.name)}</div><div><h2>{user?.name}</h2><p>{user?.email}</p><span className="badge badge-active">{user?.role}</span></div></div><div className="detail-meta"><span>{user?.email}</span><span>Role: {user?.role}</span><span>Status: {user?.status || 'ACTIVE'}</span></div><button className="button button-primary" onClick={onLogout}>Logout</button></section></div>;
}

function Dashboard({ navigate, openModal }) {
  const state = useFetch(api.dashboard.summary, []);
  if (state.loading) return <SkeletonRows count={5} />;
  if (state.error) return <ErrorState message={state.error} retry={state.reload} />;
  const data = state.data || {}; const totals = data.totals || {};
  return <><PageHeading eyebrow="OPERAÇÃO" title="Visão geral" description="O pulso das suas competições, em um só lugar." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Novo campeonato</button>} />
    <section className="metric-grid"><Metric label="Campeonatos ativos" value={totals.activeTournaments ?? 0} trend={`${totals.tournaments ?? 0} no total`} icon={Trophy} accent="mint" /><Metric label="Inscrições" value={totals.enrollments ?? 0} trend={`${totals.checkedIn ?? 0} com check-in`} icon={Users} accent="yellow" /><Metric label="Partidas hoje" value={totals.todayMatches ?? 0} trend={`${totals.liveMatches ?? 0} ao vivo`} icon={CalendarDays} accent="blue" /><Metric label="Equipes" value={totals.teams ?? 0} trend={`${totals.participants ?? 0} atletas`} icon={Shield} accent="coral" /></section>
    <div className="content-grid"><section className="panel featured-panel"><div className="panel-heading"><div><span className="eyebrow">CENTRO DE COMANDO</span><h2>Campeonatos ativos</h2></div><button className="text-button" onClick={() => navigate('tournaments')}>Ver todos <ArrowUpRight size={15} /></button></div>{(data.activeTournaments || []).length ? <div className="tournament-list">{data.activeTournaments.map(item => <TournamentRow key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} />)}</div> : <EmptyState title="Nenhum campeonato ativo" action="Criar campeonato" onAction={() => openModal('tournament')} />}</section>
      <section className="panel agenda-panel"><div className="panel-heading"><div><span className="eyebrow">HOJE</span><h2>Agenda do dia</h2></div><CalendarDays size={19} className="muted-icon" /></div>{(data.todayMatches || []).length ? data.todayMatches.slice(0, 5).map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Sem partidas hoje" description="A agenda de hoje está livre." />}</section></div>
    <div className="content-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">AO VIVO</span><h2>Acontecendo agora</h2></div>{(data.liveMatches || []).length > 0 && <span className="live-dot" />}</div>{(data.liveMatches || []).length ? data.liveMatches.map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Nada ao vivo" description="Partidas em andamento aparecem aqui." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RESULTADOS</span><h2>Últimos lançamentos</h2></div><ClipboardList size={19} className="muted-icon" /></div>{(data.recentResults || []).length ? <div className="result-feed">{data.recentResults.map(row => <div className="result-line" key={row.id}><strong>{row.match?.participantA?.name} x {row.match?.participantB?.name}</strong><b className="score">{row.scoreA} - {row.scoreB}</b><small>{row.match?.tournament?.name}</small></div>)}</div> : <EmptyState title="Sem resultados" description="Resultados lançados aparecem aqui." />}</section></div>
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

function DocumentsCenter({ openModal, notify, canManage }) {
  const state = useFetch(() => api.documents.list(), []);
  const items = state.data?.items || [];
  const remove = async item => { if (!window.confirm(`Excluir "${item.title}"?`)) return; try { await api.documents.remove(item.id); refreshData(); state.reload(); notify('Documento excluído.'); } catch (error) { alert(error.message); } };
  return <><PageHeading eyebrow="DOCUMENTOS & REGULAMENTOS" title="Biblioteca oficial" description="Regulamentos, fichas e documentos por campeonato." action={canManage ? <button className="button button-primary" onClick={() => openModal('document')}><CirclePlus size={17} /> Novo documento</button> : null} />
    {state.error && <ErrorState message={state.error} retry={state.reload} />}
    {state.loading ? <SkeletonRows count={4} /> : items.length ? <section className="panel table-panel"><div className="table-head"><span>Documento</span><span>Campeonato</span><span>Tipo</span><span>Adicionado</span></div>{items.map(item => <div className="table-row" key={item.id}><div className="person-cell"><div className="doc-icon"><FileText size={17} /></div><strong>{item.title}</strong></div><span className="muted">{item.tournament?.name}</span><span className="muted">{item.mimeType}</span><span className="muted">{formatDate(item.createdAt)}</span>{canManage && <span className="row-actions"><button onClick={() => remove(item)}>Excluir</button></span>}</div>)}</section> : <EmptyState title="Nenhum documento" description="Adicione o regulamento do campeonato." action={canManage ? 'Novo documento' : null} onAction={() => openModal('document')} />}
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

function TournamentDetail({ id, navigate, notify, openModal }) { const state = useFetch(() => api.tournaments.get(id), [id]); const standing = useFetch(() => api.tournaments.standings(id), [id]); const matches = useFetch(() => api.matches.list(id), [id]); const enrolled = useFetch(() => api.tournaments.participants(id), [id]); const people = useFetch(api.participants.list, []); const [selected, setSelected] = useState(''); if (state.loading) return <SkeletonRows count={5} />; if (state.error) return <ErrorState message={state.error} retry={state.reload} />; const item = state.data; const enrolledIds = new Set((enrolled.data || []).map(row => row.participantId)); const available = (people.data || []).filter(person => !enrolledIds.has(person.id)); const enroll = async () => { if (!selected) return; try { await api.tournaments.enroll(id, selected); setSelected(''); refreshData(); notify('Participante inscrito.'); } catch (error) { alert(error.message); } }; return <><button className="back-link" onClick={() => navigate('tournaments')}><ChevronRight size={16} className="back-arrow" /> Campeonatos</button><div className="detail-hero"><div><span className="eyebrow">CAMPEONATO</span><h1>{item.name}</h1><p>{item.description || 'Nenhuma descrição adicionada.'}</p></div><StatusBadge status={item.status} /></div><div className="detail-meta"><span><CalendarDays size={17} /> {formatDate(item.startDate)} — {formatDate(item.endDate)}</span><span><Users size={17} /> {item._count?.enrollments || 0} participantes</span><span><Dumbbell size={17} /> {item._count?.matches || 0} partidas</span></div><div className="detail-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">RANKING</span><h2>Classificação</h2></div><button className="text-button" onClick={() => navigate('standings')}>Abrir tabela <ArrowUpRight size={15} /></button></div><StandingsTable data={standing.data || []} loading={standing.loading} /></section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">PARTICIPANTES</span><h2>Inscrições</h2></div></div>{available.length ? <div className="inscription-box"><select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Selecione um participante</option>{available.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><button className="button button-primary" onClick={enroll}>Inscrever</button></div> : <EmptyState title="Não há participantes disponíveis" description="Cadastre mais atletas ou equipes." />}<div className="inscription-list">{(enrolled.data || []).map(row => <div key={row.id} className="inscription-row"><strong>{row.participant?.name}</strong><small>{row.participant?.type}</small></div>)}</div></section></div><section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">AGENDA</span><h2>Partidas</h2></div></div>{matches.loading ? <SkeletonRows count={2} /> : (matches.data || []).length ? (matches.data || []).map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />) : <EmptyState title="Nenhuma partida neste evento" description="Cadastre a primeira partida." />}</section></> }

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
