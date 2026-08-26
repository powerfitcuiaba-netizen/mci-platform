const logger = require('../utils/logger');
const { config } = require('../config/environment');

// A resposta de erro nunca carrega stack trace: em produção isso é entrega de
// mapa da aplicação. O rastro vai para o log estruturado, que já redige senha,
// token e segredo.
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  const code = err.code || (status === 500 ? 'INTERNAL_ERROR' : 'ERROR');

  if (status >= 500) {
    logger.error('erro não tratado', { rota: `${req.method} ${req.originalUrl}`, code, message: err.message, stack: config.isProduction ? undefined : err.stack });
  } else if (status === 429 || status === 401 || status === 403) {
    logger.warn('requisição recusada', { rota: `${req.method} ${req.originalUrl}`, status, code });
  }

  const corpo = {
    error: {
      code,
      message: status === 500 && config.isProduction ? 'Erro interno do servidor' : err.message
    }
  };
  if (err.details) corpo.error.details = err.details;

  res.status(status).json(corpo);
}

module.exports = errorHandler;
