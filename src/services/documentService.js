const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

// Só o que a interface precisa. Caminho interno de armazenamento nunca sai daqui.
const publicShape = {
  id: true,
  tournamentId: true,
  title: true,
  fileName: true,
  mimeType: true,
  createdAt: true,
  tournament: { select: { id: true, name: true, status: true } },
  uploadedBy: { select: { id: true, name: true } }
};

// Vínculo do usuário com o campeonato: inscrito como atleta ou técnico de um inscrito.
const viewerScope = actorId => ({
  OR: [
    { createdById: actorId },
    { enrollments: { some: { participant: { userId: actorId } } } },
    { enrollments: { some: { participant: { coachId: actorId } } } }
  ]
});

async function list(actor, tournamentId) {
  const scope = actor.role === 'ADMIN'
    ? {}
    : actor.role === 'ORGANIZER'
      ? { tournament: { createdById: actor.id } }
      : { tournament: viewerScope(actor.id) };

  const where = tournamentId ? { AND: [scope, { tournamentId }] } : scope;

  const items = await prisma.document.findMany({
    where,
    select: publicShape,
    orderBy: { createdAt: 'desc' }
  });
  return { items };
}

async function create(data, actor) {
  const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (actor.role !== 'ADMIN' && tournament.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode adicionar documentos a este campeonato');
  }

  return prisma.document.create({
    data: { ...data, fileName: safeFileName(data.fileName), uploadedById: actor.id },
    select: publicShape
  });
}

// Aceita apenas o nome do arquivo. Qualquer separador de caminho ou salto de
// diretório é rejeitado antes de tocar no banco.
function safeFileName(value) {
  const name = String(value || '').trim();
  if (!name) throw new AppError(422, 'INVALID_FILE_NAME', 'Nome de arquivo é obrigatório');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new AppError(422, 'INVALID_FILE_NAME', 'Nome de arquivo não pode conter caminho');
  }
  if (name === '.' || name === '..' || name.startsWith('..')) {
    throw new AppError(422, 'INVALID_FILE_NAME', 'Nome de arquivo inválido');
  }
  if (name.length > 255) throw new AppError(422, 'INVALID_FILE_NAME', 'Nome de arquivo muito longo');
  return name;
}

async function findById(id, actor) {
  const item = await prisma.document.findUnique({
    where: { id },
    select: { ...publicShape, tournament: { select: { id: true, name: true, status: true, createdById: true } } }
  });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  if (actor.role === 'ADMIN') return item;
  if (item.tournament.createdById === actor.id) return item;

  // Leitura para quem participa do campeonato, verificada no banco.
  const linked = await prisma.tournament.findFirst({
    where: { AND: [{ id: item.tournamentId }, viewerScope(actor.id)] },
    select: { id: true }
  });
  if (linked) return item;

  throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso a este documento');
}

async function remove(id, actor) {
  const item = await prisma.document.findUnique({ where: { id }, include: { tournament: true } });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');
  if (actor.role !== 'ADMIN' && item.tournament.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode excluir este documento');
  }
  await prisma.document.delete({ where: { id } });
}

module.exports = { list, create, findById, remove, safeFileName };
