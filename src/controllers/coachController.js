const service = require('../services/coachService');

module.exports = {
  overview: async (req, res) => res.json(await service.overview(req.user)),
  listTeams: async (req, res) => res.json(await service.listTeams(req.user)),
  listAthletes: async (req, res) => res.json(await service.listAthletes(req.user)),
  setTeam: async (req, res) => res.json(await service.setTeam(req.params.id, req.body.teamId ?? null, req.user))
};
