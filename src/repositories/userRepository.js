const prisma = require('../config/prisma');

module.exports = {
  create: data => prisma.user.create({ data }),
  findByEmail: email => prisma.user.findUnique({ where: { email } }),
  findById: id => prisma.user.findUnique({ where: { id } }),
  update: (id, data) => prisma.user.update({ where: { id }, data })
};
