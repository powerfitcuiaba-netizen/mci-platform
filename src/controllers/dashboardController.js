const service = require('../services/dashboardService');

module.exports = {
  summary: async (req, res) => res.json(await service.summary(req.user))
};
