const prisma = require('./prisma');
const { contextoAtual, executarComContexto } = require('./rlsContext');

// ============================================================================
// Contexto de RLS.
//
// As políticas do banco leem `current_setting('mci.user_id')`. A definição
// precisa valer para a MESMA conexão em que a consulta roda, então é feita com
// SET LOCAL dentro de uma transação interativa: com pool de conexões, definir
// a variável fora da transação a aplicaria a uma conexão qualquer — e, pior,
// ela poderia vazar para a próxima requisição.
//
// Uso real: `src/utils/asyncHandler.js` envolve TODO handler autenticado. Os
// services não chamam este helper diretamente — quem os liga à transação é o
// proxy de `src/config/prisma.js`.
//
// Sem ator informado, o contexto é vazio e as políticas negam. É o
// comportamento correto: falhar fechado.
// ============================================================================

const SEM_ATOR = '';

const definirAtor = (tx, ator) => tx.$executeRaw`SELECT set_config('mci.user_id', ${ator}, true)`;

const lerAtor = async tx => {
  const [linha] = await tx.$queryRaw`SELECT current_setting('mci.user_id', true) AS user_id`;
  return linha?.user_id || SEM_ATOR;
};

function withUserContext(userId, callback) {
  const ator = userId == null ? SEM_ATOR : String(userId);
  const jaEmContexto = Boolean(contextoAtual()?.tx);

  // Quando já existe transação em curso, o proxy a reaproveita em vez de
  // aninhar. Nesse caso o SET LOCAL sobrescreveria o ator até o fim da
  // transação inteira, então o valor anterior é restaurado ao sair — sem isso,
  // uma chamada aninhada com outro ator deixaria contexto residual atrás de si.
  return prisma.$transaction(async tx => {
    const anterior = jaEmContexto ? await lerAtor(tx) : null;
    await definirAtor(tx, ator);

    try {
      return await executarComContexto({ tx, userId: ator }, () => callback(tx));
    } finally {
      if (jaEmContexto) await definirAtor(tx, anterior);
    }
  });
}

// Leitura do contexto corrente, útil em diagnóstico e em teste de política.
async function currentContext() {
  const contexto = contextoAtual();
  if (contexto?.tx) return (await lerAtor(contexto.tx)) || null;
  return (await lerAtor(prisma)) || null;
}

module.exports = { withUserContext, currentContext };
