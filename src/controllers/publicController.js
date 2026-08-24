const service = require('../services/publicService');

module.exports = {
  summary: async (req, res) => res.json(await service.summary())
};
