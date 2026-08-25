import request from 'supertest';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import { SANDBOX_SECRET } from '../src/services/payment/paymentProvider.js';
import { assertTransicao, podeTransitar } from '../src/utils/financialStates.js';
import money from '../src/utils/money.js';

const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });
const PRECO = 15000; // R$ 150,00 em centavos

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

// Assina o corpo exatamente como o provedor faria.
const assinar = corpo => crypto.createHmac('sha256', SANDBOX_SECRET).update(JSON.stringify(corpo)).digest('hex');

const enviarWebhook = (corpo, assinatura) =>
  request(app)
    .post(`${api}/webhooks/payments/sandbox`)
    .set('Content-Type', 'application/json')
    .set('x-mci-signature', assinatura === undefined ? assinar(corpo) : assinatura)
    .send(corpo);

async function scenario() {
  const admin = await register('Admin', 'admin@f5.test', 'ADMIN');
  const organizer = await register('Organizador', 'org@f5.test', 'ORGANIZER');
  const rival = await register('Organizador Rival', 'rival@f5.test', 'ORGANIZER');
  const athlete = await register('Atleta', 'atleta@f5.test', 'ATHLETE');
  const outsider = await register('Atleta Externo', 'externo@f5.test', 'ATHLETE');

  const tournament = (await request(app).post(`${api}/campeonatos`).set(auth(organizer.token))
    .send({ name: 'Copa Paga', status: 'ACTIVE', entryFeeCents: PRECO })).body;
  const gratuito = (await request(app).post(`${api}/campeonatos`).set(auth(organizer.token))
    .send({ name: 'Copa Gratuita', status: 'ACTIVE' })).body;

  const participant = (await request(app).post(`${api}/participantes`).set(auth(organizer.token))
    .send({ name: 'Atleta Pagante', identification: 'F5-1', type: 'PLAYER' })).body;
  const outroParticipant = (await request(app).post(`${api}/participantes`).set(auth(organizer.token))
    .send({ name: 'Atleta Externo', identification: 'F5-2', type: 'PLAYER' })).body;

  await prisma.participant.update({ where: { id: participant.id }, data: { userId: athlete.user.id } });
  await prisma.participant.update({ where: { id: outroParticipant.id }, data: { userId: outsider.user.id } });

  return { admin, organizer, rival, athlete, outsider, tournament, gratuito, participant, outroParticipant };
}

const criarPedido = (s, extra = {}) =>
  request(app).post(`${api}/orders`).set(auth(s.athlete.token))
    .send({ tournamentId: s.tournament.id, participantId: s.participant.id, ...extra });

async function pedidoPago(s) {
  const pedido = (await criarPedido(s)).body;
  const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
  const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });
  await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.paid', providerRef: registro.providerRef, amountCents: registro.amountCents });
  return { pedido, pagamento, providerRef: registro.providerRef };
}

describe('Fase 5 — camada financeira', () => {
  beforeEach(clearDatabase);

  describe('Preço calculado no servidor', () => {
    it('usa o preço do campeonato e ignora qualquer valor do cliente', async () => {
      const s = await scenario();
      const pedido = await criarPedido(s);
      expect(pedido.status).toBe(201);
      expect(pedido.body.subtotalCents).toBe(PRECO);
      expect(pedido.body.totalCents).toBe(PRECO);
      expect(pedido.body.discountCents).toBe(0);
    });

    it('recusa o corpo que tenta enviar preço, desconto ou total', async () => {
      const s = await scenario();
      for (const adulterado of [{ totalCents: 1 }, { subtotalCents: 1 }, { discountCents: PRECO }, { unitPriceCents: 0 }, { amountCents: 1 }]) {
        const ataque = await criarPedido(s, adulterado);
        expect(ataque.status, JSON.stringify(adulterado)).toBe(400);
      }
      // Nenhum pedido foi criado por essas tentativas.
      expect(await prisma.order.count()).toBe(0);
    });

    it('a prévia de cupom calcula sobre o preço do campeonato, não sobre o valor enviado', async () => {
      const s = await scenario();
      await request(app).post(`${api}/coupons`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, code: 'MCI10', percentOff: 10 });

      const previa = await request(app).post(`${api}/coupons/preview`).set(auth(s.athlete.token))
        .send({ code: 'MCI10', tournamentId: s.tournament.id });
      expect(previa.status).toBe(200);
      expect(previa.body.subtotalCents).toBe(PRECO);
      expect(previa.body.discountCents).toBe(1500);
      expect(previa.body.totalCents).toBe(13500);

      // Um subtotal inflado no corpo é recusado, e não aceito e usado: mostrar
      // desconto que a cobrança não honraria seria mentir para o cliente.
      for (const adulterado of [{ subtotalCents: 999999 }, { discountCents: PRECO }, { totalCents: 0 }]) {
        const ataque = await request(app).post(`${api}/coupons/preview`).set(auth(s.athlete.token))
          .send({ code: 'MCI10', tournamentId: s.tournament.id, ...adulterado });
        expect(ataque.status, JSON.stringify(adulterado)).toBe(400);
      }

      // O que a prévia mostrou é exatamente o que o pedido cobra.
      const pedido = await criarPedido(s, { couponCode: 'MCI10' });
      expect(pedido.status).toBe(201);
      expect(pedido.body.discountCents).toBe(previa.body.discountCents);
      expect(pedido.body.totalCents).toBe(previa.body.totalCents);
    });

    it('não aceita pedido para campeonato gratuito', async () => {
      const s = await scenario();
      const resposta = await request(app).post(`${api}/orders`).set(auth(s.athlete.token))
        .send({ tournamentId: s.gratuito.id, participantId: s.participant.id });
      expect(resposta.status).toBe(422);
    });

    it('mantém a aritmética em centavos inteiros', () => {
      expect(money.percentOf(15000, 10)).toBe(1500);
      // Arredonda para baixo: o desconto nunca é maior que o anunciado.
      expect(money.percentOf(999, 33)).toBe(329);
      expect(money.clampDiscount(15000, 99999)).toBe(15000);
      expect(() => money.assertCents(10.5)).toThrow();
      expect(() => money.assertCents(-1)).toThrow();
    });
  });

  describe('Cupons', () => {
    const criarCupom = (s, dados) =>
      request(app).post(`${api}/coupons`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, ...dados });

    it('aplica percentual e valor fixo corretamente', async () => {
      const s = await scenario();
      await criarCupom(s, { code: 'MCI10', percentOff: 10 });
      const comPercentual = await criarPedido(s, { couponCode: 'MCI10' });
      expect(comPercentual.status).toBe(201);
      expect(comPercentual.body.discountCents).toBe(1500);
      expect(comPercentual.body.totalCents).toBe(13500);

      await request(app).patch(`${api}/orders/${comPercentual.body.id}/cancel`).set(auth(s.athlete.token));
      await criarCupom(s, { code: 'FIXO50', amountOffCents: 5000 });
      const comFixo = await criarPedido(s, { couponCode: 'FIXO50' });
      expect(comFixo.body.discountCents).toBe(5000);
      expect(comFixo.body.totalCents).toBe(10000);
    });

    it('nunca deixa o desconto superar o subtotal', async () => {
      const s = await scenario();
      await criarCupom(s, { code: 'EXAGERO', amountOffCents: 99999 });
      const pedido = await criarPedido(s, { couponCode: 'EXAGERO' });
      expect(pedido.status).toBe(201);
      expect(pedido.body.discountCents).toBe(PRECO);
      expect(pedido.body.totalCents).toBe(0);
    });

    it('recusa cupom inexistente, expirado, desativado e de outro campeonato', async () => {
      const s = await scenario();

      expect((await criarPedido(s, { couponCode: 'NAO-EXISTE' })).status).toBe(404);

      await criarCupom(s, { code: 'VENCIDO', percentOff: 10, endsAt: '2020-01-01T00:00:00.000Z' });
      expect((await criarPedido(s, { couponCode: 'VENCIDO' })).status).toBe(422);

      const desativado = (await criarCupom(s, { code: 'DESATIVADO', percentOff: 10 })).body;
      await request(app).patch(`${api}/coupons/${desativado.id}/active`).set(auth(s.organizer.token)).send({ active: false });
      expect((await criarPedido(s, { couponCode: 'DESATIVADO' })).status).toBe(422);

      const outro = (await request(app).post(`${api}/campeonatos`).set(auth(s.organizer.token))
        .send({ name: 'Outra Copa', status: 'ACTIVE', entryFeeCents: PRECO })).body;
      await request(app).post(`${api}/coupons`).set(auth(s.organizer.token))
        .send({ code: 'SODOUTRO', percentOff: 10, tournamentId: outro.id });
      expect((await criarPedido(s, { couponCode: 'SODOUTRO' })).status).toBe(422);
    });

    it('respeita o limite por usuário', async () => {
      const s = await scenario();
      await criarCupom(s, { code: 'UMAVEZ', percentOff: 10, maxPerUser: 1 });

      const primeiro = await criarPedido(s, { couponCode: 'UMAVEZ' });
      expect(primeiro.status).toBe(201);
      await request(app).patch(`${api}/orders/${primeiro.body.id}/cancel`).set(auth(s.athlete.token));

      // O cancelamento devolveu a unidade ao estoque, então o usuário pode usar de novo.
      const segundo = await criarPedido(s, { couponCode: 'UMAVEZ' });
      expect(segundo.status).toBe(201);
    });

    it('não ultrapassa o limite total sob concorrência', async () => {
      const s = await scenario();
      await criarCupom(s, { code: 'ESCASSO', percentOff: 10, maxRedemptions: 1, maxPerUser: 5 });

      // Dois atletas disputam a última unidade ao mesmo tempo.
      const [a, b] = await Promise.all([
        request(app).post(`${api}/orders`).set(auth(s.athlete.token))
          .send({ tournamentId: s.tournament.id, participantId: s.participant.id, couponCode: 'ESCASSO' }),
        request(app).post(`${api}/orders`).set(auth(s.outsider.token))
          .send({ tournamentId: s.tournament.id, participantId: s.outroParticipant.id, couponCode: 'ESCASSO' })
      ]);

      const criados = [a, b].filter(r => r.status === 201);
      const recusados = [a, b].filter(r => r.status === 409);
      expect(criados).toHaveLength(1);
      expect(recusados).toHaveLength(1);

      const cupom = await prisma.coupon.findUnique({ where: { code: 'ESCASSO' } });
      expect(cupom.redeemedCount).toBe(1);
      expect(await prisma.couponRedemption.count()).toBe(1);
    });

    it('só o dono do campeonato administra o cupom', async () => {
      const s = await scenario();
      const alheio = await request(app).post(`${api}/coupons`).set(auth(s.rival.token))
        .send({ code: 'INVASAO', percentOff: 10, tournamentId: s.tournament.id });
      expect(alheio.status).toBe(403);
      expect((await request(app).get(`${api}/coupons`).set(auth(s.athlete.token))).status).toBe(403);
    });
  });

  describe('Idempotência', () => {
    it('a mesma chave não cria dois pedidos', async () => {
      const s = await scenario();
      const chave = `pedido-${crypto.randomUUID()}`;

      const primeiro = await criarPedido(s, { idempotencyKey: chave });
      const segundo = await criarPedido(s, { idempotencyKey: chave });

      expect(primeiro.status).toBe(201);
      expect(segundo.status).toBe(201);
      expect(segundo.body.id).toBe(primeiro.body.id);
      expect(segundo.body.idempotente).toBe(true);
      expect(await prisma.order.count()).toBe(1);
    });

    it('a mesma chave não abre dois pagamentos', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const chave = `pag-${crypto.randomUUID()}`;

      const a = await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({ idempotencyKey: chave });
      const b = await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({ idempotencyKey: chave });

      expect(a.status).toBe(201);
      expect(b.body.id).toBe(a.body.id);
      expect(await prisma.payment.count()).toBe(1);
    });

    it('chave de outro usuário é recusada', async () => {
      const s = await scenario();
      const chave = `pedido-${crypto.randomUUID()}`;
      await criarPedido(s, { idempotencyKey: chave });

      const roubo = await request(app).post(`${api}/orders`).set(auth(s.outsider.token))
        .send({ tournamentId: s.tournament.id, participantId: s.outroParticipant.id, idempotencyKey: chave });
      expect(roubo.status).toBe(409);
    });
  });

  describe('Webhook', () => {
    it('confirma o pagamento e a inscrição com assinatura válida', async () => {
      const s = await scenario();
      const { pedido } = await pedidoPago(s);

      const depois = await request(app).get(`${api}/orders/${pedido.id}`).set(auth(s.athlete.token));
      expect(depois.body.status).toBe('PAID');
      expect(depois.body.paidAt).toBeTruthy();

      const inscricao = await prisma.enrollment.findFirst({ where: { participantId: s.participant.id } });
      expect(inscricao.paymentStatus).toBe('PAID');
      expect(inscricao.paidAt).toBeTruthy();
    });

    it('recusa assinatura inválida ou ausente e não altera nada', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
      const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });
      const corpo = { id: `evt_${crypto.randomUUID()}`, type: 'payment.paid', providerRef: registro.providerRef, amountCents: registro.amountCents };

      expect((await enviarWebhook(corpo, 'assinatura-falsa')).status).toBe(401);
      expect((await enviarWebhook(corpo, '')).status).toBe(401);

      const inalterado = await prisma.payment.findUnique({ where: { id: pagamento.id } });
      expect(inalterado.status).toBe('PENDING');
      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('PENDING');
    });

    it('webhook repetido não cobra nem confirma duas vezes', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
      const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });
      const corpo = { id: 'evt-repetido-1', type: 'payment.paid', providerRef: registro.providerRef, amountCents: registro.amountCents };

      const primeira = await enviarWebhook(corpo);
      const segunda = await enviarWebhook(corpo);
      const terceira = await enviarWebhook(corpo);

      expect(primeira.body.processed).toBe(true);
      expect(segunda.body.duplicated).toBe(true);
      expect(segunda.body.processed).toBe(false);
      expect(terceira.body.duplicated).toBe(true);

      expect(await prisma.payment.count({ where: { orderId: pedido.id } })).toBe(1);
      expect(await prisma.paymentEvent.count({ where: { externalId: 'evt-repetido-1' } })).toBe(1);
      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('PAID');
    });

    it('notificação atrasada não desfaz um estado terminal', async () => {
      const s = await scenario();
      const { pedido, providerRef } = await pedidoPago(s);

      // Chega, fora de ordem, um evento anterior ao pagamento.
      const atrasado = await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.processing', providerRef, amountCents: PRECO });
      expect(atrasado.body.processed).toBe(false);
      expect(atrasado.body.reason).toContain('transição ignorada');

      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('PAID');
      const pagamento = await prisma.payment.findUnique({ where: { providerRef } });
      expect(pagamento.status).toBe('PAID');
    });

    it('recusa confirmação com valor divergente do cobrado', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
      const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });

      const divergente = await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.paid', providerRef: registro.providerRef, amountCents: 1 });
      expect(divergente.status).toBe(422);

      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('PENDING');
      const trilha = await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_AMOUNT_MISMATCH' } });
      expect(trilha).toBeTruthy();
    });

    it('pagamento recusado mantém a inscrição como não paga', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
      const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });

      await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.failed', providerRef: registro.providerRef });

      expect((await prisma.payment.findUnique({ where: { id: pagamento.id } })).status).toBe('FAILED');
      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('PENDING');
      const inscricao = await prisma.enrollment.findFirst({ where: { participantId: s.participant.id } });
      expect(inscricao.paymentStatus).toBe('PENDING');
      expect(inscricao.paidAt).toBeNull();
    });

    it('referência desconhecida não derruba o endpoint nem processa nada', async () => {
      await scenario();
      const resposta = await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.paid', providerRef: 'sandbox_inexistente' });
      expect(resposta.status).toBe(200);
      expect(resposta.body.processed).toBe(false);
    });
  });

  describe('Máquina de estados', () => {
    it('recusa transições inválidas de pedido, pagamento e reembolso', () => {
      expect(() => assertTransicao('order', 'PENDING', 'REFUNDED')).toThrow();
      expect(() => assertTransicao('order', 'CANCELLED', 'PAID')).toThrow();
      expect(() => assertTransicao('payment', 'FAILED', 'PAID')).toThrow();
      expect(() => assertTransicao('refund', 'COMPLETED', 'PENDING')).toThrow();
      expect(podeTransitar('order', 'PENDING', 'PAID')).toBe(true);
      expect(podeTransitar('payment', 'PAID', 'REFUNDED')).toBe(true);
    });

    it('não permite pagar um pedido cancelado', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      await request(app).patch(`${api}/orders/${pedido.id}/cancel`).set(auth(s.athlete.token));

      const tentativa = await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({});
      expect(tentativa.status).toBe(422);
    });
  });

  describe('Reembolso', () => {
    it('estorna um pedido pago e reverte inscrição e cupom', async () => {
      const s = await scenario();
      await request(app).post(`${api}/coupons`).set(auth(s.organizer.token))
        .send({ code: 'REEMB10', percentOff: 10, tournamentId: s.tournament.id });

      const pedido = (await criarPedido(s, { couponCode: 'REEMB10' })).body;
      const pagamento = (await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token)).send({})).body;
      const registro = await prisma.payment.findUnique({ where: { id: pagamento.id } });
      await enviarWebhook({ id: `evt_${crypto.randomUUID()}`, type: 'payment.paid', providerRef: registro.providerRef, amountCents: registro.amountCents });

      const reembolso = await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.organizer.token))
        .send({ reason: 'Evento cancelado' });
      expect(reembolso.status).toBe(201);
      expect(reembolso.body.status).toBe('COMPLETED');
      expect(reembolso.body.amountCents).toBe(13500);

      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('REFUNDED');
      expect((await prisma.payment.findUnique({ where: { id: pagamento.id } })).status).toBe('REFUNDED');
      const inscricao = await prisma.enrollment.findFirst({ where: { participantId: s.participant.id } });
      expect(inscricao.paymentStatus).toBe('REFUNDED');
      expect(inscricao.paidAt).toBeNull();
      // O cupom voltou ao estoque.
      expect((await prisma.coupon.findUnique({ where: { code: 'REEMB10' } })).redeemedCount).toBe(0);
    });

    it('recusa reembolso de pedido não pago', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;
      const tentativa = await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.organizer.token)).send({});
      expect(tentativa.status).toBe(422);
    });

    it('recusa reembolso acima do valor pago e reembolso duplicado', async () => {
      const s = await scenario();
      const { pedido } = await pedidoPago(s);

      const excessivo = await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.organizer.token))
        .send({ amountCents: PRECO * 2 });
      expect(excessivo.status).toBe(422);

      expect((await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.organizer.token)).send({})).status).toBe(201);
      expect((await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.organizer.token)).send({})).status).toBe(409);
    });

    it('o comprador não reembolsa a si próprio, nem o organizador alheio', async () => {
      const s = await scenario();
      const { pedido } = await pedidoPago(s);
      expect((await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.athlete.token)).send({})).status).toBe(403);
      expect((await request(app).post(`${api}/orders/${pedido.id}/refunds`).set(auth(s.rival.token)).send({})).status).toBe(403);
    });
  });

  describe('Autorização e IDOR', () => {
    it('um atleta não vê nem paga o pedido de outro', async () => {
      const s = await scenario();
      const pedido = (await criarPedido(s)).body;

      expect((await request(app).get(`${api}/orders/${pedido.id}`).set(auth(s.outsider.token))).status).toBe(403);
      expect((await request(app).post(`${api}/orders/${pedido.id}/payments`).set(auth(s.outsider.token)).send({})).status).toBe(403);
      expect((await request(app).patch(`${api}/orders/${pedido.id}/cancel`).set(auth(s.outsider.token))).status).toBe(403);
      expect((await request(app).get(`${api}/orders/${pedido.id}`)).status).toBe(401);
    });

    it('não gera pedido para participante de outra pessoa', async () => {
      const s = await scenario();
      const tentativa = await request(app).post(`${api}/orders`).set(auth(s.athlete.token))
        .send({ tournamentId: s.tournament.id, participantId: s.outroParticipant.id });
      expect(tentativa.status).toBe(403);
    });

    it('a listagem mostra a cada um apenas o que lhe cabe', async () => {
      const s = await scenario();
      const meu = (await criarPedido(s)).body;

      const doAtleta = await request(app).get(`${api}/orders`).set(auth(s.athlete.token));
      expect(doAtleta.body.items.map(item => item.id)).toContain(meu.id);

      const doExterno = await request(app).get(`${api}/orders`).set(auth(s.outsider.token));
      expect(doExterno.body.items.map(item => item.id)).not.toContain(meu.id);

      // O organizador do campeonato acompanha os pedidos do próprio evento.
      const doOrganizador = await request(app).get(`${api}/orders`).set(auth(s.organizer.token));
      expect(doOrganizador.body.items.map(item => item.id)).toContain(meu.id);

      const doRival = await request(app).get(`${api}/orders`).set(auth(s.rival.token));
      expect(doRival.body.items.map(item => item.id)).not.toContain(meu.id);
    });

    it('nenhuma resposta financeira expõe dado sensível', async () => {
      const s = await scenario();
      const { pedido } = await pedidoPago(s);
      const respostas = await Promise.all([
        request(app).get(`${api}/orders/${pedido.id}`).set(auth(s.athlete.token)),
        request(app).get(`${api}/orders`).set(auth(s.athlete.token)),
        request(app).get(`${api}/orders/${pedido.id}/payments`).set(auth(s.athlete.token))
      ]);
      for (const resposta of respostas) {
        const payload = JSON.stringify(resposta.body);
        for (const proibido of ['passwordHash', 'cvv', 'CVV', 'cardNumber', 'idempotencyKey', 'providerRef', 'secret']) {
          expect(payload, proibido).not.toContain(proibido);
        }
      }
    });
  });

  describe('Notificações e auditoria financeira', () => {
    it('avisa o comprador na criação e na aprovação', async () => {
      const s = await scenario();
      await pedidoPago(s);

      const caixa = await request(app).get(`${api}/notifications`).set(auth(s.athlete.token));
      const tipos = caixa.body.items.map(item => item.type);
      expect(tipos).toContain('ORDER_CREATED');
      expect(tipos).toContain('PAYMENT_CREATED');
      expect(tipos).toContain('PAYMENT_APPROVED');
      const aprovado = caixa.body.items.find(item => item.type === 'PAYMENT_APPROVED');
      expect(aprovado.priority).toBe('HIGH');
    });

    it('registra a trilha sem guardar chave de idempotência nem segredo', async () => {
      const s = await scenario();
      await pedidoPago(s);

      const trilha = await request(app).get(`${api}/audit`).set(auth(s.admin.token));
      const acoes = trilha.body.items.map(item => item.action);
      expect(acoes).toContain('ORDER_CREATE');
      expect(acoes).toContain('PAYMENT_START');
      expect(acoes).toContain('PAYMENT_PAID');
      expect(JSON.stringify(trilha.body)).not.toContain('Senha@123');
    });
  });

  describe('Patrocínios', () => {
    it('registra patrocinador e contrato sem se misturar a pedidos', async () => {
      const s = await scenario();
      const patrocinador = await request(app).post(`${api}/sponsors`).set(auth(s.organizer.token))
        .send({ name: 'Marca Oficial', document: '12345678000199' });
      expect(patrocinador.status).toBe(201);

      const contrato = await request(app).post(`${api}/sponsorships`).set(auth(s.organizer.token))
        .send({ sponsorId: patrocinador.body.id, tournamentId: s.tournament.id, amountCents: 500000 });
      expect(contrato.status).toBe(201);
      expect(contrato.body.amountCents).toBe(500000);

      const lista = await request(app).get(`${api}/sponsorships`).set(auth(s.organizer.token));
      expect(lista.body.totalCents).toBe(500000);
      // Patrocínio não vira pedido.
      expect(await prisma.order.count()).toBe(0);
    });

    it('recusa contrato duplicado e acesso de quem não administra', async () => {
      const s = await scenario();
      const patrocinador = (await request(app).post(`${api}/sponsors`).set(auth(s.organizer.token)).send({ name: 'Marca' })).body;
      await request(app).post(`${api}/sponsorships`).set(auth(s.organizer.token))
        .send({ sponsorId: patrocinador.id, tournamentId: s.tournament.id, amountCents: 1000 });

      const duplicado = await request(app).post(`${api}/sponsorships`).set(auth(s.organizer.token))
        .send({ sponsorId: patrocinador.id, tournamentId: s.tournament.id, amountCents: 1000 });
      expect(duplicado.status).toBe(409);

      expect((await request(app).get(`${api}/sponsors`).set(auth(s.athlete.token))).status).toBe(403);
      const alheio = await request(app).post(`${api}/sponsorships`).set(auth(s.rival.token))
        .send({ sponsorId: patrocinador.id, tournamentId: s.tournament.id, amountCents: 1000 });
      expect(alheio.status).toBe(403);
    });
  });

  describe('Expiração de pedido', () => {
    it('expira o pendente vencido e devolve o cupom ao estoque', async () => {
      const s = await scenario();
      await request(app).post(`${api}/coupons`).set(auth(s.organizer.token))
        .send({ code: 'EXPIRA', percentOff: 10, tournamentId: s.tournament.id, maxRedemptions: 1 });

      const pedido = (await criarPedido(s, { couponCode: 'EXPIRA' })).body;
      expect((await prisma.coupon.findUnique({ where: { code: 'EXPIRA' } })).redeemedCount).toBe(1);

      // Simula o tempo passando movendo a data de expiração para trás.
      await prisma.order.update({ where: { id: pedido.id }, data: { expiresAt: new Date(Date.now() - 60000) } });
      const { expirePending } = await import('../src/services/orderService.js');
      const resultado = await expirePending();

      expect(resultado.expired).toBe(1);
      expect((await prisma.order.findUnique({ where: { id: pedido.id } })).status).toBe('EXPIRED');
      expect((await prisma.coupon.findUnique({ where: { code: 'EXPIRA' } })).redeemedCount).toBe(0);
    });
  });
});
