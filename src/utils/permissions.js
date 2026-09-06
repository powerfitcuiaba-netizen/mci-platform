const { USER_ROLES } = require('./roles');

// ============================================================================
// RBAC granular.
//
// A matriz é a única fonte de verdade sobre autorização: rotas e services
// perguntam por permissão nomeada, nunca por papel. Trocar o que um papel pode
// fazer é editar esta tabela — e a tabela é coberta por teste, de modo que uma
// permissão concedida por engano aparece como falha, não como brecha silenciosa.
//
// A permissão efetiva de um usuário é a união do papel global (User.role) com
// os papéis que ele tem na organização em questão (OrganizationMember.role).
// Não existe herança por "nível": um JUDGE não é um ADMIN pequeno, é outro
// conjunto de permissões.
// ============================================================================

const PERMISSIONS = Object.freeze([
  'organizations.read', 'organizations.manage',
  'events.read', 'events.create', 'events.update', 'events.publish', 'events.delete',
  'categories.read', 'categories.manage',
  'athletes.read', 'athletes.read_sensitive', 'athletes.create', 'athletes.update', 'athletes.manage',
  'affiliations.read', 'affiliations.manage',
  'registrations.read', 'registrations.create', 'registrations.cancel',
  'documents.read', 'documents.upload', 'documents.delete',
  'checkin.read', 'checkin.operate',
  'weighin.read', 'weighin.operate',
  'credentials.read', 'credentials.manage', 'credentials.scan',
  'stage.read', 'stage.manage',
  'judging.read', 'judging.manage', 'judging.score', 'judging.close',
  'results.read', 'results.read_unpublished', 'results.calculate', 'results.publish', 'results.override',
  'ranking.read', 'ranking.manage',
  'pro.read', 'pro.manage',
  'musclewar.import', 'musclewar.review', 'musclewar.apply',
  'teams.manage', 'coaches.manage', 'gyms.manage',
  'brands.manage', 'sponsors.manage',
  'social.read', 'social.write', 'social.moderate', 'social.delete',
  'messenger.use', 'messenger.moderate',
  'communities.read', 'communities.write', 'communities.manage',
  'notifications.read',
  'search.read', 'search.sensitive',
  'analytics.read',
  'audit.read',
  'users.read', 'users.manage'
]);

const PERMISSION_SET = new Set(PERMISSIONS);

// Todo mundo que está autenticado tem isto, seja qual for o papel.
const BASE_AUTENTICADO = Object.freeze([
  'events.read', 'categories.read', 'athletes.read', 'affiliations.read',
  'results.read', 'ranking.read', 'pro.read',
  'social.read', 'social.write', 'messenger.use',
  'communities.read', 'communities.write',
  'notifications.read', 'search.read'
]);

const operacional = (...extra) => Object.freeze([...BASE_AUTENTICADO, ...extra]);

const ROLE_PERMISSIONS = Object.freeze({
  // SUPER_ADMIN recebe tudo por construção (ver permissionsForRole), inclusive
  // permissões acrescentadas depois desta linha.
  SUPER_ADMIN: Object.freeze([...PERMISSIONS]),

  ADMIN: Object.freeze(PERMISSIONS.filter(p => p !== 'organizations.manage')),

  EVENT_DIRECTOR: operacional(
    'organizations.read',
    'events.create', 'events.update', 'events.publish', 'events.delete',
    'categories.manage', 'affiliations.manage',
    'athletes.create', 'athletes.update', 'athletes.manage', 'athletes.read_sensitive',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload', 'documents.delete',
    'checkin.read', 'checkin.operate', 'weighin.read', 'weighin.operate',
    'credentials.read', 'credentials.manage', 'credentials.scan',
    'stage.read', 'stage.manage',
    'judging.read', 'judging.manage', 'judging.close',
    'results.read_unpublished', 'results.calculate', 'results.publish',
    'ranking.manage', 'pro.manage',
    'musclewar.import', 'musclewar.review', 'musclewar.apply',
    'teams.manage', 'coaches.manage', 'gyms.manage', 'brands.manage', 'sponsors.manage',
    'analytics.read', 'search.sensitive', 'users.read'
  ),

  EVENT_COORDINATOR: operacional(
    'events.update',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload',
    'checkin.read', 'checkin.operate', 'weighin.read', 'weighin.operate',
    'credentials.read', 'credentials.manage', 'credentials.scan',
    'stage.read', 'stage.manage',
    'judging.read', 'judging.manage',
    'results.read_unpublished',
    'analytics.read'
  ),

  JUDGE_COORDINATOR: operacional(
    'judging.read', 'judging.manage', 'judging.close',
    'stage.read', 'results.read_unpublished', 'results.calculate'
  ),

  // Um juiz pontua. Não fecha sessão, não calcula, não publica.
  JUDGE: operacional('judging.read', 'judging.score', 'stage.read', 'registrations.read'),

  STAFF: operacional('registrations.read', 'stage.read', 'credentials.scan', 'checkin.read'),

  REGISTRATION_OPERATOR: operacional(
    'athletes.create', 'athletes.update', 'athletes.read_sensitive',
    'registrations.read', 'registrations.create', 'registrations.cancel',
    'documents.read', 'documents.upload', 'affiliations.manage', 'search.sensitive'
  ),

  CHECKIN_OPERATOR: operacional('registrations.read', 'checkin.read', 'checkin.operate', 'athletes.read_sensitive', 'credentials.scan', 'search.sensitive'),

  WEIGHIN_OPERATOR: operacional('registrations.read', 'weighin.read', 'weighin.operate', 'athletes.read_sensitive', 'search.sensitive'),

  RESULTS_OPERATOR: operacional('results.read_unpublished', 'results.calculate', 'results.publish', 'judging.read', 'stage.read'),

  RANKING_MANAGER: operacional('ranking.manage', 'results.read_unpublished', 'musclewar.import', 'musclewar.review', 'musclewar.apply', 'pro.manage'),

  SOCIAL_ADMIN: operacional('social.moderate', 'social.delete', 'communities.manage', 'messenger.moderate', 'brands.manage', 'sponsors.manage'),

  MODERATOR: operacional('social.moderate', 'social.delete', 'messenger.moderate'),

  ATHLETE: operacional(),
  COACH: operacional('registrations.read'),
  GYM: operacional(),
  TEAM: operacional(),
  BRAND: operacional(),
  SPONSOR: operacional(),
  MEDIA: operacional()
});

// SUPER_ADMIN nunca fica para trás quando uma permissão nova é criada.
function permissionsForRole(role) {
  if (role === 'SUPER_ADMIN') return new Set(PERMISSIONS);
  return new Set(ROLE_PERMISSIONS[role] || []);
}

// Permissões efetivas: papel global + papéis do usuário na organização
// informada. Sem organização, só o papel global conta — é assim que um
// operador de uma organização não opera outra.
function effectivePermissions(user, organizationId = null) {
  if (!user) return new Set();

  const efetivas = permissionsForRole(user.role);

  const memberships = Array.isArray(user.memberships) ? user.memberships : [];
  for (const membership of memberships) {
    if (organizationId && membership.organizationId !== organizationId) continue;
    for (const permissao of permissionsForRole(membership.role)) efetivas.add(permissao);
  }

  return efetivas;
}

function can(user, permission, organizationId = null) {
  if (!PERMISSION_SET.has(permission)) {
    throw new Error(`Permissão desconhecida: ${permission}`);
  }
  return effectivePermissions(user, organizationId).has(permission);
}

// Organizações às quais o usuário pertence. SUPER_ADMIN e ADMIN não são
// limitados por vínculo — são papéis da plataforma, não de um tenant.
function isCrossTenant(user) {
  return Boolean(user) && (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN');
}

function organizationIdsOf(user) {
  if (!user) return [];
  return [...new Set((user.memberships || []).map(m => m.organizationId))];
}

function belongsToOrganization(user, organizationId) {
  if (!user || !organizationId) return false;
  if (isCrossTenant(user)) return true;
  return organizationIdsOf(user).includes(organizationId);
}

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_ROLES,
  permissionsForRole,
  effectivePermissions,
  can,
  isCrossTenant,
  organizationIdsOf,
  belongsToOrganization
};
