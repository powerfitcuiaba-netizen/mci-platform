import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
import { iniciais } from '../lib/format';
import { fetchMediaObjectUrl, releaseMediaObjectUrl } from '../services/api';

// Blocos de interface compartilhados. Tudo aqui é apresentação: nenhuma
// decisão de autorização ou de regra de negócio mora neste arquivo.

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

export const Badge = ({ tom = 'neutro', children }) => <span className={`badge badge-${tom}`}>{children}</span>;

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
export function AsyncSection({ state, empty, children, linhas = 4 }) {
  if (state.loading && !state.data) return <Skeleton linhas={linhas} />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
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
