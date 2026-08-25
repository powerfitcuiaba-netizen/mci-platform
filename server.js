const app = require('./src/app');
const prisma = require('./src/config/prisma');
const logger = require('./src/utils/logger');
const { config, assertPronto } = require('./src/config/environment');

// Em produção o processo se recusa a abrir a porta com configuração incompleta.
// Falhar no deploy é melhor do que servir tráfego real com segredo de
// desenvolvimento ou CORS aberto.
try {
  assertPronto();
} catch (erro) {
  logger.error('inicialização abortada', { motivo: erro.message });
  console.error(erro.message);
  process.exit(1);
}

const servidor = app.listen(config.port, () => {
  logger.info('API iniciada', { porta: config.port, ambiente: config.env, banco: config.databaseKind, storage: config.storageDriver });
});

// Encerramento ordenado: para de aceitar conexões novas, deixa as em curso
// terminarem e só então fecha o banco.
const encerrar = async sinal => {
  logger.info('encerrando', { sinal });
  servidor.close(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

module.exports = servidor;
