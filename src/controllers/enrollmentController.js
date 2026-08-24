const service = require('../services/enrollmentService');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.enroll(req.params.id, req.body.participantId)),
  list: async (req, res) => res.json(await service.list(req.params.id))
};