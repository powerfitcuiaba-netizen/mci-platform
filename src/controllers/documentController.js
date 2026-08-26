const service = require('../services/documentService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user, req.query.tournamentId)),
  create: async (req, res) => res.status(201).json(await service.create(req.body, req.user)),
  upload: async (req, res) => res.status(201).json(await service.createWithFile(req.body, req.uploadedFile, req.user)),
  findById: async (req, res) => res.json(await service.findById(req.params.id, req.user)),
  download: async (req, res) => {
    const arquivo = await service.download(req.params.id, req.user);
    res.setHeader('Content-Type', arquivo.mimeType);
    res.setHeader('Content-Length', arquivo.sizeBytes);
    // filename* (RFC 5987) com percent-encoding: aspas e quebras de linha ficam
    // codificadas, então o nome do arquivo não consegue encerrar o cabeçalho.
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(arquivo.fileName)}`);
    // Conteúdo enviado por usuários nunca deve ser interpretado pelo navegador.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    arquivo.stream.on('error', () => res.destroy());
    arquivo.stream.pipe(res);
  },
  delete: async (req, res) => { await service.remove(req.params.id, req.user); res.status(204).send(); }
};
