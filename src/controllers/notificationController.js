const service = require('../services/notificationService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user.id)),
  markRead: async (req, res) => res.json(await service.markRead(req.params.id, req.user.id)),
  markAllRead: async (req, res) => res.json(await service.markAllRead(req.user.id))
};
