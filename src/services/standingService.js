const enrollmentRepository = require('../repositories/enrollmentRepository');
const matchRepository = require('../repositories/matchRepository');
const standingRepository = require('../repositories/standingRepository');

async function recalculate(tournamentId) {
  const enrollments = await enrollmentRepository.listByTournament(tournamentId);
  const rows = new Map(enrollments.map(({ participantId }) => [participantId, { tournamentId, participantId, points: 0, wins: 0, losses: 0, draws: 0, played: 0, scored: 0, conceded: 0 }]));
  const matches = await matchRepository.list(tournamentId);
  for (const match of matches) {
    if (!match.result) continue;
    const { scoreA, scoreB, winnerParticipantId } = match.result;
    const a = rows.get(match.participantAId);
    const b = rows.get(match.participantBId);
    if (!a || !b) continue;
    a.played++; b.played++; a.scored += scoreA; a.conceded += scoreB; b.scored += scoreB; b.conceded += scoreA;
    if (!winnerParticipantId) { a.draws++; b.draws++; a.points++; b.points++; }
    else if (winnerParticipantId === a.participantId) { a.wins++; a.points += 3; b.losses++; }
    else { b.wins++; b.points += 3; a.losses++; }
  }
  return standingRepository.replaceForTournament(tournamentId, [...rows.values()]);
}

module.exports = { recalculate, list: tournamentId => standingRepository.listByTournament(tournamentId) };