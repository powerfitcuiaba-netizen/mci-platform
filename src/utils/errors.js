// ============================================================================
// O ERRO DE APLICAÇÃO — e o quarto argumento que ele passou a guardar.
//
// `details` existia nas DUAS pontas e não existia no meio. `errorHandler.js:104`
// já o copiava para o corpo da resposta (`if (err.details) ...`), e dezesseis
// chamadas em nove serviços já o passavam como quarto argumento — a recusa de
// vínculo manda `currentTeamId` e o nome da equipe atual, a de estado de
// treinador manda o `status` que bloqueou a transição, a de delegação manda a
// lista do que É delegável.
//
// O construtor recebia três parâmetros e descartava o quarto em silêncio. Então
// nada disso chegava ao cliente: a tela recebia a frase e nenhum dado
// estruturado, e o operador ficava com "não foi possível" sem o id que resolve.
//
// MEDIDO: `POST /central-authorizations` com permissão fora da lista branca
// respondia 422 com `error.details` UNDEFINED, enquanto o serviço passava
// `{ delegaveis: ['athletes.transfer'] }`.
//
// O QUE ISSO NÃO É: um canal novo de vazamento. `details` é escrito à mão em
// cada chamada, nunca vem de payload do cliente e nunca carrega objeto do banco
// inteiro — e continua opcional, então toda recusa que não o passa responde
// exatamente como antes.
// ============================================================================
class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
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