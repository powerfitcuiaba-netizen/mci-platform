const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const money = require('../utils/money');
const { assertTransicao } = require('../utils/financialStates');
const couponService = require('./couponService');
const notificationService = require('./notificationService');
const auditService = require('./auditService');

// Janela para concluir o pagamento. Passado esse prazo o pedido expira e o
// cupom volta para o estoque.
const MINUTOS_PARA_EXPIRAR = Number(process.env.ORDER_EXPIRATION_MINUTES || 60);

const publicShape = {
  id: true, status: true, currency: true,
  subtotalCents: true, discountCents: true, totalCents: true,
  expiresAt: true, paidAt: true, cancelledAt: true, createdAt: true,
  tournament: { select: { id: true, name: true, status: true } },
  coupon: { select: { id: true, code: true } },
  items: { select: { id: true, description: true, quantity: true, unitPriceCents: true, totalCents: true, enrollmentId: true } },
  payments: { select: { id: true, status: true, provider: true, amountCents: true, paidAt: true, failureReason: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
  refunds: { select: { id: true, status: true, amountCents: true, reason: true, processedAt: true, createdAt: true } }
};

// Quem pode comprar por um participante. O ator vem do token; o corpo da
// requisição nunca decide de quem é o pedido.
async function assertPodeComprarPor(participantId, tournament, actor) {
  const participant = await prisma.participant.findUnique({
    where: { id: participantId },
    select: { id: true, name: true, userId: true, coachId: true }
  });
  if (!participant) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');

  if (actor.role === 'ADMIN') return participant;
  if (actor.role === 'ORGANIZER' && tournament.createdById === actor.id) return participant;
  if (participant.userId === actor.id) return participant;
  if (actor.role === 'COACH' && participant.coachId === actor.id) return participant;

  throw new AppError(403, 'FORBIDDEN', 'Você não pode gerar pedido para este participante');
}

// O preço é sempre lido do campeonato. Nada de valor, desconto ou total vindo
// do cliente entra nesta conta — o corpo da requisição só diz o que se quer
// comprar, nunca quanto custa.
function calcular({ tournament, quantidade, discountCents }) {
  const unitPriceCents = money.assertCents(tournament.entryFeeCents, 'preço do campeonato');
  const subtotalCents = money.assertCents(unitPriceCents * quantidade, 'subtotal');
  const desconto = money.clampDiscount(subtotalCents, discountCents || 0);
  return { unitPriceCents, subtotalCents, discountCents: desconto, totalCents: subtotalCents - desconto };
}

async function create(data, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');

  // Reenvio da mesma intenção de compra devolve o pedido já criado em vez de
  // gerar um segundo. É o que impede cobrança dupla por clique repetido.
  if (data.idempotencyKey) {
    const existente = await prisma.order.findUnique({ where: { idempotencyKey: data.idempotencyKey }, select: { ...publicShape, userId: true } });
    if (existente) {
      if (existente.userId !== actor.id && actor.role !== 'ADMIN') {
        throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Chave de idempotência já usada por outro pedido');
      }
      const { userId, ...visivel } = existente;
      return { ...visivel, idempotente: true };
    }
  }

  const tournament = await prisma.tournament.findUnique({ where: { id: data.tournamentId } });
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');
  if (['FINISHED', 'CANCELLED'].includes(tournament.status)) {
    throw new AppError(422, 'TOURNAMENT_CLOSED', 'Este campeonato não aceita novas inscrições');
  }
  if (tournament.entryFeeCents <= 0) {
    throw new AppError(422, 'TOURNAMENT_IS_FREE', 'Este campeonato é gratuito e não exige pedido de pagamento');
  }

  const participant = await assertPodeComprarPor(data.participantId, tournament, actor);

  // Uma inscrição já paga não gera novo pedido.
  const inscricaoExistente = await prisma.enrollment.findUnique({
    where: { tournamentId_participantId: { tournamentId: tournament.id, participantId: participant.id } }
  });
  if (inscricaoExistente && inscricaoExistente.paymentStatus === 'PAID') {
    throw new AppError(409, 'ENROLLMENT_ALREADY_PAID', 'Esta inscrição já está paga');
  }

  const pendente = await prisma.order.findFirst({
    where: { tournamentId: tournament.id, userId: actor.id, status: 'PENDING', items: { some: { enrollment: { participantId: participant.id } } } },
    select: publicShape
  });
  if (pendente) throw new AppError(409, 'ORDER_ALREADY_PENDING', 'Já existe um pedido pendente para esta inscrição');

  // Cupom é avaliado antes da transação para que o erro chegue ao cliente com
  // a causa exata; o consumo acontece dentro dela.
  let avaliacao = null;
  const preview = calcular({ tournament, quantidade: 1, discountCents: 0 });
  if (data.couponCode) {
    avaliacao = await couponService.evaluate({
      code: data.couponCode, userId: actor.id, tournamentId: tournament.id, subtotalCents: preview.subtotalCents
    });
  }

  const valores = calcular({ tournament, quantidade: 1, discountCents: avaliacao?.discountCents || 0 });
  const expiresAt = new Date(Date.now() + MINUTOS_PARA_EXPIRAR * 60000);

  const pedido = await prisma.$transaction(async tx => {
    const enrollment = inscricaoExistente
      ? await tx.enrollment.update({
          where: { id: inscricaoExistente.id },
          data: { status: 'CONFIRMED', paymentStatus: 'PENDING', cancelledAt: null, cancelledById: null }
        })
      : await tx.enrollment.create({
          data: { tournamentId: tournament.id, participantId: participant.id, status: 'CONFIRMED', paymentStatus: 'PENDING' }
        });

    const order = await tx.order.create({
      data: {
        userId: actor.id,
        tournamentId: tournament.id,
        status: 'PENDING',
        currency: tournament.currency,
        subtotalCents: valores.subtotalCents,
        discountCents: valores.discountCents,
        totalCents: valores.totalCents,
        couponId: avaliacao?.coupon.id || null,
        idempotencyKey: data.idempotencyKey || null,
        expiresAt,
        items: {
          create: [{
            enrollmentId: enrollment.id,
            description: `Inscrição — ${tournament.name} — ${participant.name}`,
            quantity: 1,
            unitPriceCents: valores.unitPriceCents,
            totalCents: valores.subtotalCents
          }]
        }
      }
    });

    if (avaliacao) {
      await couponService.redeem(tx, {
        coupon: avaliacao.coupon, userId: actor.id, orderId: order.id, discountCents: valores.discountCents
      });
    }

    return order;
  });

  await auditService.record({
    actor, action: 'ORDER_CREATE', entity: 'Order', entityId: pedido.id,
    metadata: { tournamentId: tournament.id, participantId: participant.id, totalCents: valores.totalCents, coupon: avaliacao?.coupon.code || null }
  });

  await notificationService.notify({
    userIds: [actor.id],
    title: 'Pedido criado',
    message: `Pedido de ${money.format(valores.totalCents, tournament.currency)} — ${tournament.name}.`,
    type: 'ORDER_CREATED', priority: 'NORMAL', entityType: 'Order', entityId: pedido.id, link: `#orders/${pedido.id}`
  });

  return findById(pedido.id, actor);
}

// Só o dono do pedido, o organizador do campeonato e o ADMIN enxergam.
async function assertPodeVer(orderId, actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { ...publicShape, userId: true, tournament: { select: { id: true, name: true, status: true, createdById: true } } }
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado');

  if (actor.role === 'ADMIN') return order;
  if (order.userId === actor.id) return order;
  if (actor.role === 'ORGANIZER' && order.tournament.createdById === actor.id) return order;

  throw new AppError(403, 'FORBIDDEN', 'Você não tem acesso a este pedido');
}

async function findById(id, actor) {
  const order = await assertPodeVer(id, actor);
  const { userId, tournament, ...visivel } = order;
  return { ...visivel, tournament: { id: tournament.id, name: tournament.name, status: tournament.status } };
}

async function list(actor, filtros = {}) {
  const escopo = actor.role === 'ADMIN'
    ? {}
    : actor.role === 'ORGANIZER'
      ? { OR: [{ userId: actor.id }, { tournament: { createdById: actor.id } }] }
      : { userId: actor.id };

  const where = { AND: [escopo, filtros.status ? { status: filtros.status } : {}, filtros.tournamentId ? { tournamentId: filtros.tournamentId } : {}] };
  const items = await prisma.order.findMany({ where, select: publicShape, orderBy: { createdAt: 'desc' }, take: 100 });
  return { items };
}

async function cancel(id, actor) {
  const order = await assertPodeVer(id, actor);
  assertTransicao('order', order.status, 'CANCELLED');

  await prisma.$transaction(async tx => {
    await tx.order.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await couponService.release(tx, id);
    // A inscrição volta a não ter pagamento pendente.
    for (const item of order.items) {
      if (item.enrollmentId) {
        await tx.enrollment.update({ where: { id: item.enrollmentId }, data: { paymentStatus: 'NOT_REQUIRED' } });
      }
    }
    await tx.payment.updateMany({ where: { orderId: id, status: { in: ['PENDING', 'PROCESSING', 'AUTHORIZED'] } }, data: { status: 'CANCELLED' } });
  });

  await auditService.record({ actor, action: 'ORDER_CANCEL', entity: 'Order', entityId: id, metadata: { totalCents: order.totalCents } });
  return findById(id, actor);
}

// Marca como expirados os pedidos cujo prazo passou sem pagamento, devolvendo
// os cupons ao estoque.
async function expirePending(referencia = new Date()) {
  const vencidos = await prisma.order.findMany({
    where: { status: 'PENDING', expiresAt: { lt: referencia } },
    select: { id: true, items: { select: { enrollmentId: true } } }
  });

  for (const pedido of vencidos) {
    await prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: pedido.id }, data: { status: 'EXPIRED' } });
      await couponService.release(tx, pedido.id);
      for (const item of pedido.items) {
        if (item.enrollmentId) {
          await tx.enrollment.update({ where: { id: item.enrollmentId }, data: { paymentStatus: 'NOT_REQUIRED' } });
        }
      }
    });
  }

  return { expired: vencidos.length };
}

// Chamado pelo fluxo de pagamento quando a confirmação chega do provedor.
async function markPaid(orderId, tx) {
  const cliente = tx || prisma;
  const order = await cliente.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado');
  if (order.status === 'PAID') return order;

  assertTransicao('order', order.status, 'PAID');
  const agora = new Date();

  const atualizado = await cliente.order.update({ where: { id: orderId }, data: { status: 'PAID', paidAt: agora } });
  for (const item of order.items) {
    if (item.enrollmentId) {
      await cliente.enrollment.update({
        where: { id: item.enrollmentId },
        data: { paymentStatus: 'PAID', paidAt: agora, status: 'CONFIRMED' }
      });
    }
  }
  return atualizado;
}

module.exports = { create, findById, list, cancel, expirePending, markPaid, calcular, publicShape, MINUTOS_PARA_EXPIRAR };
