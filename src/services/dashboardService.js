const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { organizationFilter } = require('../utils/tenant');
const { can } = require('../utils/permissions');

// Painéis. Toda métrica sai de contagem real no banco — nenhum número aqui é
// estimado, arredondado ou fabricado para preencher tela.

async function adminOverview(filtros, actor) {
  const escopo = organizationFilter(actor, filtros.organizationId);
  const eventoNoEscopo = Object.keys(escopo).length ? { event: escopo } : {};

  const [
    eventosAtivos, eventosTotais, atletas, atletasPro, inscricoes, checkins,
    pesagens, baterias, resultadosPublicados, importacoes, alertasEmpate, pendenciasImport
  ] = await Promise.all([
    prisma.event.count({ where: { ...escopo, status: { in: ['REGISTRATIONS_OPEN', 'REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING', 'RESULTS_IN_REVIEW'] } } }),
    prisma.event.count({ where: escopo }),
    prisma.athlete.count({ where: escopo }),
    prisma.athlete.count({ where: { ...escopo, proStatus: 'ACTIVE' } }),
    prisma.registration.count({ where: { ...eventoNoEscopo, status: 'CONFIRMED' } }),
    prisma.checkIn.count({ where: { status: 'CHECKED_IN', registration: eventoNoEscopo } }),
    prisma.weighIn.count({ where: { registration: eventoNoEscopo } }),
    prisma.stageBatch.count({ where: escopo.organizationId ? { event: escopo } : {} }),
    prisma.result.count({ where: { ...(escopo.organizationId ? { event: escopo } : {}), status: 'PUBLISHED' } }),
    prisma.muscleWarImport.count({ where: escopo }),
    prisma.result.count({ where: { ...(escopo.organizationId ? { event: escopo } : {}), hasUnresolvedTie: true } }),
    prisma.muscleWarImportItem.count({ where: { import: escopo, matchStatus: { in: ['MATCH_PENDING', 'CONFLICT'] } } })
  ]);

  const alertas = [];
  if (alertasEmpate > 0) alertas.push({ level: 'HIGH', code: 'TIE_UNRESOLVED', message: `${alertasEmpate} classe(s) com empate não resolvido` });
  if (pendenciasImport > 0) alertas.push({ level: 'NORMAL', code: 'IMPORT_PENDING', message: `${pendenciasImport} registro(s) do MuscleWar aguardando vinculação` });

  return {
    events: { active: eventosAtivos, total: eventosTotais },
    athletes: { total: atletas, pro: atletasPro },
    registrations: inscricoes,
    checkIns: checkins,
    weighIns: pesagens,
    batches: baterias,
    publishedResults: resultadosPublicados,
    muscleWarImports: importacoes,
    alerts: alertas
  };
}

async function athleteOverview(actor) {
  const athlete = await prisma.athlete.findUnique({
    where: { userId: actor.id },
    include: { team: true, coach: true, gym: true, affiliation: true }
  });

  const profile = await prisma.socialProfile.findUnique({
    where: { userId: actor.id },
    include: { _count: { select: { posts: true, followers: true, following: true } } }
  });

  if (!athlete) {
    // Usuário com conta mas sem perfil de atleta: a resposta diz isso em vez
    // de fingir um painel vazio.
    return { athlete: null, profile, registrations: [], upcoming: [], results: [], rankings: [], unreadMessages: 0 };
  }

  const [registrations, resultados, rankings, naoLidas] = await Promise.all([
    prisma.registration.findMany({
      where: { athleteId: athlete.id },
      include: {
        event: { select: { id: true, name: true, slug: true, status: true, startDate: true, city: true, state: true, timezone: true } },
        items: { include: { competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } }, stageOrders: { include: { batch: true } } } },
        checkIn: true,
        weighIns: { orderBy: { measuredAt: 'desc' }, take: 1 }
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    }),
    prisma.resultEntry.findMany({
      where: { athleteId: athlete.id, result: { status: 'PUBLISHED' } },
      include: {
        result: { select: { publishedAt: true, event: { select: { id: true, name: true, slug: true } } } },
        registrationItem: { include: { competitionClass: { select: { id: true, name: true } } } }
      },
      orderBy: { result: { publishedAt: 'desc' } },
      take: 30
    }),
    prisma.ranking.findMany({
      where: { athleteId: athlete.id },
      include: { season: { select: { id: true, name: true, year: true } }, category: { select: { id: true, code: true, name: true } } },
      orderBy: { totalPoints: 'desc' }
    }),
    profile ? prisma.message.count({
      where: {
        senderId: { not: profile.id },
        deletedAt: null,
        conversation: { members: { some: { profileId: profile.id, leftAt: null } } }
      }
    }) : Promise.resolve(0)
  ]);

  const agora = new Date();
  const agenda = registrations
    .filter(item => item.status === 'CONFIRMED' && item.event.startDate && item.event.startDate >= agora)
    .sort((a, b) => a.event.startDate - b.event.startDate);

  const titulos = resultados.filter(item => item.placing === 1).length;

  return {
    athlete,
    profile,
    registrations,
    upcoming: agenda,
    batches: registrations.flatMap(item => item.items.flatMap(sub => sub.stageOrders.map(order => ({ position: order.position, status: order.status, batch: order.batch })))),
    results: resultados,
    titles: titulos,
    rankings,
    unreadMessages: naoLidas,
    social: profile?._count ?? null
  };
}

async function summary(actor) {
  if (can(actor, 'analytics.read')) {
    return { kind: 'ADMIN', data: await adminOverview({}, actor) };
  }
  return { kind: 'ATHLETE', data: await athleteOverview(actor) };
}

// Painel operacional de um evento: o que o diretor precisa ver durante o dia.
async function eventOperations(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  if (!can(actor, 'analytics.read', event.organizationId)) throw new AppError(403, 'FORBIDDEN', 'Sem permissão para o painel operacional');

  const [inscritos, comCheckIn, pesados, credenciais, baterias, resultados] = await Promise.all([
    prisma.registration.count({ where: { eventId, status: 'CONFIRMED' } }),
    prisma.checkIn.count({ where: { status: 'CHECKED_IN', registration: { eventId } } }),
    prisma.weighIn.findMany({ where: { registration: { eventId } }, select: { registrationId: true }, distinct: ['registrationId'] }),
    prisma.credential.count({ where: { eventId, status: 'ACTIVE' } }),
    prisma.stageBatch.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } }),
    prisma.result.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } })
  ]);

  const paraMapa = linhas => Object.fromEntries(linhas.map(linha => [linha.status, linha._count._all]));

  return {
    event: { id: event.id, name: event.name, slug: event.slug, status: event.status, timezone: event.timezone },
    registrations: inscritos,
    checkedIn: comCheckIn,
    pendingCheckIn: inscritos - comCheckIn,
    weighedIn: pesados.length,
    credentials: credenciais,
    batches: paraMapa(baterias),
    results: paraMapa(resultados)
  };
}

module.exports = { adminOverview, athleteOverview, summary, eventOperations };
