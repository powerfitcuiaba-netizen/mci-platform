const prisma = require('../config/prisma');

const include = { _count: { select: { enrollments: true, matches: true } } };

module.exports = {
  create: data => prisma.tournament.create({ data }),
  list: () => prisma.tournament.findMany({ orderBy: { createdAt: 'desc' }, include }),
  findById: id => prisma.tournament.findUnique({ where: { id }, include }),
  update: (id, data) => prisma.tournament.update({ where: { id }, data }),
  delete: id => prisma.tournament.delete({ where: { id } })
};