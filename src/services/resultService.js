const resultRepository = require('../repositories/resultRepository');
const matchService = require('./matchService');
const matchRepository = require('../repositories/matchRepository');
const standingService = require('./standingService');
const { AppError } = require('../utils/errors');

async function create(matchId, data) {
  const match = await matchService.findById(matchId);
  if (await resultRepository.exists(matchId)) throw new AppError(409, 'RESULT_ALREADY_EXISTS', 'Esta partida já possui resultado');
  if (data.scoreA === data.scoreB && data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Empates não podem ter vencedor');
  if (data.scoreA !== data.scoreB && !data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Partidas sem empate precisam de vencedor');
  if (data.winnerParticipantId && ![match.participantAId, match.participantBId].includes(data.winnerParticipantId)) throw new AppError(422, 'INVALID_RESULT', 'Vencedor não participa desta partida');
  const result = await resultRepository.create({ matchId, ...data });
  await matchRepository.update(matchId, { status: 'FINISHED' });
  await standingService.recalculate(match.tournamentId);
  return result;
}

module.exports = { create };