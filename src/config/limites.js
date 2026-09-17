// Tetos de entrada declarados UMA vez.
//
// O limite do corpo vivia escrito em dois lugares: o `express.json` que o
// aplica e a mensagem de recusa que o informa ao operador. Dois lugares é uma
// divergência esperando acontecer — e a divergência aqui é particularmente
// ruim, porque a mensagem diria um número e o servidor recusaria por outro.
//
// O valor é expresso nas duas formas de que cada lado precisa: a string que o
// `body-parser` entende e o texto que vai para a mensagem.
const CORPO_MAXIMO_MB = 8;

module.exports = Object.freeze({
  CORPO_MAXIMO_MB,
  CORPO_MAXIMO: `${CORPO_MAXIMO_MB}mb`,
  CORPO_MAXIMO_LEGIVEL: `${CORPO_MAXIMO_MB} MB`,
  CORPO_MAXIMO_BYTES: CORPO_MAXIMO_MB * 1024 * 1024
});
