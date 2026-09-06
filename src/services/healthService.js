const prisma = require('../config/prisma');
const storage = require('./storageService');
const { config } = require('../config/environment');
const { inspecionar } = require('../config/rlsGuard');

// /health responde se o processo está de pé. /ready responde se ele consegue
// atender: banco alcançável e armazenamento gravável. Um orquestrador precisa
// distinguir as duas coisas.

function health() {
  return { status: 'ok', env: config.env, uptimeSeconds: Math.round(process.uptime()) };
}

async function ready() {
  const verificacoes = { database: false, storage: false, rls: false };
  let diagnosticoRls = null;

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

  // O processo já recusa subir em produção sem RLS efetivo, mas o estado pode
  // mudar debaixo dele: basta alguém conceder SUPERUSER ao papel ou tirar o
  // FORCE de uma tabela. Enquanto isso valer, a instância não deve receber
  // tráfego — daí a sonda reprovar, e não apenas informar.
  try {
    const estado = await inspecionar();
    verificacoes.rls = estado.ok;
    if (!estado.ok) diagnosticoRls = estado.problemas;
  } catch (error) {
    verificacoes.rls = false;
    diagnosticoRls = ['não foi possível conferir o RLS'];
  }

  const pronto = Object.values(verificacoes).every(Boolean);
  return {
    ready: pronto,
    checks: verificacoes,
    databaseKind: config.databaseKind,
    storageDriver: config.storageDriver,
    ...(diagnosticoRls ? { rls: diagnosticoRls } : {})
  };
}

module.exports = { health, ready };
