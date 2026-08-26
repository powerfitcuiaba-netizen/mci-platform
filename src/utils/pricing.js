const money = require('./money');

// O preço é sempre lido do campeonato. Nada de valor, desconto ou total vindo
// do cliente entra nesta conta — o corpo da requisição só diz o que se quer
// comprar, nunca quanto custa.
//
// Vive aqui, e não dentro de um serviço, porque duas camadas precisam da mesma
// resposta: o pedido, que cobra, e a prévia de cupom, que apenas mostra. Uma
// segunda cópia acabaria divergindo da primeira, e prévia que não bate com a
// cobrança é pior do que prévia nenhuma.
function calcular({ tournament, quantidade, discountCents }) {
  const unitPriceCents = money.assertCents(tournament.entryFeeCents, 'preço do campeonato');
  const subtotalCents = money.assertCents(unitPriceCents * quantidade, 'subtotal');
  const desconto = money.clampDiscount(subtotalCents, discountCents || 0);
  return { unitPriceCents, subtotalCents, discountCents: desconto, totalCents: subtotalCents - desconto };
}

module.exports = { calcular };
