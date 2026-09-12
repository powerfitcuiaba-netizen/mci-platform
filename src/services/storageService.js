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
const MAX_AVATAR_BYTES = config.avatarMaxBytes;

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

// Foto de perfil é imagem estática, e só. Vídeo e GIF ficam de fora: o avatar
// aparece dezenas de vezes numa mesma tela — no feed, nos comentários, na lista
// de conversas — e um GIF animado por linha transforma a rolagem em travamento.
// A lista é separada de ALLOWED_MEDIA de propósito, pela mesma razão que
// documento não abre caminho para vídeo.
const ALLOWED_AVATAR = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
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
const isAllowedAvatarMime = mime => Object.prototype.hasOwnProperty.call(ALLOWED_AVATAR, String(mime || '').toLowerCase());
const extensionFor = mime => {
  const normalizado = String(mime || '').toLowerCase();
  return ALLOWED[normalizado] || ALLOWED_MEDIA[normalizado] || ALLOWED_AVATAR[normalizado] || 'bin';
};

// ---------------------------------------------------------------- assinatura
//
// O TIPO REAL VEM DOS BYTES, NUNCA DO RÓTULO.
//
// `isAllowedMime` responde sobre o `Content-Type` que o CLIENTE declarou no
// multipart. Sozinha, ela deixa passar qualquer coisa: dizer "image/png" e
// enviar HTML, SVG ou um executável atravessava a lista fechada sem obstáculo
// — medido, cinco envios maliciosos devolviam 201.
//
// Não era XSS armazenado: a entrega manda `X-Content-Type-Options: nosniff`
// com o tipo declarado, e o navegador se recusa a interpretar o HTML. O que
// faltava era a barreira em si — bytes arbitrários entrando no armazenamento
// sob rótulo de imagem.
//
// SVG está fora da lista de aceitos de propósito, e continua fora: é XML que
// executa script, e nenhuma das telas do MCI precisa dele.
const ASSINATURAS = Object.freeze({
  'image/png': buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': buffer => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  'image/gif': buffer => ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('latin1')),
  // WebP é um contêiner RIFF: "RIFF" nos bytes 0-3 e "WEBP" nos 8-11.
  'image/webp': buffer => buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'WEBP',
  // MP4 e MOV são ISO-BMFF: o átomo `ftyp` começa no byte 4. A marca em 8-11
  // distingue as variantes, e não é usada aqui porque ambas são aceitas.
  'video/mp4': buffer => buffer.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/quicktime': buffer => buffer.subarray(4, 8).toString('latin1') === 'ftyp',
  'video/webm': buffer => buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  'application/pdf': buffer => buffer.subarray(0, 5).toString('latin1') === '%PDF-'
});

// Formatos sem assinatura própria (texto). Não dá para confirmá-los por bytes
// iniciais, então a verificação é pela negativa: não podem SER outra coisa
// conhecida, e precisam ser texto de verdade.
const BINARIOS_CONHECIDOS = Object.freeze([
  { nome: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { nome: 'ZIP/Office', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { nome: 'PE/EXE', bytes: [0x4d, 0x5a] },
  { nome: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { nome: 'GZIP', bytes: [0x1f, 0x8b] }
]);

const comecaCom = (buffer, bytes) => buffer.subarray(0, bytes.length).equals(Buffer.from(bytes));

function ehTextoPlausivel(buffer) {
  const amostra = buffer.subarray(0, 4096);
  // Byte nulo não existe em texto; é o sinal mais barato de binário disfarçado.
  if (amostra.includes(0)) return false;
  return amostra.toString('utf8').includes('\ufffd') === false;
}

// Marcação que um navegador poderia interpretar se algum dia o tipo declarado
// mudasse. Recusada mesmo em text/plain: não há caso de uso no MCI.
const PARECE_MARCACAO = /^\s*(<\?xml|<!doctype|<html|<svg|<script)/i;

/**
 * Confere se os BYTES correspondem ao tipo declarado.
 * Devolve null quando está tudo certo, ou o motivo da recusa.
 */
function motivoDeRecusaPorAssinatura(mimeType, buffer) {
  const tipo = String(mimeType || '').toLowerCase();
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'arquivo vazio';

  for (const { nome, bytes } of BINARIOS_CONHECIDOS) {
    if (comecaCom(buffer, bytes)) return `o conteúdo é um arquivo ${nome}, não ${tipo}`;
  }

  const conferir = ASSINATURAS[tipo];
  if (conferir) {
    if (PARECE_MARCACAO.test(buffer.subarray(0, 64).toString('latin1'))) {
      return `o conteúdo é marcação (HTML/XML/SVG), não ${tipo}`;
    }
    return conferir(buffer) ? null : `o conteúdo não corresponde a ${tipo}`;
  }

  // Sem assinatura conhecida: só os formatos de texto chegam aqui.
  if (!ehTextoPlausivel(buffer)) return `o conteúdo não é texto, ao contrário do declarado (${tipo})`;
  if (PARECE_MARCACAO.test(buffer.subarray(0, 64).toString('latin1'))) {
    return `o conteúdo é marcação (HTML/XML/SVG), não ${tipo}`;
  }
  if (tipo === 'application/json') {
    try { JSON.parse(buffer.toString('utf8')); } catch { return 'o conteúdo não é JSON válido'; }
  }
  return null;
}

const assinaturaConfere = (mimeType, buffer) => motivoDeRecusaPorAssinatura(mimeType, buffer) === null;

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
  MAX_AVATAR_BYTES,
  ALLOWED_AVATAR,
  isAllowedAvatarMime,
  assinaturaConfere,
  motivoDeRecusaPorAssinatura,
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
