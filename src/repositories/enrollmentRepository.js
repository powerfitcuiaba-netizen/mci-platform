const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.enrollment.create({ data, include: { participant: true } }),
  exists: (tournamentId, participantId) => prisma.enrollment.findUnique({ where: { tournamentId_participantId: { tournamentId, participantId } } }),
  listByTournament: tournamentId => prisma.enrollment.findMany({ where: { tournamentId }, include: { participant: true }, orderBy: { createdAt: 'asc' } })
};