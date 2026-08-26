const path = require('path');
const crypto = require('crypto');
const { AppError } = require('../utils/errors');
const { config } = require('../config/environment');
const { LocalStorageProvider } = require('./storage/localStorageProvider');

// Fachada de armazenamento. O domínio conversa só com este módulo; qual
// provedor está por baixo — disco local hoje, objeto em nuvem depois — é
// decisão de configuração, não de código de negócio.

const ROOT = path.resolve(config.storageDir || path.join(process.cwd(), 'uploads'));
const MAX_BYTES = config.uploadMaxBytes;

// Lista fechada: o que não está aqui não entra.
const ALLOWED = Object.freeze({
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'text/csv': 'csv'
});

const provedores = new Map([['local', new LocalStorageProvider({ root: ROOT })]]);

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
const extensionFor = mime => ALLOWED[String(mime || '').toLowerCase()] || 'bin';

// A chave é sempre gerada pelo servidor. Nada vindo do cliente compõe o caminho
// de armazenamento: o nome original fica apenas como metadado, para exibição.
function buildKey(scope, mimeType) {
  const escopoSeguro = String(scope || 'geral').replace(/[^a-zA-Z0-9_-]/g, '');
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
  ALLOWED,
  isAllowedMime,
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
