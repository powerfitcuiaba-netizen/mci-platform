const resultRepository = require('../repositories/resultRepository');
const matchService = require('./matchService');
const matchRepository = require('../repositories/matchRepository');
const tournamentRepository = require('../repositories/tournamentRepository');
const standingService = require('./standingService');
const notificationService = require('./notificationService');
const { AppError } = require('../utils/errors');
const { assertCanOperateTournament } = require('../utils/ownership');


async function create(matchId, data, actor) {
  const match = await matchService.findById(matchId);
  const tournament = await tournamentRepository.findById(match.tournamentId);
  await assertCanOperateTournament(tournament, actor);
  if (await resultRepository.exists(matchId)) throw new AppError(409, 'RESULT_ALREADY_EXISTS', 'Esta partida já possui resultado');
  if (['CANCELLED', 'FINISHED'].includes(match.status)) throw new AppError(422, 'INVALID_MATCH_STATUS', 'A partida não aceita novos resultados neste status');
  if (data.scoreA === data.scoreB && data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Empates não podem ter vencedor');
  if (data.scoreA !== data.scoreB && !data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Partidas sem empate precisam de vencedor');
  if (data.winnerParticipantId && ![match.participantAId, match.participantBId].includes(data.winnerParticipantId)) throw new AppError(422, 'INVALID_RESULT', 'Vencedor não participa desta partida');
  const result = await resultRepository.create({ matchId, ...data });
  await matchRepository.update(matchId, { status: 'FINISHED' });
  await standingService.recalculate(match.tournamentId);
  await notificationService.notifyMatch(matchId, actor?.id, 'RESULT');
  return result;
}

async function validateResult(matchId, data) {
  const match = await matchService.findById(matchId);
  if (data.scoreA === data.scoreB && data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Empates não podem ter vencedor');
  if (data.scoreA !== data.scoreB && !data.winnerParticipantId) throw new AppError(422, 'INVALID_RESULT', 'Partidas sem empate precisam de vencedor');
  if (data.winnerParticipantId && ![match.participantAId, match.participantBId].includes(data.winnerParticipantId)) throw new AppError(422, 'INVALID_RESULT', 'Vencedor não participa desta partida');
  return match;
}

async function update(matchId, data, actor) {
  const match = await validateResult(matchId, data);
  const tournament = await tournamentRepository.findById(match.tournamentId);
  await assertCanOperateTournament(tournament, actor);
  if (!await resultRepository.exists(matchId)) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não encontrado');
  const result = await resultRepository.update(matchId, data);
  await standingService.recalculate(match.tournamentId);
  await notificationService.notifyMatch(matchId, actor?.id, 'RESULT');
  return result;
}

module.exports = { create, findByMatchId: async matchId => { const result = await resultRepository.findByMatchId(matchId); if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não encontrado'); return result; }, update };