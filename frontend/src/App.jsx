import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, Bell, CalendarDays, ChevronRight, CirclePlus, ClipboardList, Dumbbell, FileText, LayoutDashboard, LogOut, Menu, Medal, MessageSquare, MoreHorizontal, Search, Shield, Trophy, Users, X } from 'lucide-react';
import { AuthProvider, useAuth } from './AuthContext';
import { api, refreshData } from './services/api';

const baseNav = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['tournaments', 'Eventos', Trophy],
  ['people', 'Atletas', Users],
  ['teams', 'Equipes', Shield],
  ['matches', 'Partidas', CalendarDays],
  ['standings', 'Ranking', Medal],
  ['judge', 'Judge Center', Activity],
  ['tv', 'MCI TV', MessageSquare],
  ['notifications', 'Notificações', Bell],
  ['documents', 'Documentos', FileText]
];

const roleNav = {
  ADMIN: ['dashboard', 'tournaments', 'people', 'teams', 'matches', 'standings', 'judge', 'tv', 'notifications', 'documents'],
  ORGANIZER: ['dashboard', 'tournaments', 'people', 'teams', 'matches', 'standings'],
  JUDGE: ['tournaments', 'matches', 'standings', 'judge'],
  COACH: ['dashboard', 'teams', 'people', 'tournaments', 'matches'],
  ATHLETE: ['dashboard', 'tournaments', 'standings', 'people']
};

const statusLabel = { PLANNED: 'Planejado', ACTIVE: 'Em andamento', FINISHED: 'Encerrado', CANCELLED: 'Cancelado', SCHEDULED: 'Agendada', IN_PROGRESS: 'Ao vivo' };
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Sem data';
const initials = value => (value || '?').split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase();

function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash.slice(1) || 'login');
  useEffect(() => { const onHash = () => setRoute(window.location.hash.slice(1) || 'login'); window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  return [route, value => { window.location.hash = value; }];
}

function useFetch(fetcher, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const load = () => { setState(current => ({ ...current, loading: true, error: '' })); fetcher().then(data => setState({ data, loading: false, error: '' })).catch(error => setState({ data: null, loading: false, error: error.message })); };
  useEffect(() => { load(); const refresh = () => load(); window.addEventListener('mci-data-changed', refresh); return () => window.removeEventListener('mci-data-changed', refresh); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load };
}

function App() {
  return <AuthProvider><AppShell /></AuthProvider>;
}

function AppShell() {
  const { user, authenticated, loading, logout } = useAuth();
  const [route, navigate] = useHashRoute();
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
      <div className="sidebar-foot"><div className="season"><span className="live-dot" /> Plataforma online <ChevronRight size={14} /></div><button className="profile" onClick={() => go('profile')}><div className="avatar">{initials(user?.name)}</div><div><strong>{user?.name || 'Usuário'}</strong><small>{user?.role || 'ATHLETE'}</small></div><MoreHorizontal size={17} /></button><button className="top-icon" aria-label="Logout" onClick={logout}><LogOut size={17} /></button></div>
    </aside>
    {mobileOpen && <button className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMobileOpen(false)} />}
    <main className="main-content">
      <header className="topbar"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu /></button><div className="breadcrumb"><span>MCI PLATFORM</span><ChevronRight size={14} /><strong>{nav.find(item => item[0] === page)?.[1] || 'Detalhes'}</strong></div><div className="top-actions"><button className="top-icon" aria-label="Buscar"><Search size={17} /></button><button className="top-icon notification-icon" aria-label="Notificações"><Bell size={17} /><b>3</b></button><div className="api-status"><span className="live-dot" /> Sistema online</div><div className="top-avatar">{initials(user?.name)}</div></div></header>
      <div className="page-wrap">{flash && <div className="toast"><Activity size={17} /> {flash}</div>}
        {page === 'dashboard' && <Dashboard navigate={go} openModal={setModal} />}
        {page === 'tournaments' && (detailId ? <TournamentDetail id={detailId} navigate={go} notify={notify} openModal={setModal} /> : <Events navigate={go} openModal={setModal} notify={notify} />)}
        {page === 'people' && <People openModal={setModal} notify={notify} />}
        {page === 'teams' && <People openModal={setModal} notify={notify} teamOnly />}
        {page === 'matches' && <Matches openModal={setModal} notify={notify} />}
        {page === 'standings' && <Standings />}
        {['judge', 'tv', 'notifications', 'documents'].includes(page) && <ReferencePlaceholder page={page} />}
      </div>
    </main>
    {modal === 'tournament' && <TournamentModal close={() => setModal(null)} notify={notify} />}
    {modal === 'participant' && <ParticipantModal close={() => setModal(null)} notify={notify} />}
    {modal === 'match' && <MatchModal close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'tournament-edit' && <TournamentEditModal tournament={modal.item} close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'participant-edit' && <ParticipantEditModal participant={modal.item} close={() => setModal(null)} notify={notify} />}
    {modal?.type === 'result' && <ResultModal match={modal.item} close={() => setModal(null)} notify={notify} />}
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
  const tournaments = useFetch(api.tournaments.list, []); const matches = useFetch(() => api.matches.list(), []);
  const list = tournaments.data || []; const games = matches.data || [];
  return <><PageHeading eyebrow="SÁBADO, 23 AGO 2026" title="Visão geral" description="O pulso das suas competições, em um só lugar." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Novo campeonato</button>} />
    {tournaments.error && <ErrorState message={tournaments.error} retry={tournaments.reload} />}
    <section className="metric-grid"><Metric label="Campeonatos ativos" value={list.filter(x => x.status === 'ACTIVE').length} trend="nesta temporada" icon={Trophy} accent="mint" /><Metric label="Total de equipes" value={list.reduce((sum, item) => sum + (item._count?.enrollments || 0), 0)} trend="inscrições" icon={Shield} accent="yellow" /><Metric label="Partidas agendadas" value={games.filter(x => x.status === 'SCHEDULED').length} trend="na agenda" icon={CalendarDays} accent="blue" /><Metric label="Partidas concluídas" value={games.filter(x => x.status === 'FINISHED').length} trend="resultados registrados" icon={ClipboardList} accent="coral" /></section>
    <div className="content-grid"><section className="panel featured-panel"><div className="panel-heading"><div><span className="eyebrow">CENTRO DE COMANDO</span><h2>Seus campeonatos</h2></div><button className="text-button" onClick={() => navigate('tournaments')}>Ver todos <ArrowUpRight size={15} /></button></div>{tournaments.loading ? <SkeletonRows count={3} /> : list.length ? <div className="tournament-list">{list.slice(0, 4).map(item => <TournamentRow key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} />)}</div> : <EmptyState title="Nenhum campeonato ainda" action="Criar campeonato" onAction={() => openModal('tournament')} />}</section>
      <section className="panel agenda-panel"><div className="panel-heading"><div><span className="eyebrow">PRÓXIMOS EVENTOS</span><h2>Agenda</h2></div><CalendarDays size={19} className="muted-icon" /></div>{matches.loading ? <SkeletonRows count={3} /> : games.length ? games.slice(0, 4).map(game => <GameRow key={game.id} game={game} />) : <EmptyState title="Agenda livre" description="Partidas criadas aparecerão aqui." />}</section></div>
  </>;
}

function ReferencePlaceholder({ page }) {
  const content = {
    judge: ['JUDGE CENTER', 'Painel de julgamento', 'Scorecards, chamadas e critérios oficiais serão conectados quando a API de arbitragem existir.'],
    tv: ['MCI TV', 'Produção e conteúdo', 'Agenda de transmissões e conteúdos oficiais aguardam integração com o módulo MCI TV.'],
    notifications: ['CENTRAL DE NOTIFICAÇÕES', 'Tudo em um só lugar', 'Notificações serão exibidas aqui quando o backend disponibilizar esse recurso.'],
    documents: ['DOCUMENTOS & REGULAMENTOS', 'Biblioteca oficial', 'Regulamentos e documentos serão conectados quando houver endpoint de arquivos.']
  }[page];
  return <div className="reference-page"><span className="eyebrow">MCI PLATFORM / {content[0]}</span><h1>{content[1]}</h1><p>{content[2]}</p><div className="reference-grid"><EmptyState title="Módulo em preparação" description="A estrutura visual segue a referência oficial e está pronta para receber dados reais." /><div className="reference-spec"><div className="reference-line"><span className="live-dot" /> Identidade visual MCI aplicada</div><div className="reference-line"><span className="live-dot" /> Navegação disponível</div><div className="reference-line"><span className="pending-dot" /> Integração de dados pendente</div></div></div></div>;
}

function Events({ navigate, openModal, notify }) {
  const state = useFetch(api.tournaments.list, []);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const remove = async item => { if (!window.confirm(`Excluir o campeonato "${item.name}"?`)) return; try { await api.tournaments.remove(item.id); refreshData(); notify('Campeonato excluído.'); } catch (error) { alert(error.message); } };
  const list = (state.data || []).filter(item => item.name.toLowerCase().includes(search.toLowerCase()) && (!status || item.status === status));
  return <><PageHeading eyebrow="COMPETIÇÕES" title="Eventos" description="Organize temporadas, equipes e disputas com clareza." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Criar evento</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar evento..." /></label><select className="filter-button" aria-label="Filtrar eventos por status" value={status} onChange={e => setStatus(e.target.value)}><option value="">Todos os status</option><option value="PLANNED">Planejados</option><option value="ACTIVE">Em andamento</option><option value="FINISHED">Encerrados</option><option value="CANCELLED">Cancelados</option></select></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="cards-grid">{list.map(item => <TournamentCard key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} onEdit={() => openModal({ type: 'tournament-edit', item })} onDelete={() => remove(item)} />)}{!list.length && <EmptyState title="Nenhum evento encontrado" action="Limpar filtros" onAction={() => { setSearch(''); setStatus(''); }} />}</section>}</>;
}

function Tournaments({ navigate, openModal, notify }) { const state = useFetch(api.tournaments.list, []); const [search, setSearch] = useState(''); const list = (state.data || []).filter(x => x.name.toLowerCase().includes(search.toLowerCase())); const remove = async item => { if (!window.confirm(`Excluir o campeonato "${item.name}"?`)) return; try { await api.tournaments.remove(item.id); refreshData(); notify('Campeonato excluído.'); } catch (error) { alert(error.message); } }; return <><PageHeading eyebrow="COMPETIÇÕES" title="Campeonatos" description="Organize temporadas, equipes e disputas com clareza." action={<button className="button button-primary" onClick={() => openModal('tournament')}><CirclePlus size={17} /> Criar campeonato</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar campeonato..." /></label><button className="filter-button">Todos os status <ChevronRight size={15} /></button></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="cards-grid">{list.map(item => <TournamentCard key={item.id} tournament={item} onClick={() => navigate(`tournaments/${item.id}`)} onEdit={() => openModal({ type: 'tournament-edit', item })} onDelete={() => remove(item)} />)}{!list.length && <EmptyState title="Nenhum campeonato encontrado" action="Limpar busca" onAction={() => setSearch('')} />}</section>}</> }

function TournamentDetail({ id, navigate, notify, openModal }) { const state = useFetch(() => api.tournaments.get(id), [id]); const standing = useFetch(() => api.tournaments.standings(id), [id]); const matches = useFetch(() => api.matches.list(id), [id]); const enrolled = useFetch(() => api.tournaments.participants(id), [id]); const people = useFetch(api.participants.list, []); const [selected, setSelected] = useState(''); if (state.loading) return <SkeletonRows count={5} />; if (state.error) return <ErrorState message={state.error} retry={state.reload} />; const item = state.data; const enrolledIds = new Set((enrolled.data || []).map(row => row.participantId)); const available = (people.data || []).filter(person => !enrolledIds.has(person.id)); const enroll = async () => { if (!selected) return; try { await api.tournaments.enroll(id, selected); setSelected(''); refreshData(); notify('Participante inscrito.'); } catch (error) { alert(error.message); } }; return <><button className="back-link" onClick={() => navigate('tournaments')}><ChevronRight size={16} className="back-arrow" /> Campeonatos</button><div className="detail-hero"><div><span className="eyebrow">CAMPEONATO</span><h1>{item.name}</h1><p>{item.description || 'Nenhuma descrição adicionada.'}</p></div><StatusBadge status={item.status} /></div><div className="detail-meta"><span><CalendarDays size={17} /> {formatDate(item.startDate)} — {formatDate(item.endDate)}</span><span><Users size={17} /> {item._count?.enrollments || 0} participantes</span><span><Dumbbell size={17} /> {item._count?.matches || 0} partidas</span></div><div className="detail-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">RANKING</span><h2>Classificação</h2></div><button className="text-button" onClick={() => navigate('standings')}>Abrir tabela <ArrowUpRight size={15} /></button></div><StandingsTable data={standing.data || []} loading={standing.loading} /></section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">PARTICIPANTES</span><h2>Inscrições</h2></div></div>{available.length ? <div className="inscription-box"><select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Selecione um participante</option>{available.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select><button className="button button-primary" onClick={enroll}>Inscrever</button></div> : <EmptyState title="Não há participantes disponíveis" description="Cadastre mais atletas ou equipes." />}<div className="inscription-list">{(enrolled.data || []).map(row => <div key={row.id} className="inscription-row"><strong>{row.participant?.name}</strong><small>{row.participant?.type}</small></div>)}</div></section></div><section className="panel matches-panel"><div className="panel-heading"><div><span className="eyebrow">AGENDA</span><h2>Partidas</h2></div></div>{matches.loading ? <SkeletonRows count={2} /> : (matches.data || []).length ? (matches.data || []).map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />) : <EmptyState title="Nenhuma partida neste evento" description="Cadastre a primeira partida." />}</section></> }

function People({ openModal, notify, teamOnly = false }) { const state = useFetch(teamOnly ? api.teams.list : api.participants.list, []); const [search, setSearch] = useState(''); const list = (state.data || []).filter(x => `${x.name} ${x.identification}`.toLowerCase().includes(search.toLowerCase())); const remove = async person => { if (!window.confirm(`Excluir "${person.name}"?`)) return; try { await (teamOnly ? api.teams.remove(person.id) : api.participants.remove(person.id)); refreshData(); notify('Registro excluído.'); } catch (error) { alert(error.message); } }; return <><PageHeading eyebrow={teamOnly ? 'EQUIPES' : 'ELENCO'} title={teamOnly ? 'Equipes' : 'Participantes & equipes'} description={teamOnly ? 'Organize as equipes que competem na plataforma.' : 'Gerencie quem entra em campo nas suas competições.'} action={<button className="button button-primary" onClick={() => openModal('participant')}><CirclePlus size={17} /> Novo {teamOnly ? 'equipe' : 'participante'}</button>} /><div className="toolbar"><label className="search-box"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nome ou identificação..." /></label></div>{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="panel table-panel"><div className="table-head"><span>{teamOnly ? 'Equipe' : 'Participante'}</span><span>Tipo</span><span>Identificação</span><span>Cadastro</span></div>{list.map(person => <div className="table-row" key={person.id}><div className="person-cell"><div className="avatar avatar-teal">{initials(person.name)}</div><strong>{person.name}</strong></div><span><StatusBadge status={person.type === 'TEAM' ? 'Equipe' : 'Participante'} /></span><span className="muted">{person.identification}</span><span className="muted">{formatDate(person.createdAt)}</span><span className="row-actions"><button onClick={() => openModal({ type: 'participant-edit', item: person })}>Editar</button><button onClick={() => remove(person)}>Excluir</button></span></div>)}{!list.length && <EmptyState title="Nenhum registro encontrado" description="Experimente ajustar a busca." />}</section>}</> }

function Matches({ openModal }) { const state = useFetch(() => api.matches.list(), []); return <><PageHeading eyebrow="COMPETIÇÃO" title="Partidas" description="Acompanhe a agenda e os resultados em tempo real." action={<button className="button button-primary" onClick={() => openModal('match')}><CirclePlus size={17} /> Nova partida</button>} />{state.loading ? <SkeletonRows count={5} /> : state.error ? <ErrorState message={state.error} retry={state.reload} /> : <section className="panel matches-panel">{state.data?.length ? state.data.map(game => <GameRow key={game.id} game={game} expanded onResult={() => openModal({ type: 'result', item: game })} onEdit={() => openModal({ type: 'match-edit', item: game })} />) : <EmptyState title="Nenhuma partida cadastrada" description="Crie a primeira partida para começar a agenda." action="Nova partida" onAction={() => openModal('match')} />}</section>}</> }

function Standings() { const tournaments = useFetch(api.tournaments.list, []); const [selected, setSelected] = useState(''); useEffect(() => { if (!selected && tournaments.data?.[0]) setSelected(tournaments.data[0].id); }, [tournaments.data, selected]); const state = useFetch(() => selected ? api.tournaments.standings(selected) : Promise.resolve([]), [selected]); return <><PageHeading eyebrow="PERFORMANCE" title="Classificação" description="A tabela vive dos resultados registrados em cada campeonato." action={<select className="select-control" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Selecione um campeonato</option>{(tournaments.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>} />{state.loading ? <SkeletonRows count={5} /> : <section className="panel table-panel standings-panel"><div className="table-head standings-head"><span>#</span><span>Equipe</span><span>J</span><span>V</span><span>E</span><span>D</span><span>PTS</span></div><StandingsTable data={state.data || []} loading={false} /></section>}</> }

function StandingsTable({ data, loading }) { if (loading) return <SkeletonRows count={3} />; return <div className="standing-table">{data.map((row, index) => <div className="standing-row" key={row.id}><b className={`rank rank-${index + 1}`}>{String(index + 1).padStart(2, '0')}</b><div className="person-cell"><div className="avatar avatar-gold">{initials(row.participant?.name)}</div><strong>{row.participant?.name}</strong></div><span>{row.played}</span><span>{row.wins}</span><span>{row.draws}</span><span>{row.losses}</span><b className="points">{row.points}</b></div>)}{!data.length && <EmptyState title="Classificação vazia" description="Inscreva participantes e registre resultados para gerar a tabela." />}</div> }

function TournamentModal({ close, notify }) { const [form, setForm] = useState({ name: '', description: '', startDate: '', endDate: '', status: 'PLANNED' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); if (form.endDate && form.startDate && form.endDate < form.startDate) return; setSaving(true); try { await api.tournaments.create({ ...form, startDate: form.startDate || undefined, endDate: form.endDate || undefined }); refreshData(); notify('Campeonato criado com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Criar campeonato" close={close}><form onSubmit={submit}><Field label="Nome do campeonato" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ex: Copa MCI 2026" /></Field><Field label="Descrição"><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Uma breve descrição da competição" /></Field><div className="form-grid"><Field label="Data inicial"><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field><Field label="Data final"><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field></div><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="PLANNED">Planejado</option><option value="ACTIVE">Em andamento</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ParticipantModal({ close, notify }) { const [form, setForm] = useState({ name: '', identification: '', type: 'TEAM' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.participants.create(form); refreshData(); notify('Participante criado com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Novo participante" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Nome da equipe ou pessoa" /></Field><Field label="Identificação" required><input required value={form.identification} onChange={e => setForm({ ...form, identification: e.target.value })} placeholder="Ex: MCI-001" /></Field><Field label="Tipo"><select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option value="TEAM">Equipe</option><option value="PLAYER">Participante</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function MatchModal({ close, notify }) { const tournaments = useFetch(api.tournaments.list, []); const people = useFetch(api.participants.list, []); const [form, setForm] = useState({ tournamentId: '', participantAId: '', participantBId: '', scheduledAt: '' }); const [saving, setSaving] = useState(false); const teams = people.data || []; const submit = async e => { e.preventDefault(); if (form.participantAId === form.participantBId) return; setSaving(true); try { await api.matches.create({ ...form, scheduledAt: form.scheduledAt || undefined }); refreshData(); notify('Partida criada com sucesso.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Nova partida" close={close}><form onSubmit={submit}><Field label="Campeonato" required><select required value={form.tournamentId} onChange={e => setForm({ ...form, tournamentId: e.target.value })}><option value="">Selecione um campeonato</option>{(tournaments.data || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><div className="form-grid"><Field label="Participante A" required><select required value={form.participantAId} onChange={e => setForm({ ...form, participantAId: e.target.value })}><option value="">Selecione</option>{teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Participante B" required><select required value={form.participantBId} onChange={e => setForm({ ...form, participantBId: e.target.value })}><option value="">Selecione</option>{teams.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><Field label="Data e hora"><input type="datetime-local" value={form.scheduledAt} onChange={e => setForm({ ...form, scheduledAt: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function TournamentEditModal({ tournament, close, notify }) { const [form, setForm] = useState({ name: tournament.name, description: tournament.description || '', status: tournament.status }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.tournaments.update(tournament.id, form); refreshData(); notify('Campeonato atualizado.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar campeonato" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Descrição"><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></Field><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="PLANNED">Planejado</option><option value="ACTIVE">Em andamento</option><option value="FINISHED">Encerrado</option><option value="CANCELLED">Cancelado</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ParticipantEditModal({ participant, close, notify }) { const [form, setForm] = useState({ name: participant.name, identification: participant.identification }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.participants.update(participant.id, form); refreshData(); notify('Participante atualizado.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar participante" close={close}><form onSubmit={submit}><Field label="Nome" required><input autoFocus required minLength="2" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><Field label="Identificação" required><input required value={form.identification} onChange={e => setForm({ ...form, identification: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function ResultModal({ match, close, notify }) { const [form, setForm] = useState({ scoreA: match.result?.scoreA ?? '', scoreB: match.result?.scoreB ?? '', winnerParticipantId: match.result?.winnerParticipantId || '' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); if (form.scoreA === '' || form.scoreB === '' || Number(form.scoreA) < 0 || Number(form.scoreB) < 0) return; setSaving(true); try { const data = { scoreA: Number(form.scoreA), scoreB: Number(form.scoreB), winnerParticipantId: form.scoreA === form.scoreB ? null : form.winnerParticipantId }; if (match.result) await api.matches.updateResult(match.id, data); else await api.matches.saveResult(match.id, data); refreshData(); notify('Resultado salvo e classificação atualizada.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title={match.result ? 'Editar resultado' : 'Registrar resultado'} close={close}><form onSubmit={submit}><div className="score-form"><Field label={match.participantA?.name || 'Participante A'} required><input type="number" min="0" required value={form.scoreA} onChange={e => setForm({ ...form, scoreA: e.target.value })} /></Field><strong>×</strong><Field label={match.participantB?.name || 'Participante B'} required><input type="number" min="0" required value={form.scoreB} onChange={e => setForm({ ...form, scoreB: e.target.value })} /></Field></div><Field label="Vencedor"><select value={form.winnerParticipantId} onChange={e => setForm({ ...form, winnerParticipantId: e.target.value })}><option value="">Empate</option><option value={match.participantAId}>{match.participantA?.name}</option><option value={match.participantBId}>{match.participantB?.name}</option></select></Field><ModalActions close={close} saving={saving} /></form></Modal> }
function MatchEditModal({ match, close, notify }) { const [form, setForm] = useState({ status: match.status, scheduledAt: match.scheduledAt ? new Date(match.scheduledAt).toISOString().slice(0, 16) : '' }); const [saving, setSaving] = useState(false); const submit = async e => { e.preventDefault(); setSaving(true); try { await api.matches.update(match.id, { status: form.status, scheduledAt: form.scheduledAt || undefined }); refreshData(); notify('Partida atualizada.'); close(); } catch (error) { setSaving(false); alert(error.message); } }; return <Modal title="Editar partida" close={close}><form onSubmit={submit}><Field label="Status"><select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}><option value="SCHEDULED">Agendada</option><option value="IN_PROGRESS">Ao vivo</option><option value="FINISHED">Encerrada</option><option value="CANCELLED">Cancelada</option></select></Field><Field label="Data e hora"><input type="datetime-local" value={form.scheduledAt} onChange={e => setForm({ ...form, scheduledAt: e.target.value })} /></Field><ModalActions close={close} saving={saving} /></form></Modal> }

function Modal({ title, close, children }) { return <div className="modal-layer"><button className="modal-scrim" onClick={close} aria-label="Fechar modal" /><div className="modal"><div className="modal-header"><div><span className="eyebrow">MCI CAMPEONATOS</span><h2>{title}</h2></div><button className="icon-button" onClick={close} aria-label="Fechar"><X size={19} /></button></div>{children}</div></div> }
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
