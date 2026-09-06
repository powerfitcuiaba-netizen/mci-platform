const { withUserContext } = require('../config/rlsSession');

// ============================================================================
// Ponto único por onde passa todo handler de rota — e, por isso, o lugar certo
// para estabelecer o ator de RLS.
//
// O ator vem de `req.user`, preenchido pelo middleware de autenticação a
// partir do token. NUNCA vem do corpo, da query ou de parâmetro de rota: se
// viesse, o cliente escolheria em nome de quem o banco o trataria, e a
// política deixaria de ser barreira.
//
// Requisição sem ator não abre transação: roda no cliente base, sem contexto.
// As políticas então enxergam ator anônimo e liberam apenas o que é público
// por definição — publicação PUBLIC, resultado PUBLISHED. É o mesmo resultado
// de um contexto vazio, sem gastar uma conexão do pool por sonda de
// infraestrutura.
// ============================================================================

// A resposta é retida até o commit. Sem isto, o handler chamaria `res.json`
// ainda dentro da transação e o cliente receberia 201 com um id antes de a
// linha existir para qualquer outra conexão — pior, receberia 201 mesmo que o
// commit viesse a falhar depois.
//
// Só corpo e status são retidos. Download continua escrevendo direto no
// socket: é leitura, o stream vem do disco e não do banco, e reter um arquivo
// inteiro em memória para preservar ordem que ninguém observa seria troca ruim.
function reterResposta(res) {
  const jsonOriginal = res.json.bind(res);
  const sendOriginal = res.send.bind(res);
  const retido = { houve: false, tipo: null, corpo: undefined, status: 200 };

  res.json = corpo => { Object.assign(retido, { houve: true, tipo: 'json', corpo, status: res.statusCode }); return res; };
  res.send = corpo => { Object.assign(retido, { houve: true, tipo: 'send', corpo, status: res.statusCode }); return res; };

  const restaurar = () => { res.json = jsonOriginal; res.send = sendOriginal; };
  const enviar = () => { if (retido.houve) res.status(retido.status)[retido.tipo](retido.corpo); };

  return { restaurar, enviar };
}

module.exports = function asyncHandler(handler) {
  return (req, res, next) => {
    const ator = req.user?.id ?? null;

    if (ator === null) {
      return Promise.resolve(handler(req, res, next)).catch(next);
    }

    let resposta = null;

    return withUserContext(ator, async () => {
      resposta = reterResposta(res);
      try {
        return await handler(req, res, next);
      } finally {
        resposta.restaurar();
      }
    })
      .then(() => { if (resposta) resposta.enviar(); })
      .catch(next);
  };
};
