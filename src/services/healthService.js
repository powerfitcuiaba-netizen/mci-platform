const prisma = require('../config/prisma');
const storage = require('./storageService');
const { config } = require('../config/environment');

// /health responde se o processo está de pé. /ready responde se ele consegue
// atender: banco alcançável e armazenamento gravável. Um orquestrador precisa
// distinguir as duas coisas.

function health() {
  return { status: 'ok', env: config.env, uptimeSeconds: Math.round(process.uptime()) };
}

async function ready() {
  const verificacoes = { database: false, storage: false };

  try {
    await prisma.$queryRaw`SELECT 1`;
    verificacoes.database = true;
  } catch (error) {
    verificacoes.database = false;
  }

  try {
    verificacoes.storage = await storage.healthCheck();
  } catch (error) {
    verificacoes.storage = false;
  }

  const pronto = Object.values(verificacoes).every(Boolean);
  return { ready: pronto, checks: verificacoes, databaseKind: config.databaseKind, storageDriver: config.storageDriver };
}

module.exports = { health, ready };
