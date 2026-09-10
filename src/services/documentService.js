const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { can } = require('../utils/permissions');
const storage = require('./storageService');
const audit = require('./auditService');

// Documentos de atleta (privados) e de evento (privados por padrão, públicos
// só quando marcados). A chave de armazenamento nunca vem do cliente e o
// download passa sempre por autorização — conhecer a chave não dá acesso.

async function uploadAthleteDocument(athleteId, arquivo, data, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const ehODono = athlete.userId && athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'documents.upload', athlete.organizationId);

  if (!storage.isAllowedMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de arquivo não aceito: ${arquivo.mimeType}`);
  }

  const key = storage.buildKey(`athletes/${athleteId}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const documento = await prisma.athleteDocument.create({
    data: {
      athleteId,
      kind: data.kind || 'OTHER',
      title: data.title || arquivo.originalName || 'Documento',
      fileName: arquivo.originalName || 'documento',
      mimeType: arquivo.mimeType,
      storageKey: key,
      sizeBytes: arquivo.buffer.length,
      uploadedById: actor.id
    }
  });

  await audit.record({ actor, action: 'DOCUMENT_UPLOAD', entity: 'AthleteDocument', entityId: documento.id, organizationId: athlete.organizationId, metadata: { athleteId, kind: documento.kind } });

  return documento;
}

async function listAthleteDocuments(athleteId, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const ehODono = athlete.userId && athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'documents.read', athlete.organizationId);

  return prisma.athleteDocument.findMany({
    where: { athleteId },
    select: { id: true, kind: true, title: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
}

async function downloadAthleteDocument(id, actor) {
  const documento = await prisma.athleteDocument.findUnique({ where: { id }, include: { athlete: true } });
  if (!documento) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  const ehODono = documento.athlete.userId && documento.athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'documents.read', documento.athlete.organizationId);

  if (!(await storage.exists(documento.storageKey))) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo indisponível');

  await audit.record({ actor, action: 'DOCUMENT_DOWNLOAD', entity: 'AthleteDocument', entityId: id, organizationId: documento.athlete.organizationId });

  return { stream: storage.createReadStream(documento.storageKey), document: documento };
}

async function deleteAthleteDocument(id, actor) {
  const documento = await prisma.athleteDocument.findUnique({ where: { id }, include: { athlete: true } });
  if (!documento) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  assertCan(actor, 'documents.delete', documento.athlete.organizationId);

  await prisma.athleteDocument.delete({ where: { id } });
  await storage.remove(documento.storageKey).catch(() => false);

  await audit.record({ actor, action: 'DOCUMENT_DELETE', entity: 'AthleteDocument', entityId: id, organizationId: documento.athlete.organizationId });
  return { success: true };
}

// ---------------------------------------------------------- documentos de evento
async function uploadEventDocument(eventId, arquivo, data, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  assertCan(actor, 'documents.upload', event.organizationId);

  if (!storage.isAllowedMime(arquivo.mimeType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo de arquivo não aceito: ${arquivo.mimeType}`);
  }

  const key = storage.buildKey(`events/${eventId}`, arquivo.mimeType);
  await storage.saveBuffer(key, arquivo.buffer);

  const documento = await prisma.eventDocument.create({
    data: {
      eventId,
      title: data.title || arquivo.originalName || 'Documento',
      fileName: arquivo.originalName || 'documento',
      mimeType: arquivo.mimeType,
      storageKey: key,
      sizeBytes: arquivo.buffer.length,
      isPublic: Boolean(data.isPublic),
      uploadedById: actor.id
    }
  });

  await audit.record({ actor, action: 'DOCUMENT_UPLOAD', entity: 'EventDocument', entityId: documento.id, organizationId: event.organizationId, metadata: { eventId, isPublic: documento.isPublic } });

  return documento;
}

async function listEventDocuments(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  const podeVerPrivados = actor ? can(actor, 'documents.read', event.organizationId) : false;

  return prisma.eventDocument.findMany({
    where: { eventId, ...(podeVerPrivados ? {} : { isPublic: true }) },
    select: { id: true, title: true, fileName: true, mimeType: true, sizeBytes: true, isPublic: true, createdAt: true },
    orderBy: { createdAt: 'desc' }
  });
}

async function downloadEventDocument(id, actor) {
  const documento = await prisma.eventDocument.findUnique({ where: { id }, include: { event: true } });
  if (!documento) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Documento não encontrado');

  if (!documento.isPublic) assertCan(actor, 'documents.read', documento.event.organizationId);

  if (!(await storage.exists(documento.storageKey))) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo indisponível');

  return { stream: storage.createReadStream(documento.storageKey), document: documento };
}

// Mídia social: a chave está no banco, mas o acesso segue a visibilidade da
// publicação.
async function downloadPostMedia(mediaId, actor) {
  const media = await prisma.postMedia.findUnique({ where: { id: mediaId }, include: { post: true } });
  if (!media || media.post.deletedAt) throw new AppError(404, 'MEDIA_NOT_FOUND', 'Mídia não encontrada');

  const social = require('./socialService');
  const profile = actor ? await prisma.socialProfile.findUnique({ where: { userId: actor.id } }) : null;
  await social.postVisivel(media.postId, profile?.id);

  if (!(await storage.exists(media.storageKey))) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo indisponível');

  return { stream: storage.createReadStream(media.storageKey), mimeType: media.mimeType };
}

async function downloadStoryMedia(storyId, actor) {
  const story = await prisma.story.findUnique({ where: { id: storyId } });
  if (!story || story.expiresAt <= new Date()) throw new AppError(404, 'STORY_NOT_FOUND', 'Story não encontrado ou expirado');

  const profile = actor ? await prisma.socialProfile.findUnique({ where: { userId: actor.id } }) : null;
  if (!profile) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');

  if (story.authorId !== profile.id) {
    const segue = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: profile.id, followingId: story.authorId } }
    });
    if (!segue) throw new AppError(403, 'FORBIDDEN', 'Story de perfil que você não segue');
  }

  if (!(await storage.exists(story.storageKey))) throw new AppError(404, 'FILE_NOT_FOUND', 'Arquivo indisponível');
  return { stream: storage.createReadStream(story.storageKey), mimeType: story.mimeType };
}

module.exports = {
  uploadAthleteDocument, listAthleteDocuments, downloadAthleteDocument, deleteAthleteDocument,
  uploadEventDocument, listEventDocuments, downloadEventDocument,
  downloadPostMedia, downloadStoryMedia
};
