const prisma = require('../config/prisma');
const { AppError } = require('./errors');

// Regra única de quem pode operar um campeonato. Estava duplicada em
// matchService e resultService e as duas cópias já haviam divergido: uma aceitava
// `resource.tournamentId` como alternativa, a outra não. Regra de autorização
// escrita duas vezes acaba divergindo, e o lado que falha primeiro costuma ser o
// que deixa passar.
//
// Falha fechada: sem ator não há acesso. As cópias anteriores retornavam sem
// erro quando o ator era nulo, de modo que qualquer rota montada sem requireAuth
// concederia acesso em silêncio.
async function assertCanOperateTournament(tournament, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');

  if (actor.role === 'ADMIN') return;
  if (actor.role === 'ORGANIZER' && tournament.createdById === actor.id) return;

  if (actor.role === 'JUDGE') {
    const assignment = await prisma.judgeAssignment.findUnique({
      where: { tournamentId_judgeId: { tournamentId: tournament.id, judgeId: actor.id } }
    });
    if (assignment) return;
  }

  throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este recurso');
}

module.exports = { assertCanOperateTournament };
