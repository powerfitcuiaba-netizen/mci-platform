#!/usr/bin/env node
// ============================================================================
// FASE 13.25 — AMBIENTE DE VISUALIZAÇÃO, EM UM COMANDO.
//
// O que este script NÃO é: um deploy. Ele não publica nada, não toca na `main`
// e não chega perto do ambiente de produção. O que ele faz é levantar, na
// máquina em que for executado, a pilha COMPLETA — banco, API e o build de
// produção do frontend — com o conjunto de demonstração da FASE 13.26 dentro.
//
// POR QUE ELE ESCUTA EM 0.0.0.0 POR PADRÃO
//
// Um ambiente que só responde em 127.0.0.1 só serve para quem está sentado na
// mesma máquina. Quem precisa conferir está em outro lugar, com outro
// navegador. Escutar no endereço da máquina é o que torna o ambiente
// alcançável de um celular na mesma rede, ou de fora, se a máquina for um
// servidor.
//
// Isso é abrir uma porta, e abrir porta tem preço. Por isso o script EXIGE que
// a senha da demonstração seja escolhida por quem executa: um ambiente aberto
// com senha conhecida por todo mundo não é ambiente de visualização, é convite.
// Para manter tudo fechado na máquina local, passe `--host 127.0.0.1`.
//
// Uso:
//   DEMO_PASSWORD='escolha uma' node scripts/qa/ambiente.mjs
//   DEMO_PASSWORD='escolha uma' node scripts/qa/ambiente.mjs --host 127.0.0.1
//
// A senha vem por variável de ambiente, nunca por argumento: argumento aparece
// em `ps` para qualquer usuário da máquina e fica no histórico do shell.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { setTimeout as esperar } from 'node:timers/promises';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const HOST = arg('host', '0.0.0.0');
const PORTA_API = Number(arg('porta-api', 4700));
const PORTA_WEB = Number(arg('porta-web', 5700));
const SOMENTE_LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';

const BANCO = arg('db', env.DEMO_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_demo?schema=public');

const SENHA = env.DEMO_PASSWORD;
const EMAIL_ADMIN = arg('admin-email', env.DEMO_ADMIN_EMAIL || 'admin.demo@mci.local');

if (!SENHA) {
  console.error('\n  Falta DEMO_PASSWORD.\n');
  console.error('  A senha das contas de demonstração é escolhida por quem executa — nunca');
  console.error('  por quem escreveu o script, e nunca por chat. Ela vem por variável de');
  console.error('  ambiente porque argumento de linha de comando aparece em `ps`.\n');
  console.error("    DEMO_PASSWORD='escolha uma' node scripts/qa/ambiente.mjs\n");
  console.error('  NUNCA use aqui uma senha que exista em produção.\n');
  process.exit(1);
}
if (SENHA.length < 12) {
  console.error('\n  DEMO_PASSWORD curta demais (mínimo 12 caracteres).');
  console.error('  O ambiente escuta na rede; senha curta aqui é porta aberta.\n');
  process.exit(1);
}

// O endereço que a pessoa vai digitar no navegador. Em 0.0.0.0 o script
// descobre o IP real da máquina: mandar alguém abrir "http://0.0.0.0" não
// funciona em navegador nenhum.
function enderecoVisivel() {
  if (SOMENTE_LOCAL) return '127.0.0.1';
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const rede of interfaces || []) {
      if (rede.family === 'IPv4' && !rede.internal) return rede.address;
    }
  }
  return '127.0.0.1';
}

const IP = enderecoVisivel();
const BASE_WEB = `http://${IP}:${PORTA_WEB}`;
const BASE_API = `http://${IP}:${PORTA_API}/api/v1`;

const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };
process.on('SIGINT', () => { encerrar(); process.exit(0); });
process.on('SIGTERM', () => { encerrar(); process.exit(0); });

async function esperarPorta(url, segundos = 90) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return true;
    } catch { /* subindo */ }
    await esperar(500);
  }
  return false;
}

console.log('\n============================================================');
console.log('  AMBIENTE DE VISUALIZAÇÃO — QA · DEMO');
console.log('============================================================\n');
console.log('  Dados FICTÍCIOS. Banco descartável. Nada aqui é produção.\n');

try {
  // --- banco novo a cada execução: visualização não herda lixo da anterior
  console.log('preparando banco…');
  const semSchema = BANCO.replace(/\?.*$/, '');
  const nomeDoBanco = semSchema.split('/').pop();
  const servidor = `${semSchema.slice(0, semSchema.lastIndexOf('/'))}/postgres`;
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL: BANCO } });

  // --- o primeiro administrador, pelo caminho próprio da aplicação
  console.log('criando o primeiro administrador…');
  execSync(`node scripts/criar-admin.js "QA DEMO Administracao" ${EMAIL_ADMIN}`, {
    stdio: 'pipe',
    env: {
      ...env, DATABASE_URL: BANCO, NODE_ENV: 'development',
      ADMIN_PASSWORD: SENHA, BCRYPT_ROUNDS: '10', LOG_LEVEL: 'error',
      JWT_SECRET: env.JWT_SECRET || 'ambiente-de-visualizacao-segredo-suficientemente-longo-01'
    }
  });

  // --- API
  //
  // Sobe em `development` de propósito, e a razão é a mesma do gate visual: a
  // barreira de produção exige armazenamento persistente de objetos e
  // credenciais que este ambiente não tem. Afrouxar a barreira para poder
  // visualizar seria desligar o alarme para testar a porta. O que se está
  // vendo é a aplicação; o que NÃO se está vendo é a configuração de produção.
  console.log('subindo API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL: BANCO,
      PORT: String(PORTA_API), HOST,
      LOG_LEVEL: 'info', BCRYPT_ROUNDS: '10',
      JWT_SECRET: env.JWT_SECRET || 'ambiente-de-visualizacao-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_DIR: './uploads-demo',
      // A API só aceita a origem declarada. Sem isto o navegador não passa do
      // login — e os dois endereços precisam estar aqui porque a mesma
      // máquina pode abrir pelo IP e pelo localhost.
      CORS_ORIGINS: `${BASE_WEB},http://127.0.0.1:${PORTA_WEB},http://localhost:${PORTA_WEB}`,
      RATE_LIMIT_ENABLED: 'true',
      TRUST_PROXY_HOPS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; });
  api.stderr.on('data', d => { saidaApi += d; });

  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/health`, 90)) {
    throw new Error(`API não subiu:\n${saidaApi.slice(-1200)}`);
  }

  // --- conjunto de demonstração
  console.log('semeando o conjunto de demonstração…');
  execSync(
    `node scripts/qa/demo.mjs --api http://127.0.0.1:${PORTA_API}/api/v1`
    + ` --admin-email ${EMAIL_ADMIN}`,
    {
      stdio: 'inherit',
      env: { ...env, DEMO_ADMIN_PASSWORD: SENHA, DEMO_PASSWORD: SENHA }
    }
  );

  // --- frontend: o BUILD DE PRODUÇÃO, não o servidor de desenvolvimento
  console.log('construindo o frontend…');
  execSync('npm run build', { cwd: 'frontend', stdio: 'pipe', env: { ...env, VITE_API_URL: BASE_API } });

  const web = spawn('npx', [
    'vite', 'preview', '--port', String(PORTA_WEB), '--strictPort', '--host', HOST
  ], { cwd: 'frontend', stdio: ['ignore', 'pipe', 'pipe'], env });
  processos.push(web);
  if (!await esperarPorta(`http://127.0.0.1:${PORTA_WEB}`, 90)) {
    throw new Error('o frontend não subiu');
  }

  console.log('\n============================================================');
  console.log('  NO AR');
  console.log('============================================================\n');
  console.log(`  Abra no navegador:  ${BASE_WEB}`);
  console.log(`  API:                ${BASE_API}\n`);
  if (SOMENTE_LOCAL) {
    console.log('  Escutando SÓ nesta máquina (--host 127.0.0.1).');
    console.log('  Para alcançar de outro aparelho, rode sem --host.\n');
  } else {
    console.log(`  Escutando em ${HOST} — alcançável de outros aparelhos da rede.`);
    console.log('  Se a máquina for um servidor com endereço público, a porta precisa');
    console.log('  estar liberada no firewall. E isto NÃO tem HTTPS: não é ambiente');
    console.log('  para dado real, é para conferência de dados de demonstração.\n');
  }
  console.log('  Todas as contas usam a senha que você escolheu em DEMO_PASSWORD.');
  console.log(`  Administração: ${EMAIL_ADMIN}\n`);
  console.log('  O roteiro de conferência está em docs/AMBIENTE-DE-VISUALIZACAO.md\n');
  console.log('  Ctrl+C encerra tudo e descarta o banco na próxima execução.\n');

  await new Promise(() => {});
} catch (erro) {
  console.error(`\nFALHOU: ${erro.message}\n`);
  encerrar();
  process.exit(1);
}
