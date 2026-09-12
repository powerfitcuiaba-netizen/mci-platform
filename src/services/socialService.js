const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');
const { profilePublic } = require('../utils/visibility');
const { can } = require('../utils/permissions');
const storage = require('./storageService');
const audit = require('./auditService');
const notifications = require('./notificationService');

// ============================================================================
// MCI SOCIAL — perfis, feed, publicações, mídia, interações e moderação.
//
// Duas regras atravessam tudo aqui:
//   1. Visibilidade é decidida no servidor, consultando seguidores e bloqueios.
//      A interface nunca é a autoridade sobre quem vê o quê.
//   2. Bloqueio é simétrico para conteúdo: quem bloqueou e quem foi bloqueado
//      deixam de se ver no feed e não interagem.
// ============================================================================

async function meuPerfil(userId) {
  const profile = await prisma.socialProfile.findUnique({ where: { userId } });
  if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil social não encontrado');
  return profile;
}

async function updateProfile(userId, data) {
  const profile = await meuPerfil(userId);
  const atualizado = await prisma.socialProfile.update({ where: { id: profile.id }, data });
  return profilePublic(atualizado);
}

async function setHandle(userId, handle) {
  const profile = await meuPerfil(userId);
  try {
    return profilePublic(await prisma.socialProfile.update({ where: { id: profile.id }, data: { handle } }));
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'HANDLE_IN_USE', 'Este identificador já está em uso');
    throw error;
  }
}

// Ids que o espectador não pode ver por bloqueio, nas duas direções.
async function bloqueadosDe(profileId) {
  if (!profileId) return new Set();
  const blocos = await prisma.block.findMany({
    where: { OR: [{ blockerId: profileId }, { blockedId: profileId }] },
    select: { blockerId: true, blockedId: true }
  });
  const ids = new Set();
  for (const bloco of blocos) {
    ids.add(bloco.blockerId === profileId ? bloco.blockedId : bloco.blockerId);
  }
  return ids;
}

async function seguidosPor(profileId) {
  if (!profileId) return [];
  const follows = await prisma.follow.findMany({ where: { followerId: profileId }, select: { followingId: true } });
  return follows.map(follow => follow.followingId);
}

// Cláusula de visibilidade aplicada em toda leitura de post.
// PUBLIC: qualquer um. FOLLOWERS: autor e quem o segue. PRIVATE: só o autor.
function clausulaVisibilidade(viewerProfileId, seguindo) {
  if (!viewerProfileId) return { visibility: 'PUBLIC' };
  return {
    OR: [
      { visibility: 'PUBLIC' },
      { authorId: viewerProfileId },
      { visibility: 'FOLLOWERS', authorId: { in: seguindo.length ? seguindo : ['__ninguem__'] } }
    ]
  };
}

async function profileByHandle(handle, viewer) {
  const profile = await prisma.socialProfile.findUnique({
    where: { handle },
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, proStatus: true, state: true, city: true, team: { select: { id: true, name: true } }, gym: { select: { id: true, name: true } } } },
      _count: { select: { posts: true, followers: true, following: true } }
    }
  });
  if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');

  const viewerProfile = viewer ? await prisma.socialProfile.findUnique({ where: { userId: viewer.id } }) : null;

  const bloqueados = await bloqueadosDe(viewerProfile?.id);
  if (bloqueados.has(profile.id)) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');

  const segueEste = viewerProfile
    ? Boolean(await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: viewerProfile.id, followingId: profile.id } } }))
    : false;

  // Perfil privado só mostra o conteúdo a quem segue (ou ao próprio dono).
  const podeVerConteudo = !profile.isPrivate || segueEste || viewerProfile?.id === profile.id;

  let titulos = [];
  if (profile.athleteId) {
    titulos = await prisma.resultEntry.findMany({
      where: { athleteId: profile.athleteId, result: { status: 'PUBLISHED' }, placing: { in: [1, 2, 3] } },
      include: { result: { select: { publishedAt: true, event: { select: { id: true, name: true, slug: true } } } } },
      orderBy: { result: { publishedAt: 'desc' } },
      take: 20
    });
  }

  return {
    profile: { ...profilePublic(profile), counts: profile._count, athlete: profile.athlete },
    isFollowing: segueEste,
    canViewContent: podeVerConteudo,
    titles: titulos.map(entry => ({ placing: entry.placing, event: entry.result.event, publishedAt: entry.result.publishedAt }))
  };
}

// ------------------------------------------------------------------ PUBLICAÇÕES
async function createPost(userId, data) {
  const profile = await meuPerfil(userId);

  if (data.communityId) {
    const membro = await prisma.communityMember.findUnique({
      where: { communityId_profileId: { communityId: data.communityId, profileId: profile.id } }
    });
    if (!membro) throw new AppError(403, 'NOT_A_MEMBER', 'Você não é membro desta comunidade');
  }
  if (data.eventId) {
    const evento = await prisma.event.findUnique({ where: { id: data.eventId } });
    if (!evento) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  }

  const post = await prisma.post.create({
    data: {
      authorId: profile.id,
      content: data.content,
      visibility: data.visibility || 'PUBLIC',
      eventId: data.eventId ?? null,
      communityId: data.communityId ?? null
    },
    include: { author: true, media: true }
  });

  return serializarPost(post, profile.id);
}

// Mídia entra por upload autenticado e só depois de o post existir e ser do
// autor: um arquivo nunca chega ao storage antes da autorização.
// ------------------------------------------------------------------ avatar
//
// `avatarKey` existia no modelo e era LIDO em todo lugar — no perfil, no autor
// da publicação, na lista de parceiros — mas nada no sistema escrevia. O campo
// nascia nulo e morria nulo, e a interface caía para sempre nas iniciais.
//
// A rota é sempre "a minha foto": não recebe id de perfil, e por isso não
// existe caminho para trocar a foto de outra pessoa. O perfil vem do token,
// nunca do corpo da requisição.
async function setAvatar(userId, arquivo) {
  const profile = await meuPerfil(userId);

  if (!storage.isAllowedAvatarMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Foto de perfil aceita apenas ${Object.keys(storage.ALLOWED_AVATAR).join(', ')}`);
  }

  const anterior = profile.avatarKey;
  const key = storage.buildKey(`avatars/${profile.id}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const atualizado = await prisma.socialProfile.update({
    where: { id: profile.id },
    data: { avatarKey: key }
  });

  // O arquivo antigo só é apagado DEPOIS de o banco já apontar para o novo: se
  // a ordem fosse inversa e a gravação falhasse, o perfil ficaria apontando
  // para um arquivo que não existe mais. Falhar ao apagar o antigo deixa um
  // órfão, que é muito melhor que uma foto quebrada.
  if (anterior && anterior !== key) {
    await storage.remove(anterior).catch(() => {});
  }

  await audit.record({
    actor: { id: userId }, action: 'PROFILE_AVATAR_SET', entity: 'SocialProfile', entityId: profile.id,
    metadata: { mimeType: arquivo.mimeType, sizeBytes: arquivo.buffer.length, substituiu: Boolean(anterior) }
  });

  return profilePublic(atualizado);
}

async function removeAvatar(userId) {
  const profile = await meuPerfil(userId);
  if (!profile.avatarKey) return profilePublic(profile);

  const atualizado = await prisma.socialProfile.update({
    where: { id: profile.id },
    data: { avatarKey: null }
  });
  await storage.remove(profile.avatarKey).catch(() => {});

  await audit.record({
    actor: { id: userId }, action: 'PROFILE_AVATAR_REMOVE', entity: 'SocialProfile', entityId: profile.id
  });

  return profilePublic(atualizado);
}

async function attachMedia(postId, userId, arquivo) {
  const profile = await meuPerfil(userId);
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post || post.deletedAt) throw new AppError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
  if (post.authorId !== profile.id) throw new AppError(403, 'FORBIDDEN', 'Publicação de outro autor');

  if (!storage.isAllowedMediaMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de mídia não aceito: ${arquivo.mimeType}`);
  }

  const kind = arquivo.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
  const key = storage.buildKey(`social/${profile.id}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const posicao = await prisma.postMedia.count({ where: { postId } });

  return prisma.postMedia.create({
    data: {
      postId, kind, storageKey: key, mimeType: arquivo.mimeType,
      sizeBytes: arquivo.buffer.length, position: posicao
    }
  });
}

function serializarPost(post, viewerProfileId) {
  if (!post) return null;
  return {
    id: post.id,
    content: post.content,
    visibility: post.visibility,
    createdAt: post.createdAt,
    eventId: post.eventId ?? null,
    communityId: post.communityId ?? null,
    author: profilePublic(post.author),
    media: (post.media || []).map(item => ({ id: item.id, kind: item.kind, storageKey: item.storageKey, mimeType: item.mimeType, position: item.position })),
    counts: { likes: post.likeCount, comments: post.commentCount, shares: post.shareCount, saves: post.saveCount },
    likedByMe: Boolean(post.likes?.length),
    savedByMe: Boolean(post.saves?.length),
    isMine: post.authorId === viewerProfileId
  };
}

/**
 * Feed real, paginado por cursor. Nunca carrega tudo: o escopo decide a
 * origem das publicações e a cláusula de visibilidade decide o que aparece.
 */
async function feed(userId, filtros) {
  const profile = userId ? await prisma.socialProfile.findUnique({ where: { userId } }) : null;
  const seguindo = await seguidosPor(profile?.id);
  const bloqueados = await bloqueadosDe(profile?.id);

  const where = {
    deletedAt: null,
    ...clausulaVisibilidade(profile?.id, seguindo)
  };

  if (bloqueados.size) where.authorId = { notIn: [...bloqueados] };

  if (filtros.scope === 'FOLLOWING') {
    if (!profile) throw new AppError(401, 'UNAUTHORIZED', 'Entre para ver o feed de quem você segue');
    // O próprio perfil entra no feed: sem isso o autor não vê o que publicou.
    where.authorId = { in: [...seguindo, profile.id].filter(id => !bloqueados.has(id)) };
  } else if (filtros.scope === 'EVENT') {
    if (!filtros.eventId) throw new AppError(422, 'EVENT_REQUIRED', 'Informe o evento');
    where.eventId = filtros.eventId;
  } else if (filtros.scope === 'COMMUNITY') {
    if (!filtros.communityId) throw new AppError(422, 'COMMUNITY_REQUIRED', 'Informe a comunidade');
    const comunidade = await prisma.community.findUnique({ where: { id: filtros.communityId } });
    if (!comunidade) throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');
    if (comunidade.visibility === 'PRIVATE') {
      if (!profile) throw new AppError(403, 'FORBIDDEN', 'Comunidade privada');
      const membro = await prisma.communityMember.findUnique({ where: { communityId_profileId: { communityId: comunidade.id, profileId: profile.id } } });
      if (!membro) throw new AppError(403, 'FORBIDDEN', 'Comunidade privada');
    }
    where.communityId = filtros.communityId;
  } else if (filtros.scope === 'PROFILE') {
    if (!filtros.profileId) throw new AppError(422, 'PROFILE_REQUIRED', 'Informe o perfil');
    if (bloqueados.has(filtros.profileId)) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
    where.authorId = filtros.profileId;
  }

  const posts = await prisma.post.findMany({
    where,
    include: {
      author: true,
      media: { orderBy: { position: 'asc' } },
      ...(profile ? {
        likes: { where: { profileId: profile.id }, select: { id: true } },
        saves: { where: { profileId: profile.id }, select: { id: true } }
      } : {})
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: posts.map(post => serializarPost(post, profile?.id)),
    nextCursor: posts.length === filtros.limit ? posts[posts.length - 1].id : null
  };
}

// Carrega um post conferindo visibilidade — usado por todas as interações.
async function postVisivel(postId, viewerProfileId) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { author: true, media: true } });
  if (!post || post.deletedAt) throw new AppError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');

  const bloqueados = await bloqueadosDe(viewerProfileId);
  if (bloqueados.has(post.authorId)) throw new AppError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');

  if (post.visibility === 'PUBLIC') return post;
  if (post.authorId === viewerProfileId) return post;

  if (post.visibility === 'FOLLOWERS' && viewerProfileId) {
    const segue = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: viewerProfileId, followingId: post.authorId } }
    });
    if (segue) return post;
  }

  // Post restrito responde 404, não 403: informar que existe já é vazamento.
  throw new AppError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');
}

async function getPost(postId, userId) {
  const profile = userId ? await prisma.socialProfile.findUnique({ where: { userId } }) : null;
  const post = await postVisivel(postId, profile?.id);

  const [curtido, salvo] = profile ? await Promise.all([
    prisma.postLike.findUnique({ where: { postId_profileId: { postId, profileId: profile.id } } }),
    prisma.postSave.findUnique({ where: { postId_profileId: { postId, profileId: profile.id } } })
  ]) : [null, null];

  return serializarPost({ ...post, likes: curtido ? [curtido] : [], saves: salvo ? [salvo] : [] }, profile?.id);
}

async function deletePost(postId, userId, actor) {
  const profile = await meuPerfil(userId);
  const podeModerar = can(actor, 'social.delete');

  // Quem não modera passa antes pela visibilidade: para um terceiro, uma
  // publicação restrita responde 404, e não 403 — negar por permissão
  // confirmaria que ela existe.
  const post = podeModerar
    ? await prisma.post.findUnique({ where: { id: postId } })
    : await postVisivel(postId, profile.id);

  if (!post || post.deletedAt) throw new AppError(404, 'POST_NOT_FOUND', 'Publicação não encontrada');

  const ehAutor = post.authorId === profile.id;
  if (!ehAutor && !podeModerar) throw new AppError(403, 'FORBIDDEN', 'Publicação de outro autor');

  // Remoção lógica: comentários, denúncias e trilha continuam consultáveis
  // para moderação.
  await prisma.post.update({ where: { id: postId }, data: { deletedAt: new Date() } });

  if (!ehAutor) {
    await audit.record({ actor, action: audit.ACTIONS.CONTENT_MODERATION, entity: 'Post', entityId: postId, metadata: { removedBy: 'moderation' } });
  }

  return { success: true };
}

// ----------------------------------------------------------------- INTERAÇÕES
async function like(postId, userId) {
  const profile = await meuPerfil(userId);
  const post = await postVisivel(postId, profile.id);

  try {
    await prisma.$transaction([
      prisma.postLike.create({ data: { postId, profileId: profile.id } }),
      prisma.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } })
    ]);
  } catch (error) {
    // Constraint única: curtir duas vezes não conta duas.
    if (error.code === 'P2002') return { liked: true, alreadyLiked: true };
    throw error;
  }

  const autor = await prisma.socialProfile.findUnique({ where: { id: post.authorId }, select: { userId: true } });
  await notifications.notify({
    userIds: [autor?.userId], type: notifications.TYPES.POST_LIKE,
    title: 'Nova curtida', message: `${profile.displayName} curtiu sua publicação.`,
    entityType: 'Post', entityId: postId, link: `#post/${postId}`, actorId: userId
  });

  return { liked: true };
}

async function unlike(postId, userId) {
  const profile = await meuPerfil(userId);

  const existente = await prisma.postLike.findUnique({ where: { postId_profileId: { postId, profileId: profile.id } } });
  if (!existente) return { liked: false };

  await prisma.$transaction([
    prisma.postLike.delete({ where: { id: existente.id } }),
    prisma.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } })
  ]);

  return { liked: false };
}

async function save(postId, userId) {
  const profile = await meuPerfil(userId);
  await postVisivel(postId, profile.id);

  try {
    await prisma.$transaction([
      prisma.postSave.create({ data: { postId, profileId: profile.id } }),
      prisma.post.update({ where: { id: postId }, data: { saveCount: { increment: 1 } } })
    ]);
  } catch (error) {
    if (error.code === 'P2002') return { saved: true, alreadySaved: true };
    throw error;
  }
  return { saved: true };
}

async function unsave(postId, userId) {
  const profile = await meuPerfil(userId);
  const existente = await prisma.postSave.findUnique({ where: { postId_profileId: { postId, profileId: profile.id } } });
  if (!existente) return { saved: false };

  await prisma.$transaction([
    prisma.postSave.delete({ where: { id: existente.id } }),
    prisma.post.update({ where: { id: postId }, data: { saveCount: { decrement: 1 } } })
  ]);
  return { saved: false };
}

async function share(postId, userId, { comment }) {
  const profile = await meuPerfil(userId);
  const post = await postVisivel(postId, profile.id);

  // Compartilhar conteúdo restrito para fora do círculo autorizado furaria a
  // visibilidade escolhida pelo autor.
  if (post.visibility !== 'PUBLIC' && post.authorId !== profile.id) {
    throw new AppError(422, 'POST_NOT_SHAREABLE', 'Esta publicação não é pública e não pode ser compartilhada');
  }

  const [registro] = await prisma.$transaction([
    prisma.postShare.create({ data: { postId, profileId: profile.id, comment: comment ?? null } }),
    prisma.post.update({ where: { id: postId }, data: { shareCount: { increment: 1 } } })
  ]);

  return registro;
}

async function listSaved(userId, filtros) {
  const profile = await meuPerfil(userId);

  const saves = await prisma.postSave.findMany({
    where: { profileId: profile.id, post: { deletedAt: null } },
    include: { post: { include: { author: true, media: { orderBy: { position: 'asc' } } } } },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: saves.map(item => serializarPost(item.post, profile.id)),
    nextCursor: saves.length === filtros.limit ? saves[saves.length - 1].id : null
  };
}

// ---------------------------------------------------------------- COMENTÁRIOS
async function comment(postId, userId, data) {
  const profile = await meuPerfil(userId);
  const post = await postVisivel(postId, profile.id);

  if (data.parentId) {
    const pai = await prisma.comment.findUnique({ where: { id: data.parentId } });
    if (!pai || pai.postId !== postId || pai.deletedAt) throw new AppError(404, 'COMMENT_NOT_FOUND', 'Comentário não encontrado');
  }

  const [criado] = await prisma.$transaction([
    prisma.comment.create({
      data: { postId, authorId: profile.id, parentId: data.parentId ?? null, content: data.content },
      include: { author: true }
    }),
    prisma.post.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } })
  ]);

  const destinatarios = [post.authorId];
  if (data.parentId) {
    const pai = await prisma.comment.findUnique({ where: { id: data.parentId }, select: { authorId: true } });
    if (pai) destinatarios.push(pai.authorId);
  }

  await notifications.notify({
    userIds: await notifications.usersOfProfiles(destinatarios),
    type: data.parentId ? notifications.TYPES.COMMENT_REPLY : notifications.TYPES.POST_COMMENT,
    title: data.parentId ? 'Nova resposta' : 'Novo comentário',
    message: `${profile.displayName} comentou.`,
    entityType: 'Post', entityId: postId, link: `#post/${postId}`, actorId: userId
  });

  return { id: criado.id, content: criado.content, createdAt: criado.createdAt, parentId: criado.parentId, author: profilePublic(criado.author) };
}

async function listComments(postId, userId, filtros) {
  const profile = userId ? await prisma.socialProfile.findUnique({ where: { userId } }) : null;
  await postVisivel(postId, profile?.id);

  const bloqueados = await bloqueadosDe(profile?.id);

  const comentarios = await prisma.comment.findMany({
    where: { postId, deletedAt: null, ...(bloqueados.size ? { authorId: { notIn: [...bloqueados] } } : {}) },
    include: { author: true },
    orderBy: { createdAt: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: comentarios.map(item => ({
      id: item.id, content: item.content, parentId: item.parentId, createdAt: item.createdAt,
      likeCount: item.likeCount, author: profilePublic(item.author), isMine: item.authorId === profile?.id
    })),
    nextCursor: comentarios.length === filtros.limit ? comentarios[comentarios.length - 1].id : null
  };
}

async function deleteComment(commentId, userId, actor) {
  const profile = await meuPerfil(userId);
  const comentario = await prisma.comment.findUnique({ where: { id: commentId }, include: { post: { select: { authorId: true } } } });
  if (!comentario || comentario.deletedAt) throw new AppError(404, 'COMMENT_NOT_FOUND', 'Comentário não encontrado');

  // Apaga quem escreveu, quem é dono da publicação, ou a moderação.
  const podeApagar = comentario.authorId === profile.id || comentario.post.authorId === profile.id || can(actor, 'social.delete');
  if (!podeApagar) throw new AppError(403, 'FORBIDDEN', 'Comentário de outro autor');

  await prisma.$transaction([
    prisma.comment.update({ where: { id: commentId }, data: { deletedAt: new Date() } }),
    prisma.post.update({ where: { id: comentario.postId }, data: { commentCount: { decrement: 1 } } })
  ]);

  return { success: true };
}

// ------------------------------------------------------------------- SEGUIR
async function follow(handle, userId) {
  const profile = await meuPerfil(userId);
  const alvo = await prisma.socialProfile.findUnique({ where: { handle } });
  if (!alvo) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
  if (alvo.id === profile.id) throw new AppError(422, 'CANNOT_FOLLOW_SELF', 'Você não pode seguir a si mesmo');

  const bloqueados = await bloqueadosDe(profile.id);
  if (bloqueados.has(alvo.id)) throw new AppError(403, 'BLOCKED', 'Interação bloqueada');

  try {
    await prisma.follow.create({ data: { followerId: profile.id, followingId: alvo.id } });
  } catch (error) {
    if (error.code === 'P2002') return { following: true, alreadyFollowing: true };
    throw error;
  }

  await notifications.notify({
    userIds: alvo.userId ? [alvo.userId] : [], type: notifications.TYPES.NEW_FOLLOWER,
    title: 'Novo seguidor', message: `${profile.displayName} começou a seguir você.`,
    entityType: 'SocialProfile', entityId: profile.id, link: `#profile/${profile.handle}`, actorId: userId
  });

  return { following: true };
}

async function unfollow(handle, userId) {
  const profile = await meuPerfil(userId);
  const alvo = await prisma.socialProfile.findUnique({ where: { handle } });
  if (!alvo) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');

  await prisma.follow.deleteMany({ where: { followerId: profile.id, followingId: alvo.id } });
  return { following: false };
}

async function listFollowers(handle, tipo, filtros) {
  const alvo = await prisma.socialProfile.findUnique({ where: { handle } });
  if (!alvo) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');

  const where = tipo === 'followers' ? { followingId: alvo.id } : { followerId: alvo.id };
  const registros = await prisma.follow.findMany({
    where,
    include: { follower: true, following: true },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: registros.map(item => profilePublic(tipo === 'followers' ? item.follower : item.following)),
    nextCursor: registros.length === filtros.limit ? registros[registros.length - 1].id : null
  };
}

// ------------------------------------------------------------------- STORIES
async function createStory(userId, arquivo, { caption }) {
  const profile = await meuPerfil(userId);

  if (!storage.isAllowedMediaMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de mídia não aceito: ${arquivo.mimeType}`);
  }

  const kind = arquivo.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
  const key = storage.buildKey(`stories/${profile.id}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const expiresAt = new Date(Date.now() + config.storyTtlHours * 60 * 60 * 1000);

  return prisma.story.create({
    data: { authorId: profile.id, storageKey: key, mimeType: arquivo.mimeType, kind, caption: caption ?? null, expiresAt }
  });
}

// Stories de quem o usuário segue e ainda não expiraram. A expiração é aplicada
// na consulta: um registro vencido nunca aparece, mesmo antes da limpeza.
async function listStories(userId) {
  const profile = await meuPerfil(userId);
  const seguindo = await seguidosPor(profile.id);
  const bloqueados = await bloqueadosDe(profile.id);

  const autores = [...seguindo, profile.id].filter(id => !bloqueados.has(id));

  const stories = await prisma.story.findMany({
    where: { authorId: { in: autores.length ? autores : ['__ninguem__'] }, expiresAt: { gt: new Date() } },
    include: { author: true, views: { where: { profileId: profile.id }, select: { id: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200
  });

  const porAutor = new Map();
  for (const story of stories) {
    if (!porAutor.has(story.authorId)) porAutor.set(story.authorId, { profile: profilePublic(story.author), items: [] });
    porAutor.get(story.authorId).items.push({
      id: story.id, kind: story.kind, storageKey: story.storageKey, caption: story.caption,
      createdAt: story.createdAt, expiresAt: story.expiresAt, seen: story.views.length > 0
    });
  }

  return { items: [...porAutor.values()] };
}

async function viewStory(storyId, userId) {
  const profile = await meuPerfil(userId);
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story || story.expiresAt <= new Date()) throw new AppError(404, 'STORY_NOT_FOUND', 'Story não encontrado ou expirado');

  const seguindo = await seguidosPor(profile.id);
  if (story.authorId !== profile.id && !seguindo.includes(story.authorId)) {
    throw new AppError(403, 'FORBIDDEN', 'Story de perfil que você não segue');
  }

  try {
    await prisma.storyView.create({ data: { storyId, profileId: profile.id } });
  } catch (error) {
    if (error.code !== 'P2002') throw error;
  }
  return { success: true };
}

// ------------------------------------------------------- BLOQUEIO E MODERAÇÃO
async function block(handle, userId) {
  const profile = await meuPerfil(userId);
  const alvo = await prisma.socialProfile.findUnique({ where: { handle } });
  if (!alvo) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');
  if (alvo.id === profile.id) throw new AppError(422, 'CANNOT_BLOCK_SELF', 'Você não pode bloquear a si mesmo');

  await prisma.$transaction(async tx => {
    await tx.block.upsert({
      where: { blockerId_blockedId: { blockerId: profile.id, blockedId: alvo.id } },
      create: { blockerId: profile.id, blockedId: alvo.id },
      update: {}
    });
    // Bloquear desfaz o vínculo nos dois sentidos: manter o "seguindo" faria o
    // conteúdo continuar chegando por outra porta.
    await tx.follow.deleteMany({
      where: { OR: [{ followerId: profile.id, followingId: alvo.id }, { followerId: alvo.id, followingId: profile.id }] }
    });
  });

  return { blocked: true };
}

async function unblock(handle, userId) {
  const profile = await meuPerfil(userId);
  const alvo = await prisma.socialProfile.findUnique({ where: { handle } });
  if (!alvo) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil não encontrado');

  await prisma.block.deleteMany({ where: { blockerId: profile.id, blockedId: alvo.id } });
  return { blocked: false };
}

async function report(userId, data) {
  const profile = await meuPerfil(userId);

  try {
    return await prisma.contentReport.create({
      data: { reporterId: profile.id, targetType: data.targetType, targetId: data.targetId, reason: data.reason }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'ALREADY_REPORTED', 'Você já denunciou este conteúdo');
    throw error;
  }
}

async function listReports(filtros, actor) {
  if (!can(actor, 'social.moderate')) throw new AppError(403, 'FORBIDDEN', 'Sem permissão de moderação');

  return prisma.contentReport.findMany({
    where: filtros.status ? { status: filtros.status } : { status: { in: ['OPEN', 'REVIEWING'] } },
    include: { reporter: true, resolvedBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });
}

async function resolveReport(reportId, data, actor) {
  if (!can(actor, 'social.moderate')) throw new AppError(403, 'FORBIDDEN', 'Sem permissão de moderação');

  const denuncia = await prisma.contentReport.findUnique({ where: { id: reportId } });
  if (!denuncia) throw new AppError(404, 'REPORT_NOT_FOUND', 'Denúncia não encontrada');

  if (data.removeContent) {
    if (!can(actor, 'social.delete')) throw new AppError(403, 'FORBIDDEN', 'Sem permissão para remover conteúdo');

    if (denuncia.targetType === 'POST') {
      await prisma.post.updateMany({ where: { id: denuncia.targetId }, data: { deletedAt: new Date() } });
    } else if (denuncia.targetType === 'COMMENT') {
      await prisma.comment.updateMany({ where: { id: denuncia.targetId }, data: { deletedAt: new Date() } });
    } else if (denuncia.targetType === 'MESSAGE') {
      await prisma.message.updateMany({ where: { id: denuncia.targetId }, data: { deletedAt: new Date() } });
    }
  }

  const atualizada = await prisma.contentReport.update({
    where: { id: reportId },
    data: {
      status: data.status,
      resolution: data.resolution ?? null,
      resolvedById: actor.id,
      resolvedAt: ['RESOLVED', 'DISMISSED'].includes(data.status) ? new Date() : null
    }
  });

  await audit.record({
    actor, action: audit.ACTIONS.CONTENT_MODERATION, entity: 'ContentReport', entityId: reportId,
    metadata: { status: data.status, targetType: denuncia.targetType, targetId: denuncia.targetId, removed: Boolean(data.removeContent) }
  });

  return atualizada;
}

module.exports = {
  meuPerfil, updateProfile, setHandle, profileByHandle,
  setAvatar, removeAvatar,
  createPost, attachMedia, feed, getPost, deletePost,
  like, unlike, save, unsave, share, listSaved,
  comment, listComments, deleteComment,
  follow, unfollow, listFollowers,
  createStory, listStories, viewStory,
  block, unblock, report, listReports, resolveReport,
  bloqueadosDe, seguidosPor, postVisivel, serializarPost
};
