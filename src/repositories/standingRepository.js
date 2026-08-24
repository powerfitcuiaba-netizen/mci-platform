const prisma = require('../config/prisma');

module.exports = {
  replaceForTournament: async (tournamentId, rows) => prisma.$transaction(async tx => {
    await tx.standing.deleteMany({ where: { tournamentId } });
    if (!rows.length) return [];
    await tx.standing.createMany({ data: rows });
    return tx.standing.findMany({ where: { tournamentId }, include: { participant: true } });
  }),
  listByTournament: tournamentId => prisma.standing.findMany({ where: { tournamentId }, include: { participant: true }, orderBy: [{ points: 'desc' }, { wins: 'desc' }, { scored: 'desc' }, { conceded: 'asc' }] })
};