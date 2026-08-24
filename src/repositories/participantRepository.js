const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.participant.create({ data }),
  list: type => prisma.participant.findMany({ where: type ? { type } : undefined, orderBy: { name: 'asc' } }),
  findById: id => prisma.participant.findUnique({ where: { id } }),
  update: (id, data) => prisma.participant.update({ where: { id }, data }),
  delete: id => prisma.participant.delete({ where: { id } })
};