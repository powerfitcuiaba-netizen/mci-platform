const { AppError } = require('./errors');

// Transições permitidas, declaradas de forma explícita. Um estado financeiro
// não muda por atribuição direta em algum service: passa por aqui, e o que não
// está no mapa é recusado. É o que impede, por exemplo, um pedido pendente ser
// marcado como reembolsado sem nunca ter sido pago.

const ORDER = Object.freeze({
  PENDING: ['PAID', 'CANCELLED', 'EXPIRED'],
  PAID: ['REFUNDED'],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: []
});

const PAYMENT = Object.freeze({
  PENDING: ['PROCESSING', 'AUTHORIZED', 'PAID', 'FAILED', 'CANCELLED'],
  PROCESSING: ['AUTHORIZED', 'PAID', 'FAILED', 'CANCELLED'],
  AUTHORIZED: ['PAID', 'FAILED', 'CANCELLED'],
  PAID: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: []
});

const REFUND = Object.freeze({
  PENDING: ['PROCESSING', 'FAILED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: []
});

const MAPAS = { order: ORDER, payment: PAYMENT, refund: REFUND };
const ROTULOS = { order: 'pedido', payment: 'pagamento', refund: 'reembolso' };

const estadosDe = tipo => Object.keys(MAPAS[tipo]);

const podeTransitar = (tipo, de, para) => {
  const mapa = MAPAS[tipo];
  if (!mapa) throw new Error(`Máquina de estados desconhecida: ${tipo}`);
  if (de === para) return false;
  return Array.isArray(mapa[de]) && mapa[de].includes(para);
};

// Terminal: estado do qual não sai mais nada. Útil para o webhook decidir que
// uma notificação atrasada não deve mexer em nada.
const ehTerminal = (tipo, estado) => (MAPAS[tipo][estado] || []).length === 0;

function assertTransicao(tipo, de, para) {
  const mapa = MAPAS[tipo];
  if (!mapa[de]) throw new AppError(422, 'INVALID_STATE', `Estado atual inválido para ${ROTULOS[tipo]}: ${de}`);
  if (!mapa[para]) throw new AppError(422, 'INVALID_STATE', `Estado de destino inválido para ${ROTULOS[tipo]}: ${para}`);
  if (!podeTransitar(tipo, de, para)) {
    throw new AppError(422, 'INVALID_TRANSITION', `Transição não permitida para ${ROTULOS[tipo]}: ${de} → ${para}`);
  }
  return para;
}

module.exports = { ORDER, PAYMENT, REFUND, estadosDe, podeTransitar, ehTerminal, assertTransicao };
