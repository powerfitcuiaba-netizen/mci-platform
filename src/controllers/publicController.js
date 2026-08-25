const service = require('../services/publicService');

module.exports = {
  summary: async (req, res) => res.json(await service.summary()),
  listTournaments: async (req, res) => res.json(await service.listTournaments()),
  tournamentDetail: async (req, res) => res.json(await service.tournamentDetail(req.params.id)),
  live: async (req, res) => res.json(await service.live()),
  listAthletes: async (req, res) => res.json(await service.listAthletes()),
  athleteDetail: async (req, res) => res.json(await service.athleteDetail(req.params.id)),
  listTeams: async (req, res) => res.json(await service.listTeams()),
  teamDetail: async (req, res) => res.json(await service.teamDetail(req.params.id))
};
