const service = require('../services/backstageService');

module.exports = {
  overview: async (req, res) => res.json(await service.overview(req.user))
};
