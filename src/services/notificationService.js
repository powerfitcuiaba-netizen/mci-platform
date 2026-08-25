const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

const PRIORIDADES = Object.freeze(['LOW', 'NORMAL', 'HIGH']);

async function list(userId, { onlyUnread = false, limit = 100 } = {}) {
  const items = await prisma.notification.findMany({
    where: { userId, ...(onlyUnread ? { isRead: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 100, 200)
  });

  const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });
  const highPriorityUnread = await prisma.notification.count({ where: { userId, isRead: false, priority: 'HIGH' } });

  return { items, unreadCount, highPriorityUnread };
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

async function createForUser(userId, message, meta = {}) {
  return prisma.notification.create({
    data: {
      userId,
      title: meta.title || 'Atualização',
      message,
      type: meta.type || 'INFO',
      priority: PRIORIDADES.includes(meta.priority) ? meta.priority : 'NORMAL',
      entityType: meta.entityType || null,
      entityId: meta.entityId || null,
      link: meta.link || null
    }
  });
}

// Ponto único de emissão. Remove destinatários repetidos e nunca notifica quem
// executou a ação, para não gerar eco na própria caixa do operador.
async function notify({ userIds = [], title, message, type = 'INFO', priority = 'NORMAL', entityType = null, entityId = null, link = null, actorId = null }) {
  const targets = [...new Set(userIds.filter(Boolean))].filter(id => id !== actorId);
  if (!targets.length) return { created: 0 };

  const prioridade = PRIORIDADES.includes(priority) ? priority : 'NORMAL';
  await Promise.all(targets.map(userId => prisma.notification.create({
    data: { userId, title, message, type, priority: prioridade, entityType, entityId, link }
  })));

  return { created: targets.length };
}

// Quem acompanha um campeonato: dono, juízes designados, atletas inscritos e
// seus técnicos. Inscrições canceladas não recebem mais avisos do evento.
async function tournamentAudience(tournamentId) {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: {
      id: true,
      name: true,
      createdById: true,
      judgeAssignments: { select: { judgeId: true } },
      enrollments: { where: { status: 'CONFIRMED' }, select: { participant: { select: { userId: true, coachId: true } } } }
    }
  });
  if (!tournament) return { tournament: null, ownerId: null, judgeIds: [], athleteIds: [], coachIds: [], everyone: [] };

  const judgeIds = tournament.judgeAssignments.map(item => item.judgeId);
  const athleteIds = tournament.enrollments.map(item => item.participant?.userId).filter(Boolean);
  const coachIds = tournament.enrollments.map(item => item.participant?.coachId).filter(Boolean);
  const everyone = [...new Set([tournament.createdById, ...judgeIds, ...athleteIds, ...coachIds].filter(Boolean))];

  return { tournament, ownerId: tournament.createdById, judgeIds, athleteIds, coachIds, everyone };
}

// Efeito colateral: uma falha ao notificar nunca deve derrubar a operação de negócio.
const safely = async (label, run) => {
  try {
    return await run();
  } catch (error) {
    console.error(`[notificações] falha ao emitir "${label}":`, error.message);
    return { created: 0 };
  }
};

async function notifyEnrollment(tournamentId, participantId, actorId) {
  return safely('inscrição', async () => {
    const audience = await tournamentAudience(tournamentId);
    if (!audience.tournament) return { created: 0 };
    const participant = await prisma.participant.findUnique({ where: { id: participantId }, select: { name: true, userId: true, coachId: true } });
    if (!participant) return { created: 0 };

    return notify({
      userIds: [audience.ownerId, participant.userId, participant.coachId],
      title: 'Nova inscrição',
      message: `${participant.name} foi inscrito em ${audience.tournament.name}.`,
      type: 'ENROLLMENT',
      priority: 'NORMAL',
      entityType: 'Tournament',
      entityId: tournamentId,
      link: `#tournaments/${tournamentId}`,
      actorId
    });
  });
}

async function notifyEnrollmentCancelled(enrollmentId, actorId) {
  return safely('cancelamento de inscrição', async () => {
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        tournamentId: true,
        tournament: { select: { name: true, createdById: true } },
        participant: { select: { name: true, userId: true, coachId: true } }
      }
    });
    if (!enrollment) return { created: 0 };

    return notify({
      userIds: [enrollment.tournament.createdById, enrollment.participant.userId, enrollment.participant.coachId],
      title: 'Inscrição cancelada',
      message: `${enrollment.participant.name} não participa mais de ${enrollment.tournament.name}.`,
      type: 'ENROLLMENT_CANCELLED',
      priority: 'HIGH',
      entityType: 'Tournament',
      entityId: enrollment.tournamentId,
      link: `#tournaments/${enrollment.tournamentId}`,
      actorId
    });
  });
}

async function notifyCheckIn(enrollmentId, actorId, cancelled = false) {
  return safely('check-in', async () => {
    const enrollment = await prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        tournamentId: true,
        tournament: { select: { name: true, createdById: true } },
        participant: { select: { name: true, userId: true, coachId: true } }
      }
    });
    if (!enrollment) return { created: 0 };

    return notify({
      userIds: [enrollment.tournament.createdById, enrollment.participant.userId, enrollment.participant.coachId],
      title: cancelled ? 'Check-in cancelado' : 'Check-in confirmado',
      message: `${enrollment.participant.name} — ${enrollment.tournament.name}.`,
      type: 'CHECKIN',
      priority: cancelled ? 'HIGH' : 'NORMAL',
      entityType: 'Enrollment',
      entityId: enrollmentId,
      link: '#checkin',
      actorId
    });
  });
}

async function notifyMatch(matchId, actorId, kind = 'MATCH') {
  return safely('partida', async () => {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        tournamentId: true,
        status: true,
        tournament: { select: { name: true } },
        participantA: { select: { name: true, userId: true, coachId: true } },
        participantB: { select: { name: true, userId: true, coachId: true } },
        result: { select: { scoreA: true, scoreB: true } }
      }
    });
    if (!match) return { created: 0 };

    const audience = await tournamentAudience(match.tournamentId);
    const confronto = `${match.participantA?.name || 'A'} x ${match.participantB?.name || 'B'}`;
    const placar = match.result ? ` (${match.result.scoreA} - ${match.result.scoreB})` : '';

    return notify({
      userIds: [audience.ownerId, ...audience.judgeIds, match.participantA?.userId, match.participantB?.userId, match.participantA?.coachId, match.participantB?.coachId],
      title: kind === 'RESULT' ? 'Resultado registrado' : 'Partida atualizada',
      message: `${confronto}${placar} — ${match.tournament?.name || 'campeonato'}.`,
      type: kind,
      priority: kind === 'RESULT' ? 'HIGH' : 'NORMAL',
      entityType: 'Match',
      entityId: matchId,
      link: `#tournaments/${match.tournamentId}`,
      actorId
    });
  });
}

module.exports = {
  list,
  markRead,
  markAllRead,
  createForUser,
  notify,
  tournamentAudience,
  notifyEnrollment,
  notifyEnrollmentCancelled,
  notifyCheckIn,
  notifyMatch,
  PRIORIDADES
};
