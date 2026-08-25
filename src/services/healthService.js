const prisma = require('../config/prisma');
const { config, validar } = require('../config/environment');
const storage = require('./storageService');

// Sondas de infraestrutura. Ficam num service para que o controller continue
// sem tocar no Prisma, como o resto da aplicação.

const inicio = Date.now();

const liveness = () => ({
  status: 'ok',
  env: config.env,
  uptimeSeconds: Math.floor((Date.now() - inicio) / 1000),
  timestamp: new Date().toISOString()
});

async function readiness() {
  const checks = {};

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database = { status: 'ok', kind: config.databaseKind };
  } catch (error) {
    checks.database = { status: 'error', kind: config.databaseKind };
  }

  try {
    checks.storage = { status: (await storage.healthCheck()) ? 'ok' : 'error', driver: storage.driver() };
  } catch (error) {
    checks.storage = { status: 'error', driver: config.storageDriver };
  }

  // Em produção, configuração incompleta impede a instância de se declarar
  // pronta — a resposta diz quantos problemas existem, nunca quais valores.
  const problemas = validar();
  checks.configuration = { status: problemas.length ? 'error' : 'ok', issues: problemas.length };

  const pronto = Object.values(checks).every(item => item.status === 'ok');
  return { pronto, corpo: { status: pronto ? 'ready' : 'not-ready', checks, timestamp: new Date().toISOString() } };
}

module.exports = { liveness, readiness };
