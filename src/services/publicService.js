const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { athletePublic } = require('../utils/visibility');

// Vitrine pública: só dado público, e sempre da base real.
// Nenhuma rota daqui expõe CPF, telefone, e-mail, documento ou resultado ainda
// não publicado.

const EVENTOS_VISIVEIS = Object.freeze(['PLANNED', 'REGISTRATIONS_OPEN', 'REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING', 'RESULTS_IN_REVIEW', 'RESULTS_PUBLISHED', 'CLOSED']);

async function summary() {
  const [eventos, atletas, pros, resultados, temporadas] = await Promise.all([
    prisma.event.count({ where: { status: { in: EVENTOS_VISIVEIS } } }),
    prisma.athlete.count(),
    prisma.athlete.count({ where: { proStatus: 'ACTIVE' } }),
    prisma.result.count({ where: { status: 'PUBLISHED' } }),
    prisma.rankingSeason.count({ where: { status: 'OPEN' } })
  ]);

  const proximos = await prisma.event.findMany({
    where: { status: { in: ['PLANNED', 'REGISTRATIONS_OPEN'] }, startDate: { gte: new Date() } },
    select: { id: true, name: true, slug: true, startDate: true, city: true, state: true, venue: true },
    orderBy: { startDate: 'asc' },
    take: 5
  });

  return { events: eventos, athletes: atletas, proAthletes: pros, publishedResults: resultados, openSeasons: temporadas, upcoming: proximos };
}

async function listEvents(filtros) {
  const items = await prisma.event.findMany({
    where: { status: { in: EVENTOS_VISIVEIS }, ...(filtros.search ? { name: { contains: filtros.search, mode: 'insensitive' } } : {}) },
    select: {
      id: true, name: true, slug: true, status: true, startDate: true, endDate: true,
      city: true, state: true, venue: true, description: true,
      organization: { select: { id: true, name: true, slug: true } },
      _count: { select: { registrations: true } }
    },
    // Mesma direção da listagem de operação: as duas telas mostram o mesmo
    // calendário e discordar seria defeito. O `createdAt` entra como segundo
    // critério porque sem ele a ordem entre etapas do MESMO dia é indefinida,
    // e ordem indefinida com cursor pode repetir ou pular linha entre páginas.
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return { items, nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

// Página pública do campeonato: agenda, categorias, atletas, resultados
// publicados, patrocinadores e conteúdo social do evento.
async function eventPage(slug) {
  const event = await prisma.event.findUnique({
    where: { slug },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
      eventCategories: {
        orderBy: { sortOrder: 'asc' },
        include: { category: true, divisions: { orderBy: { sortOrder: 'asc' }, include: { classes: { orderBy: { sortOrder: 'asc' } } } } }
      },
      batches: {
        orderBy: [{ sortOrder: 'asc' }, { scheduledAt: 'asc' }],
        include: { competitionClass: { select: { id: true, name: true } } }
      },
      sponsorships: { where: { status: 'ACTIVE' }, include: { sponsor: { select: { id: true, name: true, brand: { select: { id: true, name: true, slug: true } } } } } }
    }
  });

  if (!event || !EVENTOS_VISIVEIS.includes(event.status)) {
    throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  }

  const resultados = await prisma.result.findMany({
    where: { eventId: event.id, status: 'PUBLISHED' },
    include: {
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } },
      entries: {
        where: { status: 'RANKED' },
        include: { athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true, state: true, city: true, team: { select: { id: true, name: true } } } } },
        orderBy: { placing: 'asc' }
      }
    },
    orderBy: { publishedAt: 'asc' }
  });

  const atletas = await prisma.registration.findMany({
    where: { eventId: event.id, status: 'CONFIRMED' },
    select: { athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } } },
    orderBy: { athlete: { fullName: 'asc' } },
    take: 500
  });

  const posts = await prisma.post.findMany({
    where: { eventId: event.id, visibility: 'PUBLIC', deletedAt: null },
    include: { author: true, media: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  return {
    event: {
      id: event.id, name: event.name, slug: event.slug, description: event.description,
      status: event.status, startDate: event.startDate, endDate: event.endDate,
      venue: event.venue, city: event.city, state: event.state, timezone: event.timezone,
      organization: event.organization
    },
    categories: event.eventCategories,
    schedule: event.batches,
    athletes: atletas.map(item => item.athlete),
    results: resultados,
    sponsors: event.sponsorships.map(item => item.sponsor),
    posts: posts.map(post => ({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      author: { id: post.author.id, handle: post.author.handle, displayName: post.author.displayName, avatarKey: post.author.avatarKey },
      media: post.media.map(item => ({ id: item.id, kind: item.kind }))
    }))
  };
}

async function athletePage(id) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    include: {
      team: { select: { id: true, name: true } },
      coach: { select: { id: true, name: true } },
      gym: { select: { id: true, name: true } },
      affiliation: { select: { id: true, name: true, code: true } },
      socialProfile: { select: { id: true, handle: true, displayName: true, avatarKey: true, bio: true, isPrivate: true } }
    }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  const resultados = await prisma.resultEntry.findMany({
    where: { athleteId: id, result: { status: 'PUBLISHED' } },
    include: {
      result: { select: { publishedAt: true, event: { select: { id: true, name: true, slug: true, startDate: true } } } },
      registrationItem: { include: { competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } } } }
    },
    orderBy: { result: { publishedAt: 'desc' } },
    take: 100
  });

  const rankings = await prisma.ranking.findMany({
    where: { athleteId: id },
    include: { season: { select: { id: true, name: true, year: true } }, category: { select: { id: true, code: true, name: true } } },
    orderBy: { totalPoints: 'desc' }
  });

  return {
    athlete: { ...athletePublic(athlete), socialProfile: athlete.socialProfile },
    results: resultados.map(entry => ({
      placing: entry.placing,
      status: entry.status,
      event: entry.result.event,
      publishedAt: entry.result.publishedAt,
      competitionClass: entry.registrationItem.competitionClass
    })),
    titles: resultados.filter(entry => entry.placing === 1).length,
    rankings
  };
}

async function listAthletes(filtros) {
  const items = await prisma.athlete.findMany({
    where: filtros.search ? { OR: [{ fullName: { contains: filtros.search, mode: 'insensitive' } }, { stageName: { contains: filtros.search, mode: 'insensitive' } }] } : {},
    include: { team: { select: { id: true, name: true } }, gym: { select: { id: true, name: true } }, coach: { select: { id: true, name: true } }, affiliation: { select: { id: true, name: true, code: true } } },
    orderBy: { fullName: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return { items: items.map(athletePublic), nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null };
}

module.exports = { summary, listEvents, eventPage, athletePage, listAthletes, EVENTOS_VISIVEIS };
