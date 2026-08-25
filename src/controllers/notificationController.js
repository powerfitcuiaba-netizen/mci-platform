const service = require('../services/notificationService');

module.exports = {
  list: async (req, res) => res.json(await service.list(req.user.id, { onlyUnread: req.query.onlyUnread === 'true', limit: req.query.limit })),
  markRead: async (req, res) => res.json(await service.markRead(req.params.id, req.user.id)),
  markAllRead: async (req, res) => res.json(await service.markAllRead(req.user.id))
};
