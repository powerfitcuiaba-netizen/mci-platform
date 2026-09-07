const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');
const audit = require('./auditService');

// Equipes, coaches, academias, marcas, patrocinadores e parcerias.
//
// Toda relação aqui é esportiva, institucional ou de marketing. Nenhum campo
// representa valor: patrocínio e parceria guardam escopo, período e situação,
// e nada mais.

const criarComEscopo = modelo => async (data, actor) => {
  assertCan(actor, modelo.permission, data.organizationId);
  try {
    return await prisma[modelo.model].create({ data });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, modelo.conflictCode, modelo.conflictMessage);
    throw error;
  }
};

// O agregado contado difere por modelo — equipe conta atletas, empresa conta
// equipes — e pedir uma relação que o modelo não tem derruba a consulta. Fica
// explícito por isso.
const listarComEscopo = modelo => async (filtros, actor) => {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
  return prisma[modelo.model].findMany({
    where: { ...escopo, ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {}) },
    ...(modelo.count ? { include: { _count: { select: modelo.count } } } : {}),
    orderBy: { name: 'asc' },
    take: filtros.limit || 50
  });
};

const createTeam = criarComEscopo({ model: 'team', permission: 'teams.manage', conflictCode: 'TEAM_EXISTS', conflictMessage: 'Já existe equipe com este nome' });
const listTeams = listarComEscopo({ model: 'team', count: { athletes: true } });

// A empresa entra com suas equipes: ela fica acima delas, e os pontos sobem por
// essa cadeia (atleta → equipe → empresa).
const createCompany = criarComEscopo({ model: 'company', permission: 'companies.manage', conflictCode: 'COMPANY_EXISTS', conflictMessage: 'Já existe empresa com este nome' });
const listCompanies = listarComEscopo({ model: 'company', count: { teams: true } });

const createGym = criarComEscopo({ model: 'gym', permission: 'gyms.manage', conflictCode: 'GYM_EXISTS', conflictMessage: 'Já existe academia com este nome' });
const listGyms = listarComEscopo({ model: 'gym', count: { athletes: true } });

// Coach não pertence a uma organização: um técnico atende atletas de várias.
async function createCoach(data, actor) {
  const { assertPermission } = require('../utils/tenant');
  assertPermission(actor, 'coaches.manage');

  if (data.userId) {
    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  }

  try {
    return await prisma.coach.create({ data });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'COACH_EXISTS', 'Este usuário já tem cadastro de coach');
    throw error;
  }
}

async function listCoaches(filtros) {
  return prisma.coach.findMany({
    where: filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {},
    include: { _count: { select: { athletes: true } } },
    orderBy: { name: 'asc' },
    take: filtros.limit || 50
  });
}

// ------------------------------------------------------------------- MARCAS
async function createBrand(data, actor) {
  assertCan(actor, 'brands.manage', data.organizationId);

  try {
    const brand = await prisma.brand.create({ data });
    // Marca com perfil social participa do feed, das comunidades e do
    // messenger como qualquer outro perfil.
    await prisma.socialProfile.create({
      data: { handle: data.slug, displayName: data.name, kind: 'BRAND', brandId: brand.id }
    });
    return brand;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'BRAND_EXISTS', 'Já existe marca com este identificador');
    throw error;
  }
}

async function listBrands(filtros, actor) {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
  return prisma.brand.findMany({
    where: { ...escopo, active: true },
    include: { socialProfile: { select: { id: true, handle: true, avatarKey: true } }, _count: { select: { partnerships: true } } },
    orderBy: { name: 'asc' },
    take: filtros.limit || 50
  });
}

// ------------------------------------------------------------ PATROCINADORES
async function createSponsor(data, actor) {
  assertCan(actor, 'sponsors.manage', data.organizationId);

  if (data.brandId) {
    const brand = await prisma.brand.findUnique({ where: { id: data.brandId } });
    if (!brand || brand.organizationId !== data.organizationId) throw new AppError(422, 'BRAND_INVALID', 'Marca inválida para esta organização');
  }

  try {
    return await prisma.sponsor.create({ data });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SPONSOR_EXISTS', 'Já existe patrocinador com este nome');
    throw error;
  }
}

async function listSponsors(filtros, actor) {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
  return prisma.sponsor.findMany({
    where: escopo,
    include: { brand: { select: { id: true, name: true, slug: true } }, _count: { select: { sponsorships: true } } },
    orderBy: { name: 'asc' },
    take: filtros.limit || 50
  });
}

async function createSponsorship(data, actor) {
  const sponsor = await prisma.sponsor.findUnique({ where: { id: data.sponsorId } });
  if (!sponsor) throw new AppError(404, 'SPONSOR_NOT_FOUND', 'Patrocinador não encontrado');

  assertCan(actor, 'sponsors.manage', sponsor.organizationId);

  // Alvo do patrocínio precisa ser da mesma organização do patrocinador.
  for (const [campo, modelo] of [['eventId', 'event'], ['teamId', 'team'], ['athleteId', 'athlete']]) {
    if (!data[campo]) continue;
    const alvo = await prisma[modelo].findUnique({ where: { id: data[campo] } });
    if (!alvo || alvo.organizationId !== sponsor.organizationId) {
      throw new AppError(422, 'TARGET_INVALID', 'Alvo do patrocínio pertence a outra organização');
    }
  }

  const sponsorship = await prisma.sponsorship.create({ data });
  await audit.record({ actor, action: 'SPONSORSHIP_CREATE', entity: 'Sponsorship', entityId: sponsorship.id, organizationId: sponsor.organizationId, metadata: { sponsorId: data.sponsorId } });
  return sponsorship;
}

async function listSponsorships(filtros, actor) {
  const where = {};
  if (filtros.eventId) where.eventId = filtros.eventId;
  if (filtros.teamId) where.teamId = filtros.teamId;
  if (filtros.athleteId) where.athleteId = filtros.athleteId;
  if (filtros.sponsorId) where.sponsorId = filtros.sponsorId;

  if (!Object.keys(where).length && actor) {
    const escopo = organizationFilter(actor, filtros.organizationId);
    where.sponsor = escopo;
  }

  return prisma.sponsorship.findMany({
    where,
    include: {
      sponsor: { select: { id: true, name: true, brand: { select: { id: true, name: true, slug: true } } } },
      event: { select: { id: true, name: true, slug: true } },
      team: { select: { id: true, name: true } },
      athlete: { select: { id: true, fullName: true, stageName: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });
}

// ------------------------------------------------- PARCERIA ATLETA ↔ MARCA
async function createPartnership(data, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: data.athleteId } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const brand = await prisma.brand.findUnique({ where: { id: data.brandId } });
  if (!brand) throw new AppError(404, 'BRAND_NOT_FOUND', 'Marca não encontrada');
  if (brand.organizationId !== athlete.organizationId) throw new AppError(422, 'ORGANIZATION_MISMATCH', 'Atleta e marca de organizações diferentes');

  // O próprio atleta registra suas parcerias; um terceiro precisa de permissão.
  const ehODono = athlete.userId && athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'brands.manage', athlete.organizationId);

  try {
    return await prisma.athleteBrandPartnership.create({
      data: { athleteId: data.athleteId, brandId: data.brandId, scope: data.scope ?? null, startedAt: data.startedAt ?? null }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'PARTNERSHIP_EXISTS', 'Já existe parceria entre este atleta e esta marca');
    throw error;
  }
}

async function setPartnershipStatus(id, { status }, actor) {
  const parceria = await prisma.athleteBrandPartnership.findUnique({ where: { id } });
  if (!parceria) throw new AppError(404, 'PARTNERSHIP_NOT_FOUND', 'Parceria não encontrada');

  // O atleta é lido à parte, e não por `include`. A parceria não tem RLS — ela
  // é vitrine pública —, mas o atleta tem: pedir a relação obrigatória de
  // dentro de outra federação fazia o Prisma estourar 500 em cima de uma
  // negativa que já era correta. Mesma forma de `createPartnership`.
  const athlete = await prisma.athlete.findUnique({ where: { id: parceria.athleteId } });
  // 404, e não 403: o atleta invisível não vira sonda de ids válidos.
  if (!athlete) throw new AppError(404, 'PARTNERSHIP_NOT_FOUND', 'Parceria não encontrada');

  const ehODono = athlete.userId && athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'brands.manage', athlete.organizationId);

  return prisma.athleteBrandPartnership.update({
    where: { id },
    data: { status, endedAt: status === 'ENDED' ? new Date() : null }
  });
}

async function listPartnerships(filtros) {
  const where = {};
  if (filtros.athleteId) where.athleteId = filtros.athleteId;
  if (filtros.brandId) where.brandId = filtros.brandId;
  if (filtros.status) where.status = filtros.status;

  return prisma.athleteBrandPartnership.findMany({
    where,
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true } },
      brand: { select: { id: true, name: true, slug: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });
}

module.exports = {
  createTeam, listTeams, createCompany, listCompanies, createGym, listGyms, createCoach, listCoaches,
  createBrand, listBrands, createSponsor, listSponsors,
  createSponsorship, listSponsorships,
  createPartnership, setPartnershipStatus, listPartnerships
};
