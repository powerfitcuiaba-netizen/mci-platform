const service = require('../services/judgeService');

module.exports = {
  listMatches: async (req, res) => res.json(await service.listMatches(req.user)),
  listAssignments: async (req, res) => res.json(await service.listAssignments(req.user)),
  assign: async (req, res) => res.status(201).json(await service.assign(req.body, req.user))
};
