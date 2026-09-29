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

// PAPÉIS LEGADOS — existem no banco, não são mais oferecidos em lugar nenhum.
//
// `TEAM` nasceu como perfil de cadastro aberto ao lado de `COACH`, e a decisão
// aprovada unificou os dois numa oferta só: **Treinador (Equipe)**. A unificação
// é de OFERTA, e não de dados.
//
// POR QUE `TEAM` NÃO SAI DE `USER_ROLES`, E ISSO NÃO É DÍVIDA TÉCNICA
//
// Há contas reais com `role = 'TEAM'`. Tirar o valor do enum de papéis
// atribuíveis faria `adminUserUpdate` (`z.enum(USER_ROLES)`) recusar QUALQUER
// alteração nessas contas — inclusive suspendê-las ou corrigi-las —, porque o
// papel atual delas deixaria de ser um valor válido no corpo. E tirar o valor do
// enum do BANCO exigiria reescrever essas linhas, o que é alterar conta real.
// `TEAM` fica, portanto, atribuível por um administrador e inalcançável pelo
// cadastro aberto.
//
// POR QUE REMOVER `TEAM` DO CADASTRO ABERTO NÃO TIRA PODER DE NINGUÉM
//
// Medido em `permissions.js`: `TEAM: operacional()` — o conjunto é exatamente
// `BASE_AUTENTICADO`, as 14 permissões de leitura e de social que TODA conta
// autenticada tem, e NENHUMA permissão de treinador. É o mesmo conjunto de
// `ATHLETE`, `GYM`, `BRAND`, `SPONSOR` e `MEDIA`. Ou seja: quem se cadastrava
// como Equipe recebia uma conta indistinguível de uma conta de torcedor, sem
// `coaches.read_own`, sem `teams.read_own` e sem área própria. Não há permissão
// de treinador a migrar de `TEAM` para `COACH`, porque `TEAM` nunca teve
// nenhuma: a remoção da opção fecha um caminho sem saída.
//
// O CAMINHO INVERSO É PROIBIDO PELO MESMO MOTIVO: `COACH` tem as cinco
// permissões de treinador e `TEAM` não tem nenhuma delas, então converter
// automaticamente uma conta `TEAM` em `COACH` AMPLIARIA privilégio, sem
// aprovação central (R-03) e sem trilha. Quem coordena
// uma equipe e quer área de treinador pede o cadastro de treinador pela rota, e a
// administração central decide. `scripts/diagnostico-papel-legado-equipe.js`
// existe para dizer quantas contas estão nessa situação, sem tocar em nenhuma.
const PAPEIS_LEGADOS = Object.freeze(['TEAM']);

// O cadastro público só cria papéis sem poder operacional — e, desde a
// unificação, um só deles representa treinador e equipe: `COACH`.
const PAPEIS_DE_CADASTRO_ABERTO = Object.freeze(['ATHLETE', 'COACH', 'GYM', 'BRAND', 'SPONSOR', 'MEDIA']);

const isValidRole = role => USER_ROLES.includes(role);
const isPrivileged = role => PAPEIS_PRIVILEGIADOS.includes(role);
const isSelfServiceRole = role => PAPEIS_DE_CADASTRO_ABERTO.includes(role);
const isLegacyRole = role => PAPEIS_LEGADOS.includes(role);

module.exports = {
  USER_ROLES, PAPEIS_PRIVILEGIADOS, PAPEIS_DE_CADASTRO_ABERTO, PAPEIS_LEGADOS,
  isValidRole, isPrivileged, isSelfServiceRole, isLegacyRole
};
