const { AppError } = require('../utils/errors');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const error = new AppError(400, 'VALIDATION_ERROR', 'Dados inválidos');
      error.details = result.error.issues.map(issue => ({ path: issue.path, message: issue.message }));
      return next(error);
    }
    req[source] = result.data;
    next();
  };
}

module.exports = validate;