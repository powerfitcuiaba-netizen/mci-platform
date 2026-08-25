const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

// O escopo do técnico é sempre derivado de req.user.id. ADMIN enxerga tudo;
// ORGANIZER não administra elenco, então cai no mesmo escopo vazio de um técnico
// sem atletas — nunca no elenco de outro técnico.
const scopeFor = actor => (actor.role === 'ADMIN' ? {} : { coachId: actor.id });

const participantShape = {
  id: true,
  name: true,
  identification: true,
  type: true,
  coachId: true,
  teamId: true,
  createdAt: true
};

async function assertOwned(participantId, actor) {
  const participant = await prisma.participant.findUnique({ where: { id: participantId }, select: { ...participantShape, userId: true } });
  if (!participant) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');
  if (actor.role !== 'ADMIN' && participant.coachId !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Este participante não pertence ao seu elenco');
  }
  return participant;
}

async function listTeams(actor) {
  const items = await prisma.participant.findMany({
    where: { ...scopeFor(actor), type: 'TEAM' },
    select: { ...participantShape, members: { select: participantShape }, _count: { select: { enrollments: true, members: true } } },
    orderBy: { name: 'asc' }
  });
  return { items };
}

async function listAthletes(actor) {
  const items = await prisma.participant.findMany({
    where: { ...scopeFor(actor), type: 'PLAYER' },
    select: { ...participantShape, team: { select: { id: true, name: true } }, _count: { select: { enrollments: true } } },
    orderBy: { name: 'asc' }
  });
  return { items };
}

// Visão consolidada do técnico: elenco, onde ele compete, agenda e desempenho.
async function overview(actor) {
  const scope = scopeFor(actor);

  const roster = await prisma.participant.findMany({
    where: scope,
    select: { ...participantShape, _count: { select: { enrollments: true } } },
    orderBy: { name: 'asc' }
  });

  if (!roster.length) {
    return { teams: [], athletes: [], tournaments: [], matches: [], standings: [], totals: { teams: 0, athletes: 0, tournaments: 0, matches: 0 } };
  }

  const participantIds = roster.map(item => item.id);

  const [enrollments, matches, standings] = await Promise.all([
    prisma.enrollment.findMany({
      where: { participantId: { in: participantIds } },
      select: {
        id: true,
        participantId: true,
        tournament: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
        checkIns: { select: { status: true, checkedInAt: true } }
      }
    }),
    prisma.match.findMany({
      where: { OR: [{ participantAId: { in: participantIds } }, { participantBId: { in: participantIds } }] },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        phase: true,
        tournament: { select: { id: true, name: true } },
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true, winnerParticipantId: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.standing.findMany({
      where: { participantId: { in: participantIds } },
      select: {
        points: true, wins: true, losses: true, draws: true, played: true,
        participant: { select: { id: true, name: true } },
        tournament: { select: { id: true, name: true } }
      },
      orderBy: [{ points: 'desc' }, { wins: 'desc' }]
    })
  ]);

  // Um campeonato aparece uma vez, mesmo com vários atletas inscritos nele.
  const tournaments = [...new Map(
    enrollments.map(item => [item.tournament.id, { ...item.tournament, enrolled: 0, checkedIn: 0 }])
  ).values()];
  const byTournament = new Map(tournaments.map(item => [item.id, item]));
  for (const item of enrollments) {
    const entry = byTournament.get(item.tournament.id);
    entry.enrolled += 1;
    if (item.checkIns?.[0]?.status === 'CHECKED_IN') entry.checkedIn += 1;
  }

  return {
    teams: roster.filter(item => item.type === 'TEAM'),
    athletes: roster.filter(item => item.type !== 'TEAM'),
    tournaments,
    matches,
    standings,
    totals: {
      teams: roster.filter(item => item.type === 'TEAM').length,
      athletes: roster.filter(item => item.type !== 'TEAM').length,
      tournaments: tournaments.length,
      matches: matches.length
    }
  };
}

// Move um atleta do próprio elenco para uma equipe do próprio elenco.
async function setTeam(participantId, teamId, actor) {
  const participant = await assertOwned(participantId, actor);
  if (participant.type === 'TEAM') throw new AppError(422, 'INVALID_PARTICIPANT_TYPE', 'Uma equipe não pode integrar outra equipe');

  if (teamId === null || teamId === undefined || teamId === '') {
    return prisma.participant.update({ where: { id: participantId }, data: { teamId: null }, select: participantShape });
  }

  const team = await assertOwned(teamId, actor);
  if (team.type !== 'TEAM') throw new AppError(422, 'INVALID_PARTICIPANT_TYPE', 'O destino informado não é uma equipe');

  return prisma.participant.update({ where: { id: participantId }, data: { teamId }, select: participantShape });
}

module.exports = { listTeams, listAthletes, overview, setTeam, assertOwned };
