import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, unico, comoAtor } from './helpers.mjs';

// MCI Social e MCI Messenger: feed real, interações persistidas e privacidade
// aplicada no servidor.

let ana;
let bruno;
let carla;

const handle = async usuario => (await prisma.socialProfile.findUnique({ where: { userId: usuario.id } })).handle;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
  bruno = await criarUsuario({ name: 'Bruno' });
  carla = await criarUsuario({ name: 'Carla' });
});

describe('perfil e feed', () => {
  it('cria perfil social junto com a conta', async () => {
    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    expect(perfil.status).toBe(200);
    expect(perfil.body.handle).toBeTruthy();
    expect(perfil.body.displayName).toBe('Ana');
  });

  it('feed de quem sigo traz publicações reais e paginadas por cursor', async () => {
    await api().post(`/api/v1/social/profiles/${await handle(bruno)}/follow`).set(ana.auth());

    for (let i = 1; i <= 3; i += 1) {
      const post = await api().post('/api/v1/social/posts').set(bruno.auth()).send({ content: `Treino ${i}` });
      expect(post.status).toBe(201);
    }

    const primeira = await api().get('/api/v1/social/feed').set(ana.auth()).query({ scope: 'FOLLOWING', limit: 2 });
    expect(primeira.status).toBe(200);
    expect(primeira.body.items).toHaveLength(2);
    expect(primeira.body.items[0].content).toBe('Treino 3');
    expect(primeira.body.nextCursor).toBeTruthy();

    const segunda = await api().get('/api/v1/social/feed').set(ana.auth())
      .query({ scope: 'FOLLOWING', limit: 2, cursor: primeira.body.nextCursor });
    expect(segunda.body.items).toHaveLength(1);
    expect(segunda.body.items[0].content).toBe('Treino 1');
  });

  it('o autor vê a própria publicação no feed de quem segue', async () => {
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Meu treino' });
    const feed = await api().get('/api/v1/social/feed').set(ana.auth()).query({ scope: 'FOLLOWING' });
    expect(feed.body.items.map(item => item.content)).toContain('Meu treino');
  });

  it('curtida, comentário, compartilhamento e salvamento persistem e contam uma vez só', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Pose de frente' });

    await api().post(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth());
    const repetida = await api().post(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth());
    expect(repetida.body.alreadyLiked).toBe(true);

    const comentario = await api().post(`/api/v1/social/posts/${post.body.id}/comments`).set(bruno.auth())
      .send({ content: 'Condição excelente' });
    expect(comentario.status).toBe(201);

    const resposta = await api().post(`/api/v1/social/posts/${post.body.id}/comments`).set(carla.auth())
      .send({ content: 'Concordo', parentId: comentario.body.id });
    expect(resposta.status).toBe(201);
    expect(resposta.body.parentId).toBe(comentario.body.id);

    await api().post(`/api/v1/social/posts/${post.body.id}/share`).set(carla.auth()).send({ comment: 'Olhem isso' });
    await api().post(`/api/v1/social/posts/${post.body.id}/save`).set(carla.auth());

    const visto = await api().get(`/api/v1/social/posts/${post.body.id}`).set(carla.auth());
    expect(visto.body.counts).toEqual({ likes: 1, comments: 2, shares: 1, saves: 1 });
    expect(visto.body.savedByMe).toBe(true);

    const salvos = await api().get('/api/v1/social/saved').set(carla.auth());
    expect(salvos.body.items).toHaveLength(1);

    // Descurtir devolve a contagem, sem ficar negativa em chamada repetida.
    await api().delete(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth());
    await api().delete(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth());
    const depois = await api().get(`/api/v1/social/posts/${post.body.id}`).set(bruno.auth());
    expect(depois.body.counts.likes).toBe(0);
  });

  it('notifica curtida, comentário e novo seguidor', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Off season' });
    await api().post(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth());
    await api().post(`/api/v1/social/posts/${post.body.id}/comments`).set(bruno.auth()).send({ content: 'Boa' });
    await api().post(`/api/v1/social/profiles/${await handle(ana)}/follow`).set(bruno.auth());

    const notificacoes = await api().get('/api/v1/notifications').set(ana.auth());
    const tipos = notificacoes.body.items.map(item => item.type);

    expect(tipos).toContain('POST_LIKE');
    expect(tipos).toContain('POST_COMMENT');
    expect(tipos).toContain('NEW_FOLLOWER');
    expect(notificacoes.body.unreadCount).toBeGreaterThanOrEqual(3);
  });
});

describe('visibilidade das publicações', () => {
  it('publicação privada não aparece para terceiro, nem por id direto', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Anotação pessoal', visibility: 'PRIVATE' });

    const direto = await api().get(`/api/v1/social/posts/${post.body.id}`).set(bruno.auth());
    // 404, não 403: confirmar a existência já seria vazamento.
    expect(direto.status).toBe(404);

    const anonimo = await api().get(`/api/v1/social/posts/${post.body.id}`);
    expect(anonimo.status).toBe(404);

    const proprio = await api().get(`/api/v1/social/posts/${post.body.id}`).set(ana.auth());
    expect(proprio.status).toBe(200);
  });

  it('publicação para seguidores só é vista por quem segue', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Só para seguidores', visibility: 'FOLLOWERS' });

    expect((await api().get(`/api/v1/social/posts/${post.body.id}`).set(bruno.auth())).status).toBe(404);

    await api().post(`/api/v1/social/profiles/${await handle(ana)}/follow`).set(bruno.auth());
    expect((await api().get(`/api/v1/social/posts/${post.body.id}`).set(bruno.auth())).status).toBe(200);
  });

  it('terceiro não curte, não comenta e não apaga publicação restrita', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Restrito', visibility: 'PRIVATE' });

    expect((await api().post(`/api/v1/social/posts/${post.body.id}/like`).set(bruno.auth())).status).toBe(404);
    expect((await api().post(`/api/v1/social/posts/${post.body.id}/comments`).set(bruno.auth()).send({ content: 'oi' })).status).toBe(404);
    expect((await api().delete(`/api/v1/social/posts/${post.body.id}`).set(bruno.auth())).status).toBe(404);
  });

  it('publicação restrita não pode ser compartilhada por terceiro', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Seguidores apenas', visibility: 'FOLLOWERS' });
    await api().post(`/api/v1/social/profiles/${await handle(ana)}/follow`).set(bruno.auth());

    const compartilhamento = await api().post(`/api/v1/social/posts/${post.body.id}/share`).set(bruno.auth()).send({});
    expect(compartilhamento.status).toBe(422);
    expect(compartilhamento.body.error.code).toBe('POST_NOT_SHAREABLE');
  });

  it('busca pública não devolve publicação restrita', async () => {
    await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'segredo-do-bastidor', visibility: 'PRIVATE' });
    const busca = await api().get('/api/v1/search').query({ q: 'segredo-do-bastidor', types: 'posts' });
    expect(busca.body.results.posts).toHaveLength(0);
  });
});

describe('bloqueio', () => {
  it('bloqueio esconde o conteúdo nos dois sentidos e desfaz o vínculo', async () => {
    await api().post(`/api/v1/social/profiles/${await handle(bruno)}/follow`).set(ana.auth());
    await api().post(`/api/v1/social/profiles/${await handle(ana)}/follow`).set(bruno.auth());

    await api().post('/api/v1/social/posts').set(bruno.auth()).send({ content: 'Publicação do Bruno' });

    await api().post(`/api/v1/social/profiles/${await handle(bruno)}/block`).set(ana.auth());

    // Seguir dos dois lados foi desfeito.
    expect(await prisma.follow.count()).toBe(0);

    const feed = await api().get('/api/v1/social/feed').set(ana.auth()).query({ scope: 'DISCOVER' });
    expect(feed.body.items.map(item => item.content)).not.toContain('Publicação do Bruno');

    const perfil = await api().get(`/api/v1/social/profiles/${await handle(bruno)}`).set(ana.auth());
    expect(perfil.status).toBe(404);

    // O bloqueado também não volta a seguir.
    const tentativa = await api().post(`/api/v1/social/profiles/${await handle(ana)}/follow`).set(bruno.auth());
    expect(tentativa.status).toBe(403);
  });
});

describe('messenger', () => {
  it('conversa individual não se duplica entre as mesmas pessoas', async () => {
    const primeira = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
    expect(primeira.status).toBe(201);

    const segunda = await api().post('/api/v1/messenger/conversations').set(bruno.auth())
      .send({ kind: 'DIRECT', participantIds: [ana.profileId] });

    expect(segunda.body.id).toBe(primeira.body.id);
    expect(await comoAtor(ana, tx => tx.conversation.count())).toBe(1);
  });

  it('troca mensagens, marca lidas e conta não lidas', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    const enviada = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth())
      .send({ body: 'Bora treinar?' });
    expect(enviada.status).toBe(201);
    expect(enviada.body.isMine).toBe(true);

    // Antes de responder, a mensagem da Ana conta como não lida para o Bruno.
    const antesDeResponder = await api().get('/api/v1/messenger/conversations').set(bruno.auth());
    expect(antesDeResponder.body.totalUnread).toBe(1);

    const resposta = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(bruno.auth())
      .send({ body: 'Bora', replyToId: enviada.body.id });
    expect(resposta.body.replyTo.body).toBe('Bora treinar?');

    // Quem envia leu o que já estava na conversa: o contador zera sozinho.
    const depoisDeResponder = await api().get('/api/v1/messenger/conversations').set(bruno.auth());
    expect(depoisDeResponder.body.totalUnread).toBe(0);

    // E a resposta do Bruno passa a contar como não lida para a Ana.
    const listaAna = await api().get('/api/v1/messenger/conversations').set(ana.auth());
    expect(listaAna.body.totalUnread).toBe(1);

    await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/read`).set(ana.auth());
    expect((await api().get('/api/v1/messenger/conversations').set(ana.auth())).body.totalUnread).toBe(0);

    const mensagens = await api().get(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(bruno.auth());
    expect(mensagens.body.items.map(item => item.body)).toEqual(['Bora treinar?', 'Bora']);
  });

  it('terceiro não lê, não escreve e não sabe que a conversa existe', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
    await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth()).send({ body: 'Assunto privado' });

    // 404 para terceiro: nem o conteúdo, nem a existência.
    expect((await api().get(`/api/v1/messenger/conversations/${conversa.body.id}`).set(carla.auth())).status).toBe(404);
    expect((await api().get(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(carla.auth())).status).toBe(404);
    expect((await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(carla.auth()).send({ body: 'oi' })).status).toBe(404);
    expect((await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/read`).set(carla.auth())).status).toBe(404);

    const listaCarla = await api().get('/api/v1/messenger/conversations').set(carla.auth());
    expect(listaCarla.body.items).toHaveLength(0);
  });

  it('terceiro não reage nem apaga mensagem alheia', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });
    const mensagem = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth()).send({ body: 'Privado' });

    expect((await api().post(`/api/v1/messenger/messages/${mensagem.body.id}/reactions`).set(carla.auth()).send({ emoji: '🔥' })).status).toBe(404);
    expect((await api().delete(`/api/v1/messenger/messages/${mensagem.body.id}`).set(carla.auth())).status).toBe(404);

    // Participante apaga a própria mensagem; o conteúdo some da leitura.
    expect((await api().delete(`/api/v1/messenger/messages/${mensagem.body.id}`).set(ana.auth())).status).toBe(200);
    const mensagens = await api().get(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(bruno.auth());
    expect(mensagens.body.items[0].deleted).toBe(true);
    expect(mensagens.body.items[0].body).toBeNull();
  });

  it('grupo aceita novos participantes apenas por administrador', async () => {
    const grupo = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'GROUP', title: 'Equipe Wellness', participantIds: [bruno.profileId] });
    expect(grupo.status).toBe(201);

    const porMembro = await api().post(`/api/v1/messenger/conversations/${grupo.body.id}/members`).set(bruno.auth())
      .send({ participantIds: [carla.profileId] });
    expect(porMembro.status).toBe(403);

    const porAdmin = await api().post(`/api/v1/messenger/conversations/${grupo.body.id}/members`).set(ana.auth())
      .send({ participantIds: [carla.profileId] });
    expect(porAdmin.status).toBe(200);
    expect(porAdmin.body.members).toHaveLength(3);
  });

  it('bloqueio impede mensagem em conversa que já existia', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    await api().post(`/api/v1/social/profiles/${await handle(bruno)}/block`).set(ana.auth());

    const bloqueada = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth()).send({ body: 'oi' });
    expect(bloqueada.status).toBe(403);
  });

  it('recusa mensagem vazia', async () => {
    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    const vazia = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(ana.auth()).send({});
    expect(vazia.status).toBe(400);
  });
});

describe('moderação', () => {
  it('denúncia é registrada uma vez e resolvida por moderador, com remoção auditada', async () => {
    const moderador = await criarUsuario({ role: 'MODERATOR', name: 'Moderador' });
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Conteúdo denunciado' });

    const denuncia = await api().post('/api/v1/social/reports').set(bruno.auth())
      .send({ targetType: 'POST', targetId: post.body.id, reason: 'Conteúdo ofensivo' });
    expect(denuncia.status).toBe(201);

    const repetida = await api().post('/api/v1/social/reports').set(bruno.auth())
      .send({ targetType: 'POST', targetId: post.body.id, reason: 'De novo' });
    expect(repetida.status).toBe(409);

    // Quem não modera não vê a fila.
    expect((await api().get('/api/v1/social/reports').set(bruno.auth())).status).toBe(403);

    const fila = await api().get('/api/v1/social/reports').set(moderador.auth());
    expect(fila.body.items).toHaveLength(1);

    const resolucao = await api().post(`/api/v1/social/reports/${denuncia.body.id}/resolve`).set(moderador.auth())
      .send({ status: 'RESOLVED', resolution: 'Conteúdo removido', removeContent: true });
    expect(resolucao.status).toBe(200);

    expect((await api().get(`/api/v1/social/posts/${post.body.id}`).set(ana.auth())).status).toBe(404);

    // A auditoria é legível por administrador da plataforma ou operador da
    // organização. MODERATOR modera conteúdo mas não lê trilha: quem confere o
    // registro aqui é um administrador.
    const auditor = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditor' });
    const trilha = await comoAtor(auditor, tx => tx.auditLog.findMany({ where: { action: 'CONTENT_MODERATION' } }));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].userEmail).toBe(moderador.email);
  });
});

describe('comunidades', () => {
  it('comunidade pública aceita entrada e recebe publicações de membro', async () => {
    const entrada = await api().post('/api/v1/communities/wellness/join').set(ana.auth());
    expect(entrada.status).toBe(200);

    const post = await api().post('/api/v1/social/posts').set(ana.auth())
      .send({ content: 'Dica de Wellness', communityId: (await prisma.community.findUnique({ where: { slug: 'wellness' } })).id });
    expect(post.status).toBe(201);

    const naoMembro = await api().post('/api/v1/social/posts').set(bruno.auth())
      .send({ content: 'Invasão', communityId: (await prisma.community.findUnique({ where: { slug: 'wellness' } })).id });
    expect(naoMembro.status).toBe(403);
  });

  it('comunidade privada não é lida nem acessada por quem não é membro', async () => {
    const admin = await criarUsuario({ role: 'SOCIAL_ADMIN', name: 'Social Admin' });
    // Slug único: o catálogo de comunidades é semeado e não é apagado entre
    // testes, então reaproveitar um nome fixo colidiria entre execuções.
    const slug = unico('comissao');

    const privada = await api().post('/api/v1/communities').set(admin.auth())
      .send({ slug, name: 'Comissão Técnica', visibility: 'PRIVATE' });
    expect(privada.status, JSON.stringify(privada.body)).toBe(201);

    expect((await api().get(`/api/v1/communities/${slug}`).set(ana.auth())).status).toBe(404);
    expect((await api().post(`/api/v1/communities/${slug}/join`).set(ana.auth())).status).toBe(403);

    const lista = await api().get('/api/v1/communities').set(ana.auth());
    expect(lista.body.items.map(item => item.slug)).not.toContain(slug);
  });
});
