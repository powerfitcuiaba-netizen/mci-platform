// Configuração centralizada e validada na partida. Em produção o processo se
// recusa a subir com segredo de desenvolvimento: é preferível falhar no deploy
// a servir tráfego real com JWT que qualquer um consegue adivinhar.
//
// Não existe variável financeira nesta plataforma. Se alguma aparecer aqui,
// ela é um erro de escopo, não uma funcionalidade.

const AMBIENTES = Object.freeze(['development', 'test', 'production']);

const NODE_ENV = AMBIENTES.includes(process.env.NODE_ENV) ? process.env.NODE_ENV : 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

const PLACEHOLDERS = Object.freeze([
  'development-secret-change-me',
  'change-this-secret-in-production',
  'local-development-secret-not-for-production-use',
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
  databaseUrl: process.env.DATABASE_URL || '',
  databaseKind: String(process.env.DATABASE_URL || '').startsWith('postgres') ? 'postgresql' : 'desconhecido',

  jwtSecret: process.env.JWT_SECRET || 'development-secret-change-me',
  // Sem isto não dá para distinguir "JWT_SECRET ausente" de "JWT_SECRET com o
  // valor de exemplo": os dois chegam aqui como o mesmo texto, e o operador
  // recebe o diagnóstico errado.
  jwtSecretDefinido: Boolean(process.env.JWT_SECRET),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // Custo do bcrypt. Alto por padrão; a suíte de teste reduz para que a
  // verificação de milhares de hashes não domine o tempo de execução.
  bcryptRounds: inteiro(process.env.BCRYPT_ROUNDS, isTest ? 4 : 12),
  // Quantos proxies existem ENTRE o cliente e este processo. O Express usa
  // esse número para descobrir o endereço real dentro de X-Forwarded-For.
  //
  // Errar aqui não dá erro nenhum — só faz o limitador contar o endereço
  // errado. Alto demais, e o cliente escolhe o próprio endereço: foi assim
  // que 60 tentativas de login passaram sem bloqueio no ensaio do gate final.
  // Baixo demais, e todo o tráfego conta como vindo do proxy, transformando o
  // limitador numa negação de serviço geral.
  //
  // 0 = aplicação exposta direto, ninguém à frente. 1 = um proxy (o padrão).
  trustProxyHops: inteiro(process.env.TRUST_PROXY_HOPS, 1),

  corsOrigins: origensPermitidas(),
  corsOriginsDefinido: Boolean(process.env.CORS_ORIGINS || process.env.FRONTEND_URL),

  // Fuso padrão de novas organizações e eventos. Nenhum cálculo do domínio
  // assume fuso fixo: cada evento carrega o seu.
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',

  storageDriver: process.env.STORAGE_DRIVER || 'local',
  // Provedor de objetos. Só é lido quando STORAGE_DRIVER=s3; nenhuma
  // credencial tem valor padrão, de propósito.
  s3: {
    endpoint: process.env.S3_ENDPOINT || '',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, true)
  },
  // Armazenamento em disco do próprio contêiner é adequado apenas quando há
  // volume persistente montado. Sem isso, todo upload — documento de atleta,
  // foto, mídia de mensagem — desaparece no primeiro redeploy. Em produção a
  // escolha precisa ser deliberada, não herdada do padrão de desenvolvimento.
  allowLocalStorage: bool(process.env.ALLOW_LOCAL_STORAGE, false),
  storageDir: process.env.STORAGE_DIR || null,
  uploadMaxBytes: inteiro(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
  mediaMaxBytes: inteiro(process.env.MEDIA_MAX_BYTES, 50 * 1024 * 1024),
  // Foto de perfil tem teto próprio, bem menor: é imagem estática, aparece
  // dezenas de vezes por tela, e 5 MB já é generoso para um avatar.
  avatarMaxBytes: inteiro(process.env.AVATAR_MAX_BYTES, 5 * 1024 * 1024),

  // Duração de um story antes de expirar.
  storyTtlHours: inteiro(process.env.STORY_TTL_HOURS, 24),

  rateLimitEnabled: bool(process.env.RATE_LIMIT_ENABLED, isProduction),
  logLevel: process.env.LOG_LEVEL || (isTest ? 'silent' : isProduction ? 'info' : 'debug')
});

// Devolve os problemas em vez de lançar no primeiro, para que o operador veja
// tudo o que falta de uma vez.
//
// Depende exclusivamente do objeto recebido. Ler process.env aqui dentro faria
// a função julgar um ambiente diferente do que lhe foi entregue — e, quando os
// dois discordassem, ela lançaria TypeError no meio da checagem em vez de
// listar o que está errado. Uma barreira que quebra a caminho do diagnóstico
// não é barreira.
function validar(ambiente = config) {
  const problemas = [];

  if (!ambiente.isProduction) return problemas;

  const jwtSecret = ambiente.jwtSecret || '';
  if (!ambiente.jwtSecretDefinido || !jwtSecret) problemas.push('JWT_SECRET não está definido');
  else if (PLACEHOLDERS.includes(jwtSecret)) problemas.push('JWT_SECRET ainda usa o valor de desenvolvimento');
  else if (jwtSecret.length < 32) problemas.push('JWT_SECRET deve ter ao menos 32 caracteres');

  if (!ambiente.databaseUrl) problemas.push('DATABASE_URL não está definido');
  else if (ambiente.databaseKind !== 'postgresql') problemas.push('DATABASE_URL precisa apontar para PostgreSQL');

  const corsOrigins = ambiente.corsOrigins || [];
  if (!ambiente.corsOriginsDefinido) {
    problemas.push('CORS_ORIGINS não está definido: a origem do frontend precisa ser explícita');
  }
  if (corsOrigins.includes('*')) problemas.push('CORS não pode liberar todas as origens em produção');

  // Comparação afirmativa de propósito: `undefined < 10` é falso, e a checagem
  // escrita ao contrário deixaria passar justamente o ambiente sem a variável.
  if (!(ambiente.bcryptRounds >= 10)) problemas.push('BCRYPT_ROUNDS abaixo de 10 é fraco demais para produção');

  if (ambiente.storageDriver === 's3') {
    const faltando = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']
      .filter(campo => !ambiente.s3?.[campo]);
    if (faltando.length) {
      problemas.push(`STORAGE_DRIVER=s3 exige ${faltando.map(c => `S3_${c.replace(/([A-Z])/g, '_$1').toUpperCase()}`).join(', ')}`);
    }
  }

  // Falha fechada: subir com disco efêmero perde arquivo de atleta em
  // silêncio, e a perda só aparece quando alguém vai buscar o documento.
  if (ambiente.storageDriver === 'local' && !ambiente.allowLocalStorage) {
    problemas.push(
      'STORAGE_DRIVER=local grava no disco do contêiner: sem volume persistente, todo upload se perde no redeploy. '
      + 'Configure um provedor de objetos ou assuma o risco com ALLOW_LOCAL_STORAGE=true'
    );
  }

  return problemas;
}

function assertPronto(ambiente = config) {
  const problemas = validar(ambiente);
  if (!problemas.length) return true;
  const lista = problemas.map(item => `  - ${item}`).join('\n');
  throw new Error(`Configuração inválida para produção:\n${lista}`);
}

module.exports = { config, validar, assertPronto, AMBIENTES, PLACEHOLDERS };
