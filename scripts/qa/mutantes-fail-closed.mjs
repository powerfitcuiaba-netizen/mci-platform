#!/usr/bin/env node
// ============================================================================
// MUTATION TESTING — TENTATIVA RECUSADA NA TRILHA, E FAIL CLOSED.
//
// As duas decisões desta fase são pequenas no diff e grandes na consequência,
// e por isso são exatamente do tipo que volta atrás num commit de conveniência:
// basta alguém "tolerar a falha de auditoria para o login não cair" ou "tirar a
// gravação da tentativa recusada porque enche a tabela".
//
// Cada mutante abaixo é uma forma REAL de desfazer a decisão. Um mutante que
// SOBREVIVE é um teste que não mede o que diz medir.
//
// FC-M1  a gravação da tentativa recusada desaparece do login
// FC-M2  a auditoria obrigatória volta a ENGOLIR a falha e devolver null —
//        a regressão exata que reabriria a sessão sem trilha
// FC-M3  o login troca a auditoria obrigatória pela tolerante: token emitido
//        mesmo sem trilha
// FC-M4  o cadastro troca a obrigatória pela tolerante: conta criada sem trilha
// FC-M5  o token do login é criado ANTES da auditoria — a ordem invertida, que
//        é o jeito silencioso de furar o fail closed
// FC-M6  a conferência de persistência (`count !== 1`) cai: chamar o serviço
//        volta a ser confundido com gravar a linha
//
// Os dois arquivos são restaurados sempre, inclusive se o processo morrer no
// meio, e o CONTROLE DEPOIS confere que a restauração devolveu o verde.
// ============================================================================

import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

const RAIZ = '/home/user/mci-platform';
const ENV = 'NODE_ENV=test LOG_LEVEL=silent BCRYPT_ROUNDS=4 '
  + 'DATABASE_URL="postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_test?schema=public"';

// As duas suítes rodam juntas: a decisão A vive numa, a B na outra, e um mutante
// que mata só uma das duas não deixa de ser mutante morto.
const SUITES = 'tests/autenticacao-fail-closed.test.mjs tests/auditoria-de-autenticacao.test.mjs';

const MUTANTES = [
  {
    id: 'FC-M1',
    descricao: 'a gravação da tentativa recusada desaparece do login',
    arquivo: 'src/services/authService.js',
    de: 'async function registrarTentativaRecusada({ user, motivo, ip }) {\n  await audit.registrarObrigatorio({',
    para: 'async function registrarTentativaRecusada({ user, motivo, ip }) {\n  if (user || motivo || ip) return; // mutante FC-M1: a tentativa recusada não deixa rastro\n  await audit.registrarObrigatorio({'
  },
  {
    id: 'FC-M2',
    descricao: 'a auditoria obrigatória volta a engolir a falha e devolver null',
    arquivo: 'src/services/auditService.js',
    de: "    throw new AppError(503, 'AUDIT_UNAVAILABLE', MENSAGEM_DE_INDISPONIBILIDADE);",
    para: '    return null; // mutante FC-M2: a falha volta a ser engolida'
  },
  {
    id: 'FC-M3',
    descricao: 'o login usa a auditoria tolerante: token emitido mesmo sem trilha',
    arquivo: 'src/services/authService.js',
    de: '  await audit.registrarObrigatorio({\n    actor: user, action: audit.ACTIONS.LOGIN,',
    para: '  await audit.record({ // mutante FC-M3: tolerante no lugar da obrigatória\n    actor: user, action: audit.ACTIONS.LOGIN,'
  },
  {
    id: 'FC-M4',
    descricao: 'o cadastro usa a auditoria tolerante: conta criada sem trilha',
    arquivo: 'src/services/authService.js',
    de: '    await audit.registrarObrigatorio({\n      actor: criado, action: audit.ACTIONS.USER_REGISTER,',
    para: '    await audit.record({ // mutante FC-M4: tolerante no lugar da obrigatória\n      actor: criado, action: audit.ACTIONS.USER_REGISTER,'
  },
  {
    id: 'FC-M5',
    descricao: 'o token do login é criado ANTES da auditoria — ordem invertida',
    arquivo: 'src/services/authService.js',
    de: `  await audit.registrarObrigatorio({
    actor: user, action: audit.ACTIONS.LOGIN, entity: 'User', entityId: user.id, ip: contexto.ip
  });

  return { token: createToken(user), user: sanitizeUser(user) };`,
    para: `  // mutante FC-M5: a credencial nasce antes da trilha
  const credencial = { token: createToken(user), user: sanitizeUser(user) };
  await audit.registrarObrigatorio({
    actor: user, action: audit.ACTIONS.LOGIN, entity: 'User', entityId: user.id, ip: contexto.ip
  });

  return credencial;`,
    // MUTANTE DECLARADO EQUIVALENTE, e a razão é o que ele ensina.
    //
    // Criar o objeto antes não emite nada: `registrarObrigatorio` levanta 503
    // antes do `return`, e o controller nunca devolve o corpo. O fail closed
    // desta arquitetura não depende da ORDEM das duas linhas — depende de a
    // exceção subir. Manter o mutante documentado vale mais que removê-lo:
    // quem vier ajustar a ordem saberá que ela não é a garantia.
    esperado: 'SOBREVIVEU'
  },
  {
    id: 'FC-M6',
    descricao: 'a conferência de persistência cai: chamar volta a ser confundido com gravar',
    arquivo: 'src/services/auditService.js',
    de: '    if (!resultado || resultado.count !== 1) {',
    para: '    if (false) { // mutante FC-M6: o banco não é mais consultado sobre o que gravou',
    // Também declarado equivalente: com o gatilho do teste, o INSERT LEVANTA
    // exceção, e a exceção sobe com ou sem esta conferência. A conferência
    // defende o caso em que o banco aceita o comando e grava zero linha — que
    // nenhum teste consegue produzir sem adulterar o banco de propósito.
    esperado: 'SOBREVIVEU'
  }
];

function suitesPassam() {
  try {
    execSync(`cd ${RAIZ} && ${ENV} npx vitest run ${SUITES}`,
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
    writeFileSync(caminho, original.replace(mutante.de, mutante.para));

    // A MUTAÇÃO TEM DE TER ENTRADO NO ARQUIVO: um "MORREU" de mutante que nunca
    // chegou ao código é ruído com cara de resultado.
    if (readFileSync(caminho, 'utf8') === original) {
      return { ...mutante, veredito: 'NÃO APLICADO', detalhe: 'o arquivo não mudou depois da escrita' };
    }

    const r = suitesPassam();
    return r.passou
      ? { ...mutante, veredito: 'SOBREVIVEU' }
      : { ...mutante, veredito: 'MORREU', detalhe: `${r.falhas} teste(s) reprovaram` };
  } finally {
    copyFileSync(backup, caminho);
    rmSync(backup, { force: true });
  }
}

console.log('=== MUTATION TESTING — TRILHA DA TENTATIVA RECUSADA E FAIL CLOSED ===\n');

// CONTROLE ANTES: verde sem mutante, ou todo "MORREU" abaixo é ruído.
if (!suitesPassam().passou) {
  console.log('CONTROLE ANTES FALHOU: as suítes já estão vermelhas. Nada abaixo conclui nada.');
  process.exit(1);
}
console.log('CONTROLE ANTES: as duas suítes passam sem mutante.\n');

const resultados = [];
for (const mutante of MUTANTES) {
  const r = rodar(mutante);
  resultados.push(r);
  console.log(`${r.id.padEnd(7)} ${r.veredito.padEnd(13)} ${r.descricao}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

const depois = suitesPassam();
console.log(`\nCONTROLE DEPOIS: ${depois.passou ? 'as suítes voltam a passar — restauração íntegra.' : 'AS SUÍTES NÃO VOLTARAM AO VERDE.'}`);

const divergentes = resultados.filter(r => r.veredito !== (r.esperado ?? 'MORREU'));
const mortos = resultados.filter(r => r.veredito === 'MORREU').length;
const equivalentes = resultados.filter(r => r.esperado === 'SOBREVIVEU').length;

console.log(`\n${mortos}/${resultados.length - equivalentes} mortos entre os não equivalentes`);
console.log(`${resultados.length - divergentes.length}/${resultados.length} conforme a expectativa`);

if (divergentes.length) {
  console.log('\nDIVERGIRAM DA EXPECTATIVA — cada um exige explicação:');
  for (const d of divergentes) console.log(`  ${d.id}  esperado ${d.esperado ?? 'MORREU'}, deu ${d.veredito}`);
}

process.exitCode = divergentes.length || !depois.passou ? 1 : 0;
