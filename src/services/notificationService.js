const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// Tipos emitidos pela plataforma. Cobrem o §50 do escopo.
const TYPES = Object.freeze({
  NEW_FOLLOWER: 'NEW_FOLLOWER',
  POST_LIKE: 'POST_LIKE',
  POST_COMMENT: 'POST_COMMENT',
  COMMENT_REPLY: 'COMMENT_REPLY',
  MESSAGE: 'MESSAGE',
  GROUP_INVITE: 'GROUP_INVITE',
  RESULT_PUBLISHED: 'RESULT_PUBLISHED',
  BATCH_CHANGED: 'BATCH_CHANGED',
  STAGE_CALL: 'STAGE_CALL',
  IMPORT_APPLIED: 'IMPORT_APPLIED',
  ATHLETE_MATCHED: 'ATHLETE_MATCHED',
  REGISTRATION: 'REGISTRATION',
  REGISTRATION_CANCELLED: 'REGISTRATION_CANCELLED',
  CHECKIN: 'CHECKIN',
  PRO_STATUS: 'PRO_STATUS',
  MODERATION: 'MODERATION'
});

async function list(userId, { onlyUnread = false, limit = 50 } = {}) {
  const items = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { isRead: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200)
  });

  const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });
  return { items, unreadCount };
}

async function markRead(id, userId) {
  const item = await prisma.notification.findFirst({ where: { id, userId } });
  if (!item) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notificação não encontrada');
  if (item.isRead) return item;
  return prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
}

async function markAllRead(userId) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() }
  });
  return { success: true, updated: count };
}

// Ponto único de emissão. Remove destinatários repetidos e nunca notifica quem
// executou a ação, para não gerar eco na caixa do próprio autor.
async function notify({ userIds = [], type, title, message, entityType = null, entityId = null, link = null, actorId = null }) {
  const alvos = [...new Set(userIds.filter(Boolean))].filter(userId => userId !== actorId);
  if (!alvos.length) return { created: 0 };

  try {
    await prisma.notification.createMany({
      data: alvos.map(userId => ({ userId, type, title, message, entityType, entityId, link }))
    });
    return { created: alvos.length };
  } catch (error) {
    // Notificar é efeito colateral: falhar aqui não pode derrubar a operação.
    logger.error('falha ao emitir notificação', { type, erro: error.message });
    return { created: 0 };
  }
}

// Usuários por trás de perfis sociais — o messenger e o feed trabalham com
// perfis, mas a notificação chega ao usuário.
async function usersOfProfiles(profileIds) {
  if (!profileIds?.length) return [];
  const perfis = await prisma.socialProfile.findMany({
    where: { id: { in: [...new Set(profileIds)] } },
    select: { userId: true }
  });
  return perfis.map(perfil => perfil.userId).filter(Boolean);
}

// Quem acompanha um evento: quem o criou, os juízes escalados e os atletas
// inscritos com inscrição ativa.
async function eventAudience(eventId) {
  const evento = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      name: true,
      createdById: true,
      panels: { select: { judges: { select: { judgeId: true } } } },
      registrations: {
        where: { status: 'CONFIRMED' },
        select: { athlete: { select: { userId: true, coach: { select: { userId: true } } } } }
      }
    }
  });
  if (!evento) return { event: null, everyone: [] };

  const juizes = evento.panels.flatMap(painel => painel.judges.map(item => item.judgeId));
  const atletas = evento.registrations.map(item => item.athlete?.userId).filter(Boolean);
  const coaches = evento.registrations.map(item => item.athlete?.coach?.userId).filter(Boolean);

  return {
    event: evento,
    ownerId: evento.createdById,
    judgeIds: juizes,
    athleteIds: atletas,
    coachIds: coaches,
    everyone: [...new Set([evento.createdById, ...juizes, ...atletas, ...coaches].filter(Boolean))]
  };
}

module.exports = { TYPES, list, markRead, markAllRead, notify, usersOfProfiles, eventAudience };
