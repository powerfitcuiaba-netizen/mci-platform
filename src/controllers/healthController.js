const service = require('../services/healthService');

module.exports = {
  health: async (req, res) => res.json(service.liveness()),
  ready: async (req, res) => {
    const { pronto, corpo } = await service.readiness();
    res.status(pronto ? 200 : 503).json(corpo);
  }
};
