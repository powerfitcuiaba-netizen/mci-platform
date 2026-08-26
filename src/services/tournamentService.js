const repository = require('../repositories/tournamentRepository');
const { AppError } = require('../utils/errors');

const ensure = (item, message = 'Campeonato não encontrado') => {
  if (!item) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', message);
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
  list: () => repository.list(),
  findById: id => repository.findById(id).then(item => ensure(item)),
  update: async (id, data, actor) => {
    const current = ensure(await repository.findById(id));
    assertOwnedOrAdmin(current, actor);
    const startDate = data.startDate || current.startDate;
    const endDate = data.endDate || current.endDate;
    if (startDate && endDate && endDate < startDate) throw new AppError(422, 'INVALID_DATES', 'Data de término deve ser posterior à data de início');
    return repository.update(id, data);
  },
  delete: async (id, actor) => { const current = ensure(await repository.findById(id)); assertOwnedOrAdmin(current, actor); await repository.delete(id); }
};