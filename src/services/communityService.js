const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { can } = require('../utils/permissions');
const { profilePublic } = require('../utils/visibility');

// Comunidades da MCI: espaços temáticos (categorias, atletas PRO, coaches,
// academias, o próprio campeonato). Comunidade privada só é lida por membro.

async function meuPerfil(userId) {
  const profile = await prisma.socialProfile.findUnique({ where: { userId } });
  if (!profile) throw new AppError(404, 'PROFILE_NOT_FOUND', 'Perfil social não encontrado');
  return profile;
}

async function create(userId, data, actor) {
  if (!can(actor, 'communities.manage')) throw new AppError(403, 'FORBIDDEN', 'Sem permissão para criar comunidades');
  const profile = await meuPerfil(userId);

  try {
    const community = await prisma.community.create({ data });
    await prisma.communityMember.create({ data: { communityId: community.id, profileId: profile.id, role: 'ADMIN' } });
    return community;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SLUG_IN_USE', 'Já existe comunidade com este identificador');
    throw error;
  }
}

async function list(userId, filtros) {
  const profile = userId ? await prisma.socialProfile.findUnique({ where: { userId } }) : null;

  // Privadas só aparecem para quem é membro.
  const where = profile
    ? { OR: [{ visibility: 'PUBLIC' }, { members: { some: { profileId: profile.id } } }] }
    : { visibility: 'PUBLIC' };

  const items = await prisma.community.findMany({
    where,
    include: { _count: { select: { members: true, posts: true } } },
    orderBy: { name: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  const meus = profile
    ? new Set((await prisma.communityMember.findMany({ where: { profileId: profile.id }, select: { communityId: true } })).map(item => item.communityId))
    : new Set();

  return {
    items: items.map(item => ({ ...item, isMember: meus.has(item.id) })),
    nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null
  };
}

async function findBySlug(slug, userId) {
  const community = await prisma.community.findUnique({
    where: { slug },
    include: { _count: { select: { members: true, posts: true } } }
  });
  if (!community) throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');

  const profile = userId ? await prisma.socialProfile.findUnique({ where: { userId } }) : null;
  const membro = profile
    ? await prisma.communityMember.findUnique({ where: { communityId_profileId: { communityId: community.id, profileId: profile.id } } })
    : null;

  if (community.visibility === 'PRIVATE' && !membro) {
    throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');
  }

  return { community, membership: membro, isMember: Boolean(membro) };
}

async function join(slug, userId) {
  const profile = await meuPerfil(userId);
  const community = await prisma.community.findUnique({ where: { slug } });
  if (!community) throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');

  // Entrar sozinho numa comunidade privada tornaria "privada" só um rótulo.
  if (community.visibility === 'PRIVATE') {
    throw new AppError(403, 'INVITE_ONLY', 'Comunidade privada: a entrada é por convite de um administrador');
  }

  try {
    return await prisma.communityMember.create({ data: { communityId: community.id, profileId: profile.id } });
  } catch (error) {
    if (error.code === 'P2002') return { alreadyMember: true };
    throw error;
  }
}

async function leave(slug, userId) {
  const profile = await meuPerfil(userId);
  const community = await prisma.community.findUnique({ where: { slug } });
  if (!community) throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');

  await prisma.communityMember.deleteMany({ where: { communityId: community.id, profileId: profile.id } });
  return { success: true };
}

async function addMember(slug, userId, { profileId, role }) {
  const profile = await meuPerfil(userId);
  const community = await prisma.community.findUnique({ where: { slug } });
  if (!community) throw new AppError(404, 'COMMUNITY_NOT_FOUND', 'Comunidade não encontrada');

  const admin = await prisma.communityMember.findUnique({
    where: { communityId_profileId: { communityId: community.id, profileId: profile.id } }
  });
  if (!admin || admin.role !== 'ADMIN') throw new AppError(403, 'FORBIDDEN', 'Apenas administradores da comunidade convidam');

  try {
    return await prisma.communityMember.create({ data: { communityId: community.id, profileId, role: role || 'MEMBER' } });
  } catch (error) {
    if (error.code === 'P2002') return { alreadyMember: true };
    throw error;
  }
}

async function listMembers(slug, userId, filtros) {
  const { community } = await findBySlug(slug, userId);

  const membros = await prisma.communityMember.findMany({
    where: { communityId: community.id },
    include: { profile: true },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: membros.map(membro => ({ ...profilePublic(membro.profile), role: membro.role, joinedAt: membro.joinedAt })),
    nextCursor: membros.length === filtros.limit ? membros[membros.length - 1].id : null
  };
}

module.exports = { create, list, findBySlug, join, leave, addMember, listMembers };
