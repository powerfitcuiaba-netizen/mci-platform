const service = require('../services/resultService');

module.exports = { create: async (req, res) => res.status(201).json(await service.create(req.params.id, req.body)) };