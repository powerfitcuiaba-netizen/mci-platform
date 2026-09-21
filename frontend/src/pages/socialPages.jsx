import { useEffect, useRef, useState } from 'react';
import {
  Bookmark, Heart, Image as ImageIcon, MessageCircle, MoreHorizontal, Send, Share2, Trash2, UserMinus, UserPlus
} from 'lucide-react';
import api, { refreshData } from '../services/api';
import { useFetch } from '../lib/hooks';
import { AsyncSection, Avatar, Badge, EmptyState, Lightbox, Modal, ModalActions, PageHead, Paginacao, ProtectedMedia, Field } from '../components/ui';
import { anunciar, MCIEvento } from '../lib/experiencia';
import { caminhoDoAvatar, desde, ESTADO_PRO, formatarData, tipoDePerfil } from '../lib/format';
import { useIdioma } from '../lib/idioma';

// MCI Social. Toda interação chama a API: não existe contador local que não
// tenha sido confirmado pelo servidor.

function Stories({ notificar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.social.stories(), []);
  const [aberto, setAberto] = useState(null);
  const inputRef = useRef(null);
  const [enviando, setEnviando] = useState(false);

  const publicar = async evento => {
    const arquivo = evento.target.files?.[0];
    evento.target.value = '';
    if (!arquivo) return;

    setEnviando(true);
    try {
      await api.social.createStory(arquivo, {});
      notificar(t('social.storyPublicado'));
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const abrir = async grupo => {
    setAberto(grupo);
    // Marcar como visto é efeito colateral da abertura: falhar aqui não pode
    // impedir a visualização.
    for (const item of grupo.items) {
      await api.social.viewStory(item.id).catch(() => null);
    }
    estado.reload();
  };

  return (
    <>
      <div className="stories">
        <button type="button" className="story-bubble" onClick={() => inputRef.current?.click()} disabled={enviando}>
          <span className="story-ring is-seen"><span className="avatar"><ImageIcon size={18} /></span></span>
          <small>{t(enviando ? 'social.enviando' : 'social.seuStory')}</small>
        </button>
        <input ref={inputRef} type="file" accept="image/*,video/*" hidden onChange={publicar} aria-label={t('social.publicarStory')} />

        {(estado.data?.items || []).map(grupo => {
          const todosVistos = grupo.items.every(item => item.seen);
          return (
            <button key={grupo.profile.id} type="button" className="story-bubble" onClick={() => abrir(grupo)}>
              <span className={`story-ring${todosVistos ? ' is-seen' : ''}`}>
                <Avatar name={grupo.profile.displayName} mediaPath={caminhoDoAvatar(grupo.profile)} />
              </span>
              <small>{grupo.profile.handle}</small>
            </button>
          );
        })}
      </div>

      {aberto && (
        <Modal title={aberto.profile.displayName} description={`@${aberto.profile.handle}`} onClose={() => setAberto(null)}>
          <div style={{ display: 'grid', gap: 10 }}>
            {aberto.items.map(item => (
              <figure key={item.id} style={{ margin: 0 }}>
                <ProtectedMedia path={`/media/stories/${item.id}`} kind={item.kind} alt={item.caption || t('social.story')} />
                {item.caption && <figcaption style={{ fontSize: 12.5, color: 'var(--cinza)', marginTop: 6 }}>{item.caption}</figcaption>}
                <small style={{ color: 'var(--cinza-fraco)', fontSize: 11 }}>
                  {t('social.expira', { quando: desde(item.expiresAt) })}
                </small>
              </figure>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

function Composer({ notificar, onPublicado }) {
  const { t } = useIdioma();
  const [conteudo, setConteudo] = useState('');
  const [visibilidade, setVisibilidade] = useState('PUBLIC');
  const [arquivo, setArquivo] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const inputRef = useRef(null);

  // Prévia do que vai ser publicado. O nome do arquivo não diz se a pessoa
  // escolheu a foto certa; a miniatura diz.
  useEffect(() => {
    if (!arquivo) { setPrevia(null); return undefined; }
    const url = URL.createObjectURL(arquivo);
    setPrevia(url);
    return () => URL.revokeObjectURL(url);
  }, [arquivo]);

  const publicar = async evento => {
    evento.preventDefault();
    if (!conteudo.trim()) return;

    setEnviando(true);
    try {
      const post = await api.social.createPost({ content: conteudo.trim(), visibility: visibilidade });
      // A mídia só é enviada depois de a publicação existir e ser do autor:
      // o arquivo nunca chega ao storage sem dono.
      if (arquivo) await api.social.attachMedia(post.id, arquivo);

      setConteudo('');
      setArquivo(null);
      notificar(t('social.publicacaoCriadaAviso'));
      // Nível EVENTO: confirma sem tomar o centro da tela. Publicar é coisa
      // que se faz muitas vezes; interromper a cada vez cansaria.
      anunciar(MCIEvento.SUCESSO, {
        titulo: t('social.publicacaoCriada'), descricao: t('social.jaNoPerfil')
      });
      onPublicado();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="composer" onSubmit={publicar}>
      <textarea
        value={conteudo}
        onChange={evento => setConteudo(evento.target.value)}
        placeholder={t('social.compartilhePlaceholder')}
        maxLength={5000}
        aria-label={t('social.conteudoDaPublicacao')}
      />
      <div className="composer-foot">
        <button type="button" className="button button-secondary button-sm" onClick={() => inputRef.current?.click()}>
          <ImageIcon size={14} /> {t('social.midia')}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={evento => setArquivo(evento.target.files?.[0] || null)}
          aria-label={t('social.anexarMidia')}
        />
        {arquivo && (
          <span className="composer-preview">
            <span className="composer-miniatura">
              {arquivo.type.startsWith('video/')
                ? <video src={previa} muted playsInline />
                : <img src={previa} alt={t('social.previaDe', { nome: arquivo.name })} />}
              <button
                type="button" onClick={() => setArquivo(null)}
                aria-label={t('social.removerArquivo', { nome: arquivo.name })}
              >
                <Trash2 size={13} />
              </button>
            </span>
          </span>
        )}
        <select className="select-control" value={visibilidade} onChange={evento => setVisibilidade(evento.target.value)} aria-label={t('social.visibilidade')}>
          <option value="PUBLIC">{t('social.publica')}</option>
          <option value="FOLLOWERS">{t('social.seguidores')}</option>
          <option value="PRIVATE">{t('social.somenteEu')}</option>
        </select>
        <button type="submit" className="button button-primary" disabled={enviando || !conteudo.trim()}>
          {t(enviando ? 'social.publicando' : 'social.publicar')}
        </button>
      </div>
    </form>
  );
}

function Comentarios({ postId, notificar, onMudou }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.social.comments(postId, { limit: 20 }), [postId]);
  const [texto, setTexto] = useState('');
  const [respondendo, setRespondendo] = useState(null);
  const [enviando, setEnviando] = useState(false);

  const enviar = async evento => {
    evento.preventDefault();
    if (!texto.trim()) return;

    setEnviando(true);
    try {
      await api.social.comment(postId, { content: texto.trim(), parentId: respondendo?.id });
      setTexto('');
      setRespondendo(null);
      estado.reload();
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const apagar = async comentario => {
    try {
      await api.social.deleteComment(comentario.id);
      estado.reload();
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="post-comments">
      <AsyncSection state={estado} linhas={2}>
        {dados => dados.items.map(comentario => (
          <div className={`comment${comentario.parentId ? ' is-reply' : ''}`} key={comentario.id}>
            <Avatar name={comentario.author.displayName} mediaPath={caminhoDoAvatar(comentario.author)} size="avatar-sm" />
            <div className="bubble">
              <strong>@{comentario.author.handle}</strong>
              {comentario.content}
              <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                <button type="button" className="button button-ghost button-sm" onClick={() => setRespondendo(comentario)}>{t('social.responder')}</button>
                {comentario.isMine && (
                  <button type="button" className="button button-ghost button-sm" onClick={() => apagar(comentario)}>{t('social.apagar')}</button>
                )}
                <small style={{ color: 'var(--cinza-fraco)', alignSelf: 'center' }}>{desde(comentario.createdAt)}</small>
              </div>
            </div>
          </div>
        ))}
      </AsyncSection>

      <form className="comment-form" onSubmit={enviar}>
        <input
          value={texto}
          onChange={evento => setTexto(evento.target.value)}
          placeholder={respondendo
            ? t('social.respondendoA', { handle: respondendo.author.handle })
            : t('social.comentarPlaceholder')}
          aria-label={t('social.comentario')}
          maxLength={2000}
        />
        {respondendo && <button type="button" className="button button-secondary button-sm" onClick={() => setRespondendo(null)}>×</button>}
        <button type="submit" className="button button-primary button-sm" disabled={enviando || !texto.trim()}><Send size={13} /></button>
      </form>
    </div>
  );
}

export function Post({ post, notificar, onMudou, navegar }) {
  const { t } = useIdioma();
  const [aberto, setAberto] = useState(false);
  const [estado, setEstado] = useState(post);
  const [ocupado, setOcupado] = useState(false);
  const [ampliada, setAmpliada] = useState(null);

  useEffect(() => setEstado(post), [post]);

  // Toda interação confirma no servidor antes de mudar a tela: contador que
  // sobe sozinho e depois volta é pior do que meio segundo de espera.
  const alternar = async acao => {
    setOcupado(true);
    try {
      await acao();
      const atualizado = await api.social.getPost(estado.id);
      setEstado(atualizado);
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setOcupado(false);
    }
  };

  const compartilhar = async () => {
    setOcupado(true);
    try {
      await api.social.share(estado.id, {});
      const atualizado = await api.social.getPost(estado.id);
      setEstado(atualizado);
      notificar(t('social.compartilhadaAviso'));
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setOcupado(false);
    }
  };

  const apagar = async () => {
    try {
      await api.social.deletePost(estado.id);
      notificar(t('social.removidaAviso'));
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  const denunciar = async () => {
    const motivo = window.prompt(t('social.motivoDaDenuncia'));
    if (!motivo?.trim()) return;
    try {
      await api.social.report({ targetType: 'POST', targetId: estado.id, reason: motivo.trim() });
      notificar(t('social.denunciaRegistrada'));
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <article className="post">
      <header className="post-head">
        <Avatar name={estado.author.displayName} mediaPath={caminhoDoAvatar(estado.author)} />
        <div className="info">
          <strong>{estado.author.displayName}</strong>
          <small>
            <button type="button" className="button button-ghost button-sm link-inline" onClick={() => navegar(`perfil/${estado.author.handle}`)}>
              @{estado.author.handle}
            </button>
            {' · '}{desde(estado.createdAt)}
            {estado.visibility !== 'PUBLIC'
              && ` · ${t(estado.visibility === 'FOLLOWERS' ? 'social.visibilidadeSeguidores' : 'social.visibilidadePrivado')}`}
          </small>
        </div>
        {estado.isMine
          ? (
            <button type="button" className="icon-button" onClick={apagar} aria-label={t('social.apagarPublicacao')}>
              <Trash2 size={15} />
            </button>
          )
          : (
            <button type="button" className="icon-button" onClick={denunciar} aria-label={t('social.denunciarPublicacao')}>
              <MoreHorizontal size={15} />
            </button>
          )}
      </header>

      <div className="post-body">{estado.content}</div>

      {estado.media?.length > 0 && (
        <div className="post-media">
          {estado.media.map(item => (
            <button
              key={item.id}
              type="button"
              className="midia-ampliavel"
              onClick={() => setAmpliada({ path: `/media/posts/${item.id}`, kind: item.kind })}
              aria-label={t('messenger.abrirMidia')}
            >
              <ProtectedMedia
                path={`/media/posts/${item.id}`} kind={item.kind}
                alt={t('social.midiaDaPublicacao')} width={item.width} height={item.height}
              />
            </button>
          ))}
        </div>
      )}

      {ampliada && (
        <Lightbox path={ampliada.path} kind={ampliada.kind} alt={t('social.midiaDaPublicacao')} onClose={() => setAmpliada(null)} />
      )}

      {/*
        Os quatro botões abaixo são ícone + contagem. Sem aria-label o nome
        acessível de cada um é só o número — um leitor de tela anuncia
        "0, botão" e a pessoa não sabe se aquilo curte, comenta ou salva.
        aria-pressed marca os que alternam; aria-expanded, o que abre a lista
        de comentários.
      */}
      <footer className="post-actions">
        <button
          type="button"
          className={`post-action${estado.likedByMe ? ' is-on' : ''}`}
          disabled={ocupado}
          aria-label={t(estado.likedByMe ? 'social.descurtirRotulo' : 'social.curtirRotulo', { n: estado.counts.likes })}
          aria-pressed={estado.likedByMe}
          onClick={() => alternar(() => (estado.likedByMe ? api.social.unlike(estado.id) : api.social.like(estado.id)))}
        >
          <Heart size={15} fill={estado.likedByMe ? 'currentColor' : 'none'} /> {estado.counts.likes}
        </button>
        <button
          type="button"
          className="post-action"
          aria-label={t(aberto ? 'social.fecharComentarios' : 'social.abrirComentarios', { n: estado.counts.comments })}
          aria-expanded={aberto}
          onClick={() => setAberto(atual => !atual)}
        >
          <MessageCircle size={15} /> {estado.counts.comments}
        </button>
        <button
          type="button"
          className="post-action"
          aria-label={t('social.compartilharRotulo', { n: estado.counts.shares })}
          onClick={compartilhar}
          disabled={ocupado}
        >
          <Share2 size={15} /> {estado.counts.shares}
        </button>
        <button
          type="button"
          className={`post-action${estado.savedByMe ? ' is-on-save' : ''}`}
          disabled={ocupado}
          aria-label={t(estado.savedByMe ? 'social.removerDosSalvosRotulo' : 'social.salvarRotulo', { n: estado.counts.saves })}
          aria-pressed={estado.savedByMe}
          onClick={() => alternar(() => (estado.savedByMe ? api.social.unsave(estado.id) : api.social.save(estado.id)))}
          style={{ marginLeft: 'auto' }}
        >
          <Bookmark size={15} fill={estado.savedByMe ? 'currentColor' : 'none'} /> {estado.counts.saves}
        </button>
      </footer>

      {aberto && <Comentarios postId={estado.id} notificar={notificar} onMudou={() => api.social.getPost(estado.id).then(setEstado).catch(() => null)} />}
    </article>
  );
}

export function Feed({ notificar, navegar }) {
  const { t } = useIdioma();
  const [escopo, setEscopo] = useState('FOLLOWING');
  const [pagina, setPagina] = useState({ items: [], nextCursor: null });
  const [carregandoMais, setCarregandoMais] = useState(false);

  const estado = useFetch(async () => {
    const resposta = await api.social.feed({ scope: escopo, limit: 10 });
    setPagina(resposta);
    return resposta;
  }, [escopo]);

  const carregarMais = async () => {
    setCarregandoMais(true);
    try {
      const resposta = await api.social.feed({ scope: escopo, limit: 10, cursor: pagina.nextCursor });
      setPagina(atual => ({ items: [...atual.items, ...resposta.items], nextCursor: resposta.nextCursor }));
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setCarregandoMais(false);
    }
  };

  const comunidades = useFetch(() => api.communities.list({ limit: 8 }), []);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('social.mciSocial')}
        title={t('social.feed')}
        description={t('social.feedDescricao')}
      />

      <div className="grid grid-social">
        <div>
          <Stories notificar={notificar} />

          <div className="chips" style={{ marginBottom: 14 }}>
            <button type="button" className={`chip${escopo === 'FOLLOWING' ? ' is-on' : ''}`} onClick={() => setEscopo('FOLLOWING')}>{t('social.seguindo')}</button>
            <button type="button" className={`chip${escopo === 'DISCOVER' ? ' is-on' : ''}`} onClick={() => setEscopo('DISCOVER')}>{t('social.descobrir')}</button>
          </div>

          <Composer notificar={notificar} onPublicado={() => estado.reload()} />

          <AsyncSection state={estado} linhas={3}>
            {() => (pagina.items.length
              ? (
                <>
                  {pagina.items.map(post => (
                    <Post key={post.id} post={post} notificar={notificar} navegar={navegar} onMudou={() => estado.reload()} />
                  ))}
                  <Paginacao nextCursor={pagina.nextCursor} onMore={carregarMais} loading={carregandoMais} />
                </>
              )
              : (
                <EmptyState
                  title={t(escopo === 'FOLLOWING' ? 'social.feedVazio' : 'social.semPublicasAinda')}
                  description={t(escopo === 'FOLLOWING' ? 'social.feedVazioDescricao' : 'social.publiqueAlgo')}
                  action={escopo === 'FOLLOWING' && (
                    <button type="button" className="button button-secondary" onClick={() => setEscopo('DISCOVER')}>
                      {t('social.descobrirPerfis')}
                    </button>
                  )}
                />
              )
            )}
          </AsyncSection>
        </div>

        <aside>
          <section className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-head"><h2>{t('social.comunidades')}</h2></div>
            <AsyncSection state={comunidades} linhas={3}>
              {dados => dados.items.map(comunidade => (
                <button
                  key={comunidade.id}
                  type="button"
                  className="list-row"
                  style={{ width: '100%', background: 'transparent', border: 0, borderBottom: '1px solid var(--linha)', textAlign: 'left' }}
                  onClick={() => navegar(`comunidades/${comunidade.slug}`)}
                >
                  <span className="info">
                    <strong>{comunidade.name}</strong>
                    <small>
                      {t('social.membrosEPublicacoes', {
                        membros: comunidade._count.members, publicacoes: comunidade._count.posts
                      })}
                    </small>
                  </span>
                  {comunidade.isMember && <Badge tom="ok">{t('social.membro')}</Badge>}
                </button>
              ))}
            </AsyncSection>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function Perfil({ handle, notificar, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.social.profile(handle), [handle]);
  const [pagina, setPagina] = useState({ items: [], nextCursor: null });

  const posts = useFetch(async () => {
    if (!estado.data?.canViewContent || !estado.data?.profile?.id) return { items: [], nextCursor: null };
    const resposta = await api.social.feed({ scope: 'PROFILE', profileId: estado.data.profile.id, limit: 10 });
    setPagina(resposta);
    return resposta;
  }, [estado.data?.profile?.id, estado.data?.canViewContent], { ativo: Boolean(estado.data?.profile?.id) });

  const alternarSeguir = async () => {
    try {
      if (estado.data.isFollowing) await api.social.unfollow(handle);
      else await api.social.follow(handle);
      estado.reload();
      refreshData();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  const bloquear = async () => {
    try {
      await api.social.block(handle);
      notificar(t('social.perfilBloqueado'));
      navegar('social');
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <AsyncSection state={estado} linhas={4}>
        {dados => {
          const { profile, isFollowing, canViewContent, titles } = dados;
          return (
            <>
              <section className="hero" style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                <Avatar name={profile.displayName} mediaPath={caminhoDoAvatar(profile)} size="avatar-lg" />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <span className="eyebrow">{tipoDePerfil(profile.kind).rotulo}</span>
                  <h1 style={{ marginTop: 6 }}>{profile.displayName}</h1>
                  <p style={{ margin: '4px 0 0' }}>@{profile.handle}</p>
                  {profile.bio && <p style={{ marginTop: 8 }}>{profile.bio}</p>}
                  <div className="hero-meta">
                    <span><strong>{profile.counts.posts}</strong> {t('social.publicacoes')}</span>
                    <span><strong>{profile.counts.followers}</strong> {t('social.seguidoresContagem')}</span>
                    <span><strong>{profile.counts.following}</strong> {t('social.seguindoContagem')}</span>
                    {profile.athlete && <Badge tom={ESTADO_PRO[profile.athlete.proStatus].tom}>{ESTADO_PRO[profile.athlete.proStatus].rotulo}</Badge>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className={`button ${isFollowing ? 'button-secondary' : 'button-primary'}`} onClick={alternarSeguir}>
                    {isFollowing
                      ? <><UserMinus size={14} /> {t('social.deixarDeSeguir')}</>
                      : <><UserPlus size={14} /> {t('social.seguir')}</>}
                  </button>
                  <button type="button" className="button button-secondary" onClick={bloquear}>{t('social.bloquear')}</button>
                </div>
              </section>

              {profile.athlete && (
                <div className="grid grid-4" style={{ marginTop: 18 }}>
                  <div className="metric"><span>{t('social.titulos')}</span><strong>{titles.filter(item => item.placing === 1).length}</strong></div>
                  <div className="metric"><span>{t('social.podios')}</span><strong>{titles.length}</strong></div>
                  <div className="metric">
                    <span>{t('social.equipe')}</span>
                    <strong style={{ fontSize: 18 }}>{profile.athlete.team?.name || '—'}</strong>
                  </div>
                  <div className="metric">
                    <span>{t('social.academia')}</span>
                    <strong style={{ fontSize: 18 }}>{profile.athlete.gym?.name || '—'}</strong>
                  </div>
                </div>
              )}

              {titles.length > 0 && (
                <section className="panel" style={{ marginTop: 18 }}>
                  <div className="panel-head"><h2>{t('social.podios')}</h2></div>
                  {titles.map((item, indice) => (
                    <div className="list-row" key={`${item.event.id}-${indice}`}>
                      <span className={`placing placing-${item.placing}`}>{item.placing}</span>
                      <span className="info">
                        <strong>{item.event.name}</strong>
                        <small>{formatarData(item.publishedAt)}</small>
                      </span>
                      <button type="button" className="button button-ghost button-sm" onClick={() => navegar(`campeonatos/${item.event.slug}`)}>{t('social.verEtapa')}</button>
                    </div>
                  ))}
                </section>
              )}

              <div style={{ marginTop: 18 }}>
                {canViewContent
                  ? (
                    <AsyncSection state={posts} linhas={3}>
                      {() => (pagina.items.length
                        ? pagina.items.map(post => <Post key={post.id} post={post} notificar={notificar} navegar={navegar} onMudou={() => posts.reload()} />)
                        : <EmptyState title={t('social.semPublicacoes')} description={t('social.semPublicacoesDescricao')} />
                      )}
                    </AsyncSection>
                  )
                  : <EmptyState title={t('social.perfilPrivado')} description={t('social.perfilPrivadoDescricao')} />}
              </div>
            </>
          );
        }}
      </AsyncSection>
    </div>
  );
}

export function Comunidades({ navegar, notificar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.communities.list({ limit: 40 }), []);

  const entrar = async comunidade => {
    try {
      await api.communities.join(comunidade.slug);
      notificar(t('social.entrouEm', { nome: comunidade.name }));
      estado.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('social.mciCommunity')}
        title={t('social.comunidades')}
        description={t('social.comunidadesDescricao')}
      />

      <AsyncSection state={estado} linhas={4}>
        {dados => (dados.items.length
          ? (
            <div className="grid grid-3">
              {dados.items.map(comunidade => (
                <section className="panel" key={comunidade.id}>
                  <div className="panel-head">
                    <h2>{comunidade.name}</h2>
                    {comunidade.visibility === 'PRIVATE' && <Badge tom="alerta">{t('social.privada')}</Badge>}
                  </div>
                  <p style={{ color: 'var(--cinza)', fontSize: 12.5, margin: '0 0 12px', minHeight: 34 }}>{comunidade.description || t('social.semDescricao')}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--cinza-fraco)' }}>
                    <span>{t('social.membros', { n: comunidade._count.members })}</span>
                    <span>·</span>
                    <span>{t('social.publicacoesContagem', { n: comunidade._count.posts })}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                    <button type="button" className="button button-secondary button-sm" onClick={() => navegar(`comunidades/${comunidade.slug}`)}>{t('social.abrir')}</button>
                    {!comunidade.isMember && comunidade.visibility === 'PUBLIC' && (
                      <button type="button" className="button button-primary button-sm" onClick={() => entrar(comunidade)}>{t('social.entrar')}</button>
                    )}
                    {comunidade.isMember && <Badge tom="ok">{t('social.membro')}</Badge>}
                  </div>
                </section>
              ))}
            </div>
          )
          : <EmptyState title={t('social.nenhumaComunidade')} />
        )}
      </AsyncSection>
    </div>
  );
}

export function ComunidadeDetalhe({ slug, notificar, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.communities.findBySlug(slug), [slug]);
  const membros = useFetch(() => api.communities.members(slug, { limit: 20 }), [slug]);
  const [pagina, setPagina] = useState({ items: [], nextCursor: null });
  const [conteudo, setConteudo] = useState('');
  const [enviando, setEnviando] = useState(false);

  const posts = useFetch(async () => {
    if (!estado.data?.community?.id) return { items: [], nextCursor: null };
    const resposta = await api.social.feed({ scope: 'COMMUNITY', communityId: estado.data.community.id, limit: 10 });
    setPagina(resposta);
    return resposta;
  }, [estado.data?.community?.id], { ativo: Boolean(estado.data?.community?.id) });

  const publicar = async evento => {
    evento.preventDefault();
    if (!conteudo.trim()) return;
    setEnviando(true);
    try {
      await api.social.createPost({ content: conteudo.trim(), communityId: estado.data.community.id });
      setConteudo('');
      posts.reload();
      notificar(t('social.publicadoNaComunidade'));
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setEnviando(false);
    }
  };

  const alternarMembro = async () => {
    try {
      if (estado.data.isMember) await api.communities.leave(slug);
      else await api.communities.join(slug);
      estado.reload();
      membros.reload();
    } catch (erro) {
      notificar(erro.message, 'erro');
    }
  };

  return (
    <div className="page">
      <button type="button" className="button button-ghost button-sm" onClick={() => navegar('comunidades')} style={{ marginBottom: 14 }}>{t('social.voltarParaComunidades')}</button>

      <AsyncSection state={estado} linhas={3}>
        {dados => (
          <>
            <section className="hero">
              <span className="eyebrow">{t('social.mciCommunity')}</span>
              <h1>{dados.community.name}</h1>
              {dados.community.description && <p>{dados.community.description}</p>}
              <div className="hero-meta">
                <span>{t('social.membros', { n: dados.community._count.members })}</span>
                <span>{t('social.publicacoesContagem', { n: dados.community._count.posts })}</span>
                <button type="button" className={`button button-sm ${dados.isMember ? 'button-secondary' : 'button-primary'}`} onClick={alternarMembro}>
                  {t(dados.isMember ? 'social.sair' : 'social.entrar')}
                </button>
              </div>
            </section>

            {dados.community.rules && (
              <div className="alert alert-info" style={{ marginTop: 16 }}>
                <div><strong>{t('social.regras')}</strong><p>{dados.community.rules}</p></div>
              </div>
            )}

            <div className="grid grid-social" style={{ marginTop: 18 }}>
              <div>
                {dados.isMember && (
                  <form className="composer" onSubmit={publicar}>
                    <textarea value={conteudo} onChange={evento => setConteudo(evento.target.value)} placeholder={t('social.publicarEm', { nome: dados.community.name })} aria-label={t('social.publicacaoNaComunidade')} />
                    <div className="composer-foot">
                      <button type="submit" className="button button-primary" disabled={enviando || !conteudo.trim()}>
                        {t('social.publicar')}
                      </button>
                    </div>
                  </form>
                )}

                <AsyncSection state={posts} linhas={3}>
                  {() => (pagina.items.length
                    ? pagina.items.map(post => <Post key={post.id} post={post} notificar={notificar} navegar={navegar} onMudou={() => posts.reload()} />)
                    : (
                      <EmptyState
                        title={t('social.semPublicacoes')}
                        description={t(dados.isMember ? 'social.sejaOPrimeiro' : 'social.entreParaParticipar')}
                      />
                    )
                  )}
                </AsyncSection>
              </div>

              <aside className="panel">
                <div className="panel-head"><h2>{t('social.membrosTitulo')}</h2></div>
                <AsyncSection state={membros} linhas={3}>
                  {lista => lista.items.map(membro => (
                    <div className="list-row" key={membro.id}>
                      <Avatar name={membro.displayName} mediaPath={caminhoDoAvatar(membro)} size="avatar-sm" />
                      <span className="info">
                        <strong>{membro.displayName}</strong>
                        <small>@{membro.handle}</small>
                      </span>
                      {membro.role === 'ADMIN' && <Badge tom="info">{t('social.admin')}</Badge>}
                    </div>
                  ))}
                </AsyncSection>
              </aside>
            </div>
          </>
        )}
      </AsyncSection>
    </div>
  );
}

export function Salvos({ notificar, navegar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.social.saved({ limit: 20 }), []);

  return (
    <div className="page">
      <PageHead eyebrow={t('social.mciSocial')} title={t('social.salvos')} description={t('social.salvosDescricao')} />
      <AsyncSection state={estado} linhas={3}>
        {dados => (dados.items.length
          ? dados.items.map(post => <Post key={post.id} post={post} notificar={notificar} navegar={navegar} onMudou={() => estado.reload()} />)
          : <EmptyState title={t('social.nadaSalvo')} description={t('social.nadaSalvoDescricao')} />
        )}
      </AsyncSection>
    </div>
  );
}

export function Notificacoes() {
  const { t } = useIdioma();
  const estado = useFetch(() => api.notifications.list({ limit: 60 }), []);

  const marcarTodas = async () => {
    await api.notifications.markAllRead();
    estado.reload();
    refreshData();
  };

  return (
    <div className="page">
      <PageHead
        eyebrow={t('social.central')}
        title={t('social.notificacoes')}
        description={t('social.notificacoesDescricao')}
        actions={(
          <button type="button" className="button button-secondary" onClick={marcarTodas}>
            {t('social.marcarTodas')}
          </button>
        )}
      />

      <section className="panel">
        <AsyncSection state={estado} linhas={5}>
          {dados => (dados.items.length
            ? dados.items.map(item => (
              <div className="list-row" key={item.id} style={{ opacity: item.isRead ? .62 : 1 }}>
                <span className="avatar avatar-sm" style={{ background: item.isRead ? 'var(--superficie-2)' : 'var(--vermelho-fundo)', color: item.isRead ? 'var(--cinza)' : 'var(--vermelho-claro)' }}>
                  {item.type.slice(0, 1)}
                </span>
                <span className="info">
                  <strong>{item.title}</strong>
                  <small>{item.message} · {desde(item.createdAt)}</small>
                </span>
                {!item.isRead && (
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    onClick={async () => { await api.notifications.markRead(item.id); estado.reload(); refreshData(); }}
                  >
                    {t('social.marcarLida')}
                  </button>
                )}
              </div>
            ))
            : <EmptyState title={t('social.nenhumaNotificacao')} description={t('social.nenhumaNotificacaoDescricao')} />
          )}
        </AsyncSection>
      </section>
    </div>
  );
}

export function MeuPerfilSocial({ notificar }) {
  const { t } = useIdioma();
  const estado = useFetch(() => api.social.me(), []);
  const [editando, setEditando] = useState(false);

  return (
    <div className="page">
      <PageHead
        eyebrow={t('social.mciSocial')}
        title={t('social.meuPerfilSocial')}
        description={t('social.meuPerfilDescricao')}
      />

      <AsyncSection state={estado} linhas={3}>
        {perfil => (
          <section className="panel" style={{ maxWidth: 560 }}>
            <FotoDePerfil perfil={perfil} notificar={notificar} onMudou={() => { estado.reload(); refreshData(); }} />
            <p style={{ color: 'var(--cinza)', fontSize: 13 }}>{perfil.bio || t('social.semBio')}</p>
            <button type="button" className="button button-secondary" onClick={() => setEditando(true)}>
              {t('social.editarPerfil')}
            </button>

            {editando && (
              <EditarPerfilSocial
                perfil={perfil}
                notificar={notificar}
                onClose={() => setEditando(false)}
                onSalvo={() => { setEditando(false); estado.reload(); }}
              />
            )}
          </section>
        )}
      </AsyncSection>
    </div>
  );
}

// Foto de perfil: escolher, ver a prévia, salvar ou cancelar — e remover.
//
// A conferência de tipo e tamanho aqui é CONVENIÊNCIA, para o usuário saber na
// hora em vez de esperar o envio. Ela não é barreira: quem decide é o
// servidor, que confere os BYTES do arquivo e não o rótulo. O frontend nunca é
// autoridade neste projeto.
const TIPOS_DE_FOTO = ['image/png', 'image/jpeg', 'image/webp'];
const LIMITE_DA_FOTO = 5 * 1024 * 1024;

function FotoDePerfil({ perfil, notificar, onMudou }) {
  const { t } = useIdioma();
  const [arquivo, setArquivo] = useState(null);
  const [previa, setPrevia] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!arquivo) { setPrevia(null); return undefined; }
    const url = URL.createObjectURL(arquivo);
    setPrevia(url);
    return () => URL.revokeObjectURL(url);
  }, [arquivo]);

  const escolher = evento => {
    const escolhido = evento.target.files?.[0] || null;
    // Limpar o input permite escolher DE NOVO o mesmo arquivo depois de
    // cancelar; sem isto, o `change` não dispara na segunda vez.
    evento.target.value = '';
    if (!escolhido) return;
    if (!TIPOS_DE_FOTO.includes(escolhido.type)) {
      notificar(t('social.formatoNaoAceito'), 'erro');
      return;
    }
    if (escolhido.size > LIMITE_DA_FOTO) {
      notificar(t('social.fotoGrandeDemais'), 'erro');
      return;
    }
    setArquivo(escolhido);
  };

  const salvar = async () => {
    setOcupado(true);
    try {
      await api.social.setAvatar(arquivo);
      setArquivo(null);
      notificar(t('social.fotoAtualizada'));
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setOcupado(false);
    }
  };

  const remover = async () => {
    setOcupado(true);
    try {
      await api.social.removeAvatar();
      notificar(t('social.fotoRemovida'));
      onMudou();
    } catch (erro) {
      notificar(erro.message, 'erro');
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
      {previa
        ? <span className="avatar avatar-lg"><img src={previa} alt={t('social.previaDaNovaFoto')} /></span>
        : <Avatar name={perfil.displayName} mediaPath={caminhoDoAvatar(perfil)} size="avatar-lg" />}

      <div style={{ flex: 1, minWidth: 200 }}>
        <strong style={{ display: 'block', fontSize: 17 }}>{perfil.displayName}</strong>
        <small style={{ color: 'var(--cinza-fraco)' }}>@{perfil.handle}</small>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {arquivo ? (
            <>
              <button type="button" className="button button-primary button-sm" onClick={salvar} disabled={ocupado}>
                {t(ocupado ? 'social.salvando' : 'social.salvarFoto')}
              </button>
              <button type="button" className="button button-ghost button-sm" onClick={() => setArquivo(null)} disabled={ocupado}>
                {t('acao.cancelar')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="button button-secondary button-sm" onClick={() => inputRef.current?.click()} disabled={ocupado}>
                <ImageIcon size={14} /> {t(perfil.hasAvatar ? 'social.trocarFoto' : 'social.adicionarFoto')}
              </button>
              {perfil.hasAvatar && (
                <button type="button" className="button button-ghost button-sm" onClick={remover} disabled={ocupado}>
                  {t('social.removerFoto')}
                </button>
              )}
            </>
          )}
        </div>

        {/* `accept` sem `capture`: no celular o seletor do sistema já oferece a
            câmera junto da galeria. Forçar `capture` tiraria a galeria em
            parte dos navegadores — ganharíamos a câmera e perderíamos a foto
            que a pessoa já tem. */}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={escolher}
          aria-label={t('social.escolherFoto')}
        />
      </div>
    </div>
  );
}

function EditarPerfilSocial({ perfil, notificar, onClose, onSalvo }) {
  const { t } = useIdioma();
  const [form, setForm] = useState({ displayName: perfil.displayName, bio: perfil.bio || '', handle: perfil.handle, isPrivate: perfil.isPrivate });
  const [salvando, setSalvando] = useState(false);

  const salvar = async evento => {
    evento.preventDefault();
    setSalvando(true);
    try {
      await api.social.updateProfile({ displayName: form.displayName, bio: form.bio || null, isPrivate: form.isPrivate });
      if (form.handle !== perfil.handle) await api.social.setHandle(form.handle);
      notificar(t('social.perfilAtualizado'));
      onSalvo();
    } catch (erro) {
      notificar(erro.message, 'erro');
      setSalvando(false);
    }
  };

  return (
    <Modal title={t('social.editarPerfilSocial')} onClose={onClose}>
      <form onSubmit={salvar}>
        <Field label={t('social.nomeDeExibicao')} required>
          <input value={form.displayName} onChange={evento => setForm({ ...form, displayName: evento.target.value })} required minLength={2} maxLength={80} />
        </Field>
        <Field label={t('social.identificador')} required hint={t('social.identificadorHint')}>
          <input value={form.handle} onChange={evento => setForm({ ...form, handle: evento.target.value.toLowerCase() })} required pattern="[a-z0-9_.]{3,30}" />
        </Field>
        <Field label={t('social.bio')}>
          <textarea value={form.bio} onChange={evento => setForm({ ...form, bio: evento.target.value })} maxLength={500} />
        </Field>
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={form.isPrivate} onChange={evento => setForm({ ...form, isPrivate: evento.target.checked })} />
          <span style={{ margin: 0 }}>{t('social.perfilPrivadoOpcao')}</span>
        </label>
        <ModalActions onClose={onClose} saving={salvando} />
      </form>
    </Modal>
  );
}
