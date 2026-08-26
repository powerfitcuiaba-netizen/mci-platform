const service = require('../services/enrollmentService');
const { forViewer } = require('../utils/visibility');

module.exports = {
  create: async (req, res) => res.status(201).json(await service.enroll(req.params.id, req.body.participantId, req.user)),
  list: async (req, res) => res.json(forViewer(await service.list(req.params.id, { incluirCanceladas: req.query.incluirCanceladas === 'true' }), req.user)),
  cancel: async (req, res) => res.json(await service.cancel(req.params.id, req.user))
};
