const fs = require('fs');
const path = require('path');

// Carrega o .env local ANTES de qualquer módulo ler process.env — config,
// logger e Prisma congelam os valores na primeira carga.
//
// Em produção as variáveis vêm do ambiente, não de arquivo: um .env esquecido
// no servidor sobrescreveria a configuração real do deploy. Usa o carregador
// nativo do Node, sem dependência extra.
if (process.env.NODE_ENV !== 'production') {
  const arquivo = path.join(__dirname, '.env');
  if (fs.existsSync(arquivo) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(arquivo);
  }
}

const app = require('./src/app');
const prisma = require('./src/config/prisma');
const logger = require('./src/utils/logger');
const { config, assertPronto } = require('./src/config/environment');
const { inspecionar } = require('./src/config/rlsGuard');

// Em produção o processo se recusa a abrir a porta com configuração incompleta.
// Falhar no deploy é melhor do que servir tráfego real com segredo de
// desenvolvimento ou CORS aberto.
try {
  assertPronto();
} catch (erro) {
  logger.error('inicialização abortada', { motivo: erro.message });
  // Escrita direta em stderr: quem lê isto é o operador do deploy, e o logger
  // pode estar em nível silencioso justamente no ambiente em que a partida
  // falhou. Mesmo destino do console.error, sem depender dele.
  process.stderr.write(`${erro.message}\n`);
  process.exit(1);
}

// O RLS só protege se valer para ESTA conexão. Um papel superusuário, ou uma
// tabela com RLS sem FORCE, deixa a plataforma servindo dado restrito sem erro
// nenhum — então a conferência é do processo, não do runbook.
async function conferirRls() {
  let estado;
  try {
    estado = await inspecionar();
  } catch (erro) {
    // Banco inalcançável é problema de infraestrutura, não de RLS. Em produção
    // ainda assim é motivo para não abrir a porta.
    if (!config.isProduction) {
      logger.warn('não foi possível conferir o RLS', { motivo: erro.message });
      return;
    }
    throw new Error(`não foi possível conferir o RLS antes de subir: ${erro.message}`, { cause: erro });
  }

  if (estado.ok) {
    logger.info('RLS efetivo', { papel: estado.papel });
    return;
  }

  if (config.isProduction) {
    throw new Error(
      'RLS não tem efeito nesta conexão e a plataforma serviria dado restrito:\n'
      + estado.problemas.map(problema => `  - ${problema}`).join('\n')
    );
  }

  // Fora de produção o processo sobe, mas o aviso é alto: é assim que um
  // ambiente de desenvolvimento mal provisionado se denuncia antes de virar
  // configuração de produção por hábito.
  logger.warn('RLS SEM EFEITO nesta conexão', { problemas: estado.problemas });
}

let servidor = null;

// Encerramento ordenado: para de aceitar conexões novas, deixa as em curso
// terminarem e só então fecha o banco.
const encerrar = async sinal => {
  logger.info('encerrando', { sinal });

  const desconectar = async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  };

  if (servidor) servidor.close(desconectar);
  else await desconectar();

  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

async function iniciar() {
  await conferirRls();

  servidor = app.listen(config.port, () => {
    logger.info('API iniciada', { porta: config.port, ambiente: config.env, banco: config.databaseKind, storage: config.storageDriver });
  });

  return servidor;
}

// A promessa é exportada para que a suíte possa esperar a partida — e para que
// um erro na conferência de RLS derrube o processo em vez de virar rejeição
// não tratada.
const pronto = iniciar().catch(erro => {
  logger.error('inicialização abortada', { motivo: erro.message });
  process.stderr.write(`${erro.message}\n`);
  process.exit(1);
});

module.exports = { pronto, encerrar };
