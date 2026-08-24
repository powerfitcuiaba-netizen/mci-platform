const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.result.create({ data, include: { winner: true } }),
  exists: matchId => prisma.result.findUnique({ where: { matchId } }),
  findByMatchId: matchId => prisma.result.findUnique({ where: { matchId }, include: { winner: true } }),
  update: (matchId, data) => prisma.result.update({ where: { matchId }, data, include: { winner: true } })
};