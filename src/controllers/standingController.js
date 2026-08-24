const service = require('../services/standingService');

module.exports = { list: async (req, res) => res.json(await service.list(req.params.id)) };