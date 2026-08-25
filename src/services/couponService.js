const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const money = require('../utils/money');
const auditService = require('./auditService');

const normalizeCode = code => String(code || '').trim().toUpperCase();

const publicShape = {
  id: true, code: true, description: true, percentOff: true, amountOffCents: true,
  tournamentId: true, active: true, startsAt: true, endsAt: true,
  maxRedemptions: true, maxPerUser: true, redeemedCount: true, createdAt: true,
  tournament: { select: { id: true, name: true } }
};

// Avalia o cupom para um usuário e subtotal sem consumi-lo. É o que o checkout
// chama para mostrar o desconto antes de fechar o pedido.
async function evaluate({ code, userId, tournamentId, subtotalCents }) {
  const codigo = normalizeCode(code);
  if (!codigo) throw new AppError(422, 'COUPON_REQUIRED', 'Informe o código do cupom');

  const coupon = await prisma.coupon.findUnique({ where: { code: codigo } });
  if (!coupon) throw new AppError(404, 'COUPON_NOT_FOUND', 'Cupom não encontrado');
  if (!coupon.active) throw new AppError(422, 'COUPON_INACTIVE', 'Cupom desativado');

  const agora = new Date();
  if (coupon.startsAt && coupon.startsAt > agora) throw new AppError(422, 'COUPON_NOT_STARTED', 'Cupom ainda não está válido');
  if (coupon.endsAt && coupon.endsAt < agora) throw new AppError(422, 'COUPON_EXPIRED', 'Cupom expirado');

  // Cupom amarrado a um campeonato não vale em outro.
  if (coupon.tournamentId && coupon.tournamentId !== tournamentId) {
    throw new AppError(422, 'COUPON_NOT_APPLICABLE', 'Cupom não é válido para este campeonato');
  }

  if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
    throw new AppError(409, 'COUPON_EXHAUSTED', 'Cupom esgotado');
  }

  const usosDoUsuario = await prisma.couponRedemption.count({ where: { couponId: coupon.id, userId } });
  if (usosDoUsuario >= coupon.maxPerUser) {
    throw new AppError(409, 'COUPON_ALREADY_USED', 'Você já utilizou este cupom');
  }

  const bruto = coupon.percentOff !== null && coupon.percentOff !== undefined
    ? money.percentOf(subtotalCents, coupon.percentOff)
    : money.assertCents(coupon.amountOffCents || 0, 'desconto');

  // O desconto nunca ultrapassa o subtotal.
  const discountCents = money.clampDiscount(subtotalCents, bruto);

  return { coupon, discountCents };
}

// Consome uma unidade do cupom. O incremento usa comparação-e-troca sobre o
// contador que acabou de ser lido: duas requisições simultâneas disputam a
// mesma linha e apenas uma consegue escrever, então o limite não é ultrapassado
// mesmo sem lock explícito.
async function redeem(tx, { coupon, userId, orderId, discountCents }) {
  const atual = await tx.coupon.findUnique({ where: { id: coupon.id } });
  if (!atual || !atual.active) throw new AppError(422, 'COUPON_INACTIVE', 'Cupom desativado');
  if (atual.maxRedemptions !== null && atual.redeemedCount >= atual.maxRedemptions) {
    throw new AppError(409, 'COUPON_EXHAUSTED', 'Cupom esgotado');
  }

  const { count } = await tx.coupon.updateMany({
    where: { id: atual.id, redeemedCount: atual.redeemedCount },
    data: { redeemedCount: { increment: 1 } }
  });
  if (count === 0) {
    throw new AppError(409, 'COUPON_CONTENDED', 'Cupom sendo utilizado por outra solicitação. Tente novamente.');
  }

  try {
    return await tx.couponRedemption.create({
      data: { couponId: atual.id, userId, orderId, discountCents }
    });
  } catch (error) {
    // Uso duplicado pelo mesmo pedido: devolve a unidade que acabou de sair.
    if (error.code === 'P2002') {
      await tx.coupon.update({ where: { id: atual.id }, data: { redeemedCount: { decrement: 1 } } });
      throw new AppError(409, 'COUPON_ALREADY_USED', 'Cupom já aplicado a este pedido');
    }
    throw error;
  }
}

// Devolve a unidade ao cancelar ou reembolsar um pedido que consumiu cupom.
async function release(tx, orderId) {
  const resgate = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (!resgate) return null;
  await tx.couponRedemption.delete({ where: { id: resgate.id } });
  await tx.coupon.update({ where: { id: resgate.couponId }, data: { redeemedCount: { decrement: 1 } } });
  return resgate;
}

const assertGestor = actor => {
  if (!actor || !['ADMIN', 'ORGANIZER'].includes(actor.role)) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode administrar cupons');
  }
};

async function create(data, actor) {
  assertGestor(actor);

  const percentOff = data.percentOff ?? null;
  const amountOffCents = data.amountOffCents ?? null;
  if ((percentOff === null) === (amountOffCents === null)) {
    throw new AppError(422, 'INVALID_COUPON', 'Informe percentual ou valor fixo, e apenas um deles');
  }
  if (amountOffCents !== null) money.assertCents(amountOffCents, 'desconto');
  if (percentOff !== null && (percentOff < 1 || percentOff > 100)) {
    throw new AppError(422, 'INVALID_COUPON', 'Percentual deve ficar entre 1 e 100');
  }
  if (data.startsAt && data.endsAt && new Date(data.endsAt) < new Date(data.startsAt)) {
    throw new AppError(422, 'INVALID_COUPON', 'Data final deve ser posterior à inicial');
  }

  // Organizador só cria cupom para campeonato próprio.
  if (data.tournamentId) {
    const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
    if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
    if (actor.role !== 'ADMIN' && tournament.createdById !== actor.id) {
      throw new AppError(403, 'FORBIDDEN', 'Você não pode criar cupom para este campeonato');
    }
  } else if (actor.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Apenas administradores criam cupom global');
  }

  try {
    const coupon = await prisma.coupon.create({
      data: {
        code: normalizeCode(data.code),
        description: data.description || null,
        percentOff, amountOffCents,
        tournamentId: data.tournamentId || null,
        active: data.active ?? true,
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
        maxRedemptions: data.maxRedemptions ?? null,
        maxPerUser: data.maxPerUser ?? 1,
        createdById: actor.id
      },
      select: publicShape
    });

    await auditService.record({ actor, action: 'COUPON_CREATE', entity: 'Coupon', entityId: coupon.id, metadata: { code: coupon.code } });
    return coupon;
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'COUPON_CODE_TAKEN', 'Já existe um cupom com este código');
    throw error;
  }
}

async function list(actor) {
  assertGestor(actor);
  const where = actor.role === 'ADMIN' ? {} : { tournament: { createdById: actor.id } };
  const items = await prisma.coupon.findMany({ where, select: publicShape, orderBy: { createdAt: 'desc' } });
  return { items };
}

async function setActive(id, active, actor) {
  assertGestor(actor);
  const coupon = await prisma.coupon.findUnique({ where: { id }, include: { tournament: true } });
  if (!coupon) throw new AppError(404, 'COUPON_NOT_FOUND', 'Cupom não encontrado');
  if (actor.role !== 'ADMIN' && coupon.tournament?.createdById !== actor.id) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar este cupom');
  }

  const atualizado = await prisma.coupon.update({ where: { id }, data: { active: Boolean(active) }, select: publicShape });
  await auditService.record({ actor, action: active ? 'COUPON_ACTIVATE' : 'COUPON_DEACTIVATE', entity: 'Coupon', entityId: id, metadata: { code: coupon.code } });
  return atualizado;
}

module.exports = { evaluate, redeem, release, create, list, setActive, normalizeCode, publicShape };
