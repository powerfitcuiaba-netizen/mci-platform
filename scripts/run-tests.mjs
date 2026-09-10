#!/usr/bin/env node
import { execSync } from 'node:child_process';

// Prepara o banco de teste e roda a suíte. Existe para que `npm test` seja um
// comando só, tanto na máquina de quem desenvolve quanto na CI.

const url = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';

if (!url.startsWith('postgres')) {
  console.error('A suíte exige PostgreSQL. Defina TEST_DATABASE_URL apontando para um banco de teste.');
  process.exit(1);
}

const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4' };
const rodar = comando => execSync(comando, { stdio: 'inherit', env });

rodar('npx prisma migrate deploy');
rodar('node prisma/seed.js');
rodar('npx vitest run');
