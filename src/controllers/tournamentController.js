const service = require('../services/tournamentService');
const { forViewer } = require('../utils/visibility');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.create(req.body, req.user)),
  list: async (req, res) => res.json(forViewer(await service.list(), req.user)),
  findById: async (req, res) => res.json(forViewer(await service.findById(req.params.id), req.user)),
  update: async (req, res) => res.json(await service.update(req.params.id, req.body, req.user)),
  delete: async (req, res) => { await service.delete(req.params.id, req.user); res.status(204).send(); }
};
