const USER_ROLES = Object.freeze(['ADMIN', 'ORGANIZER', 'JUDGE', 'COACH', 'ATHLETE', 'PUBLIC']);

const ROLE_LEVELS = Object.freeze({
  PUBLIC: 0,
  ATHLETE: 1,
  COACH: 2,
  JUDGE: 3,
  ORGANIZER: 4,
  ADMIN: 5
});

const isValidRole = role => USER_ROLES.includes(role);

module.exports = { USER_ROLES, ROLE_LEVELS, isValidRole };
