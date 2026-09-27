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

// Conta uma batida no balde. Devolve `null` enquanto está dentro do teto e, ao
// estourar, `{ segundos, primeira }`.
//
// `primeira` é o que sustenta a auditoria do 429 (achado A-10): ela é verdadeira
// apenas na PRIMEIRA recusa de cada balde em cada janela. Sem essa distinção, a
// única forma de auditar o bloqueio seria uma linha por requisição barrada — e
// aí manter a rajada encheria a trilha de propósito.
function bater(chave, max, windowMs, agora) {
  const registro = baldes.get(chave);

  if (!registro || registro.expiraEm <= agora) {
    baldes.set(chave, { contagem: 1, expiraEm: agora + windowMs });
    return null;
  }

  registro.contagem += 1;
  if (registro.contagem > max) {
    return {
      segundos: Math.ceil((registro.expiraEm - agora) / 1000),
      primeira: registro.contagem === max + 1
    };
  }
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
// AUDITAR O BLOQUEIO — achado A-10.
//
// O 429 é decidido aqui, antes de qualquer serviço, então a rajada barrada não
// deixava rastro: uma varredura de senhas contida pelo teto era invisível para a
// trilha, e é justamente o evento que quem investiga procura.
//
// TRÊS DECISÕES, e cada uma fecha um jeito de a auditoria virar problema:
//
//   1. UMA LINHA POR JANELA POR BALDE, na transição para o estado bloqueado.
//      Uma linha por requisição barrada deixaria a trilha crescer no ritmo do
//      ataque — a defesa alimentando o ataque.
//   2. `record` TOLERANTE, e não `registrarObrigatorio`. É a única exceção
//      deliberada ao fail closed desta base, e a razão é a direção da falha: se
//      a trilha estiver indisponível, recusar com 503 em vez de 429 não abre
//      nada (os dois barram), mas trocar o código da recusa por causa de
//      auditoria confunde cliente legítimo e cria caminho novo de erro na porta
//      de entrada. A perda de linha é contabilizada por `estadoDaTrilha` e
//      aparece em `GET /audit/integrity`.
//   3. NEM ATOR, NEM ALVO NA LINHA. `userId` nulo, porque quem esbarra no teto é
//      desconhecido — e na rota de login o limitador roda antes de haver sessão.
//      O valor do alvo (o e-mail tentado) NÃO entra: guardá-lo faria da trilha
//      uma lista de contas sondadas. Fica só o ESCOPO do balde.
//
// O IP vai na coluna própria de `AuditLog`, que é onde ele já mora nos eventos de
// autenticação — e não no metadado, para não haver dois lugares com a mesma coisa.
const origemDaRequisicao = req => req.ip || req.headers?.['x-forwarded-for'] || null;

function registrarBloqueio({ nome, escopo, teto, windowMs }, req) {
  // Carregado aqui, e não no topo: `auditService` importa a configuração do
  // Prisma, e este middleware é montado na construção do app. Exigi-lo no topo
  // amarraria a montagem das rotas à conexão de banco.
  const audit = require('../services/auditService');

  // Sem `await`: a recusa não espera a trilha. `record` é tolerante e não
  // levanta; o `catch` existe para o caso de a própria importação ou o cliente
  // falharem, e aí o que não pode acontecer é uma rejeição sem dono derrubar o
  // processo.
  Promise.resolve()
    .then(() => audit.record({
      actor: null,
      action: audit.ACTIONS.RATE_LIMIT_BLOCK,
      entity: 'RateLimit',
      entityId: null,
      ip: origemDaRequisicao(req),
      metadata: { limitador: nome, escopo, teto, janelaMs: windowMs, rota: req.path ?? null }
    }))
    .catch(() => {});
}

function rateLimit({ windowMs = 60_000, max = 60, nome = 'geral', quandoAtivo = config.rateLimitEnabled,
  alvo = null, maxPorAlvo = null, auditar = false } = {}) {
  agendarLimpeza();
  const tetoAlvo = maxPorAlvo ?? max * 3;

  const limitador = (req, res, next) => {
    if (!quandoAtivo) return next();

    const agora = Date.now();
    const recusar = (resultado, escopo, teto) => {
      res.setHeader('Retry-After', String(resultado.segundos));
      if (auditar && resultado.primeira) registrarBloqueio({ nome, escopo, teto, windowMs }, req);
      return next(new AppError(429, 'TOO_MANY_REQUESTS', `Muitas tentativas. Tente novamente em ${resultado.segundos}s.`));
    };

    const porOrigem = bater(`${nome}:${identificar(req)}`, max, windowMs, agora);
    if (porOrigem !== null) return recusar(porOrigem, 'origem', max);

    if (alvo) {
      const quem = alvo(req);
      if (quem) {
        const porAlvo = bater(`${nome}:alvo:${quem}`, tetoAlvo, windowMs, agora);
        if (porAlvo !== null) return recusar(porAlvo, 'alvo', tetoAlvo);
      }
    }

    return next();
  };

  // O nome e o teto ficam legíveis na própria função para que um teste possa
  // conferir QUAIS rotas estão de fato atrás do limitador. O defeito que isso
  // previne não é o limitador errar a conta — é ele nunca ter sido ligado na
  // rota, que é silencioso e não aparece em nenhum teste de comportamento.
  limitador.limite = { nome, max, windowMs, maxPorAlvo: alvo ? tetoAlvo : null, auditar };
  return limitador;
}

// Usado pelos testes para partir de um estado conhecido.
const reset = () => baldes.clear();

module.exports = { rateLimit, reset, identificar };
