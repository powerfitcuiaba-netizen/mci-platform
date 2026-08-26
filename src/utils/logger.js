const { EOL } = require('os');
const { config } = require('../config/environment');

// Log estruturado em JSON, com redação obrigatória. O que nunca pode aparecer
// num log é justamente o que costuma vazar por descuido: senha, token, segredo
// e dado de cartão. A redação é por nome de chave, em qualquer profundidade.
const PROIBIDAS = ['password', 'senha', 'token', 'secret', 'authorization', 'cvv', 'cardnumber', 'card_number', 'passwordhash', 'apikey', 'api_key', 'idempotencykey'];

const NIVEIS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const nivelAtual = NIVEIS[config.logLevel] ?? NIVEIS.info;

const ehProibida = chave => {
  const nome = String(chave).toLowerCase().replace(/[^a-z_]/g, '');
  return PROIBIDAS.some(proibida => nome.includes(proibida.replace(/[^a-z_]/g, '')));
};

function redigir(valor, profundidade = 0) {
  if (profundidade > 5) return '[profundo demais]';
  if (Array.isArray(valor)) return valor.slice(0, 30).map(item => redigir(item, profundidade + 1));
  if (valor instanceof Error) return { name: valor.name, message: valor.message };
  if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    const saida = {};
    for (const [chave, interno] of Object.entries(valor)) {
      saida[chave] = ehProibida(chave) ? '[redigido]' : redigir(interno, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

// Monta a linha sem emitir. Separado da emissão para que a forma do log possa
// ser verificada sem depender do nível configurado no ambiente.
function format(nivel, mensagem, contexto) {
  return {
    ts: new Date().toISOString(),
    level: nivel,
    env: config.env,
    msg: String(mensagem),
    ...(contexto ? { ctx: redigir(contexto) } : {})
  };
}

function emitir(nivel, mensagem, contexto) {
  if (NIVEIS[nivel] > nivelAtual) return;

  const texto = JSON.stringify(format(nivel, mensagem, contexto));
  // Escrita direta no descritor: log estruturado não passa por console, e assim
  // a varredura por depuração esquecida não confunde a saída do logger.
  const destino = nivel === 'error' || nivel === 'warn' ? process.stderr : process.stdout;
  destino.write(texto + EOL);
}

const logger = {
  error: (mensagem, contexto) => emitir('error', mensagem, contexto),
  warn: (mensagem, contexto) => emitir('warn', mensagem, contexto),
  info: (mensagem, contexto) => emitir('info', mensagem, contexto),
  debug: (mensagem, contexto) => emitir('debug', mensagem, contexto),
  format,
  redigir,
  nivel: config.logLevel
};

module.exports = logger;
