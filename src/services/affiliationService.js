const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');

// Filiação esportiva: o vínculo formal do atleta com a entidade responsável.
// É uma das chaves do reconhecimento na importação MuscleWar, por isso `code`
// é estável e único dentro da organização.

async function create(data, actor) {
  assertCan(actor, 'affiliations.manage', data.organizationId);

  try {
    return await prisma.affiliation.create({ data });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'AFFILIATION_CODE_IN_USE', 'Já existe filiação com este código na organização');
    throw error;
  }
}

async function list(filtros, actor) {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
  return prisma.affiliation.findMany({
    where: { ...escopo, ...(filtros.search ? { OR: [{ name: { contains: filtros.search, mode: 'insensitive' } }, { code: { contains: filtros.search.toUpperCase() } }] } : {}) },
    include: { _count: { select: { athletes: true } } },
    orderBy: { name: 'asc' },
    take: filtros.limit || 100
  });
}

async function setActive(id, active, actor) {
  const affiliation = await prisma.affiliation.findUnique({ where: { id } });
  if (!affiliation) throw new AppError(404, 'AFFILIATION_NOT_FOUND', 'Filiação não encontrada');

  assertCan(actor, 'affiliations.manage', affiliation.organizationId);
  return prisma.affiliation.update({ where: { id }, data: { active } });
}

module.exports = { create, list, setActive };
