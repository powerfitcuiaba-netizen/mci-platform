const prisma = require('../config/prisma');
const adminService = require('./adminService');
const coachService = require('./coachService');
const athleteService = require('./athleteService');
const backstageService = require('./backstageService');

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

const matchShape = {
  id: true, status: true, scheduledAt: true, phase: true,
  tournament: { select: { id: true, name: true } },
  participantA: { select: { id: true, name: true } },
  participantB: { select: { id: true, name: true } },
  result: { select: { scoreA: true, scoreB: true } }
};

// Cada perfil recebe o painel do seu trabalho. A composição reaproveita os
// services de cada área em vez de repetir a regra: o dashboard é uma vista, não
// uma segunda fonte de verdade.
async function summary(actor) {
  if (actor?.role === 'ADMIN') return { role: 'ADMIN', ...(await adminDashboard(actor)) };
  if (actor?.role === 'JUDGE') return { role: 'JUDGE', ...(await judgeDashboard(actor)) };
  if (actor?.role === 'COACH') return { role: 'COACH', ...(await coachDashboard(actor)) };
  if (actor?.role === 'ATHLETE') return { role: 'ATHLETE', ...(await athleteDashboard(actor)) };
  return { role: actor?.role || 'ORGANIZER', ...(await organizerDashboard(actor)) };
}

const unreadFor = actor => (actor ? prisma.notification.count({ where: { userId: actor.id, isRead: false } }) : Promise.resolve(0));

// ADMIN — retrato global da plataforma e as últimas ações auditadas.
async function adminDashboard(actor) {
  const [global, unread, live] = await Promise.all([
    adminService.overview(actor),
    unreadFor(actor),
    prisma.match.findMany({ where: { status: 'IN_PROGRESS' }, select: matchShape, orderBy: { scheduledAt: 'asc' }, take: 5 })
  ]);

  const alerts = [];
  if ((global.enrollments.porStatus?.CANCELLED || 0) > 0) {
    alerts.push({ level: 'INFO', code: 'CANCELLED_ENROLLMENTS', message: `${global.enrollments.porStatus.CANCELLED} inscrição(ões) cancelada(s) na plataforma.` });
  }
  if ((global.users.porPerfil?.ADMIN || 0) < 2) {
    alerts.push({ level: 'WARNING', code: 'SINGLE_ADMIN', message: 'A plataforma tem apenas um administrador.' });
  }

  return {
    totals: {
      users: global.users.total,
      tournaments: global.tournaments.total,
      participants: global.participants.total,
      enrollments: global.enrollments.total,
      matches: global.matches.total,
      auditLogs: global.totals.auditLogs,
      liveMatches: live.length,
      unreadNotifications: unread
    },
    usersByRole: global.users.porPerfil,
    tournamentsByStatus: global.tournaments.porStatus,
    participantsByType: global.participants.porTipo,
    enrollmentsByStatus: global.enrollments.porStatus,
    liveMatches: live,
    recentAudit: global.recentAudit,
    alerts
  };
}

// ORGANIZER — a operação dos próprios eventos, com o que exige atenção.
async function organizerDashboard(actor) {
  const scope = actor?.role === 'ORGANIZER' ? { createdById: actor.id } : {};
  const today = { gte: startOfToday(), lte: endOfToday() };

  const tournaments = await prisma.tournament.findMany({
    where: scope,
    select: {
      id: true, name: true, status: true, startDate: true, endDate: true,
      _count: { select: { enrollments: true, matches: true, judgeAssignments: true, documents: true } }
    },
    orderBy: { startDate: 'asc' }
  });
  const ids = tournaments.map(item => item.id);
  const escopoPartida = ids.length ? { tournamentId: { in: ids } } : { id: '__none__' };

  const [enrollments, checkedIn, judges, todayMatches, liveMatches, recentResults, unread, backstage] = await Promise.all([
    ids.length ? prisma.enrollment.count({ where: { tournamentId: { in: ids }, status: 'CONFIRMED' } }) : 0,
    ids.length ? prisma.checkIn.count({ where: { status: 'CHECKED_IN', enrollment: { tournamentId: { in: ids }, status: 'CONFIRMED' } } }) : 0,
    ids.length ? prisma.judgeAssignment.findMany({
      where: { tournamentId: { in: ids } },
      select: { id: true, tournament: { select: { id: true, name: true } }, judge: { select: { id: true, name: true } } }
    }) : [],
    prisma.match.findMany({ where: { ...escopoPartida, scheduledAt: today }, select: matchShape, orderBy: { scheduledAt: 'asc' } }),
    prisma.match.findMany({ where: { ...escopoPartida, status: 'IN_PROGRESS' }, select: matchShape, orderBy: { scheduledAt: 'asc' } }),
    prisma.result.findMany({
      where: ids.length ? { match: { tournamentId: { in: ids } } } : { id: '__none__' },
      select: {
        id: true, scoreA: true, scoreB: true, updatedAt: true,
        match: { select: { id: true, tournament: { select: { id: true, name: true } }, participantA: { select: { name: true } }, participantB: { select: { name: true } } } }
      },
      orderBy: { updatedAt: 'desc' },
      take: 5
    }),
    unreadFor(actor),
    actor ? backstageService.overview(actor) : Promise.resolve({ alerts: [], pendingResults: [] })
  ]);

  const [participants, teams] = await Promise.all([
    prisma.participant.count({ where: { type: 'PLAYER' } }),
    prisma.participant.count({ where: { type: 'TEAM' } })
  ]);

  const now = new Date();
  return {
    totals: {
      tournaments: tournaments.length,
      activeTournaments: tournaments.filter(item => item.status === 'ACTIVE').length,
      participants, teams, enrollments, checkedIn,
      judges: judges.length,
      todayMatches: todayMatches.length,
      liveMatches: liveMatches.length,
      pendingResults: backstage.pendingResults?.length || 0,
      unreadNotifications: unread
    },
    activeTournaments: tournaments.filter(item => item.status === 'ACTIVE').slice(0, 5),
    upcomingTournaments: tournaments.filter(item => item.startDate && item.startDate >= now).slice(0, 5),
    judges,
    todayMatches, liveMatches, recentResults,
    pendingResults: backstage.pendingResults || [],
    alerts: backstage.alerts || []
  };
}

// JUDGE — a agenda de arbitragem, separada por momento.
async function judgeDashboard(actor) {
  const assignments = await prisma.judgeAssignment.findMany({
    where: { judgeId: actor.id },
    select: { tournament: { select: { id: true, name: true, status: true } } }
  });
  const ids = assignments.map(item => item.tournament.id);

  if (!ids.length) {
    const unread = await unreadFor(actor);
    return {
      totals: { assignments: 0, todayMatches: 0, upcoming: 0, finished: 0, pendingResults: 0, unreadNotifications: unread },
      tournaments: [], todayMatches: [], upcomingMatches: [], finishedMatches: [], pendingResults: []
    };
  }

  const [matches, unread] = await Promise.all([
    prisma.match.findMany({ where: { tournamentId: { in: ids } }, select: matchShape, orderBy: { scheduledAt: 'asc' } }),
    unreadFor(actor)
  ]);

  const inicio = startOfToday(); const fim = endOfToday(); const agora = new Date();
  const doDia = matches.filter(m => m.scheduledAt && m.scheduledAt >= inicio && m.scheduledAt <= fim);
  const proximas = matches.filter(m => m.status === 'SCHEDULED' && m.scheduledAt && m.scheduledAt > fim);
  const concluidas = matches.filter(m => m.result);
  // Pendência do juiz: partida que já passou ou encerrou e segue sem resultado.
  const pendentes = matches.filter(m => !m.result && m.status !== 'CANCELLED' && (m.status === 'FINISHED' || m.status === 'IN_PROGRESS' || (m.scheduledAt && m.scheduledAt < agora)));

  return {
    totals: {
      assignments: ids.length,
      todayMatches: doDia.length,
      upcoming: proximas.length,
      finished: concluidas.length,
      pendingResults: pendentes.length,
      unreadNotifications: unread
    },
    tournaments: assignments.map(item => item.tournament),
    todayMatches: doDia,
    upcomingMatches: proximas.slice(0, 8),
    finishedMatches: concluidas.slice(-8).reverse(),
    pendingResults: pendentes
  };
}

// COACH — o elenco e a agenda de quem ele treina.
async function coachDashboard(actor) {
  const [visao, unread] = await Promise.all([coachService.overview(actor), unreadFor(actor)]);
  const agora = new Date();
  const proximas = (visao.matches || []).filter(m => !m.result && (!m.scheduledAt || m.scheduledAt >= agora));
  const resultados = (visao.matches || []).filter(m => m.result);

  return {
    totals: { ...visao.totals, results: resultados.length, unreadNotifications: unread },
    teams: visao.teams,
    athletes: visao.athletes,
    tournaments: visao.tournaments,
    upcomingMatches: proximas.slice(0, 8),
    recentMatches: resultados.slice(-8).reverse(),
    standings: visao.standings
  };
}

// ATHLETE — a própria carreira.
async function athleteDashboard(actor) {
  const visao = await athleteService.overview(actor);
  const agora = new Date();
  const proximas = (visao.matches || []).filter(m => !m.result && (!m.scheduledAt || m.scheduledAt >= agora));

  return {
    semVinculo: visao.semVinculo,
    profile: visao.profile,
    participant: visao.participant,
    team: visao.team,
    coach: visao.coach,
    totals: visao.totals,
    enrollments: visao.enrollments,
    upcomingMatches: proximas.slice(0, 8),
    results: (visao.results || []).slice(-8).reverse(),
    standings: visao.standings,
    documents: visao.documents
  };
}

module.exports = { summary };
