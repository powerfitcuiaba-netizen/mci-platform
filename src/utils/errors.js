class AppError extends Error {
  // `details` é opcional e carrega contexto estruturado do erro — a lista de
  // problemas de uma validação, por exemplo. O errorHandler já sabe expor esse
  // campo; sem ele no construtor, a única saída era concatenar tudo na mensagem.
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { AppError };