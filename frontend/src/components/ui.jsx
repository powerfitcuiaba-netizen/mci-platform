import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
import { iniciais } from '../lib/format';
import { fetchMediaObjectUrl, releaseMediaObjectUrl } from '../services/api';

// Blocos de interface compartilhados. Tudo aqui é apresentação: nenhuma
// decisão de autorização ou de regra de negócio mora neste arquivo.

// A marca oficial. O arquivo vive em public/ e é servido pela raiz; enquanto
// ele não existir, a interface cai na sigla, que é o comportamento antigo.
// Assim quem tem o arquivo só precisa soltá-lo em frontend/public/ — nada de
// código muda, e nada quebra se ele faltar.
const CAMINHO_DA_MARCA = '/marca-mci.png';

// A ausência do arquivo é lembrada uma vez por sessão. Sem isto, cada troca de
// tela pede a imagem de novo e leva a mesma falha — barulho no console e uma
// requisição inútil por navegação.
let marcaIndisponivel = false;

export function MarcaMci({ tamanho = 34, titulo = 'Muscle Contest International' }) {
  const [temArquivo, setTemArquivo] = useState(!marcaIndisponivel);

  if (!temArquivo) return <span className="brand-mark" aria-hidden="true">M</span>;

  return (
    <img
      className="brand-logo"
      src={CAMINHO_DA_MARCA}
      alt={titulo}
      width={tamanho}
      height={tamanho}
      onError={() => { marcaIndisponivel = true; setTemArquivo(false); }}
    />
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

export function Metric({ label, value, hint, destaque = false }) {
  return (
    <div className={`metric${destaque ? ' destaque' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export const Skeleton = ({ linhas = 4 }) => (
  <div className="skeleton" aria-busy="true" aria-label="Carregando">
    {Array.from({ length: linhas }, (_, indice) => <i key={indice} />)}
  </div>
);

export function ErrorState({ message, onRetry }) {
  return (
    <div className="alert alert-erro" role="alert">
      <AlertTriangle size={17} />
      <div style={{ flex: 1 }}>
        <strong>Não foi possível carregar</strong>
        <p>{message}</p>
      </div>
      {onRetry && <button type="button" className="button button-secondary button-sm" onClick={onRetry}>Tentar de novo</button>}
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
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.data === null || state.data === undefined) return <Skeleton linhas={linhas} />;
  if (empty && empty(state.data)) return <EmptyState title="Nada por aqui ainda" description="Quando houver registro, ele aparece nesta tela." />;
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

export function Modal({ title, description, wide = false, onClose, children }) {
  useEffect(() => {
    const aoTeclar = evento => { if (evento.key === 'Escape') onClose(); };
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onClose]);

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="modal-scrim" aria-label="Fechar" onClick={onClose} />
      <div className={`modal${wide ? ' modal-wide' : ''}`}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const ModalActions = ({ onClose, saving, confirmLabel = 'Salvar', disabled = false }) => (
  <div className="modal-actions">
    <button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button>
    <button type="submit" className="button button-primary" disabled={saving || disabled}>
      {saving && <Loader2 size={14} className="spin" />} {confirmLabel}
    </button>
  </div>
);

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
export function ProtectedMedia({ path, kind = 'IMAGE', alt = '' }) {
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

  if (erro) return <div className="empty" style={{ padding: 20 }}><p>Mídia indisponível.</p></div>;
  if (!src) return <div className="skeleton" style={{ padding: 8 }}><i style={{ height: 180 }} /></div>;
  if (kind === 'VIDEO') return <video src={src} controls preload="metadata" />;
  return <img src={src} alt={alt} loading="lazy" />;
}

export function Toasts({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(toast => (
        <div key={toast.id} className={`toast${toast.tipo === 'erro' ? ' is-erro' : ''}`}>
          {toast.tipo === 'erro' ? <AlertTriangle size={15} /> : toast.tipo === 'info' ? <Info size={15} /> : <Check size={15} />}
          <span style={{ flex: 1 }}>{toast.mensagem}</span>
          <button type="button" className="button button-ghost button-sm" onClick={() => onDismiss(toast.id)} aria-label="Dispensar">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Confirmação explícita para ação destrutiva. Substitui window.confirm, que não
// é estilizável nem acessível de forma consistente.
export function ConfirmDialog({ title, message, confirmLabel = 'Confirmar', onConfirm, onClose }) {
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
        <button type="button" className="button button-secondary" onClick={onClose}>Cancelar</button>
        <button type="button" className="button button-danger" onClick={confirmar} disabled={enviando}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

export const Paginacao = ({ nextCursor, onMore, loading }) => (
  nextCursor
    ? (
      <div className="pagination">
        <button type="button" className="button button-secondary" onClick={onMore} disabled={loading}>
          {loading ? 'Carregando…' : 'Carregar mais'}
        </button>
      </div>
    )
    : null
);


// Desenha o QR da credencial a partir do código que o sistema já guarda. Não
// inventa conteúdo: o campo é rotulado "Conteúdo do QR Code impresso" e existe
// rota de leitura (POST /events/:id/credentials/scan).
//
// O SVG é montado como elementos React a partir da matriz de módulos, e não
// por injeção de HTML: assim o valor da credencial nunca vira marcação, e o
// componente não abre superfície de XSS mesmo que o código venha adulterado.
// A biblioteca entra sob demanda, fora do caminho da primeira pintura.
export function CodigoQr({ valor, tamanho = 148, legenda = false }) {
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
  if (falhou) return <p className="muted">Não foi possível desenhar o QR. O código continua legível ao lado.</p>;
  if (!matriz) return <div className="qr-carregando" style={{ width: tamanho, height: tamanho }} aria-hidden="true" />;

  const margem = 2;
  const total = matriz.lado + margem * 2;

  return (
    <figure className="qr" style={{ width: tamanho }}>
      <svg className="qr-tela" viewBox={`0 0 ${total} ${total}`} role="img" aria-label={`QR da credencial ${valor}`}>
        <rect x="0" y="0" width={total} height={total} fill="#ffffff" />
        {matriz.escuros.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x + margem} y={y + margem} width="1" height="1" fill="#000000" />
        ))}
      </svg>
      {legenda && <figcaption>{valor}</figcaption>}
    </figure>
  );
}
