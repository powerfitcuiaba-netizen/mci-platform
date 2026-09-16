const logger = require('../utils/logger');
const { config } = require('../config/environment');

// A resposta de erro nunca carrega stack trace: em produção isso é entrega de
// mapa da aplicação. O rastro vai para o log estruturado, que já redige senha,
// token e segredo.
// Corpo que não é JSON válido é erro do cliente, e o `express.json` já o
// classifica como 400. O que vazava era a mensagem crua do parser do V8
// ("Expected property name or '}' in JSON at position 1"), com um código
// genérico `ERROR` que não diz nada a quem lê o log depois.
const ehJsonQuebrado = err =>
  err instanceof SyntaxError && err.status === 400 && 'body' in err;

// Violação de unicidade e linha ausente são REGRA DE NEGÓCIO chegando pela
// porta do banco, não falha da aplicação.
//
// O caso que motivou o mapa: duas requisições simultâneas declarando o mesmo
// título Overall. A verificação no serviço não impede a corrida — entre o
// `findFirst` e o `create` cabe a outra requisição —, e quem impedia era o
// índice único, levantando P2002. Sem tradução isso saía 500, que diz ao
// cliente "a aplicação quebrou" quando o certo é "alguém chegou antes".
//
// Cada serviço continua traduzindo o SEU caso, com mensagem que explica o que
// fazer. Este mapa é a rede embaixo: garante que nenhum caminho esquecido
// devolva 500 para uma condição que o banco previu.
const POR_CODIGO_DO_PRISMA = Object.freeze({
  P2002: { status: 409, code: 'CONFLICT', message: 'Registro já existe' },
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Registro não encontrado' }
});

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (ehJsonQuebrado(err)) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Corpo da requisição não é um JSON válido' } });
  }

  // O Prisma só mapeia para P2002 os índices que conhece pelo schema. Índice
  // PARCIAL (como o que protege o Overall do evento inteiro) vive só na
  // migration, e a violação dele chega como erro desconhecido com o código do
  // PostgreSQL dentro da mensagem.
  const unicidadeCrua = !err.status && !err.code
    && typeof err.message === 'string' && err.message.includes('23505');

  const doPrisma = unicidadeCrua
    ? POR_CODIGO_DO_PRISMA.P2002
    : (!err.status && POR_CODIGO_DO_PRISMA[err.code]);
  if (doPrisma) {
    logger.warn('condição prevista pelo banco', {
      rota: `${req.method} ${req.originalUrl}`, prisma: err.code || '23505', status: doPrisma.status
    });
    return res.status(doPrisma.status).json({ error: { code: doPrisma.code, message: doPrisma.message } });
  }

  const status = err.status || 500;
  const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');

  // Falha de 500 não publica a taxonomia interna. A mensagem já era redigida
  // em produção, mas o CÓDIGO passava direto: um erro não tratado do Prisma
  // saía como `{"code":"P2003"}`, que diz ao visitante qual é a camada de
  // persistência e que classe de falha ocorreu. É o mesmo mapa da aplicação
  // que o comentário acima recusa a entregar junto com o stack.
  //
  // Nada é mascarado: o status continua 500 e o código REAL continua indo
  // para o log estruturado, logo abaixo, que é onde ele serve para alguma
  // coisa. O que muda é só o que sai pela porta da frente.
  const codigoNaResposta = status >= 500 ? 'INTERNAL_ERROR' : code;

  if (status >= 500) {
    logger.error('erro não tratado', { rota: `${req.method} ${req.originalUrl}`, code, message: err.message, stack: config.isProduction ? undefined : err.stack });
  } else if (status === 429 || status === 401 || status === 403) {
    logger.warn('requisição recusada', { rota: `${req.method} ${req.originalUrl}`, status, code });
  }

  const corpo = {
    error: {
      code: codigoNaResposta,
      message: status === 500 && config.isProduction ? 'Erro interno do servidor' : err.message
    }
  };
  if (err.details) corpo.error.details = err.details;

  res.status(status).json(corpo);
}

module.exports = errorHandler;
