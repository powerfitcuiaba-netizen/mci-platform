const { randomUUID } = require('node:crypto');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { profilePublic } = require('../utils/visibility');
const { can } = require('../utils/permissions');
const storage = require('./storageService');
const notifications = require('./notificationService');
const social = require('./socialService');

// ============================================================================
// MCI MESSENGER — conversas individuais e em grupo.
//
// Privacidade é aplicada no servidor, em toda leitura e escrita: quem não é
// participante da conversa não a lê, não escreve nela e não sabe que ela
// existe. A resposta para não-participante é 404, nunca 403 — confirmar a
// existência de uma conversa alheia já é vazamento.
// ============================================================================

async function meuPerfil(userId) {
  const profile = await prisma.socialProfile.findUnique({ where: { userId } });
  if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil social não encontrado');
  return profile;
}

// Chave canônica da conversa direta: os dois ids ordenados. É o que impede
// duas conversas 1:1 entre as mesmas pessoas.
const chaveDireta = (a, b) => [a, b].sort().join('::');

// Porta única de acesso a uma conversa. Todo método passa por aqui.
async function conversaDoParticipante(conversationId, profileId) {
  const membro = await prisma.conversationMember.findUnique({
    where: { conversationId_profileId: { conversationId, profileId } },
    include: {
      conversation: {
        include: {
          members: { include: { profile: true } }
        }
      }
    }
  });

  if (!membro || membro.leftAt) {
    throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada');
  }
  return { membership: membro, conversation: membro.conversation };
}

// Cria a conversa e seus participantes sem ler a linha de volta antes da hora.
//
// `create` do Prisma emite INSERT ... RETURNING, e o RETURNING é submetido à
// política de SELECT da tabela. A política de "Conversation" é "só participante
// lê" — e no instante do RETURNING nenhum participante existe ainda, porque as
// linhas de "ConversationMember" só entram depois. O criador ficava sem
// conseguir ler a própria conversa recém-criada.
//
// `createMany` não usa RETURNING: a escrita responde apenas à política de
// INSERT. Com os participantes já gravados, a leitura seguinte passa pela
// política normalmente. O id é gerado aqui porque, sem RETURNING, o banco não
// tem como devolvê-lo.
async function criarComParticipantes(dados, participantes) {
  const id = randomUUID();

  await prisma.$transaction(async tx => {
    await tx.conversation.createMany({ data: { id, ...dados } });
    await tx.conversationMember.createMany({
      data: participantes.map(participante => ({ conversationId: id, ...participante }))
    });
  });

  return prisma.conversation.findUnique({
    where: { id },
    include: { members: { include: { profile: true } } }
  });
}

async function createConversation(userId, data) {
  const profile = await meuPerfil(userId);

  const outros = [...new Set(data.participantIds)].filter(id => id !== profile.id);
  if (!outros.length) throw new AppError(422, 'PARTICIPANTS_REQUIRED', 'Informe ao menos um participante');

  const perfis = await prisma.socialProfile.findMany({ where: { id: { in: outros } }, select: { id: true, userId: true, displayName: true } });
  if (perfis.length !== outros.length) throw new AppError(422, 'PROFILE_INVALID', 'Há participante inexistente');

  const bloqueados = await social.bloqueadosDe(profile.id);
  const impedidos = outros.filter(id => bloqueados.has(id));
  if (impedidos.length) throw new AppError(403, 'BLOCKED', 'Há participante bloqueado');

  if (data.kind === 'DIRECT') {
    if (outros.length !== 1) throw new AppError(422, 'DIRECT_NEEDS_ONE', 'Conversa individual tem exatamente dois participantes');

    const directKey = chaveDireta(profile.id, outros[0]);
    const existente = await prisma.conversation.findUnique({
      where: { directKey },
      include: { members: { include: { profile: true } } }
    });
    if (existente) return serializar(existente, profile.id);

    const criada = await criarComParticipantes(
      { kind: 'DIRECT', directKey },
      [{ profileId: profile.id, role: 'ADMIN' }, { profileId: outros[0] }]
    );
    return serializar(criada, profile.id);
  }

  const criada = await criarComParticipantes(
    { kind: 'GROUP', title: data.title || 'Grupo' },
    [{ profileId: profile.id, role: 'ADMIN' }, ...outros.map(id => ({ profileId: id }))]
  );

  await notifications.notify({
    userIds: perfis.map(item => item.userId).filter(Boolean),
    type: notifications.TYPES.GROUP_INVITE,
    title: 'Novo grupo', message: `${profile.displayName} adicionou você a ${criada.title}.`,
    entityType: 'Conversation', entityId: criada.id, link: `#messenger/${criada.id}`, actorId: userId
  });

  return serializar(criada, profile.id);
}

function serializar(conversation, viewerProfileId, unreadCount = 0) {
  const outros = conversation.members.filter(membro => membro.profileId !== viewerProfileId);
  return {
    id: conversation.id,
    kind: conversation.kind,
    title: conversation.kind === 'DIRECT' ? (outros[0]?.profile?.displayName ?? 'Conversa') : conversation.title,
    // Quem é o OUTRO numa conversa individual. O `title` já sai daqui, mas só
    // o nome: sem o perfil, a tela não tem como saber de quem é a foto —
    // teria de descobrir qual dos membros não é ela própria, e para isso
    // precisaria do próprio id de perfil, que não tem. Em grupo é null: grupo
    // não tem uma foto só.
    counterpart: conversation.kind === 'DIRECT' ? profilePublic(outros[0]?.profile) : null,
    lastMessageAt: conversation.lastMessageAt,
    members: conversation.members.map(membro => ({ ...profilePublic(membro.profile), role: membro.role, lastReadAt: membro.lastReadAt })),
    unreadCount
  };
}

async function listConversations(userId, filtros) {
  const profile = await meuPerfil(userId);

  const memberships = await prisma.conversationMember.findMany({
    where: { profileId: profile.id, leftAt: null },
    include: { conversation: { include: { members: { include: { profile: true } } } } },
    orderBy: { conversation: { lastMessageAt: 'desc' } },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  // Contagem de não lidas por conversa: mensagens posteriores à última leitura
  // que não sejam do próprio usuário.
  const items = await Promise.all(memberships.map(async membership => {
    const unread = await prisma.message.count({
      where: {
        conversationId: membership.conversationId,
        deletedAt: null,
        senderId: { not: profile.id },
        ...(membership.lastReadAt ? { createdAt: { gt: membership.lastReadAt } } : {})
      }
    });
    return serializar(membership.conversation, profile.id, unread);
  }));

  return {
    items,
    totalUnread: items.reduce((total, item) => total + item.unreadCount, 0),
    nextCursor: memberships.length === filtros.limit ? memberships[memberships.length - 1].id : null
  };
}

async function getConversation(conversationId, userId) {
  const profile = await meuPerfil(userId);
  const { conversation } = await conversaDoParticipante(conversationId, profile.id);
  return serializar(conversation, profile.id);
}

async function listMessages(conversationId, userId, filtros) {
  const profile = await meuPerfil(userId);
  await conversaDoParticipante(conversationId, profile.id);

  // Paginação por cursor, do mais recente para trás: carregar a conversa
  // inteira de uma vez não escala.
  const mensagens = await prisma.message.findMany({
    where: { conversationId },
    include: {
      sender: true,
      reactions: { include: { profile: { select: { id: true, handle: true, displayName: true } } } },
      sharedPost: { include: { author: true, media: { orderBy: { position: 'asc' } } } },
      sharedProfile: true,
      replyTo: { select: { id: true, body: true, senderId: true, deletedAt: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: mensagens.map(mensagem => serializarMensagem(mensagem, profile.id)).reverse(),
    nextCursor: mensagens.length === filtros.limit ? mensagens[mensagens.length - 1].id : null
  };
}

function serializarMensagem(mensagem, viewerProfileId) {
  const apagada = Boolean(mensagem.deletedAt);
  return {
    id: mensagem.id,
    body: apagada ? null : mensagem.body,
    deleted: apagada,
    storageKey: apagada ? null : mensagem.storageKey,
    mimeType: apagada ? null : mensagem.mimeType,
    mediaKind: apagada ? null : mensagem.mediaKind,
    createdAt: mensagem.createdAt,
    isMine: mensagem.senderId === viewerProfileId,
    sender: profilePublic(mensagem.sender),
    replyTo: mensagem.replyTo && !mensagem.replyTo.deletedAt ? { id: mensagem.replyTo.id, body: mensagem.replyTo.body } : null,
    sharedPost: apagada || !mensagem.sharedPost ? null : {
      id: mensagem.sharedPost.id,
      content: mensagem.sharedPost.content,
      author: profilePublic(mensagem.sharedPost.author),
      media: mensagem.sharedPost.media.map(item => ({ id: item.id, kind: item.kind, storageKey: item.storageKey }))
    },
    sharedProfile: apagada ? null : profilePublic(mensagem.sharedProfile),
    reactions: (mensagem.reactions || []).map(reacao => ({ emoji: reacao.emoji, profile: reacao.profile }))
  };
}

async function sendMessage(conversationId, userId, data) {
  const profile = await meuPerfil(userId);
  const { conversation } = await conversaDoParticipante(conversationId, profile.id);

  // Bloqueio impede a mensagem, mesmo numa conversa já existente.
  const bloqueados = await social.bloqueadosDe(profile.id);
  const outros = conversation.members.filter(membro => membro.profileId !== profile.id);
  if (conversation.kind === 'DIRECT' && outros.some(membro => bloqueados.has(membro.profileId))) {
    throw new AppError(403, 'BLOCKED', 'Interação bloqueada');
  }

  if (data.replyToId) {
    const original = await prisma.message.findUnique({ where: { id: data.replyToId }, select: { conversationId: true } });
    if (!original || original.conversationId !== conversationId) throw new AppError(422, 'REPLY_INVALID', 'Mensagem respondida não é desta conversa');
  }

  // Compartilhar um post no chat exige que o remetente possa vê-lo.
  if (data.sharedPostId) await social.postVisivel(data.sharedPostId, profile.id);

  const mensagem = await prisma.$transaction(async tx => {
    const criada = await tx.message.create({
      data: {
        conversationId,
        senderId: profile.id,
        body: data.body ?? null,
        sharedPostId: data.sharedPostId ?? null,
        sharedProfileId: data.sharedProfileId ?? null,
        replyToId: data.replyToId ?? null
      },
      include: {
        sender: true, reactions: true,
        sharedPost: { include: { author: true, media: true } },
        sharedProfile: true,
        replyTo: { select: { id: true, body: true, senderId: true, deletedAt: true } }
      }
    });

    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: criada.createdAt } });
    // Quem envia leu o que enviou.
    await tx.conversationMember.update({
      where: { conversationId_profileId: { conversationId, profileId: profile.id } },
      data: { lastReadAt: criada.createdAt }
    });

    return criada;
  });

  await notifications.notify({
    userIds: await notifications.usersOfProfiles(outros.map(membro => membro.profileId)),
    type: notifications.TYPES.MESSAGE,
    title: 'Nova mensagem',
    message: `${profile.displayName} enviou uma mensagem.`,
    entityType: 'Conversation', entityId: conversationId, link: `#messenger/${conversationId}`, actorId: userId
  });

  return serializarMensagem(mensagem, profile.id);
}

async function sendMedia(conversationId, userId, arquivo) {
  const profile = await meuPerfil(userId);
  await conversaDoParticipante(conversationId, profile.id);

  if (!storage.isAllowedMediaMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de mídia não aceito: ${arquivo.mimeType}`);
  }

  const mediaKind = arquivo.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE';
  // A chave inclui a conversa: o arquivo fica sob o escopo em que foi enviado.
  const key = storage.buildKey(`messages/${conversationId}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const mensagem = await prisma.$transaction(async tx => {
    const criada = await tx.message.create({
      data: { conversationId, senderId: profile.id, storageKey: key, mimeType: arquivo.mimeType, mediaKind },
      include: { sender: true, reactions: true, sharedPost: false, sharedProfile: true, replyTo: false }
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: criada.createdAt } });
    return criada;
  });

  return serializarMensagem(mensagem, profile.id);
}

// Download de mídia da conversa: a autorização é o vínculo com a conversa,
// nunca o conhecimento da chave de armazenamento.
async function mediaStream(messageId, userId) {
  const profile = await meuPerfil(userId);
  const mensagem = await prisma.message.findUnique({ where: { id: messageId } });
  if (!mensagem || mensagem.deletedAt || !mensagem.storageKey) throw new AppError(404, 'MEDIA_NOT_FOUND', 'Mídia não encontrada');

  await conversaDoParticipante(mensagem.conversationId, profile.id);

  if (!(await storage.exists(mensagem.storageKey))) throw new AppError(404, 'MEDIA_NOT_FOUND', 'Arquivo indisponível');

  return { stream: storage.createReadStream(mensagem.storageKey), mimeType: mensagem.mimeType || 'application/octet-stream' };
}

async function markRead(conversationId, userId) {
  const profile = await meuPerfil(userId);
  await conversaDoParticipante(conversationId, profile.id);

  await prisma.conversationMember.update({
    where: { conversationId_profileId: { conversationId, profileId: profile.id } },
    data: { lastReadAt: new Date() }
  });

  return { success: true };
}

async function react(messageId, userId, { emoji }) {
  const profile = await meuPerfil(userId);
  const mensagem = await prisma.message.findUnique({ where: { id: messageId } });
  if (!mensagem || mensagem.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Mensagem não encontrada');

  await conversaDoParticipante(mensagem.conversationId, profile.id);

  try {
    return await prisma.messageReaction.create({ data: { messageId, profileId: profile.id, emoji } });
  } catch (error) {
    if (error.code === 'P2002') {
      // Repetir a mesma reação remove — é o comportamento esperado de um toggle.
      await prisma.messageReaction.deleteMany({ where: { messageId, profileId: profile.id, emoji } });
      return { removed: true };
    }
    throw error;
  }
}

async function deleteMessage(messageId, userId, actor) {
  const profile = await meuPerfil(userId);
  const mensagem = await prisma.message.findUnique({ where: { id: messageId } });
  if (!mensagem || mensagem.deletedAt) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Mensagem não encontrada');

  await conversaDoParticipante(mensagem.conversationId, profile.id);

  const ehAutor = mensagem.senderId === profile.id;
  if (!ehAutor && !can(actor, 'messenger.moderate')) throw new AppError(403, 'FORBIDDEN', 'Mensagem de outro participante');

  await prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } });
  return { success: true };
}

async function addMembers(conversationId, userId, { participantIds }) {
  const profile = await meuPerfil(userId);
  const { membership, conversation } = await conversaDoParticipante(conversationId, profile.id);

  if (conversation.kind !== 'GROUP') throw new AppError(422, 'NOT_A_GROUP', 'Conversa individual não recebe participantes');
  if (membership.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Apenas administradores do grupo adicionam participantes');

  const atuais = new Set(conversation.members.map(membro => membro.profileId));
  const novos = [...new Set(participantIds)].filter(id => !atuais.has(id));
  if (!novos.length) return getConversation(conversationId, userId);

  const perfis = await prisma.socialProfile.findMany({ where: { id: { in: novos } }, select: { id: true, userId: true } });
  if (perfis.length !== novos.length) throw new AppError(422, 'PROFILE_INVALID', 'Há participante inexistente');

  await prisma.conversationMember.createMany({ data: novos.map(id => ({ conversationId, profileId: id })) });

  await notifications.notify({
    userIds: perfis.map(item => item.userId).filter(Boolean),
    type: notifications.TYPES.GROUP_INVITE,
    title: 'Você entrou em um grupo', message: `${profile.displayName} adicionou você a ${conversation.title}.`,
    entityType: 'Conversation', entityId: conversationId, actorId: userId
  });

  return getConversation(conversationId, userId);
}

async function leave(conversationId, userId) {
  const profile = await meuPerfil(userId);
  const { conversation } = await conversaDoParticipante(conversationId, profile.id);

  if (conversation.kind !== 'GROUP') throw new AppError(422, 'NOT_A_GROUP', 'Conversa individual não pode ser deixada');

  await prisma.conversationMember.update({
    where: { conversationId_profileId: { conversationId, profileId: profile.id } },
    data: { leftAt: new Date() }
  });

  return { success: true };
}

module.exports = {
  createConversation, listConversations, getConversation,
  listMessages, sendMessage, sendMedia, mediaStream, markRead,
  react, deleteMessage, addMembers, leave,
  conversaDoParticipante, chaveDireta
};
