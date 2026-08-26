const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { USER_ROLES } = require('../utils/roles');
const { config } = require('../config/environment');
const auditService = require('./auditService');

// O LIKE do SQLite ignora maiúsculas por padrão; o do PostgreSQL não. Sem isto
// a busca acharia "Ana Souza" por "ana" hoje e deixaria de achar depois da
// migração — uma mudança silenciosa de comportamento. `mode` só existe no
// PostgreSQL, então é aplicado apenas lá.
const buscaTextual = termo => (config.databaseKind === 'postgresql'
  ? { contains: termo, mode: 'insensitive' }
  : { contains: termo });

// Nenhuma consulta desta camada seleciona passwordHash. A projeção é explícita
// em vez de exclusão por omissão: campo novo no modelo não vaza por descuido.
const userShape = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  participant: { select: { id: true, name: true, type: true } },
  _count: { select: { notifications: true, judgeAssignments: true, createdTournaments: true } }
};

const assertAdmin = actor => {
  if (!actor || actor.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Apenas administradores acessam esta área');
  }
};

async function listUsers(filtros, actor) {
  assertAdmin(actor);

  const where = {};
  if (filtros.role) where.role = filtros.role;
  if (filtros.status) where.status = filtros.status;
  if (filtros.search) {
    const termo = String(filtros.search).trim();
    where.OR = [{ name: buscaTextual(termo) }, { email: buscaTextual(termo) }];
  }

  const items = await prisma.user.findMany({
    where,
    select: userShape,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(filtros.limit) || 100, 200)
  });

  return { items, total: items.length };
}

async function findUser(id, actor) {
  assertAdmin(actor);
  const user = await prisma.user.findUnique({ where: { id }, select: userShape });
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  return user;
}

// Alterar perfil e situação é atribuição administrativa e fica registrado.
// Um administrador não pode rebaixar nem desativar a si próprio: isso já
// deixou muito sistema sem ninguém capaz de administrá-lo.
async function updateUser(id, data, actor) {
  assertAdmin(actor);

  const alvo = await prisma.user.findUnique({ where: { id } });
  if (!alvo) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

  const dados = {};

  if (data.role !== undefined) {
    if (!USER_ROLES.includes(data.role)) throw new AppError(400, 'VALIDATION_ERROR', 'Perfil inválido');
    if (alvo.id === actor.id && data.role !== 'ADMIN') {
      throw new AppError(422, 'CANNOT_DEMOTE_SELF', 'Você não pode alterar o próprio perfil de administrador');
    }
    dados.role = data.role;
  }

  if (data.status !== undefined) {
    const status = String(data.status).toUpperCase();
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Situação inválida');
    }
    if (alvo.id === actor.id && status !== 'ACTIVE') {
      throw new AppError(422, 'CANNOT_SUSPEND_SELF', 'Você não pode suspender a própria conta');
    }
    dados.status = status;
  }

  if (!Object.keys(dados).length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Informe perfil ou situação para atualizar');
  }

  const atualizado = await prisma.user.update({ where: { id }, data: dados, select: userShape });

  await auditService.record({
    actor, action: 'USER_UPDATE', entity: 'User', entityId: id,
    metadata: { de: { role: alvo.role, status: alvo.status }, para: dados }
  });

  return atualizado;
}

// Retrato global da plataforma, em consultas por lote.
async function overview(actor) {
  assertAdmin(actor);

  const [porPerfil, tournaments, participants, enrollments, matches, results, documents, notifications, auditoria, recentes] = await Promise.all([
    prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
    prisma.tournament.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.participant.groupBy({ by: ['type'], _count: { _all: true } }),
    prisma.enrollment.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.match.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.result.count(),
    prisma.document.count(),
    prisma.notification.count(),
    prisma.auditLog.count(),
    prisma.auditLog.findMany({
      select: { id: true, action: true, entity: true, entityId: true, createdAt: true, userEmail: true, user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10
    })
  ]);

  const contar = (linhas, chave) => linhas.reduce((acc, linha) => ({ ...acc, [linha[chave]]: linha._count._all }), {});

  return {
    users: { total: porPerfil.reduce((soma, linha) => soma + linha._count._all, 0), porPerfil: contar(porPerfil, 'role') },
    tournaments: { total: tournaments.reduce((soma, linha) => soma + linha._count._all, 0), porStatus: contar(tournaments, 'status') },
    participants: { total: participants.reduce((soma, linha) => soma + linha._count._all, 0), porTipo: contar(participants, 'type') },
    enrollments: { total: enrollments.reduce((soma, linha) => soma + linha._count._all, 0), porStatus: contar(enrollments, 'status') },
    matches: { total: matches.reduce((soma, linha) => soma + linha._count._all, 0), porStatus: contar(matches, 'status') },
    totals: { results, documents, notifications, auditLogs: auditoria },
    recentAudit: recentes
  };
}

module.exports = { listUsers, findUser, updateUser, overview, userShape };
