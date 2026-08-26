const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const notificationService = require('./notificationService');

const canOperate = (tournament, actor) =>
  actor.role === 'ADMIN' || (actor.role === 'ORGANIZER' && tournament.createdById === actor.id);

const assertCanOperate = (tournament, actor, message) => {
  if (!canOperate(tournament, actor)) throw new AppError(403, 'FORBIDDEN', message);
};

const enrollmentSelection = {
  include: {
    participant: { select: { id: true, name: true, identification: true, type: true, userId: true, coachId: true } },
    tournament: { select: { id: true, name: true, status: true, createdById: true } },
    checkIns: true
  }
};

// Estado derivado: sem registro o inscrito está PENDING.
const withStatus = enrollment => {
  const checkIn = enrollment.checkIns?.[0] || null;
  return {
    id: enrollment.id,
    tournamentId: enrollment.tournamentId,
    participantId: enrollment.participantId,
    participant: enrollment.participant,
    tournament: enrollment.tournament,
    status: checkIn ? checkIn.status : 'PENDING',
    checkedInAt: checkIn?.checkedInAt || null,
    operatorName: checkIn?.operatorName || null,
    checkIn
  };
};

async function listByTournament(tournamentId, actor, search = '') {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  assertCanOperate(tournament, actor, 'Você não pode consultar o check-in deste campeonato');

  const enrollments = await prisma.enrollment.findMany({
    where: { tournamentId, status: 'CONFIRMED' },
    ...enrollmentSelection,
    orderBy: { createdAt: 'asc' }
  });

  const term = String(search || '').trim().toLowerCase();
  const rows = enrollments.map(withStatus).filter(row =>
    !term || `${row.participant?.name || ''} ${row.participant?.identification || ''}`.toLowerCase().includes(term)
  );

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return {
    items: rows,
    total: rows.length,
    pending: counts.PENDING || 0,
    checkedIn: counts.CHECKED_IN || 0,
    cancelled: counts.CANCELLED || 0
  };
}

async function getByEnrollment(enrollmentId, actor) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, ...enrollmentSelection });
  if (!enrollment) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Inscrição não encontrada');

  // Operadores veem qualquer inscrição do próprio campeonato; o atleta e seu
  // técnico veem apenas a própria situação.
  const isSelf = enrollment.participant?.userId && enrollment.participant.userId === actor.id;
  const isCoach = enrollment.participant?.coachId && enrollment.participant.coachId === actor.id;
  if (!canOperate(enrollment.tournament, actor) && !isSelf && !isCoach) {
    throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso a esta inscrição');
  }

  const row = withStatus(enrollment);
  return { enrollment: row, checkIn: row.checkIn };
}

async function checkIn(enrollmentId, payload, actor) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { tournament: true } });
  if (!enrollment) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Inscrição não encontrada');
  assertCanOperate(enrollment.tournament, actor, 'Você não pode registrar check-in neste campeonato');

  const existing = await prisma.checkIn.findUnique({ where: { enrollmentId } });
  if (existing && existing.status === 'CHECKED_IN') {
    throw new AppError(409, 'CHECKIN_ALREADY_EXISTS', 'Participante já realizou check-in');
  }

  // Um check-in cancelado pode ser refeito: reaproveitamos a linha, já que
  // enrollmentId é único.
  const data = {
    status: 'CHECKED_IN',
    operatorName: payload.operatorName || actor.name,
    checkedInById: actor.id,
    checkedInAt: new Date()
  };

  const row = existing
    ? await prisma.checkIn.update({ where: { enrollmentId }, data, include: { enrollment: { include: { participant: true, tournament: true } } } })
    : await prisma.checkIn.create({ data: { enrollmentId, ...data }, include: { enrollment: { include: { participant: true, tournament: true } } } });

  await notificationService.notifyCheckIn(enrollmentId, actor.id, false);
  return row;
}

async function cancel(enrollmentId, actor) {
  const existing = await prisma.checkIn.findUnique({ where: { enrollmentId }, include: { enrollment: { include: { tournament: true } } } });
  if (!existing) throw new AppError(404, 'CHECKIN_NOT_FOUND', 'Check-in não encontrado');
  assertCanOperate(existing.enrollment.tournament, actor, 'Você não pode alterar este check-in');

  const updated = await prisma.checkIn.update({ where: { enrollmentId }, data: { status: 'CANCELLED' } });
  await notificationService.notifyCheckIn(enrollmentId, actor.id, true);
  return updated;
}

module.exports = { listByTournament, getByEnrollment, checkIn, cancel };
