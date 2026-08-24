const repository = require('../repositories/participantRepository');
const { AppError } = require('../utils/errors');

const ensure = (item, message = 'Participante não encontrado') => {
  if (!item) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', message);
  return item;
};
const ensureTeam = item => {
  ensure(item);
  if (item.type !== 'TEAM') throw new AppError(422, 'INVALID_PARTICIPANT_TYPE', 'O recurso não é uma equipe');
  return item;
};
const assertOwnedOrAdmin = (resource, actor) => {
  if (!resource || !actor) return;
  if (actor.role === 'ADMIN') return;
  if (resource.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este recurso');
  }
};

module.exports = {
  create: (data, actor) => repository.create({ ...data, ...(actor ? { createdById: actor.id } : {}) }),
  list: type => repository.list(type),
  findById: id => repository.findById(id).then(item => ensure(item)),
  findTeamById: id => repository.findById(id).then(item => ensureTeam(item)),
  update: async (id, data, actor) => { const current = ensure(await repository.findById(id)); assertOwnedOrAdmin(current, actor); return repository.update(id, data); },
  delete: async (id, actor) => { const current = ensure(await repository.findById(id)); assertOwnedOrAdmin(current, actor); await repository.delete(id); }
};