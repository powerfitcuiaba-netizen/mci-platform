const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');

// Limitador por janela deslizante, em memória. Cobre o caso que importa aqui:
// tentativa repetida de login e enxurrada em endpoint público a partir de uma
// mesma origem.
//
// Limitação assumida e documentada: o estado vive no processo. Com mais de uma
// instância, cada uma conta as suas próprias tentativas — a proteção real nesse
// cenário exige um contador compartilhado (Redis) ou o limitador da borda.
// Ver README, seção de produção.

const baldes = new Map();

// Sem uma varredura periódica o mapa cresceria indefinidamente com IPs que
// nunca mais voltam.
const LIMPEZA_MS = 10 * 60 * 1000;
let timer = null;

function agendarLimpeza() {
  if (timer || config.isTest) return;
  timer = setInterval(() => {
    const agora = Date.now();
    for (const [chave, registro] of baldes) {
      if (registro.expiraEm <= agora) baldes.delete(chave);
    }
  }, LIMPEZA_MS);
  // Não segura o processo aberto no encerramento.
  if (typeof timer.unref === 'function') timer.unref();
}

const identificar = req => {
  const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return encaminhado || req.ip || req.socket?.remoteAddress || 'desconhecido';
};

function rateLimit({ windowMs = 60_000, max = 60, nome = 'geral', quandoAtivo = config.rateLimitEnabled } = {}) {
  agendarLimpeza();

  return (req, res, next) => {
    if (!quandoAtivo) return next();

    const chave = `${nome}:${identificar(req)}`;
    const agora = Date.now();
    const registro = baldes.get(chave);

    if (!registro || registro.expiraEm <= agora) {
      baldes.set(chave, { contagem: 1, expiraEm: agora + windowMs });
      return next();
    }

    registro.contagem += 1;
    if (registro.contagem > max) {
      const segundos = Math.ceil((registro.expiraEm - agora) / 1000);
      res.setHeader('Retry-After', String(segundos));
      return next(new AppError(429, 'TOO_MANY_REQUESTS', `Muitas tentativas. Tente novamente em ${segundos}s.`));
    }

    return next();
  };
}

// Usado pelos testes para partir de um estado conhecido.
const reset = () => baldes.clear();

module.exports = { rateLimit, reset, identificar };
