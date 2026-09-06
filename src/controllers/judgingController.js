const service = require('../services/judgingService');

module.exports = {
  registrarNota: async (req, res) => res.status(201).json(await service.registrarNota(req.params.id, req.body, req.user)),
  minhasNotas: async (req, res) => res.json(await service.minhasNotas(req.params.id, req.user)),
  apurar: async (req, res) => res.json(await service.apurar(req.params.id, req.user)),
  transitar: async (req, res) => res.json(await service.transitar(req.params.id, req.body.status, req.user, { motivo: req.body.motivo })),
  publicar: async (req, res) => res.json(await service.publicar(req.params.id, req.user)),
  resultadoDaCategoria: async (req, res) => res.json(await service.consultarPorCategoria(req.params.id, req.user))
};
