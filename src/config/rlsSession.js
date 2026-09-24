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

// `opcoes` chega ao `$transaction` do Prisma e existe por um motivo só: a
// transação interativa tem prazo PADRÃO de 5 segundos, e quem escreve muitas
// linhas numa tacada estoura esse prazo quando o banco não está na mesma
// máquina. A carga do calendário são ~145 idas e voltas ao banco (47 etapas ×
// consulta + escrita + auditoria): 327ms contra PostgreSQL local, mas a 30ms
// de latência isso passa de 4 segundos e a transação morre com P2028 —
// justamente no ambiente gerenciado, que é onde a carga roda de verdade.
//
// Omitir `opcoes` mantém o padrão do Prisma. Nenhuma requisição HTTP passa por
// aqui com prazo alterado: quem dilata o prazo é o script de carga, e só ele.
function withUserContext(userId, callback, opcoes = undefined) {
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
      // RESTAURAR NÃO PODE ENGOLIR O ERRO QUE CAUSOU A SAÍDA.
      //
      // Medido: uma violação de unicidade dentro do contexto aninhado ABORTA a
      // transação. O `SET LOCAL` daqui então falha com 25P02 ("current
      // transaction is aborted"), e como ele acontece no `finally`, essa falha
      // SUBSTITUI a original — o serviço devolvia 500 genérico no lugar do
      // P2002 que sabia explicar o que houve.
      //
      // Restaurar o ator serve a uma transação que CONTINUA. Uma transação
      // abortada não continua: tudo nela será desfeito, inclusive o
      // `set_config`. Então, se a restauração falhar, o certo é seguir em
      // frente e deixar o erro de verdade subir.
      if (jaEmContexto) {
        try {
          await definirAtor(tx, anterior);
        } catch {
          // Transação já abortada: não há contexto para restaurar, e insistir
          // só trocaria a causa real por um sintoma.
        }
      }
    }
  }, opcoes);
}

// Leitura do contexto corrente, útil em diagnóstico e em teste de política.
async function currentContext() {
  const contexto = contextoAtual();
  if (contexto?.tx) return (await lerAtor(contexto.tx)) || null;
  return (await lerAtor(prisma)) || null;
}

module.exports = { withUserContext, currentContext };
