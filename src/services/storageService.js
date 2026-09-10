const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');
const { LocalStorageProvider } = require('./storage/localStorageProvider');
const { S3StorageProvider } = require('./storage/s3StorageProvider');

// Fachada de armazenamento. O domínio conversa só com este módulo; qual
// provedor está por baixo — disco local hoje, objeto em nuvem depois — é
// decisão de configuração, não de código de negócio.

const ROOT = path.resolve(config.storageDir || path.join(process.cwd(), 'uploads'));
const MAX_BYTES = config.uploadMaxBytes;
const MAX_MEDIA_BYTES = config.mediaMaxBytes;

// Lista fechada: o que não está aqui não entra.
const ALLOWED = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json'
});

// Mídia social e de mensagem aceita vídeo, que documento não aceita. As duas
// listas são separadas de propósito: um anexo de inscrição não deveria abrir
// caminho para upload de vídeo.
const ALLOWED_MEDIA = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov'
});

const provedores = new Map([['local', new LocalStorageProvider({ root: ROOT })]]);

// O provedor de objetos só é construído quando escolhido: sem credencial no
// ambiente, instanciá-lo lançaria — e um deploy que usa disco local não tem
// por que falhar por causa de configuração que não usa.
if (config.storageDriver === 's3') {
  provedores.set('s3', new S3StorageProvider(config.s3));
}

function resolverProvedor() {
  const escolhido = config.storageDriver || 'local';
  const provider = provedores.get(escolhido);
  if (!provider) {
    throw new AppError(500, 'STORAGE_NOT_CONFIGURED', `Provedor de armazenamento desconhecido: ${escolhido}`);
  }
  return provider;
}

// Um provedor de nuvem se registra aqui e passa a ser selecionável por
// STORAGE_DRIVER, sem que nenhum service precise saber disso.
const registerProvider = provider => provedores.set(provider.name, provider);

const isAllowedMime = mime => Object.prototype.hasOwnProperty.call(ALLOWED, String(mime || '').toLowerCase());
const isAllowedMediaMime = mime => Object.prototype.hasOwnProperty.call(ALLOWED_MEDIA, String(mime || '').toLowerCase());
const extensionFor = mime => {
  const normalizado = String(mime || '').toLowerCase();
  return ALLOWED[normalizado] || ALLOWED_MEDIA[normalizado] || 'bin';
};

// A chave é sempre gerada pelo servidor. Nada vindo do cliente compõe o caminho
// de armazenamento: o nome original fica apenas como metadado, para exibição.
//
// A limpeza é por SEGMENTO, e não sobre a string inteira. A versão anterior
// apagava todo caractere fora de [A-Za-z0-9_-] de uma vez — inclusive a barra
// que os chamadores passam de propósito. `events/<id>` virava `events<id>`, e
// o bucket terminava com uma pasta por evento no nível raiz em vez das árvores
// `events/` e `athletes/`. Segurança não mudava; o que se perdia era a
// possibilidade de escrever regra de ciclo de vida ou política de acesso por
// prefixo no provedor de objetos, que é justamente o que o runbook recomenda.
//
// A barreira continua igual de rígida: cada segmento perde tudo que não seja
// letra, dígito, `_` ou `-`, então `..` e `.` viram vazio e somem no filtro.
// Não existe entrada capaz de produzir `..` no caminho.
function buildKey(scope, mimeType) {
  const escopoSeguro = String(scope || '')
    .split('/')
    .map(parte => parte.replace(/[^a-zA-Z0-9_-]/g, ''))
    .filter(Boolean)
    .join('/');
  return `${escopoSeguro || 'geral'}/${crypto.randomUUID()}.${extensionFor(mimeType)}`;
}

const resolveKey = key => resolverProvedor().resolveKey(key);
const saveBuffer = (key, buffer) => resolverProvedor().saveBuffer(key, buffer);
const saveStream = (key, readable) => resolverProvedor().saveStream(key, readable);
const createReadStream = key => resolverProvedor().createReadStream(key);
const exists = key => resolverProvedor().exists(key);
const remove = key => resolverProvedor().remove(key);
const stat = key => resolverProvedor().stat(key);
const healthCheck = () => resolverProvedor().healthCheck();
const driver = () => resolverProvedor().name;

module.exports = {
  ROOT,
  MAX_BYTES,
  MAX_MEDIA_BYTES,
  ALLOWED,
  ALLOWED_MEDIA,
  isAllowedMime,
  isAllowedMediaMime,
  extensionFor,
  buildKey,
  resolveKey,
  saveBuffer,
  saveStream,
  createReadStream,
  exists,
  remove,
  stat,
  healthCheck,
  driver,
  registerProvider
};
