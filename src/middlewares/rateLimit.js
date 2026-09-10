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

// Quem está autenticado responde pela PRÓPRIA conta, não pelo endereço.
//
// Contar criação de conteúdo por IP erra dos dois lados: no wifi do ginásio,
// onde metade dos atletas sai pelo mesmo endereço, um usuário abusivo derrubaria
// o limite de todos os outros; e quem abusa de propósito troca de endereço sem
// esforço. O identificador da conta não tem nenhum dos dois problemas.
//
// O prefixo evita que um id de usuário venha a colidir com um IP.
// Rota sem autenticação — login, rota pública — continua contando por origem,
// que ali é a única coisa que existe.
//
// A origem vem de `req.ip`, NUNCA do cabeçalho cru. Aqui havia
// `headers['x-forwarded-for'].split(',')[0]`, que é o valor MAIS À ESQUERDA da
// cadeia — ou seja, exatamente o pedaço que o cliente escreve e ninguém
// verifica. Medido antes da correção: 60 tentativas de login, 60 aceitas e
// zero bloqueadas, trocando o cabeçalho a cada requisição. O limitador
// existia e não limitava nada.
//
// `req.ip` é o que o Express calcula a partir de `trust proxy`: com a
// contagem de saltos certa, ele pega o endereço que o SEU proxy escreveu e
// ignora o que o cliente inventou. Ver `config.trustProxyHops` e o runbook.
const identificar = req => {
  if (req.user?.id) return `u:${req.user.id}`;
  return req.ip || req.socket?.remoteAddress || 'desconhecido';
};

// Conta uma batida no balde e diz em quantos segundos ele libera, ou null se
// ainda está dentro do teto.
function bater(chave, max, windowMs, agora) {
  const registro = baldes.get(chave);

  if (!registro || registro.expiraEm <= agora) {
    baldes.set(chave, { contagem: 1, expiraEm: agora + windowMs });
    return null;
  }

  registro.contagem += 1;
  if (registro.contagem > max) return Math.ceil((registro.expiraEm - agora) / 1000);
  return null;
}

/**
 * @param {Function|null} alvo  Extrai de `req` QUEM está sendo atacado — no
 *   login, o email tentado. Cria um segundo balde, por alvo, que sobrevive à
 *   troca de endereço: força bruta mira UMA conta, e limitar por conta é a
 *   defesa que continua de pé mesmo com o `trust proxy` mal configurado ou com
 *   o ataque distribuído entre muitos endereços.
 * @param {number} maxPorAlvo  Teto do balde por alvo. Mais folgado que o de
 *   origem de propósito: apertar demais aqui transformaria o limitador numa
 *   negação de serviço contra o dono legítimo da conta.
 */
function rateLimit({ windowMs = 60_000, max = 60, nome = 'geral', quandoAtivo = config.rateLimitEnabled,
  alvo = null, maxPorAlvo = null } = {}) {
  agendarLimpeza();
  const tetoAlvo = maxPorAlvo ?? max * 3;

  const limitador = (req, res, next) => {
    if (!quandoAtivo) return next();

    const agora = Date.now();
    const recusar = segundos => {
      res.setHeader('Retry-After', String(segundos));
      return next(new AppError(429, 'TOO_MANY_REQUESTS', `Muitas tentativas. Tente novamente em ${segundos}s.`));
    };

    const porOrigem = bater(`${nome}:${identificar(req)}`, max, windowMs, agora);
    if (porOrigem !== null) return recusar(porOrigem);

    if (alvo) {
      const quem = alvo(req);
      if (quem) {
        const porAlvo = bater(`${nome}:alvo:${quem}`, tetoAlvo, windowMs, agora);
        if (porAlvo !== null) return recusar(porAlvo);
      }
    }

    return next();
  };

  // O nome e o teto ficam legíveis na própria função para que um teste possa
  // conferir QUAIS rotas estão de fato atrás do limitador. O defeito que isso
  // previne não é o limitador errar a conta — é ele nunca ter sido ligado na
  // rota, que é silencioso e não aparece em nenhum teste de comportamento.
  limitador.limite = { nome, max, windowMs, maxPorAlvo: alvo ? tetoAlvo : null };
  return limitador;
}

// Usado pelos testes para partir de um estado conhecido.
const reset = () => baldes.clear();

module.exports = { rateLimit, reset, identificar };
