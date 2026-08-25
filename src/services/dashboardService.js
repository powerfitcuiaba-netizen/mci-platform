const prisma = require('../config/prisma');

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

// O dashboard mostra a operação que o usuário realmente enxerga: o organizador
// vê os próprios campeonatos, o ADMIN vê tudo, os demais veem o cenário público.
const tournamentScope = actor => (actor?.role === 'ORGANIZER' ? { createdById: actor.id } : {});

async function summary(actor) {
  const scope = tournamentScope(actor);
  const today = { gte: startOfToday(), lte: endOfToday() };

  const tournaments = await prisma.tournament.findMany({
    where: scope,
    select: { id: true, name: true, status: true, startDate: true, endDate: true, _count: { select: { enrollments: true, matches: true } } },
    orderBy: { startDate: 'asc' }
  });
  const tournamentIds = tournaments.map(item => item.id);

  const matchScope = tournamentIds.length ? { tournamentId: { in: tournamentIds } } : { id: '__none__' };

  const [participants, teams, enrollments, checkedIn, todayMatches, liveMatches, recentResults, unread] = await Promise.all([
    prisma.participant.count({ where: { type: 'PLAYER' } }),
    prisma.participant.count({ where: { type: 'TEAM' } }),
    tournamentIds.length ? prisma.enrollment.count({ where: { tournamentId: { in: tournamentIds } } }) : 0,
    tournamentIds.length ? prisma.checkIn.count({ where: { status: 'CHECKED_IN', enrollment: { tournamentId: { in: tournamentIds } } } }) : 0,
    prisma.match.findMany({
      where: { ...matchScope, scheduledAt: today },
      select: {
        id: true, status: true, scheduledAt: true, phase: true,
        tournament: { select: { id: true, name: true } },
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.match.findMany({
      where: { ...matchScope, status: 'IN_PROGRESS' },
      select: {
        id: true, status: true, scheduledAt: true,
        tournament: { select: { id: true, name: true } },
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.result.findMany({
      where: tournamentIds.length ? { match: { tournamentId: { in: tournamentIds } } } : { id: '__none__' },
      select: {
        id: true, scoreA: true, scoreB: true, winnerParticipantId: true, updatedAt: true,
        match: {
          select: {
            id: true,
            tournament: { select: { id: true, name: true } },
            participantA: { select: { id: true, name: true } },
            participantB: { select: { id: true, name: true } }
          }
        }
      },
      orderBy: { updatedAt: 'desc' },
      take: 5
    }),
    actor ? prisma.notification.count({ where: { userId: actor.id, isRead: false } }) : 0
  ]);

  const now = new Date();

  return {
    totals: {
      activeTournaments: tournaments.filter(item => item.status === 'ACTIVE').length,
      plannedTournaments: tournaments.filter(item => item.status === 'PLANNED').length,
      tournaments: tournaments.length,
      participants,
      teams,
      enrollments,
      checkedIn,
      todayMatches: todayMatches.length,
      liveMatches: liveMatches.length,
      unreadNotifications: unread
    },
    activeTournaments: tournaments.filter(item => item.status === 'ACTIVE').slice(0, 5),
    upcomingTournaments: tournaments.filter(item => item.startDate && item.startDate >= now).slice(0, 5),
    todayMatches,
    liveMatches,
    recentResults
  };
}

module.exports = { summary };
