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

module.exports = {
  create: data => repository.create(data),
  list: type => repository.list(type),
  findById: id => repository.findById(id).then(item => ensure(item)),
  findTeamById: id => repository.findById(id).then(item => ensureTeam(item)),
  update: async (id, data) => { ensure(await repository.findById(id)); return repository.update(id, data); },
  delete: async id => { ensure(await repository.findById(id)); await repository.delete(id); }
};