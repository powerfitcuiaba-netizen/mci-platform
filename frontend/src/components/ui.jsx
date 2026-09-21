import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, Loader2, RefreshCw, X } from 'lucide-react';
import { iniciais } from '../lib/format';
import { fetchMediaObjectUrl, releaseMediaObjectUrl } from '../services/api';
import { useIdioma } from '../lib/idioma';

// Blocos de interface compartilhados. Tudo aqui é apresentação: nenhuma
// decisão de autorização ou de regra de negócio mora neste arquivo.

// A marca oficial. O arquivo vive em public/ e é servido pela raiz; enquanto
// ele não existir, a interface cai na sigla, que é o comportamento antigo.
// Assim quem tem o arquivo só precisa soltá-lo em frontend/public/ — nada de
// código muda, e nada quebra se ele faltar.
const CAMINHO_DA_MARCA = '/marca-mci.png';
// O MESMO desenho, em WebP sem perda: 125 kB no lugar de 197 kB. Conferido
// pixel a pixel contra o original — ZERO pixel visível alterado. Não é
// recompressão com perda nem versão "quase igual" da marca; é o mesmo arquivo
// noutro empacotamento. O PNG continua como reserva para quem não abre WebP,
// e continua sendo a fonte da verdade da identidade.
const CAMINHO_DA_MARCA_WEBP = '/marca-mci.webp';

// A ausência do arquivo é lembrada uma vez por sessão. Sem isto, cada troca de
// tela pede a imagem de novo e leva a mesma falha — barulho no console e uma
// requisição inútil por navegação.
let marcaIndisponivel = false;

// A marca oficial é um lockup para fundo claro: a espada e o "SINCE 1988" são
// pretos. Sobre o preto do sistema eles somem, e a logo aparece oca — conferido
// renderizando o arquivo a 36, 56, 96 e 152px sobre #06080b. Por isso ela vai
// sempre sobre uma plaqueta clara, que é espaço de respiro da marca e não
// alteração dela: o arquivo não é tocado, recortado nem recolorido.
//
// A mesma prova mostrou que abaixo de ~90px o letreiro vira borrão. Então a
// marca não é usada como ícone miúdo: onde havia um quadrado de 36px, agora há
// o bloco da marca em largura cheia.
export function MarcaMci({ largura = 120, titulo = 'Muscle Contest International', className = '' }) {
  const [temArquivo, setTemArquivo] = useState(!marcaIndisponivel);

  if (!temArquivo) return <span className="brand-mark" aria-hidden="true">M</span>;

  return (
    <span className={`brand-plate ${className}`.trim()} style={{ width: largura }}>
      <picture>
        <source srcSet={CAMINHO_DA_MARCA_WEBP} type="image/webp" />
        <img
          className="brand-logo"
          src={CAMINHO_DA_MARCA}
          alt={titulo}
          width={500}
          height={500}
          decoding="async"
          onError={() => { marcaIndisponivel = true; setTemArquivo(false); }}
        />
      </picture>
    </span>
  );
}

// Bloco de marca da barra lateral. Quando o arquivo oficial existe, ele fala
// sozinho — o letreiro escrito ao lado seria a marca dita duas vezes. Quando
// não existe, volta o lockup textual antigo, que é o que sustentava a
// identidade antes: sigla e nome.
export function BlocoDaMarca({ largura = 132 }) {
  const [temArquivo, setTemArquivo] = useState(!marcaIndisponivel);

  if (!temArquivo) {
    return (
      <>
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="brand-text">
          <strong>MCI Platform</strong>
          <small>Muscle Contest</small>
        </span>
      </>
    );
  }

  return (
    <span className="brand-plate brand-plate-bloco" style={{ width: largura }}>
      <picture>
        <source srcSet={CAMINHO_DA_MARCA_WEBP} type="image/webp" />
        <img
          className="brand-logo"
          src={CAMINHO_DA_MARCA}
          alt="Muscle Contest International"
          width={500}
          height={500}
          decoding="async"
          onError={() => { marcaIndisponivel = true; setTemArquivo(false); }}
        />
      </picture>
    </span>
  );
}

export function PageHead({ eyebrow, title, description, actions }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </header>
  );
}

// `aoVivo` é reservado ao que está acontecendo agora — hoje, a bateria no
// palco. O ponto do selo pulsa só nesse caso; em estado parado seria ruído.
export const Badge = ({ tom = 'neutro', aoVivo = false, children }) => (
  <span className={`badge badge-${tom}${aoVivo ? ' esta-ao-vivo' : ''}`}>{children}</span>
);

// Métrica do painel. Com `onClick` ela vira um BOTÃO de verdade — e não uma
// `div` com `cursor: pointer` e um manipulador de clique pendurado.
//
// A diferença não é estética: o botão entra na ordem de tabulação, responde a
// Enter e Espaço, é anunciado como controle pelo leitor de tela e recebe foco
// visível. Uma `div` clicável é invisível para quem navega por teclado — o
// número aparece, e não há como chegar nele.
//
// O `aria-label` junta rótulo, valor e destino porque o leitor de tela lê o
// controle fora do contexto visual: "Atletas" sozinho não diz para onde leva.
export function Metric({ label, value, hint, destaque = false, onClick, destino }) {
  const classe = `metric${destaque ? ' destaque' : ''}${onClick ? ' metric-clicavel' : ''}`;

  const conteudo = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </>
  );

  if (!onClick) return <div className={classe}>{conteudo}</div>;

  return (
    <button
      type="button"
      className={classe}
      onClick={onClick}
      aria-label={`${label}: ${value}.${destino ? ` Abrir ${destino}.` : ''}`}
    >
      {conteudo}
    </button>
  );
}

// Idade do dado à vista. Um painel que se atualiza sozinho precisa dizer
// QUANDO conferiu: sem isso, número velho por falha de rede é indistinguível
// de número recém-confirmado, e o operador confia no que não devia.
export function AtualizadoEm({ quando }) {
  const { t } = useIdioma();
  const [, redesenhar] = useState(0);

  // O texto envelhece sozinho: sem este tique, "agora" continuaria escrito
  // "agora" cinco minutos depois.
  useEffect(() => {
    if (!quando) return undefined;
    const intervalo = setInterval(() => redesenhar(n => n + 1), 15000);
    return () => clearInterval(intervalo);
  }, [quando]);

  if (!quando) return null;

  const segundos = Math.max(0, Math.round((Date.now() - quando) / 1000));
  const texto = segundos < 45
    ? t('ui.atualizadoAgora')
    : segundos < 5400
      ? t('ui.atualizadoMinutos', { n: Math.round(segundos / 60) })
      : t('ui.atualizadoHoras', { n: Math.round(segundos / 3600) });

  return (
    <p className="atualizado-em" role="status" aria-live="polite">
      <RefreshCw size={12} aria-hidden="true" /> {texto}
    </p>
  );
}

export function Skeleton({ linhas = 4 }) {
  const { t } = useIdioma();

  return (
    <div className="skeleton" aria-busy="true" aria-label={t('ui.carregando')}>
      {Array.from({ length: linhas }, (_, indice) => <i key={indice} />)}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  const { t } = useIdioma();

  return (
    <div className="alert alert-erro" role="alert">
      <AlertTriangle size={17} />
      <div style={{ flex: 1 }}>
        <strong>{t('estado.erro')}</strong>
        <p>{message}</p>
      </div>
      {onRetry && <button type="button" className="button button-secondary button-sm" onClick={onRetry}>{t('ui.tentarDeNovo')}</button>}
    </div>
  );
}

export const EmptyState = ({ title, description, action }) => (
  <div className="empty">
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {action && <div style={{ marginTop: 14 }}>{action}</div>}
  </div>
);

// Estado de tela padrão: carga, erro e vazio resolvidos em um lugar só, para
// que nenhuma página invente o seu próprio.
//
// A guarda de `data` nulo não é zelo excessivo: sem ela, uma busca que resolve
// para nulo — porque o filtro mudou, porque a consulta ficou inativa, porque a
// resposta veio vazia — cai direto em `children(null)`, e a página inteira
// morre no primeiro `dados.items`. Foi assim que a tela de credenciamento
// quebrava ao escolher um evento. Nulo é ausência de dado, não erro: mostra o
// esqueleto, que é o que estava acontecendo de fato.
export function AsyncSection({ state, empty, children, linhas = 4 }) {
  const { t } = useIdioma();

  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.data === null || state.data === undefined) return <Skeleton linhas={linhas} />;
  if (empty && empty(state.data)) return <EmptyState title={t('estado.vazio')} description={t('ui.vazioDescricao')} />;
  return children(state.data);
}

export function Field({ label, required, hint, children }) {
  return (
    <label className="field">
      <span>{label}{required && <em> *</em>}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

// Pilha de diálogos abertos. Existe por causa do Escape: cada diálogo escutava
// a tecla na janela, então abrir uma confirmação sobre um formulário e apertar
// Escape fechava OS DOIS de uma vez — o operador perdia o formulário inteiro
// por causa de um "cancelar" na confirmação. Só o diálogo do topo responde.
const pilhaDeDialogos = [];

const FOCALIZAVEIS = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

export function Modal({ title, description, wide = false, variante = '', onClose, children }) {
  const { t } = useIdioma();
  const caixa = useRef(null);

  useEffect(() => {
    const meuLugar = {};
    pilhaDeDialogos.push(meuLugar);

    // `aria-modal="true"` promete ao leitor de tela que o resto da página está
    // inerte. Sem gestão de foco a promessa é falsa: quem navega por teclado
    // sai do diálogo sem perceber e passa a operar controles que a interface
    // declarou inexistentes. Três peças cumprem a promessa: levar o foco para
    // dentro, não deixá-lo sair, e devolvê-lo a quem abriu.
    const veioDe = document.activeElement;
    caixa.current?.focus();

    // Sem filtro por `offsetParent`: ele é nulo para elemento de posição fixa
    // — que é exatamente o caso da caixa do diálogo — e sempre nulo fora de um
    // navegador com layout. A filtragem por visibilidade real custaria mais do
    // que resolve: dentro de um diálogo, o que está no DOM está à vista.
    const focalizaveis = () => Array.from(caixa.current?.querySelectorAll(FOCALIZAVEIS) || [])
      .filter(no => !no.hasAttribute('hidden') && no.getAttribute('aria-hidden') !== 'true');

    const aoTeclar = evento => {
      if (pilhaDeDialogos[pilhaDeDialogos.length - 1] !== meuLugar) return;

      if (evento.key === 'Escape') {
        onClose();
        return;
      }
      if (evento.key !== 'Tab') return;

      const alvos = focalizaveis();
      if (!alvos.length) { evento.preventDefault(); return; }

      const primeiro = alvos[0];
      const ultimo = alvos[alvos.length - 1];
      const atual = document.activeElement;

      if (evento.shiftKey && (atual === primeiro || atual === caixa.current)) {
        evento.preventDefault();
        ultimo.focus();
      } else if (!evento.shiftKey && atual === ultimo) {
        evento.preventDefault();
        primeiro.focus();
      }
    };

    window.addEventListener('keydown', aoTeclar);
    return () => {
      window.removeEventListener('keydown', aoTeclar);
      const indice = pilhaDeDialogos.indexOf(meuLugar);
      if (indice >= 0) pilhaDeDialogos.splice(indice, 1);
      // Devolver o foco importa mais no fim: sem isto ele fica no elemento que
      // acabou de sumir, e o navegador o joga para o início do documento.
      if (veioDe instanceof HTMLElement && document.contains(veioDe)) veioDe.focus();
    };
  }, [onClose]);

  // O DIÁLOGO SAI DA ÁRVORE DA PÁGINA E VAI PARA O `body`.
  //
  // `position: fixed` promete medir a VIEWPORT — e a promessa é quebrada por
  // qualquer ancestral com `transform`, `filter`, `perspective`, `contain` ou
  // `will-change`: o elemento vira bloco de contenção, e o "fixo" passa a
  // medir a caixa DELE.
  //
  // Medido na aplicação real, em 390x844: `.page` carrega
  // `transform: matrix(1,0,0,1,0,0)` — identidade, sem efeito visual nenhum, e
  // mesmo assim suficiente. A camada, declarada `fixed`, media 390x442 a
  // partir de y=60 em vez da viewport inteira. O diálogo ficava descentrado em
  // todo o desktop e parava de crescer em 418px de altura com o conteúdo
  // pedindo 909px — rolava no corpo com 400px de tela sobrando embaixo.
  //
  // Usar `vh`/`dvh` esconderia a altura, e foi o que a versão anterior fazia
  // sem saber. Não corrige a centralização, e volta a quebrar no dia em que
  // outro ancestral ganhar uma animação. O portal corrige a causa: no `body`
  // não há ancestral nenhum entre a camada e a viewport.
  return createPortal((
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      {/* O fundo fecha ao clique, mas fica FORA da ordem de tabulação: ele
          duplicaria o botão de fechar do cabeçalho e seria o primeiro alvo do
          Tab — pressionar Enter logo ao abrir descartaria o diálogo. */}
      <button type="button" className="modal-scrim" tabIndex={-1} aria-hidden="true" onClick={onClose} />
      <div className={`modal${wide ? ' modal-wide' : ''}${variante ? ` ${variante}` : ''}`} ref={caixa} tabIndex={-1}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('acao.fechar')}><X size={16} /></button>
        </div>
        {/* O CORPO É QUEM ROLA, E O DIÁLOGO NÃO.
            Antes o diálogo inteiro era o container de rolagem e o cabeçalho e o
            rodapé se seguravam com `position: sticky` mais margem negativa para
            cancelar o padding. Funcionava enquanto a altura do miolo fosse a
            prevista — e ela nunca é: muda com o idioma, com o zoom e com o
            conteúdo. Com o corpo isolado, a altura do miolo deixa de ser um
            número a adivinhar e passa a ser o que sobra. */}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  ), document.body);
}

// O RÓTULO PADRÃO NÃO PODE SER LITERAL NO PARÂMETRO: valor padrão é avaliado
// fora de qualquer contexto e ficaria em português mesmo com a tela em inglês.
// `null` significa "use o padrão traduzido".
export function ModalActions({ onClose, saving, confirmLabel = null, disabled = false }) {
  const { t } = useIdioma();

  return (
    <div className="modal-actions">
      <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
      <button type="submit" className="button button-primary" disabled={saving || disabled}>
        {saving && <Loader2 size={14} className="spin" />} {confirmLabel ?? t('acao.salvar')}
      </button>
    </div>
  );
}

export function Avatar({ name, mediaPath, size = '' }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!mediaPath) return undefined;
    let atual = null;
    let cancelado = false;

    fetchMediaObjectUrl(mediaPath)
      .then(url => {
        if (cancelado) { releaseMediaObjectUrl(url); return; }
        atual = url;
        setSrc(url);
      })
      // Avatar indisponível não é erro de tela: cai nas iniciais.
      .catch(() => setSrc(null));

    return () => { cancelado = true; releaseMediaObjectUrl(atual); };
  }, [mediaPath]);

  return (
    <span className={`avatar ${size}`.trim()}>
      {src ? <img src={src} alt={name || ''} /> : iniciais(name)}
    </span>
  );
}

// Mídia protegida: buscada com o token e exibida como object URL. Vale para
// imagem e vídeo de publicação, story e mensagem.
export function ProtectedMedia({ path, kind = 'IMAGE', alt = '', width = null, height = null }) {
  const { t } = useIdioma();
  const [src, setSrc] = useState(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let atual = null;
    let cancelado = false;
    setSrc(null);
    setErro(false);

    fetchMediaObjectUrl(path)
      .then(url => {
        if (cancelado) { releaseMediaObjectUrl(url); return; }
        atual = url;
        setSrc(url);
      })
      .catch(() => { if (!cancelado) setErro(true); });

    return () => { cancelado = true; releaseMediaObjectUrl(atual); };
  }, [path]);

  // A proporção conhecida reserva o espaço ANTES de a imagem chegar: sem ela,
  // o texto abaixo pula quando a foto carrega. Vale tanto para o esqueleto de
  // carregamento quanto para a própria imagem.
  const proporcao = width && height ? { aspectRatio: `${width} / ${height}` } : null;

  if (erro) return <div className="empty" style={{ padding: 20 }}><p>{t('ui.midiaIndisponivel')}</p></div>;
  if (!src) {
    return (
      <div className="skeleton" style={{ padding: 8 }}>
        <i style={proporcao ? { ...proporcao, height: 'auto', width: '100%' } : { height: 180 }} />
      </div>
    );
  }
  if (kind === 'VIDEO') return <video src={src} controls preload="metadata" style={proporcao || undefined} />;
  return <img src={src} alt={alt} loading="lazy" width={width || undefined} height={height || undefined} style={proporcao || undefined} />;
}

// Visualização ampliada de imagem.
//
// Diálogo de verdade, não uma div com fundo escuro: o foco entra ao abrir,
// volta para quem abriu ao fechar, ESC fecha e o Tab não escapa para a página
// atrás. Sem isso, quem navega por teclado abre a foto e continua tabulando
// por uma tela que não está mais vendo.
export function Lightbox({ path, kind = 'IMAGE', alt = '', onClose }) {
  const { t } = useIdioma();
  const caixa = useRef(null);
  const anterior = useRef(null);

  useEffect(() => {
    anterior.current = document.activeElement;
    caixa.current?.focus();

    const aoTeclar = evento => {
      if (evento.key === 'Escape') { onClose(); return; }
      if (evento.key !== 'Tab') return;
      const focaveis = caixa.current?.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
      if (!focaveis?.length) { evento.preventDefault(); return; }
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (evento.shiftKey && document.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    };

    document.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('keydown', aoTeclar);
      anterior.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="lightbox" role="presentation" onClick={onClose}>
      <div
        className="lightbox-caixa"
        ref={caixa}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={alt || t('ui.imagemAmpliada')}
        onClick={evento => evento.stopPropagation()}
      >
        <button type="button" className="icon-button lightbox-fechar" onClick={onClose} aria-label={t('ui.fecharImagem')}>
          <X size={18} />
        </button>
        <ProtectedMedia path={path} kind={kind} alt={alt} />
      </div>
    </div>
  );
}

export function Toasts({ toasts, onDismiss }) {
  const { t } = useIdioma();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast${toast.tipo === 'erro' ? ' is-erro' : ''}`}>
          {toast.tipo === 'erro' ? <AlertTriangle size={15} /> : toast.tipo === 'info' ? <Info size={15} /> : <Check size={15} />}
          <span style={{ flex: 1 }}>{toast.mensagem}</span>
          <button type="button" className="button button-ghost button-sm" onClick={() => onDismiss(toast.id)} aria-label={t('ui.dispensar')}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Confirmação explícita para ação destrutiva. Substitui window.confirm, que não
// é estilizável nem acessível de forma consistente.
export function ConfirmDialog({ title, message, confirmLabel = null, onConfirm, onClose }) {
  const { t } = useIdioma();
  const [enviando, setEnviando] = useState(false);

  const confirmar = async () => {
    setEnviando(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <p style={{ color: 'var(--cinza)', fontSize: 13, margin: 0 }}>{message}</p>
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>{t('acao.cancelar')}</button>
        <button type="button" className="button button-danger" onClick={confirmar} disabled={enviando}>
          {confirmLabel ?? t('acao.confirmar')}
        </button>
      </div>
    </Modal>
  );
}

export function Paginacao({ nextCursor, onMore, loading }) {
  const { t } = useIdioma();

  if (!nextCursor) return null;

  return (
    <div className="pagination">
      <button type="button" className="button button-secondary" onClick={onMore} disabled={loading}>
        {t(loading ? 'estado.carregando' : 'ui.carregarMais')}
      </button>
    </div>
  );
}


// Desenha o QR da credencial a partir do código que o sistema já guarda. Não
// inventa conteúdo: o campo é rotulado "Conteúdo do QR Code impresso" e existe
// rota de leitura (POST /events/:id/credentials/scan).
//
// O SVG é montado como elementos React a partir da matriz de módulos, e não
// por injeção de HTML: assim o valor da credencial nunca vira marcação, e o
// componente não abre superfície de XSS mesmo que o código venha adulterado.
// A biblioteca entra sob demanda, fora do caminho da primeira pintura.
export function CodigoQr({ valor, tamanho = 148, legenda = false }) {
  const { t } = useIdioma();
  const [matriz, setMatriz] = useState(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    if (!valor) return undefined;
    let cancelado = false;
    setMatriz(null);
    setFalhou(false);

    import('qrcode-generator')
      .then(({ default: gerar }) => {
        if (cancelado) return;
        // Correção de erro média: a credencial é lida em ginásio, com o crachá
        // amassado e a luz ruim.
        const codigo = gerar(0, 'M');
        codigo.addData(String(valor));
        codigo.make();
        const lado = codigo.getModuleCount();
        const escuros = [];
        for (let linha = 0; linha < lado; linha += 1) {
          for (let coluna = 0; coluna < lado; coluna += 1) {
            if (codigo.isDark(linha, coluna)) escuros.push([coluna, linha]);
          }
        }
        setMatriz({ lado, escuros });
      })
      .catch(() => { if (!cancelado) setFalhou(true); });

    return () => { cancelado = true; };
  }, [valor]);

  if (!valor) return null;
  if (falhou) return <p className="muted">{t('ui.qrFalhou')}</p>;
  if (!matriz) return <div className="qr-carregando" style={{ width: tamanho, height: tamanho }} aria-hidden="true" />;

  const margem = 2;
  const total = matriz.lado + margem * 2;

  return (
    <figure className="qr" style={{ width: tamanho }}>
      <svg className="qr-tela" viewBox={`0 0 ${total} ${total}`} role="img" aria-label={t('ui.qrDaCredencial', { valor })}>
        <rect x="0" y="0" width={total} height={total} fill="#ffffff" />
        {matriz.escuros.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x + margem} y={y + margem} width="1" height="1" fill="#000000" />
        ))}
      </svg>
      {legenda && <figcaption>{valor}</figcaption>}
    </figure>
  );
}
