const prisma = require('../config/prisma');

// A carga do usuário sempre traz os vínculos de organização: a autorização
// efetiva depende deles, e buscá-los depois abriria janela para decidir
// permissão com contexto incompleto.
const INCLUDE_PADRAO = Object.freeze({
  memberships: { include: { organization: { select: { id: true, name: true, slug: true, active: true } } } },
  athlete: { select: { id: true, organizationId: true } },
  socialProfile: { select: { id: true, handle: true } }
});

module.exports = {
  create: data => prisma.user.create({ data, include: INCLUDE_PADRAO }),
  findByEmail: email => prisma.user.findUnique({ where: { email }, include: INCLUDE_PADRAO }),
  findById: id => prisma.user.findUnique({ where: { id }, include: INCLUDE_PADRAO }),
  update: (id, data) => prisma.user.update({ where: { id }, data, include: INCLUDE_PADRAO }),
  INCLUDE_PADRAO
};
