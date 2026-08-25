const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const storage = require('./storageService');
const auditService = require('./auditService');

// Só o que a interface precisa. A chave de armazenamento nunca sai daqui: o
// cliente referencia o documento pelo id, e o download é servido pelo servidor.
const publicShape = {
  id: true,
  tournamentId: true,
  title: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
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

const podeGravar = (tournament, actor) =>
  actor.role === 'ADMIN' || tournament.createdById === actor.id;

async function assertTournamentWritable(tournamentId, actor) {
  const tournament = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (!podeGravar(tournament, actor)) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode adicionar documentos a este campeonato');
  }
  return tournament;
}

async function list(actor, tournamentId) {
  const scope = actor.role === 'ADMIN'
    ? {}
    : actor.role === 'ORGANIZER'
      ? { tournament: { createdById: actor.id } }
      : { tournament: viewerScope(actor.id) };

  const where = tournamentId ? { AND: [scope, { tournamentId }] } : scope;

  const items = await prisma.document.findMany({ where, select: publicShape, orderBy: { createdAt: 'desc' } });
  return { items };
}

// Aceita apenas o nome do arquivo. Qualquer separador de caminho ou salto de
// diretório é rejeitado antes de tocar no banco. Vale tanto para o registro de
// metadados quanto para o nome original de um envio.
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

// Registro por metadados: o documento existe como referência, sem arquivo.
async function create(data, actor) {
  await assertTournamentWritable(data.tournamentId, actor);

  const documento = await prisma.document.create({
    data: { ...data, fileName: safeFileName(data.fileName), uploadedById: actor.id },
    select: publicShape
  });

  await auditService.record({
    actor, action: 'DOCUMENT_CREATE', entity: 'Document', entityId: documento.id,
    metadata: { tournamentId: data.tournamentId, title: documento.title, comArquivo: false }
  });

  return documento;
}

// Envio com arquivo. A autorização é resolvida antes de gravar em disco, para
// que uma requisição negada não deixe resíduo em uploads/.
async function createWithFile(data, file, actor) {
  const tournament = await assertTournamentWritable(data.tournamentId, actor);

  const nomeOriginal = safeFileName(data.fileName || file.originalName || 'arquivo');
  const key = storage.buildKey(tournament.id, file.mimeType);
  const { sizeBytes } = await storage.saveBuffer(key, file.buffer);

  try {
    const documento = await prisma.document.create({
      data: {
        tournamentId: tournament.id,
        title: String(data.title || nomeOriginal).trim().slice(0, 180),
        fileName: nomeOriginal,
        mimeType: file.mimeType,
        storageKey: key,
        sizeBytes,
        uploadedById: actor.id
      },
      select: publicShape
    });

    await auditService.record({
      actor, action: 'DOCUMENT_UPLOAD', entity: 'Document', entityId: documento.id,
      metadata: { tournamentId: tournament.id, title: documento.title, sizeBytes, mimeType: file.mimeType }
    });

    return documento;
  } catch (error) {
    // O registro falhou: o arquivo não pode ficar órfão no disco.
    await storage.remove(key).catch(() => {});
    throw error;
  }
}

async function assertReadable(id, actor) {
  const item = await prisma.document.findUnique({
    where: { id },
    select: { ...publicShape, storageKey: true, tournament: { select: { id: true, name: true, status: true, createdById: true } } }
  });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  if (actor.role === 'ADMIN') return item;
  if (item.tournament.createdById === actor.id) return item;

  const vinculado = await prisma.tournament.findFirst({
    where: { AND: [{ id: item.tournamentId }, viewerScope(actor.id)] },
    select: { id: true }
  });
  if (vinculado) return item;

  throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso a este documento');
}

async function findById(id, actor) {
  const item = await assertReadable(id, actor);
  const { storageKey, ...visivel } = item;
  return { ...visivel, hasFile: Boolean(storageKey) };
}

// Devolve o stream para o controller servir. A mesma regra de leitura do
// findById se aplica: quem não pode ver o registro não baixa o arquivo.
async function download(id, actor) {
  const item = await assertReadable(id, actor);

  if (!item.storageKey) {
    throw new AppError(409, 'DOCUMENT_HAS_NO_FILE', 'Este documento é apenas um registro e não possui arquivo');
  }
  if (!await storage.exists(item.storageKey)) {
    throw new AppError(410, 'DOCUMENT_FILE_MISSING', 'O arquivo deste documento não está mais disponível');
  }

  await auditService.record({
    actor, action: 'DOCUMENT_DOWNLOAD', entity: 'Document', entityId: item.id,
    metadata: { tournamentId: item.tournamentId }
  });

  return {
    stream: storage.createReadStream(item.storageKey),
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes
  };
}

async function remove(id, actor) {
  const item = await prisma.document.findUnique({ where: { id }, include: { tournament: true } });
  if (!item) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');
  if (actor.role !== 'ADMIN' && item.tournament.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode excluir este documento');
  }

  await prisma.document.delete({ where: { id } });
  if (item.storageKey) await storage.remove(item.storageKey).catch(() => {});

  await auditService.record({
    actor, action: 'DOCUMENT_DELETE', entity: 'Document', entityId: id,
    metadata: { tournamentId: item.tournamentId, title: item.title }
  });
}

module.exports = { list, create, createWithFile, findById, download, remove, safeFileName };
