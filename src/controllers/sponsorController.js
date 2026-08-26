const service = require('../services/sponsorService');

module.exports = {
  listSponsors: async (req, res) => res.json(await service.listSponsors(req.user)),
  createSponsor: async (req, res) => res.status(201).json(await service.createSponsor(req.body, req.user)),
  listSponsorships: async (req, res) => res.json(await service.listSponsorships(req.user, req.query)),
  createSponsorship: async (req, res) => res.status(201).json(await service.createSponsorship(req.body, req.user))
};
