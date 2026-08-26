const service = require('../services/checkinService');

module.exports = {
  listByTournament: async (req, res) => res.json(await service.listByTournament(req.params.id, req.user, req.query.search)),
  getByEnrollment: async (req, res) => res.json(await service.getByEnrollment(req.params.id, req.user)),
  checkIn: async (req, res) => res.status(201).json(await service.checkIn(req.params.id, req.body, req.user)),
  cancel: async (req, res) => res.json(await service.cancel(req.params.id, req.user))
};
