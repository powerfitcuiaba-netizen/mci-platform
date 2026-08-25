const service = require('../services/profileService');

module.exports = {
  me: async (req, res) => res.json(await service.me(req.user.id)),
  update: async (req, res) => res.json(await service.updateProfile(req.user.id, req.body, req.user)),
  changePassword: async (req, res) => res.json(await service.changePassword(req.user.id, req.body, req.user))
};
