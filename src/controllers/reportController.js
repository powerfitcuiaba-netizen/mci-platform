const service = require('../services/reportService');

module.exports = {
  listAvailable: async (req, res) => res.json(await service.listAvailable(req.user)),
  tournamentReport: async (req, res) => res.json(await service.tournamentReport(req.params.id, req.user))
};
