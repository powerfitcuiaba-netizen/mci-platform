const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const money = require('../utils/money');
const { podeTransitar, ehTerminal } = require('../utils/financialStates');
const { getProvider, hasProvider } = require('./payment/paymentProvider');
const orderService = require('./orderService');
const notificationService = require('./notificationService');
const auditService = require('./auditService');

const publicShape = {
  id: true, orderId: true, status: true, provider: true, amountCents: true,
  failureReason: true, authorizedAt: true, paidAt: true, refundedAt: true, createdAt: true
};

// Abre a cobrança no provedor para um pedido pendente. O valor cobrado é o
// total gravado no pedido, calculado pelo servidor — nunca um número recebido
// agora do cliente.
async function start(orderId, data, actor) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { tournament: { select: { id: true, name: true, createdById: true } } }
  });
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Pedido não encontrado');

  if (order.userId !== actor.id && actor.role !== 'ADMIN') {
    throw new AppError(403, 'FORBIDDEN', 'Você não pode pagar o pedido de outro usuário');
  }
  if (order.status !== 'PENDING') {
    throw new AppError(422, 'ORDER_NOT_PAYABLE', `Pedido em estado ${order.status} não aceita pagamento`);
  }
  if (order.expiresAt && order.expiresAt < new Date()) {
    throw new AppError(422, 'ORDER_EXPIRED', 'Este pedido expirou. Gere um novo.');
  }

  // Reenvio da mesma tentativa devolve o pagamento já aberto.
  if (data.idempotencyKey) {
    const existente = await prisma.payment.findUnique({ where: { idempotencyKey: data.idempotencyKey }, select: { ...publicShape, order: { select: { userId: true } } } });
    if (existente) {
      if (existente.order.userId !== actor.id && actor.role !== 'ADMIN') {
        throw new AppError(409, 'IDEMPOTENCY_KEY_CONFLICT', 'Chave de idempotência já usada');
      }
      const { order: _, ...visivel } = existente;
      return { ...visivel, idempotente: true };
    }
  }

  const emAberto = await prisma.payment.findFirst({
    where: { orderId, status: { in: ['PENDING', 'PROCESSING', 'AUTHORIZED'] } },
    select: publicShape
  });
  if (emAberto) return { ...emAberto, idempotente: true };

  const provider = getProvider(data.provider);
  const cobranca = await provider.createCharge({
    orderId: order.id,
    amountCents: money.assertCents(order.totalCents, 'total do pedido'),
    currency: order.currency,
    metadata: { tournamentId: order.tournamentId }
  });

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      status: 'PENDING',
      provider: provider.name,
      providerRef: cobranca.providerRef,
      amountCents: order.totalCents,
      idempotencyKey: data.idempotencyKey || null
    },
    select: publicShape
  });

  await auditService.record({
    actor, action: 'PAYMENT_START', entity: 'Payment', entityId: payment.id,
    metadata: { orderId: order.id, provider: provider.name, amountCents: order.totalCents }
  });

  await notificationService.notify({
    userIds: [order.userId],
    title: 'Pagamento iniciado',
    message: `Aguardando confirmação de ${money.format(order.totalCents, order.currency)} — ${order.tournament.name}.`,
    type: 'PAYMENT_CREATED', priority: 'NORMAL', entityType: 'Order', entityId: order.id, link: `#orders/${order.id}`,
    actorId: null
  });

  return { ...payment, redirectUrl: cobranca.redirectUrl || null, isRealProvider: provider.isReal !== false };
}

const MAPA_EVENTO = Object.freeze({
  'payment.pending': 'PENDING',
  'payment.processing': 'PROCESSING',
  'payment.authorized': 'AUTHORIZED',
  'payment.paid': 'PAID',
  'payment.failed': 'FAILED',
  'payment.cancelled': 'CANCELLED',
  'payment.refunded': 'REFUNDED'
});

// Ponto de entrada do webhook. Três garantias, nesta ordem:
//   1. assinatura válida — corpo cru conferido por HMAC;
//   2. idempotência — o par (provedor, id externo) é único no banco, então a
//      segunda entrega da mesma notificação não reprocessa nada;
//   3. ordem — uma notificação atrasada não desfaz um estado terminal.
async function handleWebhook({ rawBody, headers, providerName }) {
  // O nome vem da URL, então vem de quem chama. Nome que não corresponde a
  // provedor algum é requisição errada do cliente, não falha do servidor.
  if (!hasProvider(providerName)) {
    throw new AppError(404, 'PAYMENT_PROVIDER_UNKNOWN', 'Provedor de pagamento desconhecido');
  }

  const provider = getProvider(providerName);

  const assinaturaOk = provider.verifySignature(rawBody, headers);
  if (!assinaturaOk) {
    // Registrar a tentativa é útil; processar, não.
    await prisma.paymentEvent.create({
      data: {
        provider: provider.name,
        externalId: `invalid_${Date.now()}_${Math.trunc(rawBody.length)}`,
        type: 'signature.invalid',
        signatureValid: false,
        payload: null
      }
    }).catch(() => {});
    throw new AppError(401, 'INVALID_SIGNATURE', 'Assinatura do webhook inválida');
  }

  const evento = provider.parseWebhook(rawBody, headers);

  let registro;
  try {
    registro = await prisma.paymentEvent.create({
      data: {
        provider: provider.name,
        externalId: evento.externalId,
        type: evento.type,
        signatureValid: true,
        payload: String(rawBody).slice(0, 4000)
      }
    });
  } catch (error) {
    // Colisão na constraint única: já recebemos e processamos esta notificação.
    if (error.code === 'P2002') return { duplicated: true, processed: false, reason: 'evento já processado' };
    throw error;
  }

  const payment = await prisma.payment.findUnique({
    where: { providerRef: evento.providerRef },
    include: { order: { select: { id: true, userId: true, status: true, totalCents: true, currency: true, tournament: { select: { name: true } } } } }
  });
  if (!payment) {
    await prisma.paymentEvent.update({ where: { id: registro.id }, data: { processedAt: new Date() } });
    return { duplicated: false, processed: false, reason: 'pagamento não encontrado para a referência informada' };
  }

  await prisma.paymentEvent.update({ where: { id: registro.id }, data: { paymentId: payment.id } });

  const destino = MAPA_EVENTO[evento.type];
  if (!destino) {
    await prisma.paymentEvent.update({ where: { id: registro.id }, data: { processedAt: new Date() } });
    return { duplicated: false, processed: false, reason: `tipo de evento não tratado: ${evento.type}` };
  }

  // Estado terminal não é revisitado por notificação atrasada.
  if (ehTerminal('payment', payment.status) || !podeTransitar('payment', payment.status, destino)) {
    await prisma.paymentEvent.update({ where: { id: registro.id }, data: { processedAt: new Date() } });
    return { duplicated: false, processed: false, reason: `transição ignorada: ${payment.status} → ${destino}` };
  }

  // O valor confirmado precisa bater com o cobrado. Divergência não avança nada.
  if (destino === 'PAID' && evento.amountCents !== null && evento.amountCents !== payment.amountCents) {
    await prisma.paymentEvent.update({ where: { id: registro.id }, data: { processedAt: new Date() } });
    await auditService.record({
      actor: null, action: 'PAYMENT_AMOUNT_MISMATCH', entity: 'Payment', entityId: payment.id,
      metadata: { esperado: payment.amountCents, recebido: evento.amountCents }
    });
    throw new AppError(422, 'PAYMENT_AMOUNT_MISMATCH', 'Valor confirmado diverge do valor cobrado');
  }

  const agora = new Date();
  await prisma.$transaction(async tx => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: destino,
        authorizedAt: destino === 'AUTHORIZED' ? agora : payment.authorizedAt,
        paidAt: destino === 'PAID' ? agora : payment.paidAt,
        refundedAt: destino === 'REFUNDED' ? agora : payment.refundedAt,
        failureReason: destino === 'FAILED' ? (evento.type || 'falha informada pelo provedor') : null
      }
    });

    if (destino === 'PAID') await orderService.markPaid(payment.orderId, tx);
    await tx.paymentEvent.update({ where: { id: registro.id }, data: { processedAt: agora } });
  });

  await auditService.record({
    actor: null, action: `PAYMENT_${destino}`, entity: 'Payment', entityId: payment.id,
    metadata: { orderId: payment.orderId, externalId: evento.externalId, provider: provider.name }
  });

  if (destino === 'PAID' || destino === 'FAILED') {
    await notificationService.notify({
      userIds: [payment.order.userId],
      title: destino === 'PAID' ? 'Pagamento aprovado' : 'Pagamento recusado',
      message: destino === 'PAID'
        ? `Inscrição confirmada em ${payment.order.tournament.name}.`
        : `Não foi possível confirmar o pagamento de ${money.format(payment.amountCents, payment.order.currency)}.`,
      type: destino === 'PAID' ? 'PAYMENT_APPROVED' : 'PAYMENT_FAILED',
      priority: 'HIGH', entityType: 'Order', entityId: payment.orderId, link: `#orders/${payment.orderId}`
    });
  }

  return { duplicated: false, processed: true, status: destino, paymentId: payment.id };
}

async function listByOrder(orderId, actor) {
  await orderService.findById(orderId, actor);
  const items = await prisma.payment.findMany({ where: { orderId }, select: publicShape, orderBy: { createdAt: 'desc' } });
  return { items };
}

module.exports = { start, handleWebhook, listByOrder, publicShape, MAPA_EVENTO };
