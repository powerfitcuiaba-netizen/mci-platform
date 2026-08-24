const repository = require('../repositories/tournamentRepository');
const { AppError } = require('../utils/errors');

const ensure = (item, message = 'Campeonato não encontrado') => {
  if (!item) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', message);
  return item;
};

module.exports = {
  create: data => repository.create(data),
  list: () => repository.list(),
  findById: id => repository.findById(id).then(item => ensure(item)),
  update: async (id, data) => { ensure(await repository.findById(id)); return repository.update(id, data); },
  delete: async id => { ensure(await repository.findById(id)); await repository.delete(id); }
};