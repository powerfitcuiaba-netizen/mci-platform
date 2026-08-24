const prisma = require('../config/prisma');

async function summary() {
  const [tournaments, matches, documents, standings] = await Promise.all([
    prisma.tournament.count(),
    prisma.match.count(),
    prisma.document.count(),
    prisma.standing.findMany({ take: 5, include: { participant: true }, orderBy: [{ points: 'desc' }, { wins: 'desc' }, { scored: 'desc' }] })
  ]);

  return {
    tournamentCount: tournaments,
    matchCount: matches,
    documentCount: documents,
    leaderboard: standings.map(row => ({
      participantId: row.participantId,
      participantName: row.participant.name,
      points: row.points,
      wins: row.wins,
      played: row.played
    }))
  };
}

module.exports = { summary };
