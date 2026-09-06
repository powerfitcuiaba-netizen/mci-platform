const prisma = require('./prisma');

// ============================================================================
// Contexto de RLS.
//
// As políticas do banco leem `current_setting('mci.user_id')`. Como a
// definição precisa valer para a mesma conexão em que a consulta roda, ela é
// feita com SET LOCAL dentro de uma transação interativa: com pool de
// conexões, definir a variável fora da transação a aplicaria a uma conexão
// qualquer — e, pior, ela poderia vazar para a próxima requisição.
//
// Uso:
//   const mensagens = await withUserContext(user.id, tx => tx.message.findMany(...));
//
// Sem ator informado, o contexto é vazio e as políticas negam. É o
// comportamento correto: falhar fechado.
// ============================================================================

function withUserContext(userId, callback) {
  return prisma.$transaction(async tx => {
    // `true` no terceiro argumento = escopo da transação (equivale a SET LOCAL).
    await tx.$executeRaw`SELECT set_config('mci.user_id', ${String(userId ?? '')}, true)`;
    return callback(tx);
  });
}

// Leitura do contexto corrente, útil em diagnóstico e em teste de política.
async function currentContext() {
  const [linha] = await prisma.$queryRaw`SELECT current_setting('mci.user_id', true) AS user_id`;
  return linha?.user_id || null;
}

module.exports = { withUserContext, currentContext };
