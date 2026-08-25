import request from 'supertest';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import { SANDBOX_SECRET } from '../src/services/payment/paymentProvider.js';

// Ciclo financeiro ponta a ponta contra o banco de teste real. Cada etapa
// depende do estado deixada pela anterior; nada é simulado além do provedor de
// pagamento, que é explicitamente o de desenvolvimento.
const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });
const PRECO = 20000; // R$ 200,00

const state = {};

async function clearDatabase() {
  await prisma.paymentEvent.deleteMany();
  await prisma.refund.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.couponRedemption.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.sponsorship.deleteMany();
  await prisma.sponsor.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.checkIn.deleteMany();
  await prisma.document.deleteMany();
  await prisma.judgeAssignment.deleteMany();
  await prisma.result.deleteMany();
  await prisma.standing.deleteMany();
  await prisma.match.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.participant.updateMany({ data: { teamId: null } });
  await prisma.tournament.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.user.deleteMany();
}

const register = async (name, email, role) => {
  const response = await request(app).post(`${api}/auth/register`).send({ name, email, password: 'Senha@123', role });
  expect(response.status).toBe(201);
  return { token: response.body.token, user: response.body.user };
};

const assinar = corpo => crypto.createHmac('sha256', SANDBOX_SECRET).update(JSON.stringify(corpo)).digest('hex');
const enviarWebhook = (corpo, assinatura) =>
  request(app).post(`${api}/webhooks/payments/sandbox`)
    .set('Content-Type', 'application/json')
    .set('x-mci-signature', assinatura === undefined ? assinar(corpo) : assinatura)
    .send(corpo);

describe('E2E financeiro — do evento pago ao reembolso', () => {
  beforeAll(async () => {
    await clearDatabase();
    state.admin = await register('Admin Fin', 'admin@fin.test', 'ADMIN');
    state.organizer = await register('Organizador Fin', 'org@fin.test', 'ORGANIZER');
    state.athlete = await register('Atleta Fin', 'atleta@fin.test', 'ATHLETE');
  });

  it('1. ORGANIZER publica um campeonato com inscrição paga', async () => {
    const resposta = await request(app).post(`${api}/campeonatos`).set(auth(state.organizer.token))
      .send({ name: 'Campeonato Pago E2E', status: 'ACTIVE', entryFeeCents: PRECO });
    expect(resposta.status).toBe(201);
    expect(resposta.body.entryFeeCents).toBe(PRECO);
    state.tournament = resposta.body;
  });

  it('2. ORGANIZER cria um cupom de 25% com limite', async () => {
    const resposta = await request(app).post(`${api}/coupons`).set(auth(state.organizer.token))
      .send({ code: 'E2E25', percentOff: 25, tournamentId: state.tournament.id, maxRedemptions: 5 });
    expect(resposta.status).toBe(201);
    state.coupon = resposta.body;
  });

  it('3. ATHLETE é vinculado a um participante do evento', async () => {
    const participante = (await request(app).post(`${api}/participantes`).set(auth(state.organizer.token))
      .send({ name: 'Atleta Fin', identification: 'FIN-1', type: 'PLAYER' })).body;
    await prisma.participant.update({ where: { id: participante.id }, data: { userId: state.athlete.user.id } });
    state.participant = participante;
    expect(participante.id).toBeTruthy();
  });

  it('4. CHECKOUT gera o pedido com o preço calculado no servidor', async () => {
    state.chave = `e2e-${crypto.randomUUID()}`;
    const resposta = await request(app).post(`${api}/orders`).set(auth(state.athlete.token))
      .send({ tournamentId: state.tournament.id, participantId: state.participant.id, couponCode: 'E2E25', idempotencyKey: state.chave });

    expect(resposta.status).toBe(201);
    expect(resposta.body.subtotalCents).toBe(PRECO);
    expect(resposta.body.discountCents).toBe(5000);
    expect(resposta.body.totalCents).toBe(15000);
    expect(resposta.body.status).toBe('PENDING');
    state.order = resposta.body;
  });

  it('5. Reenviar a mesma intenção não cria um segundo pedido', async () => {
    const repetido = await request(app).post(`${api}/orders`).set(auth(state.athlete.token))
      .send({ tournamentId: state.tournament.id, participantId: state.participant.id, couponCode: 'E2E25', idempotencyKey: state.chave });
    expect(repetido.body.id).toBe(state.order.id);
    expect(await prisma.order.count()).toBe(1);
  });

  it('6. A inscrição existe mas ainda não está paga', async () => {
    const inscricao = await prisma.enrollment.findFirst({ where: { participantId: state.participant.id } });
    expect(inscricao.paymentStatus).toBe('PENDING');
    expect(inscricao.paidAt).toBeNull();
    state.enrollment = inscricao;
  });

  it('7. PAGAMENTO é aberto no provedor', async () => {
    const resposta = await request(app).post(`${api}/orders/${state.order.id}/payments`).set(auth(state.athlete.token)).send({});
    expect(resposta.status).toBe(201);
    expect(resposta.body.status).toBe('PENDING');
    expect(resposta.body.amountCents).toBe(15000);
    // O provedor de desenvolvimento se identifica como tal.
    expect(resposta.body.isRealProvider).toBe(false);
    state.payment = await prisma.payment.findUnique({ where: { id: resposta.body.id } });
  });

  it('8. Uma primeira tentativa é RECUSADA e nada é confirmado', async () => {
    const recusa = await enviarWebhook({ id: `evt-fail-${crypto.randomUUID()}`, type: 'payment.failed', providerRef: state.payment.providerRef });
    expect(recusa.body.processed).toBe(true);

    expect((await prisma.order.findUnique({ where: { id: state.order.id } })).status).toBe('PENDING');
    const inscricao = await prisma.enrollment.findUnique({ where: { id: state.enrollment.id } });
    expect(inscricao.paymentStatus).toBe('PENDING');
    expect(inscricao.paidAt).toBeNull();
  });

  it('9. Uma nova tentativa é aberta e CONFIRMADA por webhook assinado', async () => {
    const nova = await request(app).post(`${api}/orders/${state.order.id}/payments`).set(auth(state.athlete.token)).send({});
    expect(nova.status).toBe(201);
    state.payment2 = await prisma.payment.findUnique({ where: { id: nova.body.id } });

    state.eventoId = `evt-paid-${crypto.randomUUID()}`;
    const confirmacao = await enviarWebhook({
      id: state.eventoId, type: 'payment.paid',
      providerRef: state.payment2.providerRef, amountCents: state.payment2.amountCents
    });
    expect(confirmacao.body.processed).toBe(true);
    expect(confirmacao.body.status).toBe('PAID');
  });

  it('10. O pedido fica PAGO e a inscrição passa a constar como paga', async () => {
    const pedido = await request(app).get(`${api}/orders/${state.order.id}`).set(auth(state.athlete.token));
    expect(pedido.body.status).toBe('PAID');
    expect(pedido.body.paidAt).toBeTruthy();

    const inscricao = await prisma.enrollment.findUnique({ where: { id: state.enrollment.id } });
    expect(inscricao.paymentStatus).toBe('PAID');
    expect(inscricao.paidAt).toBeTruthy();
  });

  it('11. WEBHOOK DUPLICADO não cobra nem confirma de novo', async () => {
    const pagamentosAntes = await prisma.payment.count();
    const duplicado = await enviarWebhook({
      id: state.eventoId, type: 'payment.paid',
      providerRef: state.payment2.providerRef, amountCents: state.payment2.amountCents
    });

    expect(duplicado.body.duplicated).toBe(true);
    expect(duplicado.body.processed).toBe(false);
    expect(await prisma.payment.count()).toBe(pagamentosAntes);
    expect((await prisma.order.findUnique({ where: { id: state.order.id } })).status).toBe('PAID');
  });

  it('12. Webhook sem assinatura válida é recusado', async () => {
    const forjado = await enviarWebhook(
      { id: `evt-forjado-${crypto.randomUUID()}`, type: 'payment.paid', providerRef: state.payment2.providerRef },
      'assinatura-inventada'
    );
    expect(forjado.status).toBe(401);
  });

  it('13. NOTIFICAÇÃO de aprovação chega ao comprador', async () => {
    const caixa = await request(app).get(`${api}/notifications`).set(auth(state.athlete.token));
    const tipos = caixa.body.items.map(item => item.type);
    expect(tipos).toContain('ORDER_CREATED');
    expect(tipos).toContain('PAYMENT_APPROVED');
    expect(tipos).toContain('PAYMENT_FAILED');
  });

  it('14. RELATÓRIO do organizador mostra a receita reconhecida', async () => {
    const relatorio = await request(app).get(`${api}/reports/tournaments/${state.tournament.id}`).set(auth(state.organizer.token));
    expect(relatorio.status).toBe(200);

    const financeiro = relatorio.body.financeiro;
    expect(financeiro.entryFeeCents).toBe(PRECO);
    expect(financeiro.receitaInscricoesCents).toBe(15000);
    expect(financeiro.descontoConcedidoCents).toBe(5000);
    expect(financeiro.orders.porStatus.PAID).toBe(1);
  });

  it('15. PATROCÍNIO entra como receita separada da inscrição', async () => {
    const patrocinador = (await request(app).post(`${api}/sponsors`).set(auth(state.organizer.token))
      .send({ name: 'Patrocinador E2E' })).body;
    await request(app).post(`${api}/sponsorships`).set(auth(state.organizer.token))
      .send({ sponsorId: patrocinador.id, tournamentId: state.tournament.id, amountCents: 800000 });

    const relatorio = await request(app).get(`${api}/reports/tournaments/${state.tournament.id}`).set(auth(state.organizer.token));
    const financeiro = relatorio.body.financeiro;
    expect(financeiro.receitaPatrocinioCents).toBe(800000);
    expect(financeiro.receitaInscricoesCents).toBe(15000);
    expect(financeiro.receitaTotalCents).toBe(815000);
  });

  it('16. REEMBOLSO estorna e reverte inscrição, pedido e cupom', async () => {
    const antes = await prisma.coupon.findUnique({ where: { code: 'E2E25' } });
    expect(antes.redeemedCount).toBe(1);

    const reembolso = await request(app).post(`${api}/orders/${state.order.id}/refunds`).set(auth(state.organizer.token))
      .send({ reason: 'Desistência do atleta' });
    expect(reembolso.status).toBe(201);
    expect(reembolso.body.status).toBe('COMPLETED');
    expect(reembolso.body.amountCents).toBe(15000);

    expect((await prisma.order.findUnique({ where: { id: state.order.id } })).status).toBe('REFUNDED');
    const inscricao = await prisma.enrollment.findUnique({ where: { id: state.enrollment.id } });
    expect(inscricao.paymentStatus).toBe('REFUNDED');
    expect(inscricao.paidAt).toBeNull();
    expect((await prisma.coupon.findUnique({ where: { code: 'E2E25' } })).redeemedCount).toBe(0);
  });

  it('17. Após o estorno a receita reconhecida some do relatório', async () => {
    const relatorio = await request(app).get(`${api}/reports/tournaments/${state.tournament.id}`).set(auth(state.organizer.token));
    const financeiro = relatorio.body.financeiro;
    expect(financeiro.receitaInscricoesCents).toBe(0);
    expect(financeiro.reembolsadoCents).toBe(15000);
    // Patrocínio não é afetado pelo estorno de inscrição.
    expect(financeiro.receitaPatrocinioCents).toBe(800000);
  });

  it('18. AUDITORIA registrou o ciclo financeiro inteiro', async () => {
    const trilha = await request(app).get(`${api}/audit`).set(auth(state.admin.token));
    const acoes = trilha.body.items.map(item => item.action);
    for (const esperada of ['ORDER_CREATE', 'PAYMENT_START', 'PAYMENT_PAID', 'PAYMENT_FAILED', 'REFUND_REQUEST', 'REFUND_COMPLETED', 'COUPON_CREATE', 'SPONSORSHIP_CREATE']) {
      expect(acoes, esperada).toContain(esperada);
    }
    const payload = JSON.stringify(trilha.body);
    expect(payload).not.toContain('Senha@123');
    expect(payload).not.toContain(SANDBOX_SECRET);
  });

  it('19. O histórico financeiro permanece íntegro após o estorno', async () => {
    // Nada é apagado: as tentativas de pagamento e os eventos recebidos ficam.
    expect(await prisma.payment.count({ where: { orderId: state.order.id } })).toBe(2);
    expect(await prisma.paymentEvent.count()).toBeGreaterThanOrEqual(3);
    expect(await prisma.refund.count({ where: { orderId: state.order.id } })).toBe(1);

    const recusado = await prisma.payment.findUnique({ where: { id: state.payment.id } });
    expect(recusado.status).toBe('FAILED');
  });
});
