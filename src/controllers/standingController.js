const service = require('../services/standingService');
const { forViewer } = require('../utils/visibility');

module.exports = { list: async (req, res) => res.json(forViewer(await service.list(req.params.id), req.user)) };
