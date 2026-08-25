const service = require('../services/orderService');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.create({ ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey }, req.user)),
  list: async (req, res) => res.json(await service.list(req.user, req.query)),
  findById: async (req, res) => res.json(await service.findById(req.params.id, req.user)),
  cancel: async (req, res) => res.json(await service.cancel(req.params.id, req.user))
};
