const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.result.create({ data, include: { winner: true } }),
  exists: matchId => prisma.result.findUnique({ where: { matchId } })
};