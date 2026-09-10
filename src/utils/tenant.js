const { AppError } = require('./errors');
const { can, belongsToOrganization, isCrossTenant, organizationIdsOf } = require('./permissions');

// Barreira de tenant usada pelos services. Middleware cobre o que chega na
// rota; isto cobre o que é carregado do banco, que é onde o vazamento
// cross-tenant costuma acontecer: o id veio na URL, o recurso existe, e o
// serviço devolve sem conferir de quem é.

function assertOrganization(user, organizationId) {
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (!organizationId) throw new AppError(422, 'ORGANIZATION_REQUIRED', 'Organização não informada');
  if (!belongsToOrganization(user, organizationId)) {
    throw new AppError(403, 'FORBIDDEN', 'Recurso de outra organização');
  }
  return organizationId;
}

function assertPermission(user, permission, organizationId = null) {
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (!can(user, permission, organizationId)) {
    throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para esta operação');
  }
  return true;
}

// Permissão + tenant na mesma chamada: as duas condições precisam valer, e é
// justamente separá-las que produz o furo onde o papel de uma organização
// autoriza operar em outra.
function assertCan(user, permission, organizationId) {
  assertOrganization(user, organizationId);
  assertPermission(user, permission, organizationId);
  return true;
}

// Filtro de organização para listagens. Quem é cross-tenant vê tudo; os demais
// veem apenas as organizações de que participam.
function organizationFilter(user, organizationId = null) {
  if (organizationId) {
    assertOrganization(user, organizationId);
    return { organizationId };
  }
  if (isCrossTenant(user)) return {};

  const ids = organizationIdsOf(user);
  // Sem vínculo nenhum a listagem é vazia, não irrestrita.
  return { organizationId: { in: ids.length ? ids : ['__sem-organizacao__'] } };
}

module.exports = { assertOrganization, assertPermission, assertCan, organizationFilter };
