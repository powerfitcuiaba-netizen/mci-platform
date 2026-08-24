const service = require('../services/tournamentService');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.create(req.body, req.user)),
  list: async (req, res) => res.json(await service.list()),
  findById: async (req, res) => res.json(await service.findById(req.params.id)),
  update: async (req, res) => res.json(await service.update(req.params.id, req.body, req.user)),
  delete: async (req, res) => { await service.delete(req.params.id, req.user); res.status(204).send(); }
};