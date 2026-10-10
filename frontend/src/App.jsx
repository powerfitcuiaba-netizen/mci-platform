import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { permissoesDe } from './lib/permissoes';
import {
  Bell, ClipboardCheck, History, Home, IdCard, LayoutDashboard, LogOut, Megaphone, Menu, MessageSquare,
  PencilLine, QrCode, Scale, Search, Settings, ShieldCheck, Trophy, Upload, UserCircle, Users, Users2,
  Volume2, VolumeX, X, Zap
} from 'lucide-react';
import { AuthProvider, useAuth } from './AuthContext';
import api from './services/api';
import { useDebounce, useFetch, useHashRoute, useToasts } from './lib/hooks';
import { Avatar, BlocoDaMarca, Skeleton, Toasts } from './components/ui';
import SeletorDeIdioma from './components/seletorDeIdioma';
import { useIdioma } from './lib/idioma';
import { caminhoDaFotoDoAtleta, caminhoDoAvatar, papel } from './lib/format';
import LimiteDeErro from './components/limiteDeErro';
import AberturaMci, { aberturaJaFoiVista } from './components/aberturaMci';
import { PalcoDaExperiencia } from './components/experiencia';
import { atoDaRota, estiloDaSequencia } from './lib/experiencia';
import ExperienceLab from './pages/experienceLab';
import { direcaoDeAudio, preferenciaDeAudio, definirPreferenciaDeAudio } from './lib/audioDirector';
import Auth from './pages/authPages';
import { AtletaDetalhe, Atletas, CampeonatoDetalhe, Campeonatos, Inicio, Ranking } from './pages/publicPages';
import { ComunidadeDetalhe, Comunidades, Feed, MeuPerfilSocial, Notificacoes, Perfil, Salvos } from './pages/socialPages';
import Messenger from './pages/messengerPage';
import { MeuPainel, MinhaConta } from './pages/mePages';
import { MeuHistorico, MinhaFiliacao } from './pages/minhaCarreira';
import MinhaSolicitacao from './pages/minhaSolicitacao';
import MeuCadastro from './pages/meuCadastro';
import MensagemDaFederacao from './components/mensagemDaFederacao';
import FaixaDePatrocinio from './components/faixaDePatrocinio';

// ============================================================================
// AS TELAS DE OPERAÇÃO ENTRAM SOB DEMANDA.
//
// Elas eram importadas de forma ansiosa, e o resultado é que TODO visitante —
// o atleta que só quer ver o próprio histórico, e até quem chega deslogado na
// vitrine — baixava o código da administração inteira antes da primeira
// pintura. Medido no pacote de produção: um único bloco de 892,55 kB (229,40 kB
// comprimido), e os módulos `admin*` mais o de treinadores somam 388,8 kB de
// fonte, que é a maior parte disso.
//
// O corte é por PERFIL DE USO, e não por tamanho: quem não é operador nunca
// abre estas telas, então elas não pertencem ao primeiro carregamento. As telas
// de uso comum (vitrine, social, minha carreira, autenticação) continuam
// ansiosas de propósito — adiá-las trocaria bytes por espera no caminho
// quente, que é o oposto do que se quer.
//
// `sob` resolve a exportação NOMEADA: `React.lazy` exige um módulo cujo
// `default` seja o componente, e quase todas estas telas são exportações
// nomeadas. O especificador do `import()` é literal em cada chamada porque o
// empacotador precisa enxergá-lo para criar o bloco — uma variável aqui
// devolveria um pacote só, que é justamente o defeito que estamos corrigindo.
//
// Isto NÃO muda autorização: a decisão continua no servidor, e o desvio de
// rota por permissão, logo abaixo, continua igual. Adiar o download de uma
// tela não a torna acessível a quem não podia abri-la.
// ============================================================================
const sob = (importar, nome) => lazy(() => importar().then(m => ({ default: nome ? m[nome] : m.default })));

const AdminCheckin = sob(() => import('./pages/adminEvent'), 'AdminCheckin');
const AdminCredenciamento = sob(() => import('./pages/adminEvent'), 'AdminCredenciamento');
const AdminEventoDetalhe = sob(() => import('./pages/adminEvent'), 'AdminEventoDetalhe');
const AdminEventos = sob(() => import('./pages/adminEvent'), 'AdminEventos');
const AdminInscricoes = sob(() => import('./pages/adminEvent'), 'AdminInscricoes');
const AdminPalco = sob(() => import('./pages/adminEvent'), 'AdminPalco');
const AdminPesagem = sob(() => import('./pages/adminEvent'), 'AdminPesagem');
const AdminResultados = sob(() => import('./pages/adminResults'), 'AdminResultados');
const AdminAuditoria = sob(() => import('./pages/adminPlatform'), 'AdminAuditoria');
const AdminConfiguracoes = sob(() => import('./pages/adminPlatform'), 'AdminConfiguracoes');
const AdminMuscleWar = sob(() => import('./pages/adminPlatform'), 'AdminMuscleWar');
const AdminPainel = sob(() => import('./pages/adminPlatform'), 'AdminPainel');
const AdminRanking = sob(() => import('./pages/adminPlatform'), 'AdminRanking');
const AdminOverall = sob(() => import('./pages/adminOverall'), 'AdminOverall');
const AdminLancamentos = sob(() => import('./pages/adminLancamentos'), 'AdminLancamentos');
const AdminSolicitacoes = sob(() => import('./pages/adminSolicitacoes'));
const AdminAtletas = sob(() => import('./pages/adminAtletas'), 'AdminAtletas');
const AdminAtleta = sob(() => import('./pages/adminAtleta'), 'AdminAtleta');
const AdminMensagens = sob(() => import('./pages/adminMensagens'), 'AdminMensagens');
const AdminTreinadores = sob(() => import('./pages/treinadores'), 'AdminTreinadores');
const MinhaEquipe = sob(() => import('./pages/treinadores'), 'MinhaEquipe');
const PainelDoTreinador = sob(() => import('./pages/treinadores'), 'PainelDoTreinador');

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
  { rota: 'meu-painel', rotulo: 'Meu painel', icone: UserCircle },
  // MEU CADASTRO é item próprio, e não uma aba dentro do painel: é onde o
  // atleta COMPLETA o que falta no cadastro dele. Quem tem campo em branco
  // precisa encontrar o caminho sem procurar — e quem não tem passa reto.
  { rota: 'meu-cadastro', rotulo: 'Meu cadastro', icone: PencilLine },
  // Duas telas, e não uma aba escondida dentro do painel: filiação e histórico
  // são as duas perguntas que o atleta faz sobre si mesmo, e as duas têm de
  // estar a um toque.
  { rota: 'minha-filiacao', rotulo: 'Minha filiação', icone: IdCard },
  { rota: 'meu-historico', rotulo: 'Meu histórico', icone: History },
  // MINHA EQUIPE é item fixo do menu, e não uma aba dentro do painel: é aqui
  // que o atleta CONFIRMA o vínculo, e a confirmação dele é o que cria o
  // vínculo. Um convite que espera resposta não pode depender de a pessoa
  // procurar onde ele está.
  { rota: 'minha-equipe', rotulo: 'Minha equipe', icone: Users2 },
  // TREINADOR (EQUIPE) aparece para quem é treinador. A tela decide sozinha
  // o que mostrar — formulário de autocadastro para quem não tem cadastro,
  // painel para quem tem —, então não há permissão a conferir no menu: uma
  // conta que ainda não é treinadora precisa justamente do caminho para se
  // tornar uma.
  //
  // O rótulo traz "(Equipe)" porque este é o ÚNICO caminho de treinador e de
  // equipe desde a unificação: quem antes procuraria um menu "Equipe" precisa
  // reconhecer que é aqui que ele conduz a dele.
  { rota: 'treinador', rotulo: 'Treinador (Equipe)', icone: IdCard }
];

// Cada item administrativo declara a permissão que o habilita.
const NAVEGACAO_ADMIN = [
  { rota: 'admin', rotulo: 'Painel', icone: LayoutDashboard, permissao: 'analytics.read' },
  { rota: 'admin/eventos', rotulo: 'Eventos', icone: Trophy, permissao: 'events.update' },
  { rota: 'admin/inscricoes', rotulo: 'Inscrições', icone: ClipboardCheck, permissao: 'registrations.read' },
  { rota: 'admin/solicitacoes', rotulo: 'Solicitações', icone: UserCircle, permissao: 'athletes.manage' },
  // ATLETAS é item próprio, e não uma aba dentro de Solicitações: a fila de
  // pedidos esvazia, o cadastro de atletas não. Quem precisa suspender alguém
  // ou conferir um histórico não está olhando para uma fila.
  { rota: 'admin/atletas', rotulo: 'Atletas', icone: Users, permissao: 'athletes.manage' },
  // TREINADORES é item próprio porque reúne DUAS decisões que ninguém encontra
  // dentro de outra tela: aprovar cadastro (administração central, R-03) e
  // autorizar atuação numa federação (a federação, R-04). A permissão declarada
  // é a da federação, que é a que mais gente tem; quem só tem
  // `coaches.approve` chega pela URL e a tela funciona igual.
  { rota: 'admin/treinadores', rotulo: 'Treinadores (Equipes)', icone: IdCard, permissao: 'coaches.authorize_org' },
  // A mensagem de abertura da federação aos seus atletas. Item próprio porque
  // é comunicação para TODA a base — não é uma configuração escondida numa
  // aba, e quem precisa publicá-la costuma estar com pressa.
  { rota: 'admin/mensagens', rotulo: 'Mensagens', icone: Megaphone, permissao: 'athletes.manage' },
  { rota: 'admin/checkin', rotulo: 'Check-in', icone: ClipboardCheck, permissao: 'checkin.operate' },
  { rota: 'admin/pesagem', rotulo: 'Pesagem', icone: Scale, permissao: 'weighin.operate' },
  { rota: 'admin/credenciamento', rotulo: 'Credenciamento', icone: QrCode, permissao: 'credentials.read' },
  { rota: 'admin/palco', rotulo: 'Palco', icone: Users2, permissao: 'stage.read' },
  { rota: 'admin/resultados', rotulo: 'Resultados', icone: ShieldCheck, permissao: 'results.read_unpublished' },
  { rota: 'admin/ranking', rotulo: 'Ranking', icone: Zap, permissao: 'ranking.manage' },
  // Item PRÓPRIO, e não uma aba dentro de Ranking: homologar Overall é o ato
  // esportivo oficial da plataforma, e precisa ser encontrável sem caça.
  { rota: 'admin/overall', rotulo: 'Overall', icone: Trophy, permissao: 'ranking.manage' },
  // Item PRÓPRIO também, pelo mesmo motivo e por mais um: corrigir resultado
  // publicado é a operação que um operador procura sob pressão, com a súmula
  // na mão e o ranking já no ar. Escondê-la dentro de outra tela custaria
  // exatamente os minutos em que ela é necessária.
  { rota: 'admin/lancamentos', rotulo: 'Lançamentos', icone: PencilLine, permissao: 'ranking.manage' },
  { rota: 'admin/musclewar', rotulo: 'MuscleWare', icone: Upload, permissao: 'musclewar.review' },
  { rota: 'admin/auditoria', rotulo: 'Auditoria', icone: ShieldCheck, permissao: 'audit.read' },
  { rota: 'admin/configuracoes', rotulo: 'Configurações', icone: Settings, permissao: 'users.read' }
];

// Qual item do menu deve acender. Vence o mais específico que casa com a rota:
// sem isso, `admin` casava com `admin/pesagem` pelo prefixo e o índice ficava
// aceso junto com o item real em toda tela administrativa.
function rotaAtiva(itens, rota) {
  let melhor = null;
  for (const item of itens) {
    const casa = rota === item.rota || rota.startsWith(`${item.rota}/`);
    if (casa && (!melhor || item.rota.length > melhor.length)) melhor = item.rota;
  }
  return melhor;
}

// Exportada com nome para que o comportamento da busca no celular — abrir,
// focar, fechar por X e por Escape — seja medido sem montar a aplicação
// inteira. `App` continua sendo o export padrão.
export function BuscaGlobal({ navegar }) {
  const { t } = useIdioma();
  const [termo, setTermo] = useState('');
  const busca = useDebounce(termo, 400);
  const [aberto, setAberto] = useState(false);
  // NO CELULAR A BUSCA É UM BOTÃO ATÉ ALGUÉM PEDIR POR ELA.
  //
  // A barra superior tem 356px de custo fixo — padding 32, botão de menu 44,
  // vãos 24 e as ações 256 — numa viewport de 360. Não sobra largura para um
  // campo de busca, e medido em Chromium real o documento ganhava 33px de
  // rolagem horizontal em 360x800 e 19px em 390x844.
  //
  // Encolher os botões resolveria a aritmética e quebraria o piso de 40px de
  // alvo de toque que a suíte já protege. Esconder a busca resolveria também,
  // e tiraria uma função de quem usa telefone. O botão preserva as duas
  // coisas: ocupa 44px fechado, e aberto toma a barra inteira.
  const [expandida, setExpandida] = useState(false);
  const campo = useRef(null);

  // Ctrl+K / Cmd+K leva o foco para a busca, e Esc devolve. Operação de piso
  // é feita com as duas mãos ocupadas: quem já sabe o nome da atleta não
  // deveria precisar procurar o campo com o mouse.
  useEffect(() => {
    const aoTeclar = evento => {
      if ((evento.ctrlKey || evento.metaKey) && evento.key.toLowerCase() === 'k') {
        evento.preventDefault();
        campo.current?.focus();
        campo.current?.select();
      } else if (evento.key === 'Escape' && document.activeElement === campo.current) {
        campo.current.blur();
        setAberto(false);
        setExpandida(false);
      }
    };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, []);

  const estado = useFetch(
    () => (busca.trim().length >= 2 ? api.search({ q: busca.trim(), limit: 5 }) : Promise.resolve(null)),
    [busca]
  );

  const resultados = estado.data?.results || {};
  const temResultado = Object.values(resultados).some(lista => lista?.length);

  const fechar = () => { setExpandida(false); setAberto(false); setTermo(''); };

  return (
    <>
      {/* Só existe no celular. Fora dele o campo já está à vista e um botão
          para abrir o que está aberto seria ruído para o leitor de tela. */}
      <button
        type="button"
        className="icon-button busca-abrir"
        aria-label={t('busca.abrir')}
        aria-expanded={expandida}
        onClick={() => { setExpandida(true); setTimeout(() => campo.current?.focus(), 0); }}
      >
        <Search size={16} />
      </button>

      {/* O ESTILO SAIU DO `style` INLINE E FOI PARA O CSS.
          Este `div` é o item flex da barra — e enquanto ele carregou
          `flex: '1 1 260px'` inline, nenhuma regra de faixa de tela alcançava
          o item que precisava encolher: estilo inline vence folha de estilo. */}
      <div className={`busca-global${expandida ? ' is-expandida' : ''}`}>
      <label className="search-box">
        <Search size={15} />
        <input
          value={termo}
          onChange={evento => { setTermo(evento.target.value); setAberto(true); }}
          onFocus={() => setAberto(true)}
          onBlur={() => setTimeout(() => setAberto(false), 160)}
          placeholder={t('busca.placeholder')}
          aria-label={t('busca.rotulo')}
          ref={campo}
        />
        <kbd className="atalho" aria-hidden="true">Ctrl K</kbd>
      </label>

      {/* Fechar só aparece quando a busca foi aberta no celular: no desktop o
          campo é permanente e não há o que fechar. */}
      <button type="button" className="icon-button busca-fechar" aria-label={t('busca.fechar')} onClick={fechar}>
        <X size={16} />
      </button>

      {aberto && busca.trim().length >= 2 && (
        <div className="panel" style={{ position: 'absolute', top: 46, left: 0, right: 0, zIndex: 8, maxHeight: 380, overflowY: 'auto' }}>
          {!temResultado && <p style={{ fontSize: 12.5, color: 'var(--cinza-fraco)', margin: 0 }}>{t('busca.nadaEncontrado')}</p>}

          {(resultados.athletes || []).map(atleta => (
            <button key={atleta.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`atletas/${atleta.id}`)}>
              <Avatar name={atleta.fullName} mediaPath={caminhoDaFotoDoAtleta(atleta)} size="avatar-sm" />
              <span className="info"><strong>{atleta.stageName || atleta.fullName}</strong><small>{t('busca.atleta')}</small></span>
            </button>
          ))}
          {(resultados.events || []).map(evento => (
            <button key={evento.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`campeonatos/${evento.slug}`)}>
              <span className="avatar avatar-sm"><Trophy size={13} /></span>
              <span className="info"><strong>{evento.name}</strong><small>{t('busca.campeonato')}</small></span>
            </button>
          ))}
          {(resultados.profiles || []).map(perfil => (
            <button key={perfil.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`perfil/${perfil.handle}`)}>
              <Avatar name={perfil.displayName} mediaPath={caminhoDoAvatar(perfil)} size="avatar-sm" />
              <span className="info"><strong>{perfil.displayName}</strong><small>@{perfil.handle}</small></span>
            </button>
          ))}
          {(resultados.communities || []).map(comunidade => (
            <button key={comunidade.id} type="button" className="list-row" style={{ width: '100%', background: 'transparent', border: 0, textAlign: 'left' }} onClick={() => navegar(`comunidades/${comunidade.slug}`)}>
              <span className="avatar avatar-sm"><Users2 size={13} /></span>
              <span className="info"><strong>{comunidade.name}</strong><small>{t('busca.comunidade')}</small></span>
            </button>
          ))}
        </div>
      )}
      </div>
    </>
  );
}

function Shell() {
  // O hook fica na PRIMEIRA linha do componente porque `Shell` tem retorno
  // antecipado (a abertura da marca): chamá-lo depois dele mudaria a ordem dos
  // hooks entre renderizações, que é o defeito que o ESLint pegou aqui.
  const { t } = useIdioma();

  // A tradução do item de navegação sai da ROTA. `item.rotulo` continua no
  // código como o português de origem e como recuo — se uma rota nova entrar
  // sem chave, ela aparece em português em vez de aparecer como "nav.x".
  const rotuloDoItem = item => {
    const chave = `nav.${item.rota}`;
    const traduzido = t(chave);
    return traduzido === chave ? item.rotulo : traduzido;
  };

  const { user, logout, authenticated, loading } = useAuth();
  // A abertura roda uma vez por sessão do navegador, antes de qualquer tela.
  // `aberturaJaFoiVista` é lido na inicialização do estado — não num efeito —
  // para a abertura não piscar em quem já a viu.
  const [abertura, setAbertura] = useState(() => !aberturaJaFoiVista());
  // O visitante anônimo pediu para entrar. Fica aqui, e não na rota, porque a
  // rota é o que ele estava LENDO — e é para ela que ele volta se desistir.
  const [querEntrar, setQuerEntrar] = useState(false);

  // CONTINUIDADE DA ABERTURA.
  //
  // Quem acabou de ver a abertura entra no sistema; quem já a viu apenas
  // recarregou uma página. São duas coisas diferentes, e o corte seco entre a
  // abertura e a primeira tela fazia as duas parecerem iguais — a abertura
  // terminava e o casco aparecia, sem ligação nenhuma entre os dois gestos.
  //
  // A marca dura só a primeira entrada e sai sozinha: alongar a entrada de
  // TODA navegação deixaria o sistema lento pelo resto da sessão, que é o
  // oposto do que esta fase inteira busca.
  const [entradaContinua, setEntradaContinua] = useState(false);
  useEffect(() => {
    if (!entradaContinua) return undefined;
    const relogio = setTimeout(() => setEntradaContinua(false), 1400);
    return () => clearTimeout(relogio);
  }, [entradaContinua]);
  const [somLigado, setSomLigado] = useState(() => preferenciaDeAudio());
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

  // O perfil social é buscado aqui só para a foto do rodapé da barra lateral.
  // `user` é a conta (nome, papel) e não carrega avatar: quem tem foto é o
  // perfil social. Uma chamada por sessão, e o `refreshData` do envio de foto
  // já a refaz — trocar a foto atualiza o canto da tela sem recarregar.
  const perfilSocial = useFetch(
    () => (authenticated ? api.social.me().catch(() => null) : Promise.resolve(null)),
    [authenticated],
    { ativo: authenticated }
  );

  useEffect(() => { setMenuAberto(false); }, [rota]);

  // Tocar num item do menu SEMPRE fecha a gaveta — inclusive quando o item é o
  // da tela em que já se está. Fechar só na troca de rota deixava a gaveta
  // aberta nesse caso, e no celular isso parece que o toque não registrou.
  const navegarEFechar = destino => { setMenuAberto(false); navegar(destino); };

  // A abertura vem ANTES do estado de carregamento: ela é a primeira coisa que
  // a pessoa vê, e enquanto ela roda a sessão termina de ser verificada em
  // segundo plano. Nada da abertura espera rede.
  if (abertura) {
    return <AberturaMci aoTerminar={() => { setAbertura(false); setEntradaContinua(true); }} />;
  }

  if (loading) {
    return <div className="auth-shell"><div className="auth-card"><p>{t('estado.carregando')}</p></div></div>;
  }

  // O VISITANTE ANÔNIMO ALCANÇA A VITRINE — E SÓ ELA.
  //
  // Esta linha devolvia a tela de entrada para QUALQUER rota, inclusive as
  // marcadas `publico: true` logo acima. A API nunca exigiu sessão nelas:
  // `GET /api/v1/public/...`, `/ranking`, `/events` respondem 200 ao anônimo,
  // e há suíte provando isso. Quem barrava era só o casco — e o efeito era
  // uma vitrine que não se podia visitar e um resultado "público" que pedia
  // senha.
  //
  // A LISTA NÃO É NOVA E NÃO É SEGUNDA FONTE DE VERDADE: ela sai de
  // `NAVEGACAO_PRINCIPAL`, onde `publico: true` já estava declarado item a
  // item. Acrescentar uma tela pública é marcar a bandeira lá, num lugar só.
  //
  // O QUE CONTINUA FECHADO é tudo o mais: social, messenger, comunidades, meu
  // painel, meu cadastro, minha conta, treinador e TODO o `admin/*`. Rota não
  // declarada pública cai na tela de entrada, que é o padrão seguro — e a
  // autoridade continua no servidor: esconder é conveniência, nunca a defesa.
  // `querEntrar` é o PEDIDO EXPLÍCITO do visitante: ele clicou "Entrar agora"
  // na barra lateral. Sem este estado o botão era um beco — a rota continuava
  // pública, a condição abaixo continuava falsa, e o clique devolvia a mesma
  // vitrine. Medido no Chromium anônimo antes de existir.
  const [rotaRaiz] = partes;
  const ehRotaPublica = NAVEGACAO_PRINCIPAL.some(item => item.publico && item.rota === rotaRaiz);
  if (!authenticated && (querEntrar || !ehRotaPublica)) {
    return (
      <Auth
        entradaContinua={entradaContinua}
        // A saída só é oferecida a quem TEM para onde voltar. Quem caiu aqui
        // por tentar uma rota fechada não tem vitrine atrás de si.
        aoVoltarParaVitrine={querEntrar && ehRotaPublica ? () => setQuerEntrar(false) : null}
      />
    );
  }

  // Sem sessão não há permissão nenhuma, e o grupo administrativo nem é
  // montado. `pode()` já recusaria; a guarda explícita evita depender disso.
  const itensAdmin = authenticated ? NAVEGACAO_ADMIN.filter(item => pode(item.permissao)) : [];
  const ativoPrincipal = rotaAtiva(NAVEGACAO_PRINCIPAL, rota);
  const ativoAdmin = rotaAtiva(itensAdmin, rota);

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
      case 'meu-painel': return <MeuPainel navegar={navegar} notificar={notificar} />;
      case 'minha-conta': return <MinhaConta notificar={notificar} />;
      case 'meu-cadastro': return <MeuCadastro notificar={notificar} navegar={navegar} />;
      case 'minha-filiacao': return <MinhaFiliacao />;
      case 'meu-historico': return <MeuHistorico />;
      case 'minha-solicitacao': return <MinhaSolicitacao notificar={notificar} />;
      case 'minha-equipe': return <MinhaEquipe notificar={notificar} />;
      case 'treinador': return <PainelDoTreinador notificar={notificar} />;
      // Laboratório de experiência: existe para calibrar os efeitos num lugar
      // só, antes de espalhá-los. Fica FORA do pacote de produção (ver o
      // `import.meta.env.DEV` abaixo) — não é tela de usuário.
      case 'experience-lab': return import.meta.env.DEV ? <ExperienceLab /> : <Inicio navegar={navegar} />;

      case 'admin': {
        // Rota administrativa alcançada sem permissão volta para o início em
        // vez de mostrar uma tela que a API recusaria.
        const item = NAVEGACAO_ADMIN.find(entrada => entrada.rota === (segundo ? `admin/${segundo}` : 'admin'));
        if (item && !pode(item.permissao)) return <Inicio navegar={navegar} />;

        if (!segundo) return pode('analytics.read') ? <AdminPainel navegar={navegar} /> : <Inicio navegar={navegar} />;
        if (segundo === 'eventos') return terceiro ? <AdminEventoDetalhe eventId={terceiro} notificar={notificar} navegar={navegar} /> : <AdminEventos notificar={notificar} navegar={navegar} />;
        if (segundo === 'inscricoes') return <AdminInscricoes notificar={notificar} />;
        if (segundo === 'solicitacoes') return <AdminSolicitacoes notificar={notificar} />;
        if (segundo === 'atletas') return terceiro
          ? <AdminAtleta id={terceiro} navegar={navegar} notificar={notificar} />
          : <AdminAtletas navegar={navegar} />;
        if (segundo === 'checkin') return <AdminCheckin notificar={notificar} />;
        if (segundo === 'pesagem') return <AdminPesagem notificar={notificar} />;
        if (segundo === 'credenciamento') return <AdminCredenciamento notificar={notificar} />;
        if (segundo === 'palco') return <AdminPalco notificar={notificar} />;
        if (segundo === 'resultados') return <AdminResultados notificar={notificar} />;
        if (segundo === 'ranking') return <AdminRanking notificar={notificar} />;
        if (segundo === 'overall') return <AdminOverall notificar={notificar} />;
        if (segundo === 'lancamentos') return <AdminLancamentos notificar={notificar} />;
        if (segundo === 'musclewar') return <AdminMuscleWar notificar={notificar} />;
        if (segundo === 'mensagens') return <AdminMensagens notificar={notificar} />;
        if (segundo === 'treinadores') return <AdminTreinadores notificar={notificar} />;
        if (segundo === 'auditoria') return <AdminAuditoria />;
        if (segundo === 'configuracoes') return <AdminConfiguracoes notificar={notificar} />;
        return <AdminPainel navegar={navegar} />;
      }

      default: return <Inicio navegar={navegar} />;
    }
  };

  const naoLidas = notificacoes.data?.unreadCount ?? 0;
  const mensagensNaoLidas = mensagens.data?.totalUnread ?? 0;

  return (
    <div className={`shell${entradaContinua ? ' entrada-continua' : ''}`} data-ato={atoDaRota(rota)}>
      {menuAberto && <button type="button" className="mobile-scrim" aria-label={t('navegacao.fecharMenu')} onClick={() => setMenuAberto(false)} />}

      <nav className={`sidebar${menuAberto ? ' is-open' : ''}`} aria-label={t('navegacao.principal')}>
        <div className="brand">
          <BlocoDaMarca />
        </div>

        <div className="nav-group">
          <span className="nav-label">{t('grupo.plataforma')}</span>
          {/* O menu do visitante mostra só o que ele pode abrir. Oferecer um
              item que leva à tela de entrada seria convidar para uma porta
              fechada. */}
          {NAVEGACAO_PRINCIPAL.filter(item => authenticated || item.publico).map((item, indice) => {
            const Icone = item.icone;
            const ativo = item.rota === ativoPrincipal;
            const contador = item.contador === 'mensagens' ? mensagensNaoLidas : 0;
            return (
              <button key={item.rota} type="button" className={`nav-item revela${ativo ? ' is-active' : ''}`} style={estiloDaSequencia(indice)} onClick={() => navegarEFechar(item.rota)}>
                <Icone size={16} /> {rotuloDoItem(item)}
                {contador > 0 && <span className="badge-count">{contador}</span>}
              </button>
            );
          })}
        </div>

        {itensAdmin.length > 0 && (
          <div className="nav-group">
            <span className="nav-label">{t('grupo.administracao')}</span>
            {itensAdmin.map((item, indice) => {
              const Icone = item.icone;
              const ativo = item.rota === ativoAdmin;
              return (
                <button key={item.rota} type="button" className={`nav-item revela${ativo ? ' is-active' : ''}`} style={estiloDaSequencia(NAVEGACAO_PRINCIPAL.length + indice)} onClick={() => navegarEFechar(item.rota)}>
                  <Icone size={16} /> {rotuloDoItem(item)}
                </button>
              );
            })}
          </div>
        )}

        <div className="sidebar-foot">
          {authenticated
            ? (
              <>
                <button type="button" className="session-card" style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left' }} onClick={() => navegar('minha-conta')}>
                  <Avatar name={user?.name} mediaPath={caminhoDoAvatar(perfilSocial.data)} size="avatar-sm" />
                  <span className="info">
                    <strong>{user?.name}</strong>
                    <small>{papel(user?.role).rotulo}</small>
                  </span>
                </button>
                <button type="button" className="nav-item" onClick={logout}><LogOut size={16} /> {t('topo.sair')}</button>
              </>
            )
            : (
              // O visitante precisa de uma porta de entrada visível. Sem ela,
              // quem chega pela vitrine não encontra como entrar.
              // VAI PARA O LOGIN, e não para a abertura da marca: `setAbertura(true)`
              // reexibia o vídeo de marca e terminava devolvendo a mesma vitrine,
              // sem nunca mostrar o formulário.
              <button type="button" className="button button-primary" style={{ width: '100%' }} onClick={() => setQuerEntrar(true)}>
                {t('abertura.entrarAgora')}
              </button>
            )}
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-button mobile-toggle" onClick={() => setMenuAberto(true)} aria-label={t('navegacao.abrirMenu')}><Menu size={16} /></button>
          <BuscaGlobal navegar={navegar} />
          <div className="topbar-actions">
          {/* Canto superior direito, antes dos demais controles: é o primeiro
              lugar onde quem não lê português procura. */}
          <SeletorDeIdioma />
          {/* Controle global de som. Desligar encerra a trilha na hora e a
              preferência vale nas próximas sessões. */}
          <button
            type="button"
            className="icon-button"
            aria-pressed={somLigado}
            aria-label={somLigado ? t('topo.desligarSom') : t('topo.ligarSom')}
            title={somLigado ? t('topo.somLigado') : t('topo.somDesligado')}
            onClick={() => {
              const proximo = !somLigado;
              definirPreferenciaDeAudio(proximo);
              if (!proximo) direcaoDeAudio.encerrar({ imediato: true });
              setSomLigado(proximo);
            }}
          >
            {somLigado ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
            {/* Notificações e perfil são DE QUEM TEM SESSÃO. Para o visitante
                anônimo os dois levariam à tela de entrada — um botão que só
                serve para frustrar. O idioma e o som ficam: são preferências
                de quem está lendo, com ou sem conta. */}
            {authenticated && (
              <>
                <button type="button" className="icon-button" onClick={() => navegar('notificacoes')} aria-label={`${t('topo.notificacoes')}${naoLidas ? `: ${t('topo.naoLidas', { n: naoLidas })}` : ''}`}>
                  <Bell size={16} />
                  {naoLidas > 0 && <span className="dot">{naoLidas > 9 ? '9+' : naoLidas}</span>}
                </button>
                <button type="button" className="icon-button" onClick={() => navegar('perfil')} aria-label={t('topo.meuPerfil')}><UserCircle size={16} /></button>
              </>
            )}
          </div>
        </header>

        {/* O limite envolve só a tela, e não o casco: se uma tela falhar, o
            menu e a barra de topo continuam de pé, e o operador navega para
            outra em vez de ficar diante de uma página em branco. A chave pela
            rota rearma o limite a cada navegação. */}
        {/* `Suspense` existe porque as telas de operação chegam sob demanda
            (ver o bloco `sob` no topo). O esqueleto é o MESMO que as listas já
            usam enquanto buscam dados — quem espera vê a linguagem de
            carregamento de sempre, e não uma tela branca nem um texto solto.
            Ele fica DENTRO do limite de erro: falha ao baixar um bloco é erro
            de tela, e cai na mesma rede que já protege o casco. */}
        <main>
          <LimiteDeErro key={rota}>
            <Suspense fallback={<Skeleton linhas={6} />}>{conteudo()}</Suspense>
          </LimiteDeErro>
        </main>

        {/* A FAIXA DE PATROCÍNIO, no rodapé da VITRINE.
            Ela acompanha as telas públicas — início, campeonatos, atletas e
            ranking —, que são a superfície de transmissão do campeonato e onde
            a exposição de patrocínio tem lugar. `ehRotaPublica` é a MESMA
            bandeira `publico: true` de `NAVEGACAO_PRINCIPAL` usada na guarda
            de sessão acima: uma fonte só decide o que é vitrine.

            FORA DELA, NÃO. Messenger é conversa de altura cheia; `admin/*` são
            tabelas de operação com coluna de ações grudada — uma faixa ali
            comeria altura de trabalho e atrapalharia quem opera sob pressão.

            É um irmão do `main`, EM FLUXO: a altura entra no layout, nada é
            sobreposto, nenhum clique é bloqueado e não há `z-index` disputando
            com modal, menu, dropdown ou toast. */}
        {ehRotaPublica && <FaixaDePatrocinio />}
      </div>

      {/* Um único palco de experiência no aplicativo inteiro. Ele NÃO substitui
          os toasts: o feedback funcional continua igual, e a celebração entra
          por cima apenas quando o motor libera o nível. */}
      <PalcoDaExperiencia />

      {/* O RECADO DA FEDERAÇÃO, por cima de tudo — e só para quem tem cadastro
          de atleta. Quem decide se ele abre é o servidor (`deveExibir`), que
          já conferiu a janela de validade e a leitura desta pessoa. */}
      {user?.athleteId && <MensagemDaFederacao />}

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
