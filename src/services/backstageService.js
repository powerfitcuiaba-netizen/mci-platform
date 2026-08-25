const prisma = require('../config/prisma');

// ADMIN vê a operação inteira; ORGANIZER apenas os campeonatos que criou.
const tournamentScope = actor => (actor.role === 'ADMIN' ? {} : { createdById: actor.id });

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };

async function overview(actor) {
  const scope = tournamentScope(actor);

  const tournaments = await prisma.tournament.findMany({
    where: scope,
    select: {
      id: true, name: true, status: true, startDate: true, endDate: true,
      _count: { select: { enrollments: true, matches: true, documents: true, judgeAssignments: true } }
    },
    orderBy: [{ status: 'asc' }, { startDate: 'asc' }]
  });

  if (!tournaments.length) {
    return {
      tournaments: [],
      totals: { tournaments: 0, enrollments: 0, matches: 0, checkedIn: 0, pendingCheckIn: 0, missingResults: 0, liveMatches: 0 },
      todayMatches: [], liveMatches: [], pendingResults: [], alerts: []
    };
  }

  const tournamentIds = tournaments.map(item => item.id);

  // Tudo carregado em consultas por lote sobre o conjunto de campeonatos, em vez
  // de uma consulta por campeonato.
  const [enrollments, checkIns, matches] = await Promise.all([
    prisma.enrollment.count({ where: { tournamentId: { in: tournamentIds } } }),
    prisma.checkIn.groupBy({
      by: ['status'],
      where: { enrollment: { tournamentId: { in: tournamentIds } } },
      _count: { _all: true }
    }),
    prisma.match.findMany({
      where: { tournamentId: { in: tournamentIds } },
      select: {
        id: true, status: true, scheduledAt: true, phase: true, tournamentId: true,
        tournament: { select: { id: true, name: true } },
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    })
  ]);

  const checkedIn = checkIns.find(row => row.status === 'CHECKED_IN')?._count._all || 0;
  const cancelledCheckIn = checkIns.find(row => row.status === 'CANCELLED')?._count._all || 0;

  const today = { from: startOfToday(), to: endOfToday() };
  const todayMatches = matches.filter(m => m.scheduledAt && m.scheduledAt >= today.from && m.scheduledAt <= today.to);
  const liveMatches = matches.filter(m => m.status === 'IN_PROGRESS');

  // Situação pendente: partida encerrada ou já passada sem resultado lançado.
  const now = new Date();
  const pendingResults = matches.filter(m =>
    !m.result && m.status !== 'CANCELLED' && (m.status === 'FINISHED' || (m.scheduledAt && m.scheduledAt < now))
  );

  const alerts = [];
  if (pendingResults.length) {
    alerts.push({ level: 'WARNING', code: 'MISSING_RESULTS', message: `${pendingResults.length} partida(s) sem resultado lançado.` });
  }
  const pendingCheckIn = enrollments - checkedIn - cancelledCheckIn;
  if (pendingCheckIn > 0) {
    alerts.push({ level: 'INFO', code: 'PENDING_CHECKIN', message: `${pendingCheckIn} inscrito(s) ainda sem check-in.` });
  }
  if (liveMatches.length) {
    alerts.push({ level: 'INFO', code: 'LIVE_MATCHES', message: `${liveMatches.length} partida(s) em andamento agora.` });
  }
  const withoutJudge = tournaments.filter(t => t.status === 'ACTIVE' && t._count.judgeAssignments === 0);
  if (withoutJudge.length) {
    alerts.push({ level: 'WARNING', code: 'NO_JUDGE', message: `${withoutJudge.length} campeonato(s) ativo(s) sem juiz designado.` });
  }

  return {
    tournaments,
    totals: {
      tournaments: tournaments.length,
      enrollments,
      matches: matches.length,
      checkedIn,
      pendingCheckIn: Math.max(pendingCheckIn, 0),
      missingResults: pendingResults.length,
      liveMatches: liveMatches.length
    },
    todayMatches,
    liveMatches,
    pendingResults,
    alerts
  };
}

module.exports = { overview };
