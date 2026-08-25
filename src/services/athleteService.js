const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

// Todo o escopo desta visão sai de req.user.id. Não existe parâmetro de
// entrada que permita apontar para outro atleta: o isolamento não depende de
// checagem posterior, e sim de a consulta nunca alcançar dados de terceiros.
async function overview(actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');

  const participant = await prisma.participant.findFirst({
    where: { userId: actor.id },
    select: {
      id: true, name: true, identification: true, type: true, createdAt: true,
      team: { select: { id: true, name: true, identification: true } },
      coach: { select: { id: true, name: true, email: true } }
    }
  });

  const base = {
    profile: { id: actor.id, name: actor.name, email: actor.email, role: actor.role, status: actor.status },
    participant,
    team: participant?.team || null,
    coach: participant?.coach || null,
    enrollments: [],
    matches: [],
    results: [],
    standings: [],
    documents: [],
    totals: { enrollments: 0, checkedIn: 0, matches: 0, wins: 0, unreadNotifications: 0 }
  };

  const unread = await prisma.notification.count({ where: { userId: actor.id, isRead: false } });
  base.totals.unreadNotifications = unread;

  // Sem vínculo com um participante o atleta ainda tem conta e caixa de avisos,
  // mas não tem vida esportiva a mostrar. O estado é explícito, não um zero
  // disfarçado de dado.
  if (!participant) return { ...base, semVinculo: true };

  const [enrollments, matches, standings, documents] = await Promise.all([
    prisma.enrollment.findMany({
      where: { participantId: participant.id },
      select: {
        id: true, status: true, createdAt: true, cancelledAt: true,
        tournament: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
        checkIns: { select: { status: true, checkedInAt: true } }
      },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.match.findMany({
      where: { OR: [{ participantAId: participant.id }, { participantBId: participant.id }] },
      select: {
        id: true, status: true, scheduledAt: true, phase: true, round: true,
        tournament: { select: { id: true, name: true } },
        participantA: { select: { id: true, name: true } },
        participantB: { select: { id: true, name: true } },
        result: { select: { scoreA: true, scoreB: true, winnerParticipantId: true } }
      },
      orderBy: { scheduledAt: 'asc' }
    }),
    prisma.standing.findMany({
      where: { participantId: participant.id },
      select: {
        points: true, wins: true, losses: true, draws: true, played: true, scored: true, conceded: true,
        tournament: { select: { id: true, name: true } }
      },
      orderBy: { points: 'desc' }
    }),
    // Documentos dos campeonatos em que este atleta está inscrito.
    prisma.document.findMany({
      where: { tournament: { enrollments: { some: { participantId: participant.id, status: 'CONFIRMED' } } } },
      select: {
        id: true, title: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true,
        storageKey: true,
        tournament: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  const comCheckIn = enrollments.filter(item => item.checkIns?.[0]?.status === 'CHECKED_IN').length;
  const vitorias = matches.filter(item => item.result?.winnerParticipantId === participant.id).length;

  return {
    ...base,
    enrollments: enrollments.map(item => ({
      id: item.id,
      status: item.status,
      enrolledAt: item.createdAt,
      cancelledAt: item.cancelledAt,
      tournament: item.tournament,
      checkInStatus: item.checkIns?.[0]?.status || 'PENDING',
      checkedInAt: item.checkIns?.[0]?.checkedInAt || null
    })),
    matches,
    results: matches.filter(item => item.result),
    standings,
    documents: documents.map(({ storageKey, ...doc }) => ({ ...doc, hasFile: Boolean(storageKey) })),
    totals: {
      enrollments: enrollments.filter(item => item.status === 'CONFIRMED').length,
      checkedIn: comCheckIn,
      matches: matches.length,
      wins: vitorias,
      unreadNotifications: unread
    },
    semVinculo: false
  };
}

module.exports = { overview };
