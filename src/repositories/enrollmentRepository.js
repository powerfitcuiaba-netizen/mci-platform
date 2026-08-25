const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.enrollment.create({ data, include: { participant: true } }),
  exists: (tournamentId, participantId) => prisma.enrollment.findUnique({ where: { tournamentId_participantId: { tournamentId, participantId } } }),
  // Cancelada não compete: fica de fora salvo pedido explícito da visão administrativa.
  listByTournament: (tournamentId, { incluirCanceladas = false } = {}) => prisma.enrollment.findMany({ where: { tournamentId, ...(incluirCanceladas ? {} : { status: 'CONFIRMED' }) }, include: { participant: true }, orderBy: { createdAt: 'asc' } })
};