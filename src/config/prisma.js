const { contextoAtual } = require('./rlsContext');

// Cliente base: dono do pool. Só é usado diretamente quando não há contexto de
// requisição — partida, sondas e rotas públicas, que leem apenas o que as
// políticas liberam para ator anônimo.
//
// Mora em `./prismaPublico` porque esse uso deixou de ser implícito: a
// projeção pública passou a lê-lo de propósito, e não só por acaso de a
// requisição não ter token. É a MESMA instância — um cliente só, um pool só.
const base = require('./prismaPublico');

// ============================================================================
// Cliente sensível ao contexto.
//
// Quando a requisição corrente já abriu a transação com o ator definido, todo
// acesso é roteado para ela. Os services não mudam: continuam escrevendo
// `prisma.message.findMany(...)`, e a consulta passa a sair na conexão que
// carrega o `SET LOCAL mci.user_id` — que é o que faz a política do
// PostgreSQL valer para o caminho real da aplicação.
// ============================================================================

const prisma = new Proxy(base, {
  get(alvo, propriedade, receptor) {
    const contexto = contextoAtual();
    if (!contexto?.tx) return Reflect.get(alvo, propriedade, receptor);

    // O Prisma não aninha transações interativas. Abrir uma segunda aqui
    // perderia o contexto definido na primeira e ainda travaria uma conexão
    // extra do pool, então a chamada reaproveita a transação em curso.
    if (propriedade === '$transaction') {
      return operacoes => (typeof operacoes === 'function'
        ? operacoes(contexto.tx)
        : Promise.all(operacoes));
    }

    // `$disconnect` e `$connect` não existem na transação e continuam indo
    // para o cliente base, que é quem de fato governa o pool.
    if (propriedade in contexto.tx) return Reflect.get(contexto.tx, propriedade);
    return Reflect.get(alvo, propriedade, receptor);
  }
});

module.exports = prisma;
