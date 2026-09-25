#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — O GATE DE AUTORIZAÇÃO POR ROTA (T1).
//
// Um gate de autorização que passa não prova nada: ele tem de FALHAR quando a
// autorização é removida. Cada mutante aqui desliga uma garantia diferente, e
// o veredito é binário — se a suíte continua verde, aquela garantia não está
// sendo medida por ninguém.
//
// MUTANTE EQUIVALENTE NÃO É MUTANTE SOBREVIVENTE
//
// Dois destes NÃO podem morrer, e isso é resultado — não lacuna. Cada um declara
// `esperado: 'SOBREVIVE'` com a prova, e o script só aprova se cada mutante fizer
// o que a expectativa dele diz. Forçar uma morte aqui seria inventar cobertura.
//
// M1  o `assertCan` de uma rota mutante desaparece
// M2  a permissão exigida é AMPLIADA para uma que todo autenticado tem
// M3  a conferência de TENANT é neutralizada
// M4  o middleware de permissão passa a liberar todo mundo
// M5  a recusa 403 vira sucesso — o interruptor geral da autorização
// M6  uma rota protegida perde o `requireAuth`
//
// O arquivo é restaurado sempre, inclusive se o processo morrer no meio.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const ENV = 'NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 '
  + 'DATABASE_URL="postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public"';

const SUITE = 'tests/gate-autorizacao-por-rota.test.mjs';

const MUTANTES = [
  {
    id: 'M1',
    descricao: 'remove o assertCan de DELETE /events/:id',
    arquivo: 'src/services/eventService.js',
    de: "  assertCan(actor, 'events.delete', event.organizationId);",
    para: '  // mutante M1: autorização removida'
  },
  {
    id: 'M2',
    descricao: 'amplia a permissão de POST /events/:id/credentials para uma da base autenticada',
    arquivo: 'src/services/operationsService.js',
    de: "  assertCan(actor, 'credentials.manage', event.organizationId);",
    para: "  assertCan(actor, 'events.read', event.organizationId);"
  },
  {
    id: 'M3',
    descricao: 'neutraliza a conferência de tenant em assertOrganization',
    arquivo: 'src/utils/tenant.js',
    de: '  if (!belongsToOrganization(user, organizationId)) {',
    para: '  if (false) { // mutante M3: tenant não é mais conferido',
    esperado: 'SOBREVIVEU',
    porQue: 'EQUIVALENTE dentro do escopo do T1. `assertCan` confere duas vezes: '
      + '`assertOrganization` e `assertPermission(user, perm, organizationId)` — e a segunda '
      + 'JÁ é escopada por organização, porque `can()` soma o papel global com os papéis '
      + 'NAQUELA organização. Um operador da federação B não tem a permissão EM A, então a '
      + 'recusa continua vindo da permissão. O tenant só seria a ÚNICA barreira onde o '
      + '`assertCan` usa permissão da base autenticada, e as três ocorrências no código '
      + '(membershipService:211, rankingService:2168 e :2486) estão em rotas GET — fora do '
      + 'escopo mutante do T1. É essa a lacuna a fechar na fase de leitura.'
  },
  {
    id: 'M4',
    descricao: 'o middleware requirePermission libera qualquer ator',
    arquivo: 'src/middlewares/auth.js',
    de: '    if (!can(user, permission, organizationId)) {',
    para: '    if (false) { // mutante M4: permissão não é mais conferida',
    esperado: 'SOBREVIVEU',
    porQue: 'EQUIVALENTE por defesa em profundidade, medido: com o middleware desligado, '
      + 'PATCH /admin/users/:id continua respondendo 403, porque `adminService.js:98` chama '
      + '`assertPermission(actor, \'users.manage\')` por conta própria. O `perm()` da rota é '
      + 'redundante com o serviço nas 18 rotas que o usam — e é bom que seja.'
  },
  {
    id: 'M5',
    descricao: 'assertPermission deixa de recusar — 403 vira sucesso',
    arquivo: 'src/utils/tenant.js',
    de: '  if (!can(user, permission, organizationId)) {',
    para: '  if (false) { // mutante M5: a recusa 403 foi desligada'
  },
  {
    id: 'M6',
    descricao: 'PATCH /admin/users/:id perde o requireAuth',
    arquivo: 'src/routes/index.js',
    de: "router.patch('/admin/users/:id', requireAuth,",
    para: "router.patch('/admin/users/:id', (req, res, next) => next(),"
  }
];

function rodar(mutante) {
  const caminho = `${RAIZ}/${mutante.arquivo}`;
  const backup = `${caminho}.mutante-bak`;
  copyFileSync(caminho, backup);
  try {
    const original = readFileSync(caminho, 'utf8');
    const ocorrencias = original.split(mutante.de).length - 1;
    if (ocorrencias !== 1) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: `o trecho aparece ${ocorrencias} vez(es)` };
    }
    writeFileSync(caminho, original.replace(mutante.de, mutante.para));

    try {
      execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`,
        { stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
      return { ...mutante, veredito: 'SOBREVIVEU' };
    } catch (erro) {
      const saida = `${erro.stdout ?? ''}`;
      const falhas = (saida.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? '?';
      return { ...mutante, veredito: 'MORREU', detalhe: `${falhas} teste(s) reprovaram` };
    }
  } finally {
    copyFileSync(backup, caminho);
    rmSync(backup, { force: true });
  }
}

console.log('=== MUTATION TESTING — GATE DE AUTORIZAÇÃO POR ROTA ===\n');

// CONTROLE ANTES. Se o gate já estivesse vermelho, todo "MORREU" abaixo seria
// indistinguível de ruído.
try {
  execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`, { stdio: 'pipe', timeout: 900000 });
  console.log('CONTROLE: o gate passa SEM mutante.\n');
} catch {
  console.log('CONTROLE FALHOU: o gate já está vermelho. Nada abaixo conclui nada.');
  process.exit(1);
}

const resultados = [];
for (const mutante of MUTANTES) {
  const r = rodar(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(4)} ${r.veredito.padEnd(12)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

const conforme = resultados.filter(r => r.veredito === (r.esperado ?? 'MORREU'));
const divergentes = resultados.filter(r => r.veredito !== (r.esperado ?? 'MORREU'));
const mortos = resultados.filter(r => r.veredito === 'MORREU').length;
const equivalentes = resultados.filter(r => r.esperado === 'SOBREVIVEU');

console.log(`\n${mortos} morreram, ${equivalentes.length} equivalentes declarados, `
  + `${conforme.length}/${resultados.length} conforme a expectativa`);

for (const e of equivalentes) {
  console.log(`\n${e.id} EQUIVALENTE — por que não pode morrer:\n  ${e.porQue}`);
}

if (divergentes.length) {
  console.log('\nDIVERGIRAM DA EXPECTATIVA — cada um exige explicação:');
  for (const d of divergentes) console.log(`  ${d.id}  esperado ${d.esperado ?? 'MORREU'}, deu ${d.veredito}`);
}
process.exitCode = divergentes.length ? 1 : 0;
