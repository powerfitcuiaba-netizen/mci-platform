class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}


// Violação de unicidade, reconhecida pelas DUAS formas que ela chega.
//
// O Prisma só mapeia para P2002 os índices que CONHECE pelo schema. Índice
// parcial — como o que protege o Overall do evento inteiro, criado só na
// migration — não é modelado por ele, e a violação chega como erro
// desconhecido com o código do PostgreSQL (23505) dentro da mensagem.
//
// Olhar só para P2002 deixa justamente esse caso escapar como 500, que foi o
// que a FASE 13 mediu disparando duas declarações em paralelo.
function ehViolacaoDeUnicidade(erro) {
  if (erro?.code === 'P2002') return true;
  return typeof erro?.message === 'string' && erro.message.includes('23505');
}

module.exports = { AppError, ehViolacaoDeUnicidade };