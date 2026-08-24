const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

async function getByEnrollment(enrollmentId) {
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { participant: true, tournament: true } });
  if (!enrollment) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Inscrição não encontrada');
  const checkIn = await prisma.checkIn.findUnique({ where: { enrollmentId } });
  return { enrollment, checkIn: checkIn || null };
}

async function checkIn(enrollmentId, payload, actor) {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para registrar check-in');
  const enrollment = await prisma.enrollment.findUnique({ where: { id: enrollmentId }, include: { tournament: true } });
  if (!enrollment) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Inscrição não encontrada');
  if (actor.role !== 'ADMIN' && enrollment.tournament.createdById !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Você não pode registrar check-in neste campeonato');
  const existing = await prisma.checkIn.findUnique({ where: { enrollmentId } });
  if (existing) throw new AppError(409, 'CHECKIN_ALREADY_EXISTS', 'Participante já realizou check-in');

  const row = await prisma.checkIn.create({
    data: {
      enrollmentId,
      status: 'CHECKED_IN',
      operatorName: payload.operatorName || actor.name,
      checkedInById: actor.id,
      checkedInAt: new Date()
    },
    include: { enrollment: { include: { participant: true, tournament: true } } }
  });

  return row;
}

async function cancel(enrollmentId, actor) {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para cancelar check-in');
  const existing = await prisma.checkIn.findUnique({ where: { enrollmentId }, include: { enrollment: { include: { tournament: true } } } });
  if (!existing) throw new AppError(404, 'CHECKIN_NOT_FOUND', 'Check-in não encontrado');
  if (actor.role !== 'ADMIN' && existing.enrollment.tournament.createdById !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este check-in');
  const updated = await prisma.checkIn.update({ where: { enrollmentId }, data: { status: 'CANCELLED', updatedAt: new Date() } });
  return updated;
}

module.exports = { getByEnrollment, checkIn, cancel };
