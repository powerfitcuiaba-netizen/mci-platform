const prisma = require('../config/prisma');

// A carga do usuário sempre traz os vínculos de organização: a autorização
// efetiva depende deles, e buscá-los depois abriria janela para decidir
// permissão com contexto incompleto.
const INCLUDE_PADRAO = Object.freeze({
  memberships: { include: { organization: { select: { id: true, name: true, slug: true, active: true } } } },
  athlete: { select: { id: true, organizationId: true } },
  socialProfile: { select: { id: true, handle: true } },

  // AS DELEGAÇÕES CENTRAIS VIAJAM COM O USUÁRIO — decisão R-02.
  //
  // Pelo mesmo motivo dos vínculos de organização: a autorização efetiva depende
  // delas, e buscá-las depois abriria janela para decidir permissão com contexto
  // incompleto.
  //
  // Só as NÃO REVOGADAS vêm do banco. O PRAZO é conferido em
  // `effectivePermissions`, que é função pura: assim a expiração é testável sem
  // banco, e uma concessão vencida não precisa de job para parar de valer.
  centralGrantsReceived: {
    where: { revokedAt: null },
    select: { permission: true, organizationId: true, expiresAt: true }
  },

  // O cadastro de treinador do próprio usuário, quando existe. O módulo
  // Treinadores precisa saber, a cada requisição, se quem fala é um treinador e
  // em que situação cadastral ele está — `PENDING` não opera nada.
  coach: { select: { id: true, status: true } }
});

module.exports = {
  create: data => prisma.user.create({ data, include: INCLUDE_PADRAO }),
  findByEmail: email => prisma.user.findUnique({ where: { email }, include: INCLUDE_PADRAO }),
  findById: id => prisma.user.findUnique({ where: { id }, include: INCLUDE_PADRAO }),
  update: (id, data) => prisma.user.update({ where: { id }, data, include: INCLUDE_PADRAO }),
  INCLUDE_PADRAO
};
