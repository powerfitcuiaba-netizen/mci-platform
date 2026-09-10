import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ImagePlus, Plus, Send, Trash2 } from 'lucide-react';
import api from '../services/api';
import { useFetch } from '../lib/hooks';
import { Avatar, EmptyState, Field, Modal, ModalActions, ProtectedMedia, Skeleton } from '../components/ui';
import { desde, formatarHora } from '../lib/format';

// MCI Messenger. A privacidade é do servidor: aqui só se pede o que o usuário
// tem direito de ver, e a API responde 404 para conversa alheia.

const REACOES = ['👍', '🔥', '💪', '👏', '❤️'];

export default function Messenger({ notificar }) {
  const [selecionada, setSelecionada] = useState(null);
  const [novaConversa, setNovaConversa] = useState(false);

  const conversas = useFetch(() => api.messenger.conversations({ limit: 40 }), []);

  // Numa tela estreita, lista e conversa são telas distintas, como num app de
  // mensagens; no desktop, convivem lado a lado.
  const classe = `messenger ${selecionada ? 'mostra-chat' : 'mostra-lista'}`;

  return (
    <div className="page">
      <div className={classe}>
        <aside className="conversation-list">
          <header>
            <h2>Mensagens</h2>
            <button type="button" className="icon-button" onClick={() => setNovaConversa(true)} aria-label="Nova conversa"><Plus size={16} /></button>
          </header>

          {conversas.loading && !conversas.data && <div style={{ padding: 14 }}><Skeleton linhas={4} /></div>}
          {conversas.error && <div style={{ padding: 14, color: 'var(--vermelho-claro)', fontSize: 12.5 }}>{conversas.error}</div>}

          {(conversas.data?.items || []).map(conversa => (
            <button
              key={conversa.id}
              type="button"
              className={`conversation-item${selecionada === conversa.id ? ' is-active' : ''}`}
              onClick={() => setSelecionada(conversa.id)}
            >
              <Avatar name={conversa.title} />
              <span className="info">
                <strong>{conversa.title}</strong>
                <small>{conversa.lastMessageAt ? desde(conversa.lastMessageAt) : 'sem mensagens'}</small>
              </span>
              {conversa.unreadCount > 0 && <span className="unread">{conversa.unreadCount}</span>}
            </button>
          ))}

          {conversas.data && !conversas.data.items.length && (
            <div style={{ padding: 20 }}>
              <EmptyState
                title="Nenhuma conversa"
                description="Comece uma conversa com um atleta, coach ou marca."
                action={<button type="button" className="button button-primary button-sm" onClick={() => setNovaConversa(true)}>Nova conversa</button>}
              />
            </div>
          )}
        </aside>

        <section className="chat">
          {selecionada
            ? <Conversa key={selecionada} conversationId={selecionada} notificar={notificar} onVoltar={() => setSelecionada(null)} onMudou={() => conversas.reload()} />
            : <div className="chat-empty">Selecione uma conversa para começar.</div>}
        </section>
      </div>

      {novaConversa && (
        <NovaConversa
          notificar={notificar}
          onClose={() => setNovaConversa(false)}
          onCriada={id => { setNovaConversa(false); setSelecionada(id); conversas.reload(); }}
        />
      )}
    </div>
  );
}

function Conversa({ conversationId, notificar, onVoltar, onMudou }) {
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const fim = useRef(null);
  const inputArquivo = useRef(null);

  const conversa = useFetch(() => api.messenger.conversation(conversationId), [conversationId]);
  const mensagens = useFetch(() => api.messenger.messages(conversationId, { limit: 50 }), [conversationId]);

  // Abrir a conversa é ler: a marcação parte daqui e o contador da lista
  // acompanha.
  useEffect(() => {
    api.messenger.markRead(conversationId).then(onMudou).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, mensagens.data]);

  useEffect(() => {
    fim.current?.scrollIntoView({ block: 'end' });
  }, [mensagens.data]);

  const enviar = async evento => {
    evento.preventDefault();
    if (!texto.trim()) return;

    setEnviando(true);
    try {
      await api.messenger.send(conversationId, { body: texto.trim() });
      setTexto('');
      await mensagens.reload();
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const enviarMidia = async evento => {
    const arquivo = evento.target.files?.[0];
    evento.target.value = '';
    if (!arquivo) return;

    try {
      await api.messenger.sendMedia(conversationId, arquivo);
      await mensagens.reload();
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  const reagir = async (messageId, emoji) => {
    try {
      await api.messenger.react(messageId, { emoji });
      mensagens.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  const apagar = async messageId => {
    try {
      await api.messenger.deleteMessage(messageId);
      mensagens.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  if (conversa.error) return <div className="chat-empty">{conversa.error}</div>;

  return (
    <>
      <header className="chat-head">
        <button type="button" className="icon-button mobile-toggle" onClick={onVoltar} aria-label="Voltar"><ArrowLeft size={16} /></button>
        <Avatar name={conversa.data?.title} />
        <div className="info">
          <strong>{conversa.data?.title || 'Conversa'}</strong>
          <small>{conversa.data?.kind === 'GROUP' ? `${conversa.data.members.length} participantes` : 'Conversa individual'}</small>
        </div>
      </header>

      <div className="chat-body">
        {mensagens.loading && !mensagens.data && <Skeleton linhas={4} />}
        {(mensagens.data?.items || []).map(mensagem => (
          <div key={mensagem.id} className={`chat-msg${mensagem.isMine ? ' is-mine' : ''}${mensagem.deleted ? ' is-deleted' : ''}`}>
            {conversa.data?.kind === 'GROUP' && !mensagem.isMine && <span className="autor">{mensagem.sender.displayName}</span>}

            {mensagem.replyTo && <div className="quote">{mensagem.replyTo.body}</div>}

            {mensagem.deleted
              ? 'Mensagem apagada'
              : (
                <>
                  {mensagem.body}
                  {mensagem.storageKey && <ProtectedMedia path={`/messenger/messages/${mensagem.id}/media`} kind={mensagem.mediaKind} alt="Mídia da mensagem" />}
                  {mensagem.sharedPost && (
                    <div style={{ borderLeft: '2px solid var(--ciano)', paddingLeft: 8, marginTop: 6, fontSize: 12 }}>
                      <strong>@{mensagem.sharedPost.author.handle}</strong>
                      <div>{mensagem.sharedPost.content}</div>
                    </div>
                  )}
                </>
              )}

            {mensagem.reactions?.length > 0 && (
              <div className="reacoes">
                {mensagem.reactions.map((reacao, indice) => <span key={`${reacao.emoji}-${indice}`}>{reacao.emoji}</span>)}
              </div>
            )}

            {!mensagem.deleted && (
              <div style={{ display: 'flex', gap: 2, marginTop: 5, flexWrap: 'wrap' }}>
                {REACOES.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => reagir(mensagem.id, emoji)}
                    style={{ border: 0, background: 'transparent', fontSize: 13, padding: '1px 3px', opacity: .65 }}
                    aria-label={`Reagir com ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
                {mensagem.isMine && (
                  <button type="button" onClick={() => apagar(mensagem.id)} style={{ border: 0, background: 'transparent', color: 'var(--cinza-fraco)', padding: '1px 3px' }} aria-label="Apagar mensagem">
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            )}

            <span className="hora">{formatarHora(mensagem.createdAt)}</span>
          </div>
        ))}
        <div ref={fim} />
      </div>

      <form className="chat-foot" onSubmit={enviar}>
        <button type="button" className="icon-button" onClick={() => inputArquivo.current?.click()} aria-label="Enviar mídia"><ImagePlus size={16} /></button>
        <input ref={inputArquivo} type="file" accept="image/*,video/*" hidden onChange={enviarMidia} />
        <input type="text" value={texto} onChange={evento => setTexto(evento.target.value)} placeholder="Escreva uma mensagem…" aria-label="Mensagem" maxLength={4000} />
        <button type="submit" className="button button-primary" disabled={enviando || !texto.trim()}><Send size={15} /></button>
      </form>
    </>
  );
}

function NovaConversa({ notificar, onClose, onCriada }) {
  const [busca, setBusca] = useState('');
  const [selecionados, setSelecionados] = useState([]);
  const [titulo, setTitulo] = useState('');
  const [resultados, setResultados] = useState([]);
  const [criando, setCriando] = useState(false);

  const procurar = async evento => {
    evento.preventDefault();
    if (busca.trim().length < 2) return;
    try {
      const resposta = await api.search({ q: busca.trim(), types: 'profiles', limit: 12 });
      setResultados(resposta.results.profiles || []);
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  const alternar = perfil => {
    setSelecionados(atual => (atual.some(item => item.id === perfil.id)
      ? atual.filter(item => item.id !== perfil.id)
      : [...atual, perfil]));
  };

  const criar = async evento => {
    evento.preventDefault();
    if (!selecionados.length) return;

    setCriando(true);
    try {
      const kind = selecionados.length > 1 ? 'GROUP' : 'DIRECT';
      const conversa = await api.messenger.createConversation({
        kind,
        title: kind === 'GROUP' ? (titulo.trim() || 'Grupo') : undefined,
        participantIds: selecionados.map(item => item.id)
      });
      onCriada(conversa.id);
    } catch (erro) {
      notificar(erro.message, 'erro');
      setCriando(false);
    }
  };

  return (
    <Modal title="Nova conversa" description="Busque por identificador ou nome de exibição." onClose={onClose}>
      <form onSubmit={procurar} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input
          value={busca}
          onChange={evento => setBusca(evento.target.value)}
          placeholder="Buscar perfil…"
          aria-label="Buscar perfil"
          style={{ flex: 1, background: 'var(--preto)', border: '1px solid var(--linha)', borderRadius: 4, padding: '10px 11px' }}
        />
        <button type="submit" className="button button-secondary">Buscar</button>
      </form>

      {selecionados.length > 0 && (
        <div className="chips" style={{ marginBottom: 12 }}>
          {selecionados.map(perfil => (
            <button key={perfil.id} type="button" className="chip is-on" onClick={() => alternar(perfil)}>@{perfil.handle} ×</button>
          ))}
        </div>
      )}

      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {resultados.map(perfil => (
          <button
            key={perfil.id}
            type="button"
            className="list-row"
            style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left' }}
            onClick={() => alternar(perfil)}
          >
            <Avatar name={perfil.displayName} size="avatar-sm" />
            <span className="info">
              <strong>{perfil.displayName}</strong>
              <small>@{perfil.handle}</small>
            </span>
            {selecionados.some(item => item.id === perfil.id) && <span className="badge badge-ok">Selecionado</span>}
          </button>
        ))}
        {!resultados.length && <p style={{ color: 'var(--cinza-fraco)', fontSize: 12.5 }}>Busque um perfil para começar.</p>}
      </div>

      <form onSubmit={criar}>
        {selecionados.length > 1 && (
          <Field label="Nome do grupo" required>
            <input value={titulo} onChange={evento => setTitulo(evento.target.value)} required minLength={1} maxLength={90} placeholder="Ex: Equipe Wellness" />
          </Field>
        )}
        <ModalActions onClose={onClose} saving={criando} confirmLabel="Abrir conversa" disabled={!selecionados.length} />
      </form>
    </Modal>
  );
}
