const { AppError } = require('../utils/errors');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(new AppError(400, 'VALIDATION_ERROR', result.error.issues.map(issue => issue.message).join('; ')));
    req[source] = result.data;
    next();
  };
}

module.exports = validate;