const service = require('../services/resultService');

module.exports = {
	findByMatchId: async (req, res) => res.json(await service.findByMatchId(req.params.id)),
	create: async (req, res) => res.status(201).json(await service.create(req.params.id, req.body, req.user)),
	update: async (req, res) => res.json(await service.update(req.params.id, req.body, req.user))
};