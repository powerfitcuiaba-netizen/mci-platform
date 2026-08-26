const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.user.create({ data }),
  findByEmail: email => prisma.user.findUnique({ where: { email }, include: { participant: { select: { id: true } } } }),
  findById: id => prisma.user.findUnique({ where: { id }, include: { participant: { select: { id: true } } } }),
  update: (id, data) => prisma.user.update({ where: { id }, data })
};
