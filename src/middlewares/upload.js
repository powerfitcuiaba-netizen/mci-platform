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
// `tipo` decide a lista de tipos aceitos: documento não abre caminho para
// vídeo, e mídia social não abre caminho para PDF. As duas listas são
// separadas de propósito.
// `arquivoObrigatorio: false` NÃO afrouxa nada — muda QUEM diz a frase.
//
// A ausência de arquivo tem mensagem de PRODUTO em algumas rotas ("O envio de uma
// foto de perfil é obrigatório para concluir seu cadastro e aparecer no ranking
// oficial de treinadores."), decidida pelo negócio e escrita num lugar só, no
// serviço. Com a recusa aqui, o cliente receberia "Nenhum arquivo foi enviado" e
// a frase combinada nunca sairia.
//
// Então, com a opção desligada, este middleware deixa passar DOIS casos e só
// eles: corpo sem arquivo e corpo que não é multipart (JSON, tipicamente uma
// chamada direta à API). Nos dois, `req.file` fica nulo e o serviço recusa — que
// é o mesmo caminho para qualquer chamador, e por isso não há como contornar.
// Tudo o mais continua igual: teto de bytes, lista de tipos e a conferência da
// ASSINATURA dos bytes seguem aqui e seguem recusando.
function singleFileUpload(fieldName = 'file', { maxBytes = storage.MAX_BYTES, tipo = 'documento', arquivoObrigatorio = true } = {}) {
  const LISTAS = {
    midia: [storage.isAllowedMediaMime, storage.ALLOWED_MEDIA],
    avatar: [storage.isAllowedAvatarMime, storage.ALLOWED_AVATAR],
    documento: [storage.isAllowedMime, storage.ALLOWED]
  };
  const [aceita, tabela] = LISTAS[tipo] || LISTAS.documento;
  const aceitos = () => Object.keys(tabela).join(', ');

  return (req, res, next) => {
    const tipo = String(req.headers['content-type'] || '');
    if (!tipo.toLowerCase().startsWith('multipart/form-data')) {
      // Sem arquivo e sem obrigatoriedade aqui: segue com `req.file` nulo, e quem
      // recusa é o serviço, com a mensagem do produto. `req.body` continua o que
      // o parser de JSON já montou.
      if (!arquivoObrigatorio) {
        req.file = null;
        req.uploadedFile = null;
        return next();
      }
      return next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Envie o arquivo como multipart/form-data'));
    }

    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes, fields: 20 } });
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
        const limiteMb = Math.round(maxBytes / (1024 * 1024));
        return encerrar(new AppError(413, 'FILE_TOO_LARGE', `Arquivo excede o limite de ${limiteMb} MB`));
      }
      if (!arquivo || !arquivo.buffer.length) {
        if (!arquivoObrigatorio) {
          req.body = { ...campos };
          req.file = null;
          req.uploadedFile = null;
          finalizado = true;
          return next();
        }
        return encerrar(new AppError(422, 'FILE_REQUIRED', 'Nenhum arquivo foi enviado'));
      }
      if (!aceita(arquivo.mimeType)) {
        return encerrar(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Tipo não aceito. Aceitos: ${aceitos()}`));
      }

      // A lista acima julga o RÓTULO que o cliente mandou. Esta segunda guarda
      // julga os BYTES: sem ela, dizer "image/png" e enviar HTML, SVG ou um
      // executável atravessava a lista fechada sem obstáculo nenhum.
      const motivo = storage.motivoDeRecusaPorAssinatura(arquivo.mimeType, arquivo.buffer);
      if (motivo) {
        return encerrar(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', `Arquivo recusado: ${motivo}`));
      }

      req.body = { ...campos };
      // `req.file` é o nome que os controllers usam; `req.uploadedFile` fica
      // como alias para não quebrar quem já dependia dele.
      req.file = arquivo;
      req.uploadedFile = arquivo;
      finalizado = true;
      next();
    });

    req.pipe(busboy);
  };
}

module.exports = { singleFileUpload };
