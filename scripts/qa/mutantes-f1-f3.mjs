#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — F1 e F3, as duas políticas corrigidas.
//
// Aqui o mutante não é código: é SQL. Cada um REVERTE uma política ao estado que
// produzia o defeito, e a suíte do T2 tem de reprovar. Se ela continuasse verde,
// a correção estaria sem guarda e voltaria no primeiro `DROP POLICY` distraído.
//
// A restauração é feita no `finally`, sempre: o mutante vive dentro de uma
// transação da sessão de aplicação e o script regrava a política correta mesmo se
// o processo morrer no meio.
// ============================================================================

import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = '/home/user/mci-platform';
const URL_BANCO = process.env.DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public';
const ENV = `NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 DATABASE_URL="${URL_BANCO}"`;

const SUITE = 'tests/f1-f3-autorizacao-coerente.test.mjs';

// As políticas CORRETAS, como a migration 20260925070000 as define. É isto que o
// script regrava para restaurar — e, por ser a mesma fonte, uma divergência entre
// este arquivo e a migration aparece como suíte vermelha depois da restauração.
const CORRETA_COMENTARIO = `
DROP POLICY IF EXISTS comentario_leitura ON "Comment";
CREATE POLICY comentario_leitura ON "Comment"
  FOR SELECT USING (
    mci_is_moderator()
    OR "authorId" = mci_current_profile_id()
    OR EXISTS (
      SELECT 1 FROM "Post" p
      WHERE p.id = "Comment"."postId" AND p."authorId" = mci_current_profile_id()
    )
    OR (
      "deletedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId")
    )
  );`;

const CORRETA_ATLETA = `
DROP POLICY IF EXISTS atleta_alteracao ON "Athlete";
CREATE POLICY atleta_alteracao ON "Athlete"
  FOR UPDATE
  USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
  WITH CHECK (mci_operator_of("organizationId") OR "userId" = mci_current_user_id());`;

const MUTANTES = [
  {
    id: 'F1-M1',
    descricao: 'reverte comentario_leitura ao estado do defeito (sem autor nem moderação)',
    sql: `
      DROP POLICY IF EXISTS comentario_leitura ON "Comment";
      CREATE POLICY comentario_leitura ON "Comment"
        FOR SELECT USING (
          "deletedAt" IS NULL
          AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId")
        );`,
    restaurar: CORRETA_COMENTARIO
  },
  {
    id: 'F1-M2',
    descricao: 'tira só a ramificação do AUTOR DA PUBLICAÇÃO de comentario_leitura',
    sql: `
      DROP POLICY IF EXISTS comentario_leitura ON "Comment";
      CREATE POLICY comentario_leitura ON "Comment"
        FOR SELECT USING (
          mci_is_moderator()
          OR "authorId" = mci_current_profile_id()
          OR (
            "deletedAt" IS NULL
            AND EXISTS (SELECT 1 FROM "Post" p WHERE p.id = "Comment"."postId")
          )
        );`,
    restaurar: CORRETA_COMENTARIO
  },
  {
    id: 'F3-M1',
    descricao: 'reverte atleta_alteracao ao WITH CHECK só de operador',
    sql: `
      DROP POLICY IF EXISTS atleta_alteracao ON "Athlete";
      CREATE POLICY atleta_alteracao ON "Athlete"
        FOR UPDATE
        USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
        WITH CHECK (mci_operator_of("organizationId"));`,
    restaurar: CORRETA_ATLETA
  },
  {
    id: 'F3-M2',
    descricao: 'abre o WITH CHECK de atleta_alteracao para qualquer membro da organização',
    sql: `
      DROP POLICY IF EXISTS atleta_alteracao ON "Athlete";
      CREATE POLICY atleta_alteracao ON "Athlete"
        FOR UPDATE
        USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
        WITH CHECK (mci_member_of("organizationId"));`,
    restaurar: CORRETA_ATLETA
  }
];

// O SQL VAI POR ARQUIVO, e não por `-c`.
//
// Com `-c` e uma string de várias linhas, o shell entrega ao psql um `\n`
// literal (duas letras), e o psql lê a barra invertida como início de
// meta-comando: `invalid command \nDROP`. Medido. Com `-f` o arquivo é lido como
// script, que é o que estas mutações são.
const psql = sql => {
  const pasta = mkdtempSync(join(tmpdir(), 'mci-mutante-sql-'));
  const arquivo = join(pasta, 'mutante.sql');
  try {
    writeFileSync(arquivo, sql);
    return execSync(`psql "${URL_BANCO.replace('?schema=public', '')}" -v ON_ERROR_STOP=1 -q -f "${arquivo}"`,
      { stdio: 'pipe', encoding: 'utf8', env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD || 'mci_local_dev' } });
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
};

function rodar(mutante) {
  try {
    psql(mutante.sql);
    try {
      execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`,
        { stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
      return { ...mutante, veredito: 'SOBREVIVEU' };
    } catch (erro) {
      const falhas = (`${erro.stdout ?? ''}`.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? '?';
      return { ...mutante, veredito: 'MORREU', detalhe: `${falhas} teste(s) reprovaram` };
    }
  } finally {
    psql(mutante.restaurar);
  }
}

console.log('=== MUTATION TESTING — POLÍTICAS DE F1 E F3 ===\n');

try {
  execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`, { stdio: 'pipe', timeout: 900000 });
  console.log('CONTROLE: a suíte do T2 passa com as políticas corretas.\n');
} catch {
  console.log('CONTROLE FALHOU: a suíte já está vermelha. Nada abaixo conclui nada.');
  process.exit(1);
}

const resultados = [];
for (const mutante of MUTANTES) {
  const r = rodar(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(12)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

const sobreviventes = resultados.filter(r => r.veredito !== 'MORREU');
console.log(`\n${resultados.length - sobreviventes.length}/${resultados.length} mutantes mortos`);
if (sobreviventes.length) {
  console.log('\nSOBREVIVERAM — a correção está sem guarda:');
  for (const s of sobreviventes) console.log(`  ${s.id}  ${s.descricao}`);
}

// CONTROLE DEPOIS: a restauração tem de devolver o verde. Sem isto, um script que
// restaurasse errado deixaria o banco de QA quebrado e o próximo run confuso.
try {
  execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`, { stdio: 'pipe', timeout: 900000 });
  console.log('\nCONTROLE FINAL: as políticas foram restauradas e a suíte volta a passar.');
} catch {
  console.log('\nCONTROLE FINAL FALHOU: a restauração não devolveu o estado correto.');
  process.exitCode = 1;
}

process.exitCode = sobreviventes.length ? 1 : (process.exitCode ?? 0);
