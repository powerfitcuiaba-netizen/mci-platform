const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { can } = require('../utils/permissions');

// Ações críticas registradas na trilha. A lista existe para que o nome da ação
// seja estável e pesquisável, não para restringir: `record` aceita qualquer
// string, mas o domínio usa estas.
const ACTIONS = Object.freeze({
  LOGIN: 'LOGIN',
  ATHLETE_CREATE: 'ATHLETE_CREATE',
  ATHLETE_UPDATE: 'ATHLETE_UPDATE',
  ATHLETE_CPF_VIEW: 'ATHLETE_CPF_VIEW',
  REGISTRATION_CREATE: 'REGISTRATION_CREATE',
  REGISTRATION_CANCEL: 'REGISTRATION_CANCEL',
  CHECKIN: 'CHECKIN',
  WEIGHIN: 'WEIGHIN',
  CREDENTIAL_ISSUE: 'CREDENTIAL_ISSUE',
  CREDENTIAL_SCAN: 'CREDENTIAL_SCAN',
  EVENT_CREATE: 'EVENT_CREATE',
  EVENT_TRANSITION: 'EVENT_TRANSITION',
  JUDGING_SCORE: 'JUDGING_SCORE',
  JUDGING_CLOSE: 'JUDGING_CLOSE',
  RESULT_RECEIVED: 'RESULT_RECEIVED',
  RESULT_PUBLICATION: 'RESULT_PUBLICATION',
  RESULT_OVERRIDE: 'RESULT_OVERRIDE',
  RANKING_UPDATE: 'RANKING_UPDATE',
  // Correção administrativa de lançamento já publicado. Três ações separadas
  // porque as três respondem perguntas diferentes na trilha: o que mudou, o
  // que deixou de valer, e o que voltou a valer.
  RANKING_POINT_EDITED: 'RANKING_POINT_EDITED',
  RANKING_POINT_VOIDED: 'RANKING_POINT_VOIDED',
  RANKING_POINT_RESTORED: 'RANKING_POINT_RESTORED',
  // Pontuação (fase 11.3). O padrão do projeto é ENTIDADE_VERBO, então os
  // nomes seguem SCORE_*, e não os do enunciado, que usa VERBO no particípio.
  // RANKING_UPDATE já cobre o recálculo do agregado e permanece como está.
  SCORE_CONFLICT: 'SCORE_CONFLICT',
  SUPER_OVERALL_UPDATE: 'SUPER_OVERALL_UPDATE',
  OVERALL_DECLARE: 'OVERALL_DECLARE',
  // Revogação de título homologado. Ação PRÓPRIA, e não um DECLARE com valor
  // nulo: corrigir uma homologação é ato administrativo distinto de fazê-la, e
  // quem audita precisa distinguir os dois na trilha sem interpretar metadado.
  OVERALL_REVOKE: 'OVERALL_REVOKE',
  CLASS_CATALOG_SET: 'CLASS_CATALOG_SET',
  ATHLETE_TEAM_LINK: 'ATHLETE_TEAM_LINK',
  ATHLETE_TEAM_TRANSFER: 'ATHLETE_TEAM_TRANSFER',
  ATHLETE_TEAM_UNLINK: 'ATHLETE_TEAM_UNLINK',
  MUSCLEWAR_IMPORT: 'MUSCLEWAR_IMPORT',
  MUSCLEWAR_REVIEW: 'MUSCLEWAR_REVIEW',
  MUSCLEWAR_APPLY: 'MUSCLEWAR_APPLY',
  PRO_STATUS_CHANGE: 'PRO_STATUS_CHANGE',
  ROLE_CHANGE: 'ROLE_CHANGE',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  CONTENT_MODERATION: 'CONTENT_MODERATION'
});

// Chaves que nunca entram na trilha, mesmo que apareçam no payload da ação.
const PROIBIDAS = ['password', 'senha', 'token', 'secret', 'authorization', 'hash'];

const ehProibida = chave => {
  const nome = String(chave).toLowerCase();
  return PROIBIDAS.some(proibida => nome.includes(proibida));
};

function sanitize(valor, profundidade = 0) {
  if (profundidade > 4) return '[profundo demais]';
  if (Array.isArray(valor)) return valor.slice(0, 50).map(item => sanitize(item, profundidade + 1));
  if (valor instanceof Date) return valor.toISOString();
  if (valor && typeof valor === 'object') {
    const saida = {};
    for (const [chave, interno] of Object.entries(valor)) {
      if (ehProibida(chave)) continue;
      saida[chave] = sanitize(interno, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

// Auditar é efeito colateral: uma falha aqui não derruba a operação auditada,
// mas também não passa despercebida.
// `createMany` e não `create`: o `create` do Prisma emite INSERT ... RETURNING,
// e o RETURNING é submetido à política de SELECT da tabela. Como a auditoria só
// é legível por administrador e operador da organização, gravar um registro em
// nome de um ator comum falharia ao tentar lê-lo de volta — e o retorno é
// descartado por todas as 44 chamadas. Sem RETURNING, a escrita passa pela
// política de INSERT, que é a que de fato governa quem pode auditar.
async function record({ actor, action, entity, entityId = null, organizationId = null, metadata = null, ip = null }) {
  try {
    return await prisma.auditLog.createMany({
      data: {
        organizationId,
        userId: actor?.id || null,
        userEmail: actor?.email || null,
        action: String(action),
        entity: String(entity),
        entityId: entityId ? String(entityId) : null,
        metadata: metadata ? sanitize(metadata) : undefined,
        ip: ip ? String(ip).slice(0, 60) : null
      }
    });
  } catch (error) {
    logger.error('falha ao registrar auditoria', { action: String(action), entity: String(entity), erro: error.message });
    return null;
  }
}

async function list(filtros, actor) {
  if (!can(actor, 'audit.read', filtros.organizationId || null)) {
    throw new AppError(403, 'FORBIDDEN', 'Sem permissão para consultar a auditoria');
  }

  const where = {};
  if (filtros.entity) where.entity = filtros.entity;
  if (filtros.entityId) where.entityId = filtros.entityId;
  if (filtros.userId) where.userId = filtros.userId;
  if (filtros.action) where.action = filtros.action;
  if (filtros.organizationId) where.organizationId = filtros.organizationId;

  const limite = Math.min(Number(filtros.limit) || 100, 200);

  const items = await prisma.auditLog.findMany({
    where,
    select: {
      id: true, action: true, entity: true, entityId: true, metadata: true,
      organizationId: true, createdAt: true, userEmail: true, ip: true,
      user: { select: { id: true, name: true, role: true } }
    },
    // `createdAt` não é único: duas ações do mesmo lote caem no mesmo
    // milissegundo. O `id` fecha a ordem por contrato — auditoria embaralhada
    // entre duas leituras não é auditoria. Mesma decisão do check-in, e pelo
    // mesmo motivo: determinismo por contrato, não por sorte do plano.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limite,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  // `total: items.length` devolvia o tamanho da PÁGINA. Numa trilha de
  // auditoria isso é pior que numa lista comum: auditoria existe para
  // responder "isto aconteceu quantas vezes?", e um total que na verdade é o
  // teto responde sempre a mesma coisa. A tela não exibia esse número, o que
  // reduzia o impacto — mas número errado exposto por API é defeito mesmo
  // quando ninguém está olhando, porque a próxima tela vai acreditar nele.
  return {
    items,
    total: await prisma.auditLog.count({ where }),
    nextCursor: items.length === limite ? items[items.length - 1].id : null
  };
}

module.exports = { record, list, sanitize, ACTIONS };
