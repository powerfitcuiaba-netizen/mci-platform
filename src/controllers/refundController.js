const service = require('../services/refundService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user, req.query)),
  request: async (req, res) => res.status(201).json(await service.request(req.params.id, req.body, req.user))
};
