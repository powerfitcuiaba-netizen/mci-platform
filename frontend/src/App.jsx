import { useEffect, useMemo, useState } from 'react';
import {
  Bell, Building2, ClipboardCheck, Gavel, Home, LayoutDashboard, LogOut, Menu, MessageSquare,
  QrCode, Scale, Search, Settings, ShieldCheck, Trophy, Upload, UserCircle, Users, Users2, Zap
} from 'lucide-react';
import { AuthProvider, useAuth } from './AuthContext';
import api from './services/api';
import { useDebounce, useFetch, useHashRoute, useToasts } from './lib/hooks';
import { Avatar, Toasts } from './components/ui';
import Auth from './pages/authPages';
import { AtletaDetalhe, Atletas, CampeonatoDetalhe, Campeonatos, Inicio, Ranking } from './pages/publicPages';
import { ComunidadeDetalhe, Comunidades, Feed, MeuPerfilSocial, Notificacoes, Perfil, Salvos } from './pages/socialPages';
import Messenger from './pages/messengerPage';
import { AdminCheckin, AdminCredenciamento, AdminEventoDetalhe, AdminEventos, AdminInscricoes, AdminPalco, AdminPesagem } from './pages/adminEvent';
import { AdminJulgamento, AdminResultados } from './pages/adminJudging';
import { AdminAuditoria, AdminConfiguracoes, AdminMuscleWar, AdminPainel, AdminRanking } from './pages/adminPlatform';
import { MeuPainel, MinhaConta } from './pages/mePages';

// A navegação é montada a partir das permissões efetivas do usuário: um item
// que a API recusaria não aparece no menu. A autoridade continua no servidor —
// esconder é conveniência, não segurança.

const NAVEGACAO_PRINCIPAL = [
  { rota: 'inicio', rotulo: 'Início', icone: Home, publico: true },
  { rota: 'campeonatos', rotulo: 'Campeonatos', icone: Trophy, publico: true },
  { rota: 'atletas', rotulo: 'Atletas', icone: Users, publico: true },
  { rota: 'ranking', rotulo: 'Ranking', icone: Zap, publico: true },
  { rota: 'social', rotulo: 'Social', icone: LayoutDashboard },
  { rota: 'messenger', rotulo: 'Messenger', icone: MessageSquare, contador: 'mensagens' },
  { rota: 'comunidades', rotulo: 'Comunidades', icone: Users2 },
  { rota: 'meu-painel', rotulo: 'Meu painel', icone: UserCircle }
];

// Cada item administrativo declara a permissão que o habilita.
const NAVEGACAO_ADMIN = [
  { rota: 'admin', rotulo: 'Painel', icone: LayoutDashboard, permissao: 'analytics.read' },
  { rota: 'admin/eventos', rotulo: 'Eventos', icone: Trophy, permissao: 'events.update' },
  { rota: 'admin/inscricoes', rotulo: 'Inscrições', icone: ClipboardCheck, permissao: 'registrations.read' },
  { rota: 'admin/checkin', rotulo: 'Check-in', icone: ClipboardCheck, permissao: 'checkin.operate' },
  { rota: 'admin/pesagem', rotulo: 'Pesagem', icone: Scale, permissao: 'weighin.operate' },
  { rota: 'admin/credenciamento', rotulo: 'Credenciamento', icone: QrCode, permissao: 'credentials.read' },
  { rota: 'admin/palco', rotulo: 'Palco', icone: Users2, permissao: 'stage.read' },
  { rota: 'admin/julgamento', rotulo: 'Julgamento', icone: Gavel, permissao: 'judging.read' },
  { rota: 'admin/resultados', rotulo: 'Resultados', icone: ShieldCheck, permissao: 'results.read_unpublished' },
  { rota: 'admin/ranking', rotulo: 'Ranking', icone: Zap, permissao: 'ranking.manage' },
  { rota: 'admin/musclewar', rotulo: 'MuscleWar', icone: Upload, permissao: 'musclewar.review' },
  { rota: 'admin/auditoria', rotulo: 'Auditoria', icone: ShieldCheck, permissao: 'audit.read' },
  { rota: 'admin/configuracoes', rotulo: 'Configurações', icone: Settings, permissao: 'users.read' }
];

// Espelho da matriz do servidor, restrito ao que decide menu. Não substitui a
// autorização: serve para não oferecer um caminho que terminaria em 403.
const PERMISSOES_POR_PAPEL = {
  SUPER_ADMIN: ['*'],
  ADMIN: ['*'],
  EVENT_DIRECTOR: ['analytics.read', 'events.update', 'registrations.read', 'checkin.operate', 'weighin.operate', 'credentials.read', 'stage.read', 'judging.read', 'results.read_unpublished', 'ranking.manage', 'musclewar.review', 'users.read'],
  EVENT_COORDINATOR: ['analytics.read', 'events.update', 'registrations.read', 'checkin.operate', 'weighin.operate', 'credentials.read', 'stage.read', 'judging.read', 'results.read_unpublished'],
  JUDGE_COORDINATOR: ['judging.read', 'stage.read', 'results.read_unpublished'],
  JUDGE: ['judging.read', 'stage.read', 'registrations.read'],
  STAFF: ['registrations.read', 'stage.read', 'checkin.read'],
  REGISTRATION_OPERATOR: ['registrations.read'],
  CHECKIN_OPERATOR: ['registrations.read', 'checkin.operate'],
  WEIGHIN_OPERATOR: ['registrations.read', 'weighin.operate'],
  RESULTS_OPERATOR: ['results.read_unpublished', 'judging.read', 'stage.read'],
  RANKING_MANAGER: ['ranking.manage', 'results.read_unpublished', 'musclewar.review'],
  SOCIAL_ADMIN: [],
  MODERATOR: [],
  ATHLETE: [],
  COACH: ['registrations.read'],
  GYM: [], TEAM: [], BRAND: [], SPONSOR: [], MEDIA: []
};

function permissoesDe(user) {
  if (!user) return new Set();
  const papeis = [user.role, ...(user.organizations || []).map(vinculo => vinculo.role)];
  const conjunto = new Set();

  for (const papel of papeis) {
    const lista = PERMISSOES_POR_PAPEL[papel] || [];
    if (lista.includes('*')) return new Set(['*']);
    for (const permissao of lista) conjunto.add(permissao);
  }
  return conjunto;
}

function BuscaGlobal({ navegar }) {
  const [termo, setTermo] = useState('');
  const busca = useDebounce(termo, 400);
  const [aberto, setAberto] = useState(false);

  const estado = useFetch(
    () => (busca.trim().length >= 2 ? api.search({ q: busca.trim(), limit: 5 }) : Promise.resolve(null)),
    [busca]
  );

  const resultados = estado.data?.results || {};
  const temResultado = Object.values(resultados).some(lista => lista?.length);

  return (
    <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 420 }}>
      <label className="search-box">
        <Search size={15} />
        <input
          value={termo}
          onChange={evento => { setTermo(evento.target.value); setAberto(true); }}
          onFocus={() => setAberto(true)}
          onBlur={() => setTimeout(() => setAberto(false), 160)}
          placeholder="Buscar atleta, evento, perfil, comunidade…"
          aria-label="Busca global"
        />
      </label>

      {aberto && busca.trim().length >= 2 && (
        <div className="panel" style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 8, maxHeight: 380, overflowY: 'auto' }}>
          {!temResultado && <p style={{ fontSize: 12.5, color: 'var(--cinza-fraco)', margin: 0 }}>Nada encontrado.</p>}

          {(resultados.athletes || []).map(atleta => (
            <button key={atleta.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`atletas/${atleta.id}`)}>
              <Avatar name={atleta.fullName} size="avatar-sm" />
              <span className="info"><strong>{atleta.stageName || atleta.fullName}</strong><small>Atleta</small></span>
            </button>
          ))}
          {(resultados.events || []).map(evento => (
            <button key={evento.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`campeonatos/${evento.slug}`)}>
              <span className="avatar avatar-sm"><Trophy size={13} /></span>
              <span className="info"><strong>{evento.name}</strong><small>Campeonato</small></span>
            </button>
          ))}
          {(resultados.profiles || []).map(perfil => (
            <button key={perfil.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`perfil/${perfil.handle}`)}>
              <Avatar name={perfil.displayName} size="avatar-sm" />
              <span className="info"><strong>{perfil.displayName}</strong><small>@{perfil.handle}</small></span>
            </button>
          ))}
          {(resultados.communities || []).map(comunidade => (
            <button key={comunidade.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`comunidades/${comunidade.slug}`)}>
              <span className="avatar avatar-sm"><Users2 size={13} /></span>
              <span className="info"><strong>{comunidade.name}</strong><small>Comunidade</small></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { user, logout, authenticated, loading } = useAuth();
  const { rota, partes, navegar } = useHashRoute();
  const { toasts, notificar, remover } = useToasts();
  const [menuAberto, setMenuAberto] = useState(false);

  const permissoes = useMemo(() => permissoesDe(user), [user]);
  const pode = permissao => permissoes.has('*') || permissoes.has(permissao);

  const notificacoes = useFetch(
    () => (authenticated ? api.notifications.list({ onlyUnread: true, limit: 1 }) : Promise.resolve({ unreadCount: 0 })),
    [authenticated],
    { ativo: authenticated }
  );
  const mensagens = useFetch(
    () => (authenticated ? api.messenger.conversations({ limit: 40 }) : Promise.resolve({ totalUnread: 0 })),
    [authenticated],
    { ativo: authenticated }
  );

  useEffect(() => { setMenuAberto(false); }, [rota]);

  if (loading) {
    return <div className="auth-shell"><div className="auth-card"><p>Carregando…</p></div></div>;
  }

  if (!authenticated) return <Auth />;

  const itensAdmin = NAVEGACAO_ADMIN.filter(item => pode(item.permissao));

  const conteudo = () => {
    const [primeiro, segundo, terceiro] = partes;

    switch (primeiro) {
      case 'inicio': return <Inicio navegar={navegar} />;
      case 'campeonatos': return segundo ? <CampeonatoDetalhe slug={segundo} navegar={navegar} /> : <Campeonatos navegar={navegar} />;
      case 'atletas': return segundo ? <AtletaDetalhe id={segundo} navegar={navegar} /> : <Atletas navegar={navegar} />;
      case 'ranking': return <Ranking />;
      case 'social': return <Feed notificar={notificar} navegar={navegar} />;
      case 'salvos': return <Salvos notificar={notificar} navegar={navegar} />;
      case 'perfil': return segundo ? <Perfil handle={segundo} notificar={notificar} navegar={navegar} /> : <MeuPerfilSocial notificar={notificar} />;
      case 'messenger': return <Messenger notificar={notificar} />;
      case 'comunidades': return segundo ? <ComunidadeDetalhe slug={segundo} notificar={notificar} navegar={navegar} /> : <Comunidades navegar={navegar} notificar={notificar} />;
      case 'notificacoes': return <Notificacoes />;
      case 'meu-painel': return <MeuPainel navegar={navegar} />;
      case 'minha-conta': return <MinhaConta notificar={notificar} />;

      case 'admin': {
        // Rota administrativa alcançada sem permissão volta para o início em
        // vez de mostrar uma tela que a API recusaria.
        const item = NAVEGACAO_ADMIN.find(entrada => entrada.rota === (segundo ? `admin/${segundo}` : 'admin'));
        if (item && !pode(item.permissao)) return <Inicio navegar={navegar} />;

        if (!segundo) return pode('analytics.read') ? <AdminPainel notificar={notificar} navegar={navegar} /> : <Inicio navegar={navegar} />;
        if (segundo === 'eventos') return terceiro ? <AdminEventoDetalhe eventId={terceiro} notificar={notificar} navegar={navegar} /> : <AdminEventos notificar={notificar} navegar={navegar} />;
        if (segundo === 'inscricoes') return <AdminInscricoes notificar={notificar} />;
        if (segundo === 'checkin') return <AdminCheckin notificar={notificar} />;
        if (segundo === 'pesagem') return <AdminPesagem notificar={notificar} />;
        if (segundo === 'credenciamento') return <AdminCredenciamento notificar={notificar} />;
        if (segundo === 'palco') return <AdminPalco notificar={notificar} />;
        if (segundo === 'julgamento') return <AdminJulgamento notificar={notificar} />;
        if (segundo === 'resultados') return <AdminResultados notificar={notificar} />;
        if (segundo === 'ranking') return <AdminRanking notificar={notificar} />;
        if (segundo === 'musclewar') return <AdminMuscleWar notificar={notificar} />;
        if (segundo === 'auditoria') return <AdminAuditoria />;
        if (segundo === 'configuracoes') return <AdminConfiguracoes notificar={notificar} />;
        return <AdminPainel notificar={notificar} navegar={navegar} />;
      }

      default: return <Inicio navegar={navegar} />;
    }
  };

  const naoLidas = notificacoes.data?.unreadCount ?? 0;
  const mensagensNaoLidas = mensagens.data?.totalUnread ?? 0;

  return (
    <div className="shell">
      {menuAberto && <button type="button" className="mobile-scrim" aria-label="Fechar menu" onClick={() => setMenuAberto(false)} />}

      <nav className={`sidebar${menuAberto ? ' is-open' : ''}`} aria-label="Navegação principal">
        <div className="brand">
          <span className="brand-mark">M</span>
          <span className="brand-text">
            <strong>MCI Platform</strong>
            <small>Muscle Contest</small>
          </span>
        </div>

        <div className="nav-group">
          <span className="nav-label">Plataforma</span>
          {NAVEGACAO_PRINCIPAL.map(item => {
            const Icone = item.icone;
            const ativo = rota === item.rota || rota.startsWith(`${item.rota}/`);
            const contador = item.contador === 'mensagens' ? mensagensNaoLidas : 0;
            return (
              <button key={item.rota} type="button" className={`nav-item${ativo ? ' is-active' : ''}`} onClick={() => navegar(item.rota)}>
                <Icone size={16} /> {item.rotulo}
                {contador > 0 && <span className="badge-count">{contador}</span>}
              </button>
            );
          })}
        </div>

        {itensAdmin.length > 0 && (
          <div className="nav-group">
            <span className="nav-label">Administração</span>
            {itensAdmin.map(item => {
              const Icone = item.icone;
              const ativo = rota === item.rota || rota.startsWith(`${item.rota}/`);
              return (
                <button key={item.rota} type="button" className={`nav-item${ativo ? ' is-active' : ''}`} onClick={() => navegar(item.rota)}>
                  <Icone size={16} /> {item.rotulo}
                </button>
              );
            })}
          </div>
        )}

        <div className="sidebar-foot">
          <button type="button" className="session-card" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => navegar('minha-conta')}>
            <Avatar name={user?.name} size="avatar-sm" />
            <span className="info">
              <strong>{user?.name}</strong>
              <small>{user?.role}</small>
            </span>
          </button>
          <button type="button" className="nav-item" onClick={logout}><LogOut size={16} /> Sair</button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-button mobile-toggle" onClick={() => setMenuAberto(true)} aria-label="Abrir menu"><Menu size={16} /></button>
          <BuscaGlobal navegar={navegar} />
          <div className="topbar-actions">
            <button type="button" className="icon-button" onClick={() => navegar('notificacoes')} aria-label={`Notificações${naoLidas ? `: ${naoLidas} não lidas` : ''}`}>
              <Bell size={16} />
              {naoLidas > 0 && <span className="dot">{naoLidas > 9 ? '9+' : naoLidas}</span>}
            </button>
            <button type="button" className="icon-button" onClick={() => navegar('perfil')} aria-label="Meu perfil social"><UserCircle size={16} /></button>
          </div>
        </header>

        <main>{conteudo()}</main>
      </div>

      <Toasts toasts={toasts} onDismiss={remover} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
