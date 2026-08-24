const repository = require('../repositories/matchRepository');
const tournamentRepository = require('../repositories/tournamentRepository');
const participantRepository = require('../repositories/participantRepository');
const enrollmentRepository = require('../repositories/enrollmentRepository');
const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

const assertOwnedOrAdmin = async (resource, actor) => {
  if (!resource || !actor) return;
  if (actor.role === 'ADMIN') return;
  if (actor.role === 'ORGANIZER' && resource.createdById === actor.id) return;
  if (actor.role === 'JUDGE') {
    const assignment = await prisma.judgeAssignment.findUnique({ where: { tournamentId_judgeId: { tournamentId: resource.id || resource.tournamentId, judgeId: actor.id } } });
    if (assignment) return;
  }
  throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este recurso');
};

async function create(data, actor) {
  const tournament = await tournamentRepository.findById(data.tournamentId);
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  await assertOwnedOrAdmin(tournament, actor);
  if (data.participantAId === data.participantBId) throw new AppError(422, 'INVALID_MATCH', 'Os participantes da partida devem ser diferentes');
  const [a, b] = await Promise.all([participantRepository.findById(data.participantAId), participantRepository.findById(data.participantBId)]);
  if (!a || !b) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');
  const enrolled = await enrollmentRepository.listByTournament(data.tournamentId);
  const ids = new Set(enrolled.map(item => item.participantId));
  if (!ids.has(a.id) || !ids.has(b.id)) throw new AppError(422, 'PARTICIPANT_NOT_ENROLLED', 'Os participantes precisam estar inscritos no campeonato');
  return repository.create(data);
}

module.exports = { create, list: tournamentId => repository.list(tournamentId), findById: async id => { const item = await repository.findById(id); if (!item) throw new AppError(404, 'MATCH_NOT_FOUND', 'Partida não encontrada'); return item; }, update: async (id, data, actor) => { const current = await module.exports.findById(id); const tournament = await tournamentRepository.findById(current.tournamentId); await assertOwnedOrAdmin(tournament, actor); return repository.update(id, data); } };