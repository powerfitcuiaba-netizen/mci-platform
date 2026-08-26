const crypto = require('crypto');
const { AppError } = require('../../utils/errors');

// Contrato que o domínio conhece. Nenhum service financeiro importa um gateway
// específico: quando entrar Stripe ou Mercado Pago, é este contrato que eles
// implementam, e nada acima muda.
//
//   createCharge({ orderId, amountCents, currency, metadata })
//     -> { providerRef, status, redirectUrl? }
//   refundCharge({ providerRef, amountCents })
//     -> { refundRef, status }
//   verifySignature(rawBody, headers) -> boolean
//   parseWebhook(rawBody, headers)
//     -> { externalId, type, providerRef, status, amountCents }

// Provedor de desenvolvimento. Não é um gateway: não move dinheiro, não fala
// com banco nenhum e serve apenas para exercitar o fluxo de estados localmente
// e nos testes. Recusa-se a existir fora de desenvolvimento justamente para que
// um pagamento simulado nunca seja confundido com um pagamento real.
const { config } = require('../../config/environment');

const SANDBOX_SECRET = config.paymentWebhookSecret;

class SandboxPaymentProvider {
  constructor() {
    this.name = 'sandbox';
    this.isReal = false;
  }

  static assertUsoPermitido() {
    if (config.isProduction && !config.allowSandboxPayments) {
      throw new AppError(
        500,
        'PAYMENT_PROVIDER_NOT_CONFIGURED',
        'Nenhum provedor de pagamento real está configurado. O provedor de desenvolvimento não opera em produção.'
      );
    }
  }

  async createCharge({ orderId, amountCents, currency }) {
    SandboxPaymentProvider.assertUsoPermitido();
    return {
      providerRef: `sandbox_${orderId}_${crypto.randomUUID()}`,
      status: 'PENDING',
      amountCents,
      currency,
      // Sem página de pagamento: o avanço de estado acontece por webhook,
      // exatamente como aconteceria com um gateway de verdade.
      redirectUrl: null
    };
  }

  async refundCharge({ providerRef, amountCents }) {
    SandboxPaymentProvider.assertUsoPermitido();
    return { refundRef: `sandbox_refund_${crypto.randomUUID()}`, providerRef, status: 'COMPLETED', amountCents };
  }

  // Assinatura HMAC sobre o corpo cru, comparada em tempo constante. É o mesmo
  // formato que os gateways reais usam, então o endpoint de webhook já nasce
  // com a verificação no lugar certo.
  verifySignature(rawBody, headers) {
    const assinatura = String(headers['x-mci-signature'] || '');
    if (!assinatura) return false;

    const esperada = crypto.createHmac('sha256', SANDBOX_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(assinatura);
    const b = Buffer.from(esperada);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhook(rawBody) {
    let corpo;
    try {
      corpo = JSON.parse(rawBody);
    } catch (error) {
      throw new AppError(400, 'INVALID_WEBHOOK', 'Corpo do webhook não é JSON válido');
    }

    const { id, type, providerRef, amountCents } = corpo;
    if (!id || !type || !providerRef) {
      throw new AppError(400, 'INVALID_WEBHOOK', 'Webhook sem identificador, tipo ou referência');
    }

    return {
      externalId: String(id),
      type: String(type),
      providerRef: String(providerRef),
      amountCents: Number.isInteger(amountCents) ? amountCents : null
    };
  }

  static assinar(payload) {
    const corpo = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHmac('sha256', SANDBOX_SECRET).update(corpo).digest('hex');
  }
}

const registro = new Map([['sandbox', new SandboxPaymentProvider()]]);

// Um gateway real se registra aqui e passa a ser escolhido por PAYMENT_PROVIDER.
const register = provider => registro.set(provider.name, provider);

// Saber se um nome corresponde a provedor registrado, sem lançar. Existe
// porque as duas origens do nome têm gravidades opostas: vindo da configuração,
// nome desconhecido é falha do servidor (500); vindo da URL de um webhook, é
// só um estranho digitando qualquer coisa — e 500 nesse caso vira ruído de
// nível error num endpoint público, escondendo incidente de verdade.
const hasProvider = nome => registro.has(nome || config.paymentProvider || 'sandbox');

function getProvider(nome) {
  const escolhido = nome || config.paymentProvider || 'sandbox';
  const provider = registro.get(escolhido);
  if (!provider) {
    throw new AppError(500, 'PAYMENT_PROVIDER_NOT_CONFIGURED', `Provedor de pagamento desconhecido: ${escolhido}`);
  }
  return provider;
}

module.exports = { getProvider, hasProvider, register, SandboxPaymentProvider, SANDBOX_SECRET };
