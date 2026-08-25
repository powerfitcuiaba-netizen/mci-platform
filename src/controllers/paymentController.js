const service = require('../services/paymentService');

module.exports = {
  start: async (req, res) => res.status(201).json(await service.start(req.params.id, { ...req.body, idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey }, req.user)),
  listByOrder: async (req, res) => res.json(await service.listByOrder(req.params.id, req.user)),
  webhook: async (req, res) => {
    // A assinatura é conferida sobre o corpo cru: qualquer reserialização
    // mudaria os bytes e invalidaria o HMAC.
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const resultado = await service.handleWebhook({ rawBody, headers: req.headers, providerName: req.params.provider });
    res.status(200).json(resultado);
  }
};
