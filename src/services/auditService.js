const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');

// Chaves que nunca podem entrar na trilha, mesmo que apareçam no payload de
// alguma ação. A comparação é por substring em minúsculas para pegar variações
// como newPassword, currentPassword, accessToken.
const PROIBIDAS = ['password', 'senha', 'token', 'secret', 'authorization', 'cvv', 'card', 'hash'];

const ehProibida = chave => {
  const nome = String(chave).toLowerCase();
  return PROIBIDAS.some(proibida => nome.includes(proibida));
};

function sanitize(valor, profundidade = 0) {
  if (profundidade > 4) return '[profundo demais]';
  if (Array.isArray(valor)) return valor.slice(0, 20).map(item => sanitize(item, profundidade + 1));
  if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    const saida = {};
    for (const [chave, interno] of Object.entries(valor)) {
      if (ehProibida(chave)) continue;
      saida[chave] = sanitize(interno, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

// Registrar é efeito colateral de auditoria: uma falha aqui não pode derrubar a
// operação que estava sendo auditada, mas também não pode passar despercebida.
async function record({ actor, action, entity, entityId = null, metadata = null }) {
  try {
    const limpo = metadata ? sanitize(metadata) : null;
    return await prisma.auditLog.create({
      data: {
        userId: actor?.id || null,
        userEmail: actor?.email || null,
        action: String(action),
        entity: String(entity),
        entityId: entityId ? String(entityId) : null,
        metadata: limpo ? JSON.stringify(limpo).slice(0, 4000) : null
      }
    });
  } catch (error) {
    console.error(`[auditoria] falha ao registrar ${action} em ${entity}:`, error.message);
    return null;
  }
}

async function list(filtros, actor) {
  if (!actor || actor.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Apenas administradores consultam a auditoria');
  }

  const where = {};
  if (filtros.entity) where.entity = filtros.entity;
  if (filtros.entityId) where.entityId = filtros.entityId;
  if (filtros.userId) where.userId = filtros.userId;
  if (filtros.action) where.action = filtros.action;

  const take = Math.min(Number(filtros.limit) || 100, 200);

  const items = await prisma.auditLog.findMany({
    where,
    select: {
      id: true, action: true, entity: true, entityId: true, metadata: true, createdAt: true,
      userEmail: true,
      user: { select: { id: true, name: true, role: true } }
    },
    orderBy: { createdAt: 'desc' },
    take
  });

  return { items, total: items.length };
}

module.exports = { record, list, sanitize };
