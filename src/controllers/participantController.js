const service = require('../services/participantService');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.create(req.body)),
  list: async (req, res) => res.json(await service.list(req.query.type)),
  findById: async (req, res) => res.json(await service.findById(req.params.id)),
  update: async (req, res) => res.json(await service.update(req.params.id, req.body)),
  delete: async (req, res) => { await service.delete(req.params.id); res.status(204).send(); }
};