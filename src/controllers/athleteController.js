const service = require('../services/athleteService');

module.exports = {
  overview: async (req, res) => res.json(await service.overview(req.user))
};
