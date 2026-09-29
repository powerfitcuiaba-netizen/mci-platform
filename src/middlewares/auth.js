const { AppError } = require('../utils/errors');
const { verifyToken } = require('../utils/auth');
const userRepository = require('../repositories/userRepository');
const { withUserContext } = require('../config/rlsSession');
const { can, belongsToOrganization } = require('../utils/permissions');

// ============================================================================
// A CARGA DO ATOR ACONTECE DENTRO DO CONTEXTO DE RLS DELE. Por quê:
//
// `asyncHandler` abre a transação com `SET LOCAL mci.user_id` a partir de
// `req.user` — ou seja, DEPOIS daqui. Este middleware sempre rodou antes dessa
// transação, na conexão base, sem contexto: para o banco, quem consultava era
// um ator anônimo.
//
// Isso não incomodava ninguém enquanto tudo o que a carga do usuário precisava
// vinha de tabelas sem RLS (`User`, `OrganizationMember`). A decisão R-02
// mudou o quadro: a permissão efetiva passou a depender de
// `CentralAuthorization`, que TEM RLS — `central_leitura` exige
// `mci_is_platform_admin()` ou `"userId" = mci_current_user_id()`, e sem
// contexto nenhuma das duas vale.
//
// MEDIDO, antes da correção: com uma concessão de `athletes.transfer` viva e
// gravada (201 na rota, e visível em `GET /central-authorizations/me`, que roda
// dentro da transação da requisição), `userRepository.findById` devolvia
// `centralGrantsReceived: []` e `can(ator, 'athletes.transfer', org)` era
// `false`. A delegação existia no banco e não chegava à autorização — a rota
// respondia 403 a quem tinha o poder.
//
// A correção NÃO é afrouxar a política: é dar contexto à carga. O id vem do
// token já verificado, que é a mesma origem que `asyncHandler` usa — não do
// corpo, nem da query, nem de parâmetro de rota. Se o id for de conta
// inexistente, a consulta volta vazia e a resposta é 401, como antes.
//
// CUSTO: uma transação curta a mais por requisição autenticada (BEGIN,
// set_config, SELECT, COMMIT). A consulta já existia; o que se acrescenta é o
// par BEGIN/COMMIT em volta dela. É o preço de a autorização ler o que o banco
// de fato guarda.
// ============================================================================

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

  const user = await withUserContext(payload.sub, () => userRepository.findById(payload.sub));
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
