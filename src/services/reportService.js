const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

const canRead = (tournament, actor) =>
  actor.role === 'ADMIN' || (actor.role === 'ORGANIZER' && tournament.createdById === actor.id);

// Relatório consolidado de um campeonato, em JSON estruturado para a interface
// montar a visualização sem recalcular nada.
async function tournamentReport(tournamentId, actor) {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, name: true, description: true, status: true, startDate: true, endDate: true, createdById: true, entryFeeCents: true, currency: true }
  });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (!canRead(tournament, actor)) throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso ao relatório deste campeonato');

  const [enrollments, matches, standings, pedidos, patrocinios] = await Promise.all([
    prisma.enrollment.findMany({
      where: { tournamentId },
      select: {
        id: true,
        createdAt: true,
        status: true,
        cancelledAt: true,
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
    }),
    prisma.order.findMany({
      where: { tournamentId },
      select: { id: true, status: true, subtotalCents: true, discountCents: true, totalCents: true, currency: true, paidAt: true, createdAt: true }
    }),
    prisma.sponsorship.findMany({
      where: { tournamentId, status: 'ACTIVE' },
      select: { amountCents: true, sponsor: { select: { id: true, name: true } } }
    })
  ]);

  const rows = enrollments.map(item => ({
    enrollmentId: item.id,
    participant: item.participant,
    enrolledAt: item.createdAt,
    status: item.status,
    cancelledAt: item.cancelledAt,
    checkInStatus: item.checkIns?.[0]?.status || 'PENDING',
    checkedInAt: item.checkIns?.[0]?.checkedInAt || null,
    operatorName: item.checkIns?.[0]?.operatorName || null
  }));

  // Inscrição cancelada continua no relatório como histórico, mas não conta
  // como participante do evento.
  const ativas = rows.filter(row => row.status !== 'CANCELLED');
  const canceladas = rows.filter(row => row.status === 'CANCELLED');
  const checkedIn = ativas.filter(row => row.checkInStatus === 'CHECKED_IN').length;
  const cancelled = ativas.filter(row => row.checkInStatus === 'CANCELLED').length;
  const finished = matches.filter(match => match.result).length;

  return {
    tournament: { id: tournament.id, name: tournament.name, description: tournament.description, status: tournament.status, startDate: tournament.startDate, endDate: tournament.endDate },
    summary: {
      enrollments: ativas.length,
      cancelledEnrollments: canceladas.length,
      teams: ativas.filter(row => row.participant.type === 'TEAM').length,
      athletes: ativas.filter(row => row.participant.type !== 'TEAM').length,
      checkedIn,
      pendingCheckIn: Math.max(ativas.length - checkedIn - cancelled, 0),
      cancelledCheckIn: cancelled,
      matches: matches.length,
      matchesWithResult: finished,
      matchesPending: matches.length - finished
    },
    enrollments: rows,
    matches,
    standings,
    financeiro: resumoFinanceiro(pedidos, patrocinios, tournament),
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


// Receita reconhecida é apenas a de pedidos efetivamente pagos. Pendente e
// cancelado aparecem separados para que ninguém confunda expectativa com caixa.
function resumoFinanceiro(pedidos, patrocinios, tournament) {
  const porStatus = pedidos.reduce((acc, pedido) => {
    acc[pedido.status] = (acc[pedido.status] || 0) + 1;
    return acc;
  }, {});

  const somar = status => pedidos.filter(p => p.status === status).reduce((total, p) => total + p.totalCents, 0);
  const receitaInscricoes = somar('PAID');
  const receitaPatrocinio = patrocinios.reduce((total, item) => total + item.amountCents, 0);

  return {
    currency: tournament.currency || 'BRL',
    entryFeeCents: tournament.entryFeeCents || 0,
    orders: { total: pedidos.length, porStatus },
    receitaInscricoesCents: receitaInscricoes,
    pendenteCents: somar('PENDING'),
    reembolsadoCents: somar('REFUNDED'),
    descontoConcedidoCents: pedidos.filter(p => p.status === 'PAID').reduce((total, p) => total + p.discountCents, 0),
    receitaPatrocinioCents: receitaPatrocinio,
    patrocinadores: patrocinios.map(item => ({ id: item.sponsor.id, name: item.sponsor.name, amountCents: item.amountCents })),
    receitaTotalCents: receitaInscricoes + receitaPatrocinio
  };
}

module.exports = { tournamentReport, listAvailable };
