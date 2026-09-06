const { AppError } = require('../utils/errors');
const { verifyToken } = require('../utils/auth');
const userRepository = require('../repositories/userRepository');
const { ROLE_LEVELS } = require('../utils/roles');
const { pode } = require('../domain/acesso/permissoes');

async function loadUserFromHeader(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  try {
    const payload = verifyToken(token);
    const user = await userRepository.findById(payload.sub);
    if (!user) return null;
    // `req` pertence a uma unica requisicao e nao e compartilhado entre
    // execucoes concorrentes: nao ha a corrida que a regra supoe.
    // eslint-disable-next-line require-atomic-updates
    req.user = user;
    return user;
  } catch (_error) {
    throw new AppError(401, 'INVALID_TOKEN', 'Token inválido ou expirado');
  }
}

async function optionalAuth(req, res, next) {
  try {
    req.user = null;
    await loadUserFromHeader(req).catch(error => {
      if (error.status === 401) {
        req.user = null;
        return null;
      }
      throw error;
    });
    next();
  } catch (error) {
    next(error);
  }
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUserFromHeader(req);
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(roles, allowAnonymous = false) {
  return (req, res, next) => {
    const user = req.user;

    if (!user && allowAnonymous) return next();
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória'));

    if (!roles.includes(user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'Você não tem permissão para acessar este recurso'));
    }

    next();
  };
}

function requireHigherRole(minRole) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória'));
    if (ROLE_LEVELS[user.role] < ROLE_LEVELS[minRole]) {
      return next(new AppError(403, 'FORBIDDEN', 'Nível de acesso insuficiente'));
    }
    next();
  };
}

// Autorização por permissão nomeada, e não por lista de papéis embutida na
// rota. A diferença aparece quando um papel novo entra no sistema: com lista de
// papéis é preciso caçar todas as rotas; com permissão, basta concedê-la no
// mapa de papéis.
//
// Continua sendo apenas a primeira barreira. Quem responde "este juiz pode ver
// ESTA bateria" é o service e, no banco, a política de RLS.
function requirePermission(permissao) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória'));

    if (!pode(user.role, permissao)) {
      return next(new AppError(403, 'FORBIDDEN', 'Você não tem permissão para acessar este recurso', {
        permissaoExigida: permissao
      }));
    }
    next();
  };
}

module.exports = { optionalAuth, requireAuth, requireRole, requireHigherRole, requirePermission, loadUserFromHeader };
