const { AppError } = require('../utils/errors');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const error = new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos');
      error.details = result.error.issues.map(issue => ({ path: issue.path, message: issue.message }));
      return next(error);
    }
    // No Express 5 req.query é somente-leitura: a atribuição direta falharia em
    // silêncio e o valor convertido pelo schema seria perdido.
    try {
      req[source] = result.data;
      if (req[source] !== result.data) throw new Error('read-only');
    } catch (error) {
      Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true, enumerable: true });
    }
    next();
  };
}

module.exports = validate;