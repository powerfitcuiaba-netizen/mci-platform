const { AppError } = require('../utils/errors');
const { verifyToken } = require('../utils/auth');
const userRepository = require('../repositories/userRepository');
const { can, belongsToOrganization } = require('../utils/permissions');

async function loadUserFromHeader(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    throw new AppError(401, 'INVALID_TOKEN', 'Token inválido ou expirado');
  }

  const user = await userRepository.findById(payload.sub);
  if (!user) throw new AppError(401, 'INVALID_TOKEN', 'Token inválido ou expirado');
  // Conta suspensa ou desativada não opera nada, mesmo com token ainda no prazo.
  if (user.status !== 'ACTIVE') throw new AppError(403, 'USER_INACTIVE', 'Conta inativa');

  req.user = user;
  return user;
}

// Leitura aberta: token ausente ou inválido segue como visitante, sem erro.
async function optionalAuth(req, res, next) {
  req.user = null;
  try {
    await loadUserFromHeader(req);
  } catch (error) {
    if (error.status !== 401) return next(error);
    req.user = null;
  }
  next();
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

// Autorização por permissão nomeada, nunca por papel. `organizationFrom`
// extrai da requisição o tenant em que a permissão precisa valer — sem isso,
// um operador de uma organização usaria seu papel em outra.
function requirePermission(permission, organizationFrom = null) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória'));

    const organizationId = typeof organizationFrom === 'function' ? organizationFrom(req) : organizationFrom;

    if (!can(user, permission, organizationId)) {
      return next(new AppError(403, 'FORBIDDEN', 'Você não tem permissão para esta operação'));
    }
    next();
  };
}

// Barreira de tenant explícita para rotas que recebem a organização no corpo
// ou na query.
function requireOrganizationAccess(organizationFrom) {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return next(new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória'));

    const organizationId = typeof organizationFrom === 'function' ? organizationFrom(req) : organizationFrom;
    if (!organizationId) return next(new AppError(422, 'ORGANIZATION_REQUIRED', 'Organização não informada'));

    if (!belongsToOrganization(user, organizationId)) {
      return next(new AppError(403, 'FORBIDDEN', 'Recurso de outra organização'));
    }
    next();
  };
}

module.exports = { optionalAuth, requireAuth, requirePermission, requireOrganizationAccess, loadUserFromHeader };
