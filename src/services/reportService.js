const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

const canRead = (tournament, actor) =>
  actor.role === 'ADMIN' || (actor.role === 'ORGANIZER' && tournament.createdById === actor.id);

// Relatório consolidado de um campeonato, em JSON estruturado para a interface
// montar a visualização sem recalcular nada.
async function tournamentReport(tournamentId, actor) {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, name: true, description: true, status: true, startDate: true, endDate: true, createdById: true }
  });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (!canRead(tournament, actor)) throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso ao relatório deste campeonato');

  const [enrollments, matches, standings] = await Promise.all([
    prisma.enrollment.findMany({
      where: { tournamentId },
      select: {
        id: true,
        createdAt: true,
        participant: { select: { id: true, name: true, identification: true, type: true } },
        checkIns: { select: { status: true, checkedInAt: true, operatorName: true } }
      },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.match.findMany({
      where: { tournamentId },
      select: {
        id: true, status: true, scheduledAt: true, phase: true, round: true,
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true, winnerParticipantId: true, updatedAt: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.standing.findMany({
      where: { tournamentId },
      select: {
        points: true, wins: true, losses: true, draws: true, played: true, scored: true, conceded: true,
        participant: { select: { id: true, name: true, type: true } }
      },
      orderBy: [{ points: 'desc' }, { wins: 'desc' }, { scored: 'desc' }]
    })
  ]);

  const rows = enrollments.map(item => ({
    enrollmentId: item.id,
    participant: item.participant,
    enrolledAt: item.createdAt,
    checkInStatus: item.checkIns?.[0]?.status || 'PENDING',
    checkedInAt: item.checkIns?.[0]?.checkedInAt || null,
    operatorName: item.checkIns?.[0]?.operatorName || null
  }));

  const checkedIn = rows.filter(row => row.checkInStatus === 'CHECKED_IN').length;
  const cancelled = rows.filter(row => row.checkInStatus === 'CANCELLED').length;
  const finished = matches.filter(match => match.result).length;

  return {
    tournament: { id: tournament.id, name: tournament.name, description: tournament.description, status: tournament.status, startDate: tournament.startDate, endDate: tournament.endDate },
    summary: {
      enrollments: rows.length,
      teams: rows.filter(row => row.participant.type === 'TEAM').length,
      athletes: rows.filter(row => row.participant.type !== 'TEAM').length,
      checkedIn,
      pendingCheckIn: Math.max(rows.length - checkedIn - cancelled, 0),
      cancelledCheckIn: cancelled,
      matches: matches.length,
      matchesWithResult: finished,
      matchesPending: matches.length - finished
    },
    enrollments: rows,
    matches,
    standings,
    generatedAt: new Date().toISOString()
  };
}

// Índice dos campeonatos que o usuário pode relatar.
async function listAvailable(actor) {
  const where = actor.role === 'ADMIN' ? {} : { createdById: actor.id };
  const items = await prisma.tournament.findMany({
    where,
    select: { id: true, name: true, status: true, startDate: true, _count: { select: { enrollments: true, matches: true } } },
    orderBy: { createdAt: 'desc' }
  });
  return { items };
}

module.exports = { tournamentReport, listAvailable };
