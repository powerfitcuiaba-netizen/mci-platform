const service = require('../services/documentService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user, req.query.tournamentId)),
  create: async (req, res) => res.status(201).json(await service.create(req.body, req.user)),
  findById: async (req, res) => res.json(await service.findById(req.params.id, req.user)),
  delete: async (req, res) => { await service.remove(req.params.id, req.user); res.status(204).send(); }
};
