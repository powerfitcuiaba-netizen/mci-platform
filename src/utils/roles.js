// Papéis da plataforma — os que uma PESSOA pode ter.
//
// A lista é um subconjunto do enum `UserRole` do banco, e a diferença é UMA e
// deliberada: `FEDERATION_SERVICE` fica de fora. Ela existe no enum porque a
// conta de serviço da federação precisa dela; fica fora daqui porque esta
// lista alimenta `adminUserUpdate` (`z.enum(USER_ROLES)`) e é o que decide o
// que um operador pode ATRIBUIR a alguém. Nenhuma pessoa deve receber a
// identidade técnica do sistema, e nenhuma conta de serviço deve nascer pela
// tela de administração — ela nasce só em `serviceAccountService.provisionar`.
//
// NÃO ACRESCENTE `FEDERATION_SERVICE` AQUI PARA "ESPELHAR O BANCO". Ela não
// está em `PAPEIS_PRIVILEGIADOS`, então acrescentá-la a tornaria atribuível
// por qualquer um com `users.manage` — e há teste em `unidade-dominio`
// cobrando exatamente esta ausência, com este motivo.
//
// Acrescentar um papel de pessoa continua exigindo migration: o banco não
// conhece o que não está no enum dele.
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
