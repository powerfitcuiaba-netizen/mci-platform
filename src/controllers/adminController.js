const service = require('../services/adminService');

module.exports = {
  overview: async (req, res) => res.json(await service.overview(req.user)),
  listUsers: async (req, res) => res.json(await service.listUsers(req.query, req.user)),
  findUser: async (req, res) => res.json(await service.findUser(req.params.id, req.user)),
  updateUser: async (req, res) => res.json(await service.updateUser(req.params.id, req.body, req.user))
};
