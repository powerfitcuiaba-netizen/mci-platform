#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — GOVERNANÇA DO CATÁLOGO GLOBAL (F2).
//
// A correção do F2 tem duas metades, e nenhuma delas é estrutural: uma linha
// que SAIU de `ROLE_PERMISSIONS.EVENT_DIRECTOR` e uma conferência que ENTROU em
// `createCoach`. Correção pequena é a que volta mais fácil — basta alguém
// "reativar a permissão que o diretor perdeu" num commit de conveniência.
//
// Cada mutante aqui é uma forma REAL de desfazer a decisão. O veredito só vale
// se a restauração devolver o verde: sem o controle DEPOIS, um "MORREU"
// poderia ser o arquivo corrompido, não a garantia medida.
//
// F2-M1  `categories.manage` volta para EVENT_DIRECTOR — a reversão exata
// F2-M2  a conferência de `coaches.link_account` desaparece
// F2-M3  `coaches.link_account` é concedida ao diretor do evento
// F2-M4  a conferência do vínculo passa para DEPOIS da busca do usuário,
//        recriando o oráculo de existência de conta
// F2-M5  a permissão nova sai da lista mestra — o `can()` passa a explodir
//        em vez de recusar, e "erro" não é "recusa"
//
// O arquivo é restaurado sempre, inclusive se o processo morrer no meio.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const ENV = 'NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 '
  + 'DATABASE_URL="postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public"';

const SUITE = 'tests/f2-governanca-do-catalogo-global.test.mjs';

const MUTANTES = [
  {
    id: 'F2-M1',
    descricao: 'categories.manage volta para EVENT_DIRECTOR — a reversão exata da decisão',
    arquivo: 'src/utils/permissions.js',
    de: "    'affiliations.manage',\n    'athletes.create',",
    para: "    'categories.manage', 'affiliations.manage',\n    'athletes.create',"
  },
  {
    id: 'F2-M2',
    descricao: 'a conferência de coaches.link_account desaparece de createCoach',
    arquivo: 'src/services/partnerService.js',
    de: "    if (!can(actor, 'coaches.link_account')) {",
    para: '    if (false) { // mutante F2-M2: o vínculo de conta não é mais conferido'
  },
  {
    id: 'F2-M3',
    descricao: 'coaches.link_account é concedida ao diretor do evento',
    arquivo: 'src/utils/permissions.js',
    de: "    'teams.manage', 'companies.manage', 'coaches.manage', 'gyms.manage', 'brands.manage', 'sponsors.manage',",
    para: "    'teams.manage', 'companies.manage', 'coaches.manage', 'coaches.link_account', 'gyms.manage', 'brands.manage', 'sponsors.manage',"
  },
  {
    id: 'F2-M4',
    descricao: 'a conferência do vínculo vai para DEPOIS da busca do usuário — volta o oráculo',
    arquivo: 'src/services/partnerService.js',
    de: `    if (!can(actor, 'coaches.link_account')) {
      throw new AppError(403, 'FORBIDDEN',
        'Vincular o cadastro de técnico a uma conta da plataforma é operação de administrador. '
        + 'Cadastre o técnico sem o vínculo e solicite o vínculo da conta.');
    }

    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');`,
    para: `    const user = await prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Usuário não encontrado');

    if (!can(actor, 'coaches.link_account')) {
      throw new AppError(403, 'FORBIDDEN',
        'Vincular o cadastro de técnico a uma conta da plataforma é operação de administrador. '
        + 'Cadastre o técnico sem o vínculo e solicite o vínculo da conta.');
    }`
  },
  {
    id: 'F2-M5',
    descricao: 'coaches.link_account sai da lista mestra de permissões',
    arquivo: 'src/utils/permissions.js',
    de: "  'coaches.link_account',\n  'brands.manage', 'sponsors.manage',",
    para: "  'brands.manage', 'sponsors.manage',"
  }
];

function suitePassa() {
  try {
    execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE}`,
      { stdio: 'pipe', encoding: 'utf8', timeout: 900000 });
    return { passou: true };
  } catch (erro) {
    const saida = `${erro.stdout ?? ''}`;
    const falhas = (saida.match(/Tests\s+(\d+) failed/) ?? [])[1] ?? '?';
    return { passou: false, falhas };
  }
}

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
    const mutado = original.replace(mutante.de, mutante.para);
    writeFileSync(caminho, mutado);

    // A MUTAÇÃO TEM DE TER ENTRADO NO ARQUIVO. Numa fase anterior desta
    // sessão, quatro mutantes reportaram verde porque o script escrevia em
    // caminho relativo e nenhum deles chegou ao código. Conferir é barato.
    if (readFileSync(caminho, 'utf8') === original) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: 'o arquivo não mudou depois da escrita' };
    }

    const r = suitePassa();
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    copyFileSync(backup, caminho);
    rmSync(backup, { force: true });
  }
}

console.log('=== MUTATION TESTING — GOVERNANÇA DO CATÁLOGO GLOBAL (F2) ===\n');

// CONTROLE ANTES: a suíte tem de estar verde, ou todo "MORREU" abaixo é ruído.
if (!suitePassa().passou) {
  console.log('CONTROLE ANTES FALHOU: a suíte do F2 já está vermelha. Nada abaixo conclui nada.');
  process.exit(1);
}
console.log('CONTROLE ANTES: a suíte do F2 passa sem mutante.\n');

const resultados = [];
for (const mutante of MUTANTES) {
  const r = rodar(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

// CONTROLE DEPOIS: a restauração devolveu o verde? Sem isto, "MORREU" poderia
// ser arquivo quebrado em vez de garantia medida.
const depois = suitePassa();
console.log(`\nCONTROLE DEPOIS: ${depois.passou ? 'a suíte volta a passar — restauração íntegra.' : 'A SUÍTE NÃO VOLTOU AO VERDE.'}`);

const divergentes = resultados.filter(r => r.veredito !== (r.esperado ?? 'MORREU'));
const mortos = resultados.filter(r => r.veredito === 'MORREU').length;

console.log(`\n${mortos}/${resultados.length} mortos, ${resultados.length - divergentes.length}/${resultados.length} conforme a expectativa`);

if (divergentes.length) {
  console.log('\nDIVERGIRAM DA EXPECTATIVA — cada um exige explicação:');
  for (const d of divergentes) console.log(`  ${d.id}  esperado ${d.esperado ?? 'MORREU'}, deu ${d.veredito}`);
}

process.exitCode = divergentes.length || !depois.passou ? 1 : 0;
