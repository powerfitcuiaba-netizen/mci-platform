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
  if (resource.createdById === actor.id) return;
  // O técnico administra quem está no próprio elenco, mesmo que o cadastro
  // original tenha sido feito por um organizador.
  if (actor.role === 'COACH' && resource.coachId === actor.id) return;
  throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este recurso');
};

// O vínculo com o técnico é decidido no servidor. Um COACH nunca consegue
// cadastrar alguém no elenco de outro técnico enviando coachId no corpo.
const resolveCoachId = (data, actor) => {
  if (actor?.role === 'COACH') return actor.id;
  if (Object.prototype.hasOwnProperty.call(data, 'coachId')) return data.coachId || null;
  return undefined;
};

module.exports = {
  create: (data, actor) => {
    const coachId = resolveCoachId(data, actor);
    const payload = { ...data, ...(actor ? { createdById: actor.id } : {}) };
    if (coachId === undefined) delete payload.coachId;
    else payload.coachId = coachId;
    return repository.create(payload);
  },
  list: type => repository.list(type),
  findById: id => repository.findById(id).then(item => ensure(item)),
  findTeamById: id => repository.findById(id).then(item => ensureTeam(item)),
  update: async (id, data, actor) => {
    const current = ensure(await repository.findById(id));
    assertOwnedOrAdmin(current, actor);
    const payload = { ...data };
    const coachId = resolveCoachId(data, actor);
    if (coachId === undefined) delete payload.coachId;
    else payload.coachId = coachId;
    return repository.update(id, payload);
  },
  delete: async (id, actor) => {
    const current = ensure(await repository.findById(id));
    assertOwnedOrAdmin(current, actor);
    await repository.delete(id);
  }
};
