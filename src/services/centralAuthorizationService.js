const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertPermission } = require('../utils/tenant');
const { PERMISSOES_CENTRAIS_DELEGADAS, PERMISSOES_NAO_DELEGAVEIS } = require('../utils/permissions');
const audit = require('./auditService');
const notifications = require('./notificationService');

// ============================================================================
// DELEGAÇÃO CENTRAL — a decisão R-02, executável.
//
// R-02: transferência, desvínculo e correção que afetem a ATRIBUIÇÃO DE PONTOS
// só podem ser efetivadas por `SUPER_ADMIN` ou por administradores centrais
// FORMALMENTE AUTORIZADOS, com permissão específica, escopo definido e
// auditoria.
//
// "Formalmente autorizado" não podia ser papel genérico. MEDIDO antes de
// escrever isto: a autorização do projeto vinha só de `User.role` e
// `OrganizationMember.role`, e nenhum dos dois carrega concessão, autor, motivo,
// prazo nem revogação. Não havia mecanismo a reusar — daí a tabela.
//
// TRÊS RECUSAS SUSTENTAM A CADEIA, E CADA UMA FECHA UM CAMINHO DE AUTOELEVAÇÃO:
//
//   1. NINGUÉM CONCEDE PARA SI MESMO. Sem esta, quem tem `central.grant` se
//      concederia `athletes.transfer` e a exigência de duas pessoas viraria
//      decoração.
//
//   2. SÓ AS PERMISSÕES DA LISTA BRANCA SÃO DELEGÁVEIS. A tabela não é um
//      distribuidor universal de privilégio: delegar `users.manage` ou
//      `results.publish` por aqui criaria uma segunda matriz RBAC, invisível
//      para `tests/matriz-de-autorizacao.mjs`.
//
//   3. `central.grant` NÃO SE DELEGA. Se delegasse, o delegado delegaria a si
//      mesmo um poder maior — autoelevação com um passo a mais. A cadeia
//      termina em `SUPER_ADMIN`, sempre. A regra é conferida DUAS vezes: aqui,
//      na escrita, e em `effectivePermissions`, na leitura — porque uma linha
//      gravada por outro caminho (script, migration, mão humana no banco) não
//      pode virar poder.
// ============================================================================

const DELEGAVEIS = new Set(PERMISSOES_CENTRAIS_DELEGADAS);
const NAO_DELEGAVEIS = new Set(PERMISSOES_NAO_DELEGAVEIS);

// A chave da concessão VIVA. Enquanto ela carrega valor, o índice único do banco
// impede uma segunda concessão idêntica; na revogação vira NULL e a vaga
// reabre. Mesmo padrão de `AthleteTeamMembership.activeAthleteId`.
const chaveAtiva = (userId, permission, organizationId) =>
  `${userId}:${permission}:${organizationId ?? 'ALL'}`;

const SELECT_CONCESSAO = Object.freeze({
  id: true, userId: true, permission: true, organizationId: true, reason: true,
  grantedAt: true, expiresAt: true, revokedAt: true, revokeReason: true,
  user: { select: { id: true, name: true, email: true, role: true } },
  grantedBy: { select: { id: true, name: true } },
  revokedBy: { select: { id: true, name: true } },
  organization: { select: { id: true, name: true, slug: true } }
});

async function conceder(data, actor) {
  assertPermission(actor, 'central.grant');

  const { userId, permission, organizationId = null, reason, expiresAt = null } = data;

  // RECUSA 1 — autoconcessão.
  if (userId === actor.id) {
    throw new AppError(403, 'SELF_GRANT_FORBIDDEN',
      'Ninguém concede delegação central para si mesmo. A concessão precisa de outra pessoa com essa permissão.');
  }

  // RECUSA 3 antes da 2, de propósito: a mensagem é diferente e mais
  // informativa, e a permissão não delegável também não está na lista branca.
  if (NAO_DELEGAVEIS.has(permission)) {
    throw new AppError(422, 'PERMISSION_NOT_DELEGABLE',
      `A permissão ${permission} não é delegável. A cadeia de concessão termina em SUPER_ADMIN.`);
  }

  // RECUSA 2 — lista branca.
  if (!DELEGAVEIS.has(permission)) {
    throw new AppError(422, 'PERMISSION_NOT_DELEGABLE',
      `A permissão ${permission} não está entre as delegáveis por autorização central.`,
      { delegaveis: [...DELEGAVEIS] });
  }

  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe a justificativa da concessão');

  const usuario = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, status: true } });
  if (!usuario) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');
  if (usuario.status && usuario.status !== 'ACTIVE') {
    throw new AppError(422, 'USER_NOT_ACTIVE', 'Conta inativa não recebe delegação central');
  }

  if (organizationId) {
    const organizacao = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!organizacao) throw new AppError(404, 'ORGANIZATION_NOT_FOUND', 'Organização não encontrada');
  }

  // Prazo no passado não é concessão: é uma linha que nunca vale e que confunde
  // quem audita. Recusada na entrada.
  const vencimento = expiresAt ? new Date(expiresAt) : null;
  if (vencimento && vencimento <= new Date()) {
    throw new AppError(422, 'EXPIRES_AT_IN_PAST', 'O prazo da concessão precisa estar no futuro');
  }

  let concessao;
  try {
    concessao = await prisma.centralAuthorization.create({
      data: {
        userId, permission, organizationId, reason,
        grantedById: actor.id, expiresAt: vencimento,
        activeKey: chaveAtiva(userId, permission, organizationId)
      },
      select: SELECT_CONCESSAO
    });
  } catch (error) {
    if (error.code === 'P2002') {
      throw new AppError(409, 'GRANT_ALREADY_ACTIVE',
        'Já existe concessão viva desta permissão para este usuário neste escopo. Revogue a atual antes de conceder outra.');
    }
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.CENTRAL_GRANT, entity: 'CentralAuthorization', entityId: concessao.id,
    organizationId, metadata: { userId, permission, expiresAt: vencimento, reason }
  });

  await notifications.notify({
    userIds: [userId], actorId: actor.id,
    type: notifications.TYPES.CENTRAL_AUTHORIZATION,
    title: 'Delegação central concedida',
    message: `Você recebeu a permissão ${permission}${organizationId ? ' com escopo de uma federação' : ''}.`
      + `${vencimento ? ` Válida até ${vencimento.toISOString().slice(0, 10)}.` : ''}`,
    entityType: 'CentralAuthorization', entityId: concessao.id
  });

  return concessao;
}

async function revogar(id, { reason }, actor) {
  assertPermission(actor, 'central.grant');
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe o motivo da revogação');

  const atual = await prisma.centralAuthorization.findUnique({
    where: { id },
    select: { id: true, userId: true, permission: true, organizationId: true, revokedAt: true }
  });
  if (!atual) throw new AppError(404, 'GRANT_NOT_FOUND', 'Concessão não encontrada');
  if (atual.revokedAt) throw new AppError(422, 'GRANT_ALREADY_REVOKED', 'Concessão já revogada');

  const revogada = await prisma.centralAuthorization.update({
    where: { id },
    // `activeKey` para NULL é o que libera a vaga para uma concessão futura — e
    // a linha permanece, com quem revogou, quando e por quê.
    data: { revokedById: actor.id, revokedAt: new Date(), revokeReason: reason, activeKey: null },
    select: SELECT_CONCESSAO
  });

  await audit.record({
    actor, action: audit.ACTIONS.CENTRAL_REVOKE, entity: 'CentralAuthorization', entityId: id,
    organizationId: atual.organizationId,
    metadata: { userId: atual.userId, permission: atual.permission, reason }
  });

  return revogada;
}

/**
 * A lista de concessões. Quem lê é quem concede ou quem audita: são as duas
 * pessoas cujo trabalho depende de ver o mapa inteiro de quem pode o quê.
 */
async function listar(filtros, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');

  const { can } = require('../utils/permissions');
  if (!can(actor, 'central.grant') && !can(actor, 'audit.read')) {
    throw new AppError(403, 'FORBIDDEN', 'Você não tem permissão para esta operação');
  }

  return prisma.centralAuthorization.findMany({
    where: {
      ...(filtros?.userId ? { userId: filtros.userId } : {}),
      ...(filtros?.permission ? { permission: filtros.permission } : {}),
      ...(filtros?.organizationId ? { organizationId: filtros.organizationId } : {}),
      // Por padrão só as VIVAS: a lista serve para responder "quem pode hoje", e
      // misturar revogadas nela é como uma concessão vencida parece ativa.
      ...(filtros?.incluirRevogadas ? {} : { revokedAt: null })
    },
    select: SELECT_CONCESSAO,
    orderBy: { grantedAt: 'desc' },
    take: Math.min(Number(filtros?.limit) || 50, 200)
  });
}

/** O que a própria pessoa recebeu. Ver a sua delegação não depende de poder conceder. */
async function minhasDelegacoes(actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');

  return prisma.centralAuthorization.findMany({
    where: { userId: actor.id, revokedAt: null },
    select: {
      id: true, permission: true, organizationId: true, reason: true, grantedAt: true, expiresAt: true,
      organization: { select: { id: true, name: true } }
    },
    orderBy: { grantedAt: 'desc' }
  });
}

module.exports = { conceder, revogar, listar, minhasDelegacoes, chaveAtiva, DELEGAVEIS };
