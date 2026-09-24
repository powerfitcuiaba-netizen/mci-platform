#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — A ENTIDADE DE FILIAÇÃO OFICIAL.
//
// Cada mutante desliga UMA garantia do provisionamento. A suíte tem de
// reprovar. Mutante que sobrevive é garantia que ninguém está medindo — e aqui
// as garantias são: a organização vem de configuração, o código não se
// renomeia, o conflito para, a idempotência não reescreve, e a corrida não
// duplica.
//
// O arquivo é restaurado sempre, inclusive se o processo morrer no meio: o
// backup é feito antes e o `finally` o devolve.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const ENV = 'NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 '
  + 'DATABASE_URL="postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public"';

const SUITE = 'tests/filiacao-oficial-npc.test.mjs';
const SUITE_HISTORICO = 'tests/npc-historico-do-ipiranga.test.mjs';
const SERVICO = 'src/services/officialAffiliationService.js';
const SCRIPT = 'scripts/provisionar-contas-de-servico.js';

const MUTANTES = [
  {
    id: 'N1', descricao: 'a organização passa a ser DESCOBERTA em vez de configurada',
    arquivo: SERVICO,
    de: `  const organizacao = await prisma.organization.findUnique({
    where: { id },`,
    para: `  const organizacao = await prisma.organization.findFirst({
    where: { active: true },`,
    suite: SUITE
  },
  {
    id: 'N2', descricao: 'o código oficial muda — a chave de reconhecimento quebra',
    arquivo: SERVICO,
    de: "const CODIGO_OFICIAL = 'NPC';",
    para: "const CODIGO_OFICIAL = 'NPCBR';",
    suite: SUITE
  },
  {
    id: 'N3', descricao: 'o nome oficial muda por um caractere',
    arquivo: SERVICO,
    de: "const NOME_OFICIAL = 'NPC - National Physique Committe';",
    para: "const NOME_OFICIAL = 'NPC - National Physique Committee';",
    suite: SUITE
  },
  {
    id: 'N4', descricao: 'o tipo deixa de ser ENTITY',
    arquivo: SERVICO,
    de: "const TIPO_OFICIAL = 'ENTITY';",
    para: "const TIPO_OFICIAL = 'FEDERATION';",
    suite: SUITE
  },
  {
    id: 'N5', descricao: 'a entidade nasce INATIVA',
    arquivo: SERVICO,
    de: `        kind: TIPO_OFICIAL,
        active: true`,
    para: `        kind: TIPO_OFICIAL,
        active: false`,
    suite: SUITE
  },
  {
    id: 'N6', descricao: 'a inatividade deixa de ser pendência — a entidade fica fora da vitrine',
    arquivo: SERVICO,
    de: '  if (!filiacao.active) pendencias.push(PENDENCIAS.FILIACAO_INATIVA);',
    para: '  if (false) pendencias.push(PENDENCIAS.FILIACAO_INATIVA);',
    suite: SUITE
  },
  {
    id: 'N7', descricao: 'o autocadastro deixa de ser aberto',
    arquivo: SERVICO,
    de: "  if (!organizacao.selfRegistrationOpen) pendencias.push(PENDENCIAS.AUTOCADASTRO_FECHADO);",
    para: '  // pendência removida',
    suite: SUITE
  },
  {
    id: 'N8', descricao: 'o autocadastro é aberto para TODAS as organizações',
    arquivo: SERVICO,
    de: '    await organizacoes.setSelfRegistration(antes.organizationId, true, actor);',
    para: `    for (const o of await prisma.organization.findMany({ select: { id: true } })) {
      await organizacoes.setSelfRegistration(o.id, true, actor);
    }`,
    suite: SUITE
  },
  {
    id: 'N9', descricao: 'a proteção de conflito é removida — o script escolhe uma candidata',
    arquivo: SERVICO,
    de: `  if (candidatas.length > 1) {`,
    para: `  if (false) {`,
    suite: SUITE
  },
  {
    id: 'N10', descricao: 'a entidade com o nome oficial sob outro código passa a ser aceita',
    arquivo: SERVICO,
    de: '  if (filiacao.code.toUpperCase() !== CODIGO_OFICIAL) {',
    para: '  if (false) {',
    suite: SUITE
  },
  {
    id: 'N11', descricao: 'a idempotência cai: o estado correto passa a reescrever',
    arquivo: SERVICO,
    de: `  if (antes.estado === ESTADOS.CORRETO) {
    return { ...antes, acoes: [] };
  }`,
    para: `  if (antes.estado === ESTADOS.CORRETO) {
    await prisma.affiliation.update({ where: { id: antes.affiliationId }, data: { name: NOME_OFICIAL } });
    await audit.record({
      actor, action: 'OFFICIAL_AFFILIATION_PROVISIONED', entity: 'Affiliation',
      entityId: antes.affiliationId, organizationId: antes.organizationId, metadata: {}
    });
    return { ...antes, acoes: ['REESCRITO'] };
  }`,
    suite: SUITE
  },
  {
    id: 'N12', descricao: 'a contenção por SAVEPOINT some — a corrida volta a matar a transação',
    arquivo: SERVICO,
    de: '  if (!tx) return inserir();',
    para: '  return inserir();',
    suite: SUITE
  },
  {
    id: 'N13', descricao: 'a recuperação da corrida some — P2002 vira falha',
    arquivo: SERVICO,
    de: "      if (erro?.code !== 'P2002') throw erro;",
    para: '      throw erro;',
    suite: SUITE
  },
  {
    id: 'N14', descricao: 'a organização inativa passa a ser provisionada',
    arquivo: SERVICO,
    de: `  if (!organizacao.active) {
    return { ...base, estado: ESTADOS.ORGANIZACAO_INATIVA, pendencias: [] };
  }`,
    para: '  // guarda removida',
    suite: SUITE
  },
  {
    id: 'N15', descricao: 'o script para de falhar quando falta o administrador',
    arquivo: SCRIPT,
    de: `    console.error('\\nDefina PROVISIONAR_ADMIN_EMAIL com o e-mail do administrador que autoriza.');
    console.error('A auditoria grava quem foi; ato administrativo sem dono não é auditável.');
    return 1;`,
    para: `    console.error('\\nDefina PROVISIONAR_ADMIN_EMAIL com o e-mail do administrador que autoriza.');
    return 0;`,
    suite: SUITE
  },
  {
    id: 'N16', descricao: 'o script segue mesmo com conflito',
    arquivo: SCRIPT,
    de: `  if (diagnostico.estado === ESTADOS.CONFLITO) {
    console.error('\\nCONFLITO na entidade de filiação oficial. NADA foi alterado.');
    console.error('Resolva na federação qual é a oficial antes de prosseguir.');
    return 1;
  }`,
    para: '  // guarda removida',
    suite: SUITE
  },
  {
    id: 'N17', descricao: 'o --conferir passa a ESCREVER antes de relatar',
    arquivo: SCRIPT,
    de: `  if (SO_CONFERIR) {
    console.log('\\n--conferir: NADA foi escrito.');`,
    para: `  if (SO_CONFERIR) {
    await prisma.organization.update({ where: { id: diagnostico.organizationId }, data: { selfRegistrationOpen: true } });
    console.log('\\n--conferir: NADA foi escrito.');`,
    suite: SUITE
  },
  {
    id: 'N18', descricao: 'a conciliação do histórico vira adoção por qualquer coisa',
    arquivo: SERVICO,
    de: `  const porNome = daOrganizacao.filter(f =>
    f.name.trim().toLowerCase() === NOME_OFICIAL.toLowerCase()
    && f.code.toUpperCase() !== CODIGO_OFICIAL);`,
    para: '  const porNome = [];',
    suite: SUITE
  }
];

function rodar(mutante) {
  const caminho = `${RAIZ}/${mutante.arquivo}`;
  const backup = `${caminho}.mutante-backup`;
  copyFileSync(caminho, backup);

  try {
    const original = readFileSync(caminho, 'utf8');
    const ocorrencias = original.split(mutante.de).length - 1;
    if (ocorrencias !== 1) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: `o trecho aparece ${ocorrencias} vez(es)` };
    }
    writeFileSync(caminho, original.replace(mutante.de, mutante.para));

    try {
      execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${mutante.suite}`,
        { stdio: 'pipe', encoding: 'utf8', timeout: 600000 });
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

console.log('=== MUTATION TESTING — ENTIDADE DE FILIAÇÃO OFICIAL ===\n');

const resultados = [];
for (const mutante of MUTANTES) {
  const r = rodar(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(5)} ${r.veredito.padEnd(12)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

const mortos = resultados.filter(r => r.veredito === 'MORREU').length;
const sobreviventes = resultados.filter(r => r.veredito === 'SOBREVIVEU');
console.log(`\n${mortos}/${resultados.length} mutantes mortos`);
if (sobreviventes.length) {
  console.log('\nSOBREVIVERAM — cada um é uma garantia que ninguém mede:');
  for (const s of sobreviventes) console.log(`  ${s.id}  ${s.descricao}`);
}
process.exitCode = sobreviventes.length ? 1 : 0;

// A suíte do histórico é rodada uma vez, sem mutante, como controle: se ela já
// estivesse vermelha, todo "MORREU" acima seria indistinguível de ruído.
try {
  execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITE_HISTORICO}`, { stdio: 'pipe', timeout: 600000 });
  console.log('\nCONTROLE: a suíte do histórico passa sem mutante.');
} catch {
  console.log('\nCONTROLE FALHOU: a suíte do histórico já está vermelha — os vereditos acima não concluem nada.');
  process.exitCode = 1;
}
