const { AsyncLocalStorage } = require('node:async_hooks');

// ============================================================================
// Contexto da requisição corrente.
//
// Guarda a transação em que o ator de RLS já foi definido, para que os
// services continuem chamando `prisma.athlete.findMany(...)` e ainda assim
// executem na MESMA conexão que carrega o `SET LOCAL`. Sem isso, o pool
// entregaria uma conexão diferente e o contexto não valeria para a consulta.
//
// AsyncLocalStorage é o mecanismo certo aqui: o escopo acompanha a cadeia de
// await da requisição e não vaza para outra, que é exatamente a garantia
// necessária quando há requisições concorrentes disputando o mesmo pool.
// ============================================================================

const armazenamento = new AsyncLocalStorage();

const contextoAtual = () => armazenamento.getStore() || null;

const executarComContexto = (contexto, callback) => armazenamento.run(contexto, callback);

module.exports = { contextoAtual, executarComContexto };
