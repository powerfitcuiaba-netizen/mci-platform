const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

async function listAssignments(actor) {
  const where = actor.role === 'ADMIN' ? {} : actor.role === 'ORGANIZER' ? { tournament: { createdById: actor.id } } : { judgeId: actor.id };
  const rows = await prisma.judgeAssignment.findMany({ where, include: { tournament: true, judge: { select: { id: true, name: true, email: true, role: true } } }, orderBy: { createdAt: 'desc' } });
  return { items: rows };
}

async function assign(data, actor) {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Você não pode atribuir juízes');
  const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (actor.role !== 'ADMIN' && tournament.createdById !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este campeonato');
  const judge = await prisma.user.findUnique({ where: { id: data.judgeId } });
  if (!judge || judge.role !== 'JUDGE') throw new AppError(404, 'JUDGE_NOT_FOUND', 'Juiz não encontrado');
  try {
    return await prisma.judgeAssignment.create({ data: { tournamentId: data.tournamentId, judgeId: data.judgeId }, include: { tournament: true, judge: true } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'JUDGE_ALREADY_ASSIGNED', 'Esse juiz já está atribuído ao campeonato');
    throw error;
  }
}

async function listMatches(actor) {
  const assignments = await prisma.judgeAssignment.findMany({ where: actor.role === 'ADMIN' ? {} : actor.role === 'ORGANIZER' ? { tournament: { createdById: actor.id } } : { judgeId: actor.id }, select: { tournamentId: true } });
  const tournamentIds = [...new Set(assignments.map(item => item.tournamentId))];
  if (!tournamentIds.length) return { items: [] };

  const matches = await prisma.match.findMany({
    where: { tournamentId: { in: tournamentIds } },
    include: { participantA: true, participantB: true, result: true, tournament: true },
    orderBy: { scheduledAt: 'asc' }
  });

  return { items: matches };
}

module.exports = { listAssignments, assign, listMatches };
