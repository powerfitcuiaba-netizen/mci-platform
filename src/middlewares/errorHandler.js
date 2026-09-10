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

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (ehJsonQuebrado(err)) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Corpo da requisição não é um JSON válido' } });
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
