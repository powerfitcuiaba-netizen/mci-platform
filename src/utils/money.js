const { AppError } = require('./errors');

// Dinheiro é sempre inteiro, em centavos. Ponto flutuante não representa
// 0,1 + 0,2 exatamente, e um erro de arredondamento em cobrança não é um
// detalhe estético: é diferença de caixa.
const MAX_CENTS = 100_000_000; // R$ 1.000.000,00 por operação

function assertCents(valor, campo = 'valor') {
  if (typeof valor !== 'number' || !Number.isInteger(valor)) {
    throw new AppError(422, 'INVALID_AMOUNT', `${campo} deve ser um inteiro em centavos`);
  }
  if (valor < 0) throw new AppError(422, 'INVALID_AMOUNT', `${campo} não pode ser negativo`);
  if (valor > MAX_CENTS) throw new AppError(422, 'AMOUNT_TOO_LARGE', `${campo} excede o limite permitido`);
  return valor;
}

// Percentual sobre centavos, arredondando para baixo: na dúvida o desconto é
// menor, nunca maior do que o anunciado.
function percentOf(cents, percent) {
  assertCents(cents, 'subtotal');
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new AppError(422, 'INVALID_PERCENT', 'Percentual deve ser inteiro entre 0 e 100');
  }
  return Math.floor((cents * percent) / 100);
}

// O desconto nunca ultrapassa o subtotal: total negativo viraria crédito ao
// cliente sem nenhuma regra que o autorize.
const clampDiscount = (subtotalCents, discountCents) =>
  Math.max(0, Math.min(assertCents(subtotalCents, 'subtotal'), assertCents(discountCents, 'desconto')));

const sum = valores => valores.reduce((total, valor) => total + assertCents(valor, 'item'), 0);

const format = (cents, currency = 'BRL') =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(assertCents(cents) / 100);

module.exports = { MAX_CENTS, assertCents, percentOf, clampDiscount, sum, format };
