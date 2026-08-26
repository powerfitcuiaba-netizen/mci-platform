const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const money = require('../utils/money');
const { assertTransicao } = require('../utils/financialStates');
const { getProvider } = require('./payment/paymentProvider');
const couponService = require('./couponService');
const notificationService = require('./notificationService');
const auditService = require('./auditService');

const publicShape = {
  id: true, orderId: true, paymentId: true, status: true, amountCents: true,
  reason: true, failureReason: true, processedAt: true, createdAt: true
};

// Reembolsar é decisão de quem administra o evento, não do comprador: o atleta
// solicita por fora e o organizador executa. Só um pedido efetivamente pago
// chega até aqui — a máquina de estados recusa PENDING → REFUNDED.
async function assertPodeReembolsar(orderId, actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      tournament: { select: { id: true, name: true, createdById: true } },
      payments: true,
      refunds: true
    }
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado');

  const ehDono = actor.role === 'ADMIN';
  const ehOrganizador = actor.role === 'ORGANIZER' && order.tournament.createdById === actor.id;
  if (!ehDono && !ehOrganizador) {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode reembolsar este pedido');
  }

  // Duplicidade é verificada antes do estado: depois de um estorno concluído o
  // pedido fica REFUNDED, e responder "estado inválido" esconderia do chamador
  // a informação que ele precisa — que o reembolso já existe.
  const jaReembolsado = order.refunds.some(item => ['PENDING', 'PROCESSING', 'COMPLETED'].includes(item.status));
  if (jaReembolsado) throw new AppError(409, 'REFUND_ALREADY_EXISTS', 'Este pedido já possui reembolso');

  if (order.status !== 'PAID') {
    throw new AppError(422, 'ORDER_NOT_REFUNDABLE', `Pedido em estado ${order.status} não pode ser reembolsado`);
  }

  const pago = order.payments.find(item => item.status === 'PAID');
  if (!pago) throw new AppError(422, 'PAYMENT_NOT_FOUND', 'Não há pagamento confirmado para reembolsar');

  return { order, pago };
}

async function request(orderId, data, actor) {
  const { order, pago } = await assertPodeReembolsar(orderId, actor);

  const amountCents = data.amountCents === undefined || data.amountCents === null
    ? pago.amountCents
    : money.assertCents(data.amountCents, 'valor do reembolso');

  if (amountCents > pago.amountCents) {
    throw new AppError(422, 'REFUND_EXCEEDS_PAYMENT', 'Reembolso não pode superar o valor pago');
  }
  if (amountCents === 0) throw new AppError(422, 'INVALID_AMOUNT', 'Valor do reembolso deve ser maior que zero');

  const refund = await prisma.refund.create({
    data: {
      orderId: order.id, paymentId: pago.id, status: 'PENDING',
      amountCents, reason: data.reason || null, requestedById: actor.id
    },
    select: publicShape
  });

  await auditService.record({
    actor, action: 'REFUND_REQUEST', entity: 'Refund', entityId: refund.id,
    metadata: { orderId: order.id, amountCents, reason: data.reason || null }
  });

  return process_(refund.id, actor);
}

// Executa o estorno no provedor e propaga o resultado para pagamento, pedido e
// inscrição — tudo numa transação, para não existir estado meio-reembolsado.
async function process_(refundId, actor) {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: { payment: true, order: { include: { items: true, tournament: { select: { name: true } } } } }
  });
  if (!refund) throw new AppError(404, 'REFUND_NOT_FOUND', 'Reembolso não encontrado');

  assertTransicao('refund', refund.status, 'PROCESSING');
  await prisma.refund.update({ where: { id: refundId }, data: { status: 'PROCESSING' } });

  const provider = getProvider(refund.payment.provider);
  let resultado;
  try {
    resultado = await provider.refundCharge({ providerRef: refund.payment.providerRef, amountCents: refund.amountCents });
  } catch (error) {
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: error.message } });
    await auditService.record({ actor, action: 'REFUND_FAILED', entity: 'Refund', entityId: refundId, metadata: { motivo: error.message } });
    throw new AppError(502, 'REFUND_PROVIDER_ERROR', 'O provedor não concluiu o estorno');
  }

  if (resultado.status !== 'COMPLETED') {
    await prisma.refund.update({ where: { id: refundId }, data: { status: 'FAILED', failureReason: 'provedor não concluiu o estorno' } });
    throw new AppError(502, 'REFUND_PROVIDER_ERROR', 'O provedor não concluiu o estorno');
  }

  const agora = new Date();
  await prisma.$transaction(async tx => {
    await tx.refund.update({ where: { id: refundId }, data: { status: 'COMPLETED', processedAt: agora } });
    await tx.payment.update({ where: { id: refund.paymentId }, data: { status: 'REFUNDED', refundedAt: agora } });
    await tx.order.update({ where: { id: refund.orderId }, data: { status: 'REFUNDED' } });

    // A inscrição deixa de constar como paga; o cupom volta ao estoque.
    for (const item of refund.order.items) {
      if (item.enrollmentId) {
        await tx.enrollment.update({ where: { id: item.enrollmentId }, data: { paymentStatus: 'REFUNDED', paidAt: null } });
      }
    }
    await couponService.release(tx, refund.orderId);
  });

  await auditService.record({
    actor, action: 'REFUND_COMPLETED', entity: 'Refund', entityId: refundId,
    metadata: { orderId: refund.orderId, amountCents: refund.amountCents }
  });

  await notificationService.notify({
    userIds: [refund.order.userId],
    title: 'Pagamento reembolsado',
    message: `${money.format(refund.amountCents, refund.order.currency)} — ${refund.order.tournament.name}.`,
    type: 'PAYMENT_REFUNDED', priority: 'HIGH', entityType: 'Order', entityId: refund.orderId, link: `#orders/${refund.orderId}`,
    actorId: actor?.id || null
  });

  return prisma.refund.findUnique({ where: { id: refundId }, select: publicShape });
}

async function list(actor, filtros = {}) {
  const escopo = actor.role === 'ADMIN'
    ? {}
    : actor.role === 'ORGANIZER'
      ? { order: { tournament: { createdById: actor.id } } }
      : { order: { userId: actor.id } };

  const items = await prisma.refund.findMany({
    where: { AND: [escopo, filtros.orderId ? { orderId: filtros.orderId } : {}] },
    select: publicShape,
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  return { items };
}

module.exports = { request, process: process_, list, publicShape };
