const enrollmentRepository = require('../repositories/enrollmentRepository');
const tournamentRepository = require('../repositories/tournamentRepository');
const participantRepository = require('../repositories/participantRepository');
const { AppError } = require('../utils/errors');

async function enroll(tournamentId, participantId) {
  if (!await tournamentRepository.findById(tournamentId)) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (!await participantRepository.findById(participantId)) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');
  if (await enrollmentRepository.exists(tournamentId, participantId)) throw new AppError(409, 'ENROLLMENT_ALREADY_EXISTS', 'Participante já inscrito neste campeonato');
  return enrollmentRepository.create({ tournamentId, participantId });
}

module.exports = { enroll, list: tournamentId => enrollmentRepository.listByTournament(tournamentId) };