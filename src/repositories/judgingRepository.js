const prisma = require('../config/prisma');

// Acesso a dados do julgamento. Só consulta e escrita — nenhuma regra de
// negócio mora aqui; quem decide é o service.

module.exports = {
  // Carrega tudo o que a apuração precisa numa consulta só: painel, juízes,
  // regra e notas. Evita o N+1 clássico de buscar as notas atleta por atleta.
  carregarSessaoParaApuracao: sessionId =>
    prisma.judgingSession.findUnique({
      where: { id: sessionId },
      include: {
        panel: { include: { members: { select: { judgeUserId: true } } } },
        scoringRule: true,
        eventCategory: {
          include: {
            scoringRule: true,
            tournament: { select: { id: true, organizationId: true, status: true } },
            enrollments: {
              where: { status: { in: ['APROVADA', 'CONFIRMED', 'PAGA'] } },
              select: { id: true, athleteId: true, status: true }
            }
          }
        },
        scores: { select: { judgeUserId: true, enrollmentId: true, placing: true } }
      }
    }),

  buscarSessao: sessionId =>
    prisma.judgingSession.findUnique({
      where: { id: sessionId },
      include: { panel: { include: { members: { select: { judgeUserId: true } } } } }
    }),

  // Upsert pela chave natural (bateria, juiz, atleta): reenviar a mesma nota
  // corrige o valor em vez de criar uma segunda linha.
  registrarNota: ({ sessionId, judgeUserId, enrollmentId, placing, clientRef }) =>
    prisma.judgingScore.upsert({
      where: { sessionId_judgeUserId_enrollmentId: { sessionId, judgeUserId, enrollmentId } },
      create: { sessionId, judgeUserId, enrollmentId, placing, clientRef: clientRef || null },
      update: { placing, clientRef: clientRef || null }
    }),

  notasDoJuiz: (sessionId, judgeUserId) =>
    prisma.judgingScore.findMany({
      where: { sessionId, judgeUserId },
      select: { enrollmentId: true, placing: true, submittedAt: true },
      orderBy: { placing: 'asc' }
    }),

  buscarResultado: resultId =>
    prisma.competitionResult.findUnique({
      where: { id: resultId },
      include: { eventCategory: { include: { tournament: { select: { organizationId: true } } } } }
    }),

  resultadoDaCategoria: eventCategoryId =>
    prisma.competitionResult.findFirst({
      where: { eventCategoryId },
      orderBy: { version: 'desc' },
      include: { placements: { orderBy: { placing: 'asc' } } }
    }),

  atualizarStatusResultado: (resultId, data) =>
    prisma.competitionResult.update({ where: { id: resultId }, data })

  // A busca da temporada vigente não está aqui de propósito: ela roda dentro da
  // transação de publicação e precisa do cliente transacional (`tx`), não do
  // `prisma` global. Expor uma versão fora da transação convidaria a lançar
  // ponto de ranking fora dela.
};
