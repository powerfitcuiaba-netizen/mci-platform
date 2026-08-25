// Configuração centralizada e validada na partida. Em produção o processo se
// recusa a subir com segredo de desenvolvimento: é preferível falhar no deploy
// a servir tráfego real com JWT que qualquer um consegue adivinhar.

const AMBIENTES = Object.freeze(['development', 'test', 'production']);

const NODE_ENV = AMBIENTES.includes(process.env.NODE_ENV) ? process.env.NODE_ENV : 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

// Valores que só existem porque facilitam o desenvolvimento local. Nenhum deles
// pode sobreviver a um deploy.
const PLACEHOLDERS = Object.freeze([
  'development-secret-change-me',
  'change-this-secret-in-production',
  'sandbox-webhook-secret',
  'secret',
  'changeme'
]);

const bool = (valor, padrao = false) => {
  if (valor === undefined || valor === null || valor === '') return padrao;
  return ['1', 'true', 'yes', 'on'].includes(String(valor).toLowerCase());
};

const inteiro = (valor, padrao) => {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n >= 0 ? n : padrao;
};

// Origens liberadas no CORS. Em produção não existe curinga: a lista é
// explícita e vem do ambiente.
const origensPermitidas = () => {
  const bruto = process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:5173';
  return bruto.split(',').map(item => item.trim()).filter(Boolean);
};

const config = Object.freeze({
  env: NODE_ENV,
  isProduction,
  isTest,
  isDevelopment: NODE_ENV === 'development',

  port: inteiro(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
  // O provider do Prisma é declarado no schema; aqui só se registra qual banco
  // a URL aponta, para health check e diagnóstico.
  databaseKind: String(process.env.DATABASE_URL || '').startsWith('postgres') ? 'postgresql' : 'sqlite',

  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  corsOrigins: origensPermitidas(),

  storageDriver: process.env.STORAGE_DRIVER || 'local',
  storageDir: process.env.STORAGE_DIR || null,
  uploadMaxBytes: inteiro(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),

  paymentProvider: process.env.PAYMENT_PROVIDER || 'sandbox',
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'sandbox-webhook-secret',
  allowSandboxPayments: bool(process.env.ALLOW_SANDBOX_PAYMENTS, false),

  rateLimitEnabled: bool(process.env.RATE_LIMIT_ENABLED, isProduction),
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : isProduction ? 'info' : 'debug')
});

// Devolve os problemas em vez de lançar no primeiro, para que o operador veja
// tudo o que falta de uma vez.
function validar(ambiente = config) {
  const problemas = [];

  if (!ambiente.isProduction) return problemas;

  if (!process.env.JWT_SECRET) problemas.push('JWT_SECRET não está definido');
  else if (PLACEHOLDERS.includes(ambiente.jwtSecret)) problemas.push('JWT_SECRET ainda usa o valor de desenvolvimento');
  else if (ambiente.jwtSecret.length < 32) problemas.push('JWT_SECRET deve ter ao menos 32 caracteres');

  if (!process.env.DATABASE_URL) problemas.push('DATABASE_URL não está definido');
  else if (ambiente.databaseKind === 'sqlite') problemas.push('SQLite não é adequado para produção: aponte DATABASE_URL para PostgreSQL');

  if (!process.env.CORS_ORIGINS && !process.env.FRONTEND_URL) {
    problemas.push('CORS_ORIGINS não está definido: a origem do frontend precisa ser explícita');
  }
  if (ambiente.corsOrigins.includes('*')) problemas.push('CORS não pode liberar todas as origens em produção');

  if (ambiente.paymentProvider === 'sandbox' && !ambiente.allowSandboxPayments) {
    problemas.push('PAYMENT_PROVIDER é o de desenvolvimento: configure um provedor real ou assuma ALLOW_SANDBOX_PAYMENTS=true');
  }
  if (PLACEHOLDERS.includes(ambiente.paymentWebhookSecret)) {
    problemas.push('PAYMENT_WEBHOOK_SECRET ainda usa o valor de desenvolvimento');
  }

  return problemas;
}

// Chamado por server.js antes de abrir a porta.
function assertPronto(ambiente = config) {
  const problemas = validar(ambiente);
  if (!problemas.length) return true;
  const lista = problemas.map(item => `  - ${item}`).join('\n');
  throw new Error(`Configuração inválida para produção:\n${lista}`);
}

module.exports = { config, validar, assertPronto, AMBIENTES, PLACEHOLDERS };
