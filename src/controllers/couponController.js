const service = require('../services/couponService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user)),
  create: async (req, res) => res.status(201).json(await service.create(req.body, req.user)),
  setActive: async (req, res) => res.json(await service.setActive(req.params.id, req.body.active, req.user)),
  preview: async (req, res) => res.json(await service.preview({
    code: req.body.code,
    tournamentId: req.body.tournamentId,
    userId: req.user.id
  }))
};
