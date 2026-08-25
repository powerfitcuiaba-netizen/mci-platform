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

// Só entra na vitrine pública quem de fato compete: participante sem inscrição
// confirmada não é exposto, para que a superfície aberta não vire um índice do
// cadastro interno.
const competeEmAlgumLugar = { enrollments: { some: { status: 'CONFIRMED' } } };

const perfilPublico = {
  id: true,
  name: true,
  identification: true,
  type: true,
  createdAt: true,
  team: { select: { id: true, name: true } },
  _count: { select: { enrollments: true } }
};

async function listAthletes() {
  const items = await prisma.participant.findMany({
    where: { AND: [{ type: { not: 'TEAM' } }, competeEmAlgumLugar] },
    select: perfilPublico,
    orderBy: { name: 'asc' }
  });
  return { items };
}

async function listTeams() {
  const items = await prisma.participant.findMany({
    where: { AND: [{ type: 'TEAM' }, competeEmAlgumLugar] },
    select: { ...perfilPublico, _count: { select: { enrollments: true, members: true } } },
    orderBy: { name: 'asc' }
  });
  return { items };
}

// Histórico esportivo de um participante: onde compete, o que jogou e como está
// classificado. Nada de conta, técnico, operador ou quem cadastrou.
async function participantDetail(id, tipoEsperado) {
  const participant = await prisma.participant.findFirst({
    where: { AND: [{ id }, competeEmAlgumLugar, ...(tipoEsperado === 'TEAM' ? [{ type: 'TEAM' }] : tipoEsperado === 'ATHLETE' ? [{ type: { not: 'TEAM' } }] : [])] },
    select: perfilPublico
  });
  if (!participant) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');

  const [enrollments, matches, standings, members] = await Promise.all([
    prisma.enrollment.findMany({
      where: { participantId: id, status: 'CONFIRMED' },
      select: { id: true, createdAt: true, tournament: { select: publicTournament } },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.match.findMany({
      where: { OR: [{ participantAId: id }, { participantBId: id }] },
      select: publicMatch,
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.standing.findMany({
      where: { participantId: id },
      select: {
        points: true, wins: true, losses: true, draws: true, played: true, scored: true, conceded: true,
        tournament: { select: { id: true, name: true, status: true } }
      },
      orderBy: { points: 'desc' }
    }),
    participant.type === 'TEAM'
      ? prisma.participant.findMany({ where: { teamId: id }, select: { id: true, name: true, identification: true, type: true }, orderBy: { name: 'asc' } })
      : Promise.resolve([])
  ]);

  const vitorias = matches.filter(item => item.result?.winnerParticipantId === id).length;
  const comResultado = matches.filter(item => item.result);

  return {
    participant,
    team: participant.team || null,
    members,
    tournaments: enrollments.map(item => item.tournament),
    matches,
    results: comResultado,
    standings,
    totals: {
      tournaments: enrollments.length,
      matches: matches.length,
      played: comResultado.length,
      wins: vitorias,
      members: members.length
    }
  };
}

const athleteDetail = id => participantDetail(id, 'ATHLETE');
const teamDetail = id => participantDetail(id, 'TEAM');

module.exports = { summary, listTournaments, tournamentDetail, live, listAthletes, listTeams, athleteDetail, teamDetail };
