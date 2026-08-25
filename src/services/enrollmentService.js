const enrollmentRepository = require('../repositories/enrollmentRepository');
const tournamentRepository = require('../repositories/tournamentRepository');
const participantRepository = require('../repositories/participantRepository');
const notificationService = require('./notificationService');
const { AppError } = require('../utils/errors');

// A rota admite ADMIN, ORGANIZER e COACH. Cada um por um motivo diferente:
// o organizador por ser dono do campeonato, o técnico por ser dono do atleta.
async function assertCanEnroll(tournament, participant, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (actor.role === 'ADMIN') return;
  if (tournament.createdById === actor.id) return;
  if (actor.role === 'COACH' && participant.coachId === actor.id) return;
  throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar inscrições deste campeonato');
}

async function enroll(tournamentId, participantId, actor) {
  const tournament = await tournamentRepository.findById(tournamentId);
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');

  const participant = await participantRepository.findById(participantId);
  if (!participant) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');

  await assertCanEnroll(tournament, participant, actor);

  if (await enrollmentRepository.exists(tournamentId, participantId)) {
    throw new AppError(409, 'ENROLLMENT_ALREADY_EXISTS', 'Participante já inscrito neste campeonato');
  }

  const enrollment = await enrollmentRepository.create({ tournamentId, participantId });
  await notificationService.notifyEnrollment(tournamentId, participantId, actor?.id);
  return enrollment;
}

module.exports = { enroll, list: tournamentId => enrollmentRepository.listByTournament(tournamentId) };
