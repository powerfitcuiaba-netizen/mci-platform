const service = require('../services/auditService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.query, req.user))
};
