// Papéis da plataforma. A lista espelha o enum UserRole do banco: acrescentar
// um papel exige migration, então não há como o código conceder acesso a um
// papel que o banco não conhece.
const USER_ROLES = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'EVENT_DIRECTOR',
  'EVENT_COORDINATOR',
  'JUDGE_COORDINATOR',
  'JUDGE',
  'STAFF',
  'REGISTRATION_OPERATOR',
  'CHECKIN_OPERATOR',
  'WEIGHIN_OPERATOR',
  'RESULTS_OPERATOR',
  'RANKING_MANAGER',
  'SOCIAL_ADMIN',
  'MODERATOR',
  'ATHLETE',
  'COACH',
  'GYM',
  'TEAM',
  'BRAND',
  'SPONSOR',
  'MEDIA'
]);

// Papéis que só um SUPER_ADMIN concede. Um usuário nunca se autoatribui
// nenhum deles no cadastro aberto.
const PAPEIS_PRIVILEGIADOS = Object.freeze([
  'SUPER_ADMIN',
  'ADMIN',
  'EVENT_DIRECTOR',
  'EVENT_COORDINATOR',
  'JUDGE_COORDINATOR',
  'JUDGE',
  'STAFF',
  'REGISTRATION_OPERATOR',
  'CHECKIN_OPERATOR',
  'WEIGHIN_OPERATOR',
  'RESULTS_OPERATOR',
  'RANKING_MANAGER',
  'SOCIAL_ADMIN',
  'MODERATOR'
]);

// O cadastro público só cria papéis sem poder operacional.
const PAPEIS_DE_CADASTRO_ABERTO = Object.freeze(['ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'MEDIA']);

const isValidRole = role => USER_ROLES.includes(role);
const isPrivileged = role => PAPEIS_PRIVILEGIADOS.includes(role);
const isSelfServiceRole = role => PAPEIS_DE_CADASTRO_ABERTO.includes(role);

module.exports = { USER_ROLES, PAPEIS_PRIVILEGIADOS, PAPEIS_DE_CADASTRO_ABERTO, isValidRole, isPrivileged, isSelfServiceRole };
