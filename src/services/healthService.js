const prisma = require('../config/prisma');
const storage = require('./storageService');
const { config } = require('../config/environment');
const { inspecionar } = require('../config/rlsGuard');

// /health responde se o processo está de pé. /ready responde se ele consegue
// atender: banco alcançável e armazenamento gravável. Um orquestrador precisa
// distinguir as duas coisas.

// Traduz a falha para quem está olhando a sonda de fora, sem publicar segredo.
// O mapeamento existe porque o número sozinho não diz o que fazer: 403 manda
// conferir credencial e permissão do token; 404 manda conferir o nome do
// bucket; 5xx é indisponibilidade do provedor, e não há o que corrigir aqui.
const EXPLICACAO_POR_STATUS = {
  400: 'requisição recusada pelo serviço — confira endpoint, região e estilo de caminho',
  401: 'credencial não autenticada — confira S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY',
  403: 'credencial recusada ou sem permissão no bucket — confira o par de chaves e o escopo do token',
  404: 'recurso não encontrado — confira S3_BUCKET e o endpoint da conta'
};

function descreverFalhaDeStorage(error) {
  const status = error?.diagnosticoStorage?.statusHttp ?? null;
  const codigo = error?.diagnosticoStorage?.codigoS3 ?? null;

  if (!status) {
    // Sem resposta HTTP: não chegou a falar com o serviço.
    return 'o armazenamento não respondeu (rede, DNS ou endpoint inalcançável)';
  }

  const explicacao = EXPLICACAO_POR_STATUS[status]
    || (status >= 500 ? 'o serviço de armazenamento está indisponível' : 'resposta inesperada do armazenamento');

  return `o armazenamento respondeu ${status}${codigo ? ` (${codigo})` : ''}: ${explicacao}`;
}

function health() {
  return { status: 'ok', env: config.env, uptimeSeconds: Math.round(process.uptime()) };
}

async function ready() {
  const verificacoes = { database: false, storage: false, rls: false };
  let diagnosticoRls = null;
  let diagnosticoStorage = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    verificacoes.database = true;
  } catch (error) {
    verificacoes.database = false;
  }

  // O RLS, logo abaixo, sempre explicou a própria reprovação. O armazenamento
  // não: o erro era descartado aqui e sobrava um `storage: false` que não dizia
  // se a credencial foi recusada, se o bucket não existe ou se a rede caiu.
  // Diagnosticar isso exigia acesso ao servidor; agora a sonda basta.
  //
  // O que sai é o status HTTP e o `<Code>` do serviço — nunca o corpo bruto da
  // resposta, porque /ready é PÚBLICO e erro de credencial em S3 devolve a
  // Access Key dentro do XML.
  try {
    verificacoes.storage = await storage.healthCheck();
  } catch (error) {
    verificacoes.storage = false;
    diagnosticoStorage = [descreverFalhaDeStorage(error)];
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
    ...(diagnosticoRls ? { rls: diagnosticoRls } : {}),
    ...(diagnosticoStorage ? { storage: diagnosticoStorage } : {})
  };
}

module.exports = { health, ready };
