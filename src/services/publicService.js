const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

// Superfície pública: somente leitura, sem login e sem qualquer dado de usuário.
// Nada aqui expõe email, perfil, operador de check-in ou identificador interno
// de quem cadastrou o registro.
const publicParticipant = { select: { id: true, name: true, type: true } };
const publicTournament = { id: true, name: true, description: true, status: true, startDate: true, endDate: true };
const publicMatch = {
  id: true,
  status: true,
  scheduledAt: true,
  phase: true,
  round: true,
  tournament: { select: { id: true, name: true } },
  participantA: publicParticipant,
  participantB: publicParticipant,
  result: { select: { scoreA: true, scoreB: true, winnerParticipantId: true } }
};

async function summary() {
  const [tournaments, matches, documents, standings] = await Promise.all([
    prisma.tournament.count(),
    prisma.match.count(),
    prisma.document.count(),
    prisma.standing.findMany({ take: 5, include: { participant: publicParticipant }, orderBy: [{ points: 'desc' }, { wins: 'desc' }, { scored: 'desc' }] })
  ]);

  return {
    tournamentCount: tournaments,
    matchCount: matches,
    documentCount: documents,
    leaderboard: standings.map(row => ({
      participantId: row.participantId,
      participantName: row.participant.name,
      points: row.points,
      wins: row.wins,
      played: row.played
    }))
  };
}

// Campeonatos visíveis ao público. Rascunhos (PLANNED) só aparecem quando já
// têm data definida, para a grade pública não listar evento sem informação.
async function listTournaments() {
  const items = await prisma.tournament.findMany({
    where: { OR: [{ status: { in: ['ACTIVE', 'FINISHED'] } }, { AND: [{ status: 'PLANNED' }, { startDate: { not: null } }] }] },
    select: { ...publicTournament, _count: { select: { enrollments: true, matches: true } } },
    orderBy: [{ startDate: 'desc' }]
  });
  return { items };
}

async function tournamentDetail(id) {
  const tournament = await prisma.tournament.findUnique({ where: { id }, select: { ...publicTournament, _count: { select: { enrollments: true, matches: true } } } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');

  const [matches, standings] = await Promise.all([
    prisma.match.findMany({ where: { tournamentId: id }, select: publicMatch, orderBy: { scheduledAt: 'asc' } }),
    prisma.standing.findMany({
      where: { tournamentId: id },
      select: { points: true, wins: true, losses: true, draws: true, played: true, scored: true, conceded: true, participant: publicParticipant },
      orderBy: [{ points: 'desc' }, { wins: 'desc' }, { scored: 'desc' }]
    })
  ]);

  const now = new Date();
  const live = matches.filter(item => item.status === 'IN_PROGRESS');
  const nextMatch = matches.find(item => item.status === 'SCHEDULED' && item.scheduledAt && item.scheduledAt >= now)
    || matches.find(item => item.status === 'SCHEDULED')
    || null;

  return {
    tournament,
    matches,
    standings,
    liveMatches: live,
    nextMatch,
    results: matches.filter(item => item.result)
  };
}

// Grade ao vivo do MCI TV: o que está acontecendo agora, o que vem a seguir e
// os últimos resultados reais. Sem dados inventados: listas vazias quando não há.
async function live() {
  const now = new Date();

  const [liveMatches, upcoming, recent] = await Promise.all([
    prisma.match.findMany({ where: { status: 'IN_PROGRESS' }, select: publicMatch, orderBy: { scheduledAt: 'asc' } }),
    prisma.match.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { gte: now } },
      select: publicMatch,
      orderBy: { scheduledAt: 'asc' },
      take: 8
    }),
    prisma.match.findMany({
      where: { result: { isNot: null } },
      select: publicMatch,
      orderBy: { updatedAt: 'desc' },
      take: 8
    })
  ]);

  return { liveMatches, upcoming, recentResults: recent, nextMatch: upcoming[0] || null };
}

module.exports = { summary, listTournaments, tournamentDetail, live };
