const prisma = require('../config/prisma');

const include = { participantA: true, participantB: true, result: true };

module.exports = {
  create: data => prisma.match.create({ data, include }),
  list: tournamentId => prisma.match.findMany({ where: tournamentId ? { tournamentId } : undefined, include, orderBy: { scheduledAt: 'asc' } }),
  findById: id => prisma.match.findUnique({ where: { id }, include }),
  update: (id, data) => prisma.match.update({ where: { id }, data, include })
};