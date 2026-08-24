const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

async function list(actor) {
  const where = actor.role === 'ADMIN' ? {} : actor.role === 'ORGANIZER' ? { tournament: { createdById: actor.id } } : { tournament: { OR: [{ createdById: actor.id }, { enrollments: { some: { participant: { userId: actor.id } } } }] } };
  const items = await prisma.document.findMany({
    where,
    include: { tournament: true },
    orderBy: { createdAt: 'desc' }
  });
  return { items };
}

async function create(data, actor) {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para criar documentos');
  const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (actor.role !== 'ADMIN' && tournament.createdById !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este campeonato');
  return prisma.document.create({ data: { ...data, uploadedById: actor.id }, include: { tournament: true } });
}

async function findById(id, actor) {
  const item = await prisma.document.findUnique({ where: { id }, include: { tournament: true } });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');
  if (actor.role === 'ADMIN') return item;
  if (actor.role === 'ORGANIZER' && item.tournament.createdById === actor.id) return item;
  if (actor.role === 'ATHLETE' && item.tournament.enrollments?.some) return item;
  throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso a este documento');
}

async function remove(id, actor) {
  const item = await prisma.document.findUnique({ where: { id }, include: { tournament: true } });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');
  if (actor.role !== 'ADMIN' && item.tournament.createdById !== actor.id) throw new AppError(403, 'FORBIDDEN', 'Você não pode excluir este documento');
  await prisma.document.delete({ where: { id } });
}

module.exports = { list, create, findById, remove };
