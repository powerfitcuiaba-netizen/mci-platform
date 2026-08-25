const Busboy = require('busboy');
const { AppError } = require('../utils/errors');
const storage = require('../services/storageService');

// Lê um envio multipart em memória, com teto de tamanho aplicado pelo próprio
// parser. O arquivo só chega ao disco depois que o service confirma que o
// usuário pode gravar naquele campeonato — assim uma requisição não autorizada
// nunca deixa resíduo em uploads/.
//
// O buffer é adequado ao tamanho previsto aqui (10 MB por padrão). Para
// arquivos grandes, o caminho é trocar por gravação em stream num temporário,
// que o storageService já suporta.
function singleFileUpload(fieldName = 'file') {
  return (req, res, next) => {
    const tipo = String(req.headers['content-type'] || '');
    if (!tipo.toLowerCase().startsWith('multipart/form-data')) {
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o arquivo como multipart/form-data'));
    }

    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: storage.MAX_BYTES, fields: 20 } });
    } catch (error) {
      return next(new AppError(400, 'INVALID_UPLOAD', 'Envio malformado'));
    }

    const campos = {};
    let arquivo = null;
    let excedeuTamanho = false;
    let finalizado = false;

    const encerrar = erro => {
      if (finalizado) return;
      finalizado = true;
      req.unpipe(busboy);
      next(erro);
    };

    busboy.on('field', (nome, valor) => { campos[nome] = valor; });

    busboy.on('file', (nome, stream, info) => {
      if (nome !== fieldName) {
        stream.resume();
        return;
      }

      const pedacos = [];
      stream.on('data', pedaco => pedacos.push(pedaco));
      stream.on('limit', () => { excedeuTamanho = true; stream.resume(); });
      stream.on('end', () => {
        if (excedeuTamanho) return;
        arquivo = {
          fieldName: nome,
          originalName: info.filename || '',
          mimeType: info.mimeType || 'application/octet-stream',
          buffer: Buffer.concat(pedacos)
        };
      });
    });

    busboy.on('error', () => encerrar(new AppError(400, 'INVALID_UPLOAD', 'Falha ao ler o envio')));

    busboy.on('close', () => {
      if (finalizado) return;

      if (excedeuTamanho) {
        const limiteMb = Math.round(storage.MAX_BYTES / (1024 * 1024));
        return encerrar(new AppError(413, 'FILE_TOO_LARGE', `Arquivo excede o limite de ${limiteMb} MB`));
      }
      if (!arquivo || !arquivo.buffer.length) {
        return encerrar(new AppError(422, 'FILE_REQUIRED', 'Nenhum arquivo foi enviado'));
      }
      if (!storage.isAllowedMime(arquivo.mimeType)) {
        const aceitos = Object.keys(storage.ALLOWED).join(', ');
        return encerrar(new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Tipo não aceito. Aceitos: ${aceitos}`));
      }

      req.body = { ...campos };
      req.uploadedFile = arquivo;
      finalizado = true;
      next();
    });

    req.pipe(busboy);
  };
}

module.exports = { singleFileUpload };
