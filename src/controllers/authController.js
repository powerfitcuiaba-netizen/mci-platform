const service = require('../services/authService');

module.exports = {
  register: async (req, res) => res.status(201).json(await service.register(req.body)),
  login: async (req, res) => res.json(await service.login(req.body)),
  me: async (req, res) => res.json(await service.me(req.user.id))
};
