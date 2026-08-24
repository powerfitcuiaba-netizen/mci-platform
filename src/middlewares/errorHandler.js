function errorHandler(err, req, res, next) {
  void req;
  void next;
  const isUniqueConflict = err.code === 'P2002';
  const isInvalidJson = err.type === 'entity.parse.failed';
  const status = err.status || (isUniqueConflict ? 409 : isInvalidJson ? 400 : 500);
  const code = err.status ? err.code : isUniqueConflict ? 'RESOURCE_CONFLICT' : isInvalidJson ? 'INVALID_JSON' : 'INTERNAL_SERVER_ERROR';
  const message = err.status ? err.message : isUniqueConflict ? 'Recurso já existe' : isInvalidJson ? 'JSON inválido' : 'Erro interno do servidor';

  if (status >= 500) console.error(err);

  const response = { error: { code, message } };
  if (err.details) response.error.details = err.details;
  res.status(status).json(response);
}

module.exports = errorHandler;