const { AppError } = require('../utils/errors');

// ==========================================================================
// Recusa o byte NUL (U+0000) na porta de entrada.
//
// O PostgreSQL nao aceita 0x00 em coluna de texto — devolve
// `22021 invalid byte sequence for encoding "UTF8"`. Sem esta guarda, o byte
// atravessava validacao, service e Prisma, e so era recusado la no fundo, ja
// dentro da consulta: o que subia era erro NAO TRATADO, e a resposta virava
// 500.
//
// A varredura que originou este arquivo mediu o tamanho do buraco: 890
// requisicoes contra 89 rotas com parametro, 81 combinacoes de rota e ator
// respondendo 5xx, SEIS delas alcancaveis sem autenticacao nenhuma. E o byte
// entrava por todos os caminhos — parametro de rota, string de consulta e
// corpo JSON.
//
// Nada vazava: o corpo da resposta ja saia redigido como INTERNAL_ERROR. O
// prejuizo era operacional. Qualquer pessoa na internet podia, com um `curl`,
// derrubar a linha de base de 5xx do monitoramento e encher o log de pilha —
// afogando o erro de verdade no ruido exatamente no dia em que o log importa.
//
// A guarda e uma so porque a causa e uma so: nenhuma das outras cargas
// testadas reproduziu o problema (travessia de caminho, CR/LF, unicode
// invalido, string de 300 caracteres — todas ja tratadas). E ela fica na
// porta, e nao em cada rota, porque um byte que o banco nao consegue gravar
// nao tem uso legitimo em lugar nenhum da aplicacao: recusa-lo cedo nao perde
// funcionalidade alguma.
//
// So o NUL. Quebra de linha e tabulacao SAO gravaveis e podem ser legitimas
// num campo de texto; alargar a recusa aqui recusaria dado valido.
// ==========================================================================

const NULO = '\u0000';
const PROFUNDIDADE_MAXIMA = 8;

function contemNulo(valor, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAXIMA) return false;
  if (typeof valor === 'string') return valor.includes(NULO);
  if (Array.isArray(valor)) return valor.some(item => contemNulo(item, profundidade + 1));
  if (valor && typeof valor === 'object') {
    return Object.values(valor).some(item => contemNulo(item, profundidade + 1));
  }
  return false;
}

function recusarByteNulo(req, res, next) {
  // A URL crua ainda carrega `%00`: os parametros de caminho so sao
  // decodificados quando a rota casa, ou seja, depois deste ponto. Conferir a
  // URL crua cobre `/athletes/%00` e `/athletes/abc%00def` de uma vez.
  //
  // `%2500` NAO entra aqui, e e o comportamento correto: aquilo decodifica
  // para o TEXTO "%00", que o banco grava sem problema nenhum.
  const url = req.originalUrl || req.url || '';

  if (/%00/i.test(url) || url.includes(NULO) || contemNulo(req.query) || contemNulo(req.body)) {
    return next(new AppError(
      400,
      'INVALID_CHARACTER',
      'A requisicao contem um caractere que nao pode ser processado'
    ));
  }
  return next();
}

module.exports = recusarByteNulo;
