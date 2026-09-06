const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');
const { assertCan, organizationFilter } = require('../utils/tenant');
const { can } = require('../utils/permissions');
const { assertTransition } = require('../utils/eventStates');
const audit = require('./auditService');
const notifications = require('./notificationService');

const ESTRUTURA = Object.freeze({
  eventCategories: {
    orderBy: { sortOrder: 'asc' },
    include: {
      category: { select: { id: true, code: true, name: true, sex: true } },
      divisions: {
        orderBy: { sortOrder: 'asc' },
        include: { classes: { orderBy: { sortOrder: 'asc' } } }
      }
    }
  }
});

async function carregar(id) {
  const event = await prisma.event.findUnique({ where: { id } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  return event;
}

async function create(data, actor) {
  assertCan(actor, 'events.create', data.organizationId);

  const existente = await prisma.event.findUnique({ where: { slug: data.slug } });
  if (existente) throw new AppError(409, 'SLUG_IN_USE', 'Já existe um evento com este slug');

  if (data.seasonId) {
    const temporada = await prisma.rankingSeason.findUnique({ where: { id: data.seasonId } });
    if (!temporada || temporada.organizationId !== data.organizationId) throw new AppError(422, 'SEASON_INVALID', 'Temporada inválida para esta organização');
  }

  const organization = await prisma.organization.findUnique({ where: { id: data.organizationId } });

  const event = await prisma.event.create({
    data: {
      organizationId: data.organizationId,
      name: data.name,
      slug: data.slug,
      description: data.description ?? null,
      // Fuso: o do evento, senão o da organização, senão o padrão da instalação.
      timezone: data.timezone || organization?.timezone || config.defaultTimezone,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      venue: data.venue ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      seasonId: data.seasonId ?? null,
      scoringRuleSetId: data.scoringRuleSetId ?? null,
      createdById: actor.id
    }
  });

  await audit.record({ actor, action: audit.ACTIONS.EVENT_CREATE, entity: 'Event', entityId: event.id, organizationId: event.organizationId, metadata: { slug: event.slug } });

  return event;
}

async function update(id, data, actor) {
  const event = await carregar(id);
  assertCan(actor, 'events.update', event.organizationId);

  // Evento encerrado ou cancelado não se edita: o registro histórico é o que
  // dá valor ao resultado publicado.
  if (['CLOSED', 'CANCELLED'].includes(event.status)) {
    throw new AppError(422, 'EVENT_IMMUTABLE', `Evento em ${event.status} não pode ser alterado`);
  }

  const atualizado = await prisma.event.update({ where: { id }, data });
  await audit.record({ actor, action: 'EVENT_UPDATE', entity: 'Event', entityId: id, organizationId: event.organizationId, metadata: { fields: Object.keys(data) } });
  return atualizado;
}

async function transition(id, { status, reason }, actor) {
  const event = await carregar(id);

  // Publicar resultado é permissão própria: mudar o evento para
  // RESULTS_PUBLISHED expõe resultados ao público.
  const permissao = status === 'RESULTS_PUBLISHED' ? 'events.publish' : 'events.update';
  assertCan(actor, permissao, event.organizationId);

  assertTransition(event.status, status);

  const atualizado = await prisma.event.update({ where: { id }, data: { status } });

  await audit.record({
    actor, action: audit.ACTIONS.EVENT_TRANSITION, entity: 'Event', entityId: id,
    organizationId: event.organizationId, metadata: { from: event.status, to: status, reason: reason ?? null }
  });

  if (status === 'RESULTS_PUBLISHED') {
    const audiencia = await notifications.eventAudience(id);
    await notifications.notify({
      userIds: audiencia.everyone, type: notifications.TYPES.RESULT_PUBLISHED,
      title: 'Resultados publicados', message: `Os resultados de ${event.name} foram publicados.`,
      entityType: 'Event', entityId: id, link: `#events/${event.slug}`, actorId: actor.id
    });
  }

  return atualizado;
}

async function remove(id, actor) {
  const event = await carregar(id);
  assertCan(actor, 'events.delete', event.organizationId);

  // Depois de existir inscrição, o evento faz parte do histórico esportivo do
  // atleta: cancela-se, não se apaga.
  const inscricoes = await prisma.registration.count({ where: { eventId: id } });
  if (inscricoes > 0) {
    throw new AppError(422, 'EVENT_HAS_REGISTRATIONS', 'Evento com inscrições não pode ser excluído; cancele-o');
  }
  if (event.status !== 'DRAFT') {
    throw new AppError(422, 'EVENT_NOT_DRAFT', 'Apenas eventos em rascunho podem ser excluídos');
  }

  await prisma.event.delete({ where: { id } });
  await audit.record({ actor, action: 'EVENT_DELETE', entity: 'Event', entityId: id, organizationId: event.organizationId });
  return { success: true };
}

async function list(filtros, actor) {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};

  const where = { ...escopo };
  if (filtros.status) where.status = filtros.status;
  if (filtros.search) where.name = { contains: filtros.search, mode: 'insensitive' };
  // Visitante e usuário sem acesso operacional não veem rascunho.
  if (!actor) where.status = filtros.status || { notIn: ['DRAFT', 'CANCELLED'] };

  const items = await prisma.event.findMany({
    where,
    orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {}),
    select: {
      id: true, name: true, slug: true, status: true, startDate: true, endDate: true,
      city: true, state: true, venue: true, timezone: true, organizationId: true,
      _count: { select: { registrations: true, eventCategories: true } }
    }
  });

  return { items, nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

async function findBySlugOrId(chave, actor) {
  const event = await prisma.event.findFirst({
    where: { OR: [{ id: chave }, { slug: chave }] },
    include: {
      ...ESTRUTURA,
      organization: { select: { id: true, name: true, slug: true } },
      season: { select: { id: true, name: true, year: true } },
      sponsorships: { where: { status: 'ACTIVE' }, include: { sponsor: { select: { id: true, name: true, brand: { select: { id: true, name: true, slug: true } } } } } },
      _count: { select: { registrations: true, batches: true, results: true } }
    }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  const podeVerRascunho = actor ? can(actor, 'events.update', event.organizationId) : false;
  if (event.status === 'DRAFT' && !podeVerRascunho) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  }

  return event;
}

// -------------------------------------------- categorias, divisões e classes
async function addCategory(eventId, data, actor) {
  const event = await carregar(eventId);
  assertCan(actor, 'events.update', event.organizationId);

  const categoria = await prisma.category.findUnique({ where: { id: data.categoryId } });
  if (!categoria || !categoria.active) throw new AppError(422, 'CATEGORY_INVALID', 'Categoria inválida ou inativa');

  try {
    return await prisma.eventCategory.create({
      data: { eventId, categoryId: data.categoryId, sortOrder: data.sortOrder ?? categoria.sortOrder },
      include: { category: true }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'CATEGORY_ALREADY_IN_EVENT', 'Categoria já está no evento');
    throw error;
  }
}

async function addDivision(eventCategoryId, data, actor) {
  const eventCategory = await prisma.eventCategory.findUnique({ where: { id: eventCategoryId }, include: { event: true } });
  if (!eventCategory) throw new AppError(404, 'EVENT_CATEGORY_NOT_FOUND', 'Categoria do evento não encontrada');
  assertCan(actor, 'events.update', eventCategory.event.organizationId);

  try {
    return await prisma.division.create({ data: { eventCategoryId, name: data.name, code: data.code, sortOrder: data.sortOrder ?? 0 } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'DIVISION_CODE_IN_USE', 'Já existe divisão com este código nesta categoria');
    throw error;
  }
}

async function addClass(divisionId, data, actor) {
  const division = await prisma.division.findUnique({
    where: { id: divisionId },
    include: { eventCategory: { include: { event: true } } }
  });
  if (!division) throw new AppError(404, 'DIVISION_NOT_FOUND', 'Divisão não encontrada');
  assertCan(actor, 'events.update', division.eventCategory.event.organizationId);

  try {
    return await prisma.competitionClass.create({ data: { divisionId, ...data, sortOrder: data.sortOrder ?? 0 } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'CLASS_CODE_IN_USE', 'Já existe classe com este código nesta divisão');
    throw error;
  }
}

// Catálogo global de categorias oficiais.
async function listCategories() {
  return prisma.category.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

async function createCategory(data, actor) {
  // O catálogo é global: gerenciá-lo não é permissão de um tenant.
  if (!can(actor, 'categories.manage')) throw new AppError(403, 'FORBIDDEN', 'Sem permissão para gerenciar o catálogo de categorias');

  try {
    return await prisma.category.create({ data: { ...data, sortOrder: data.sortOrder ?? 0 } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'CATEGORY_CODE_IN_USE', 'Já existe categoria com este código');
    throw error;
  }
}

module.exports = {
  create, update, transition, remove, list, findBySlugOrId,
  addCategory, addDivision, addClass, listCategories, createCategory, carregar
};
