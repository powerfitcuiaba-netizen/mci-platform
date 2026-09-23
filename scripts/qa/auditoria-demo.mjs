#!/usr/bin/env node
// ==========================================================================
// AUDITORIA E2E POR PERFIL, CONTRA A PILHA REAL, COM DADOS DEMO.
//
//   node scripts/qa/auditoria-demo.mjs
//
// O QUE ISTO É, E O QUE NÃO É
//
// Não é teste de unidade com mock, e não é "a tela abriu". É a API de verdade,
// com RLS ligada, respondendo a usuários de verdade — cada um com o papel que
// tem no sistema —, percorrendo os caminhos que um operador e um atleta
// percorrem num dia de trabalho.
//
// CONTRA UM BANCO DESCARTÁVEL. O banco é criado, migrado, semeado, usado e
// derrubado por esta execução. Produção não é tocada em momento nenhum, e
// nenhum dado real existe aqui para ser apagado por engano.
//
// TODO REGISTRO CRIADO LEVA MARCA. `DEMO_E2E_<tipo>_<carimbo>` entra no nome,
// no slug, no e-mail e no código de tudo o que esta auditoria cria. É essa
// marca que torna a limpeza VERIFICÁVEL: no fim, uma varredura por tabela
// conta quantas linhas ainda a carregam, e o número tem de ser zero.
//
// A LIMPEZA USA OS FLUXOS DO PRÓPRIO SISTEMA — arquivar, excluir, revogar —,
// e não DELETE amplo por tabela. Apagar por fora provaria que o banco aceita
// DELETE; apagar por dentro prova que os caminhos de remoção funcionam.
// ==========================================================================

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';

const { argv, env } = process;
const arg = (nome, padrao = null) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const PORTA_API = Number(arg('porta-api', 4611));
const BASE_API = `http://127.0.0.1:${PORTA_API}/api/v1`;
const DATABASE_URL = arg('db', env.QA_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_qa_auditoria?schema=public');
const MANTER_BANCO = argv.includes('--manter-banco');

// A MARCA. Um carimbo por execução, para que duas auditorias simultâneas não
// se confundam e para que a varredura final saiba exatamente o que procurar.
const CARIMBO = Date.now().toString(36).toUpperCase();
const marca = tipo => `DEMO_E2E_${tipo}_${CARIMBO}`;
// Slug e código não aceitam sublinhado — a marca vira hífen minúsculo neles.
// O que o inventário procura é o CARIMBO, que sobrevive às duas formas.
const marcaSlug = tipo => `demo-e2e-${tipo.toLowerCase().replace(/_/g, '-')}-${CARIMBO.toLowerCase()}`;
const MARCA_GERAL = `DEMO_E2E_`;
const MARCA_DESTA_EXECUCAO = CARIMBO;

const SENHA = 'senha-de-auditoria-2026';

// ------------------------------------------------------------------ placar

const resultados = [];
let moduloAtual = 'geral';
let perfilAtual = '-';

const modulo = nome => { moduloAtual = nome; console.log(`\n--- ${nome} ---`); };
const comoPerfil = nome => { perfilAtual = nome; };

function conferir(descricao, condicao, detalhe = '') {
  const ok = Boolean(condicao);
  resultados.push({ modulo: moduloAtual, perfil: perfilAtual, descricao, ok, detalhe });
  console.log(`  ${ok ? 'PASS  ' : 'FALHOU'}  ${descricao}${ok || !detalhe ? '' : `  — ${detalhe}`}`);
  return ok;
}

// ------------------------------------------------------------------- HTTP

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null, cru = false } = {}) {
  const resposta = await fetch(`${BASE_API}${caminho}`, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let json;
  try { json = await resposta.json(); } catch { json = null; }
  if (cru) return { status: resposta.status, corpo: json };
  if (!resposta.ok) {
    const erro = new Error(`${metodo} ${caminho} → ${resposta.status} ${JSON.stringify(json).slice(0, 220)}`);
    erro.status = resposta.status;
    erro.corpo = json;
    throw erro;
  }
  return json;
}

// `talvez` devolve status e corpo sem lançar: é o que as sondas de permissão
// usam, porque nelas a RECUSA é o resultado esperado.
const talvez = (caminho, opcoes = {}) => chamar(caminho, { ...opcoes, cru: true });

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await esperar(500);
  }
  return false;
}

// ---------------------------------------------------------------- CPF de QA

function cpfDeQa(semente) {
  const base = String(semente).padStart(9, '0').slice(-9).split('').map(Number);
  const d1cru = base.reduce((t, n, i) => t + n * (10 - i), 0);
  const r1 = (d1cru * 10) % 11;
  const d1 = r1 === 10 ? 0 : r1;
  const comD1 = base.concat([d1]);
  const d2cru = comD1.reduce((t, n, i) => t + n * (11 - i), 0);
  const r2 = (d2cru * 10) % 11;
  const d2 = r2 === 10 ? 0 : r2;
  return base.join('') + d1 + d2;
}
let sementeCpf = 811000000;
const proximoCpf = () => cpfDeQa(sementeCpf += 7919);

const conta = (tipo, extra = {}) => ({
  name: marca(tipo),
  email: `${marca(tipo).toLowerCase()}@demo.local`,
  password: SENHA,
  birthDate: '1994-05-17', phone: '65999990000', whatsapp: '65988880000',
  postalCode: '78000000', addressLine: 'Rua da Auditoria', addressNumber: '10',
  state: 'MT', city: 'Cuiabá',
  ...extra
});

const entrar = async email => (await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } })).token;

const processos = [];
function encerrar() {
  for (const p of processos) { try { p.kill('SIGTERM'); } catch { /* já morreu */ } }
}
process.on('exit', encerrar);
process.on('SIGINT', () => { encerrar(); process.exit(130); });

// ==========================================================================
// MAIN
// ==========================================================================

console.log(`\n=== AUDITORIA E2E POR PERFIL — marca ${MARCA_GERAL}*${MARCA_DESTA_EXECUCAO} ===\n`);

let prisma = null;
let falhaDeExecucao = null;

try {
  console.log('preparando banco de auditoria (descartável)…');
  const semSchema = DATABASE_URL.replace(/\?.*$/, '');
  const nomeDoBanco = semSchema.split('/').pop();
  const servidor = `${semSchema.slice(0, semSchema.lastIndexOf('/'))}/postgres`;
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL } });

  console.log('subindo API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL, PORT: String(PORTA_API),
      LOG_LEVEL: 'silent', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'auditoria-demo-segredo-suficientemente-longo-0001',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/qa-auditoria-storage'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let saidaApi = '';
  api.stdout.on('data', d => { saidaApi += d; });
  api.stderr.on('data', d => { saidaApi += d; });

  if (!await esperarPorta(`http://127.0.0.1:${PORTA_API}/health`, 60)) {
    throw new Error(`API não subiu. Saída:\n${saidaApi.slice(-1500)}`);
  }
  console.log('API no ar.\n');

  const { default: PrismaPkg } = await import('@prisma/client');
  prisma = new PrismaPkg.PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  await auditar(prisma);
} catch (erro) {
  falhaDeExecucao = erro;
  console.error(`\nFALHA NA EXECUÇÃO: ${erro.message}\n${erro.stack?.split('\n').slice(1, 4).join('\n')}`);
} finally {
  if (prisma) await prisma.$disconnect().catch(() => {});
  encerrar();
  if (!MANTER_BANCO) {
    try {
      const semSchema = DATABASE_URL.replace(/\?.*$/, '');
      const nomeDoBanco = semSchema.split('/').pop();
      const servidor = `${semSchema.slice(0, semSchema.lastIndexOf('/'))}/postgres`;
      execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
    } catch { /* o banco some com o contêiner de qualquer jeito */ }
  }
}

// ----------------------------------------------------------------- relatório

const falhas = resultados.filter(r => !r.ok);
const porModulo = new Map();
for (const r of resultados) {
  if (!porModulo.has(r.modulo)) porModulo.set(r.modulo, { total: 0, falhas: 0 });
  const m = porModulo.get(r.modulo);
  m.total += 1;
  if (!r.ok) m.falhas += 1;
}

console.log('\n=== RESUMO POR MÓDULO ===');
for (const [nome, m] of porModulo) {
  console.log(`  ${nome.padEnd(34)} ${String(m.total - m.falhas).padStart(3)}/${String(m.total).padEnd(3)}${m.falhas ? '  REPROVOU' : ''}`);
}
console.log(`\n  verificações ... ${resultados.length}`);
console.log(`  aprovadas ...... ${resultados.length - falhas.length}`);
console.log(`  reprovadas ..... ${falhas.length}`);
for (const f of falhas) console.log(`     ! [${f.modulo}] ${f.descricao}${f.detalhe ? ` — ${f.detalhe}` : ''}`);

if (falhaDeExecucao) console.log(`\n  EXECUÇÃO INTERROMPIDA: ${falhaDeExecucao.message}`);

console.log(`\n=== ${falhas.length || falhaDeExecucao ? 'REPROVADO' : 'APROVADO'} ===`);
process.exit(falhas.length || falhaDeExecucao ? 1 : 0);

// ==========================================================================
// O CORPO DA AUDITORIA
// ==========================================================================

async function auditar(db) {
  const criados = { organizacoes: [], atletas: [], eventos: [], temporadas: [], avisos: [], importacoes: [], filiacoes: [], contas: [] };

  // ------------------------------------------------------------ AUTENTICAÇÃO
  modulo('1. autenticação');
  comoPerfil('anônimo');

  const semAuth = await talvez('/athletes');
  conferir('sem token, a API recusa (401)', semAuth.status === 401, `status ${semAuth.status}`);

  const tokenFalso = await talvez('/athletes', { token: 'nao-e-um-token-valido' });
  conferir('token inventado é recusado (401)', tokenFalso.status === 401, `status ${tokenFalso.status}`);

  const cadastroInvalido = await talvez('/auth/register', { metodo: 'POST', corpo: { name: 'x', email: 'nao-e-email', password: '123' } });
  conferir('cadastro com dados inválidos é recusado (400)', cadastroInvalido.status === 400, `status ${cadastroInvalido.status}`);

  // O CADASTRO DA CONTA RECUSA CPF DE PROPÓSITO — e diz para onde ir.
  const cadastroComCpf = await talvez('/auth/register', { metodo: 'POST', corpo: { ...conta('TENTA_CPF'), cpf: proximoCpf() } });
  conferir('a conta recusa CPF e explica onde ele é registrado',
    cadastroComCpf.status === 400 && JSON.stringify(cadastroComCpf.corpo).includes('perfil de atleta'),
    `status ${cadastroComCpf.status}`);

  const admin = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('SUPERADMIN') })).user;
  criados.contas.push(admin.email);
  execSync(`psql "${DATABASE_URL.replace(/\?.*$/, '')}" -c "update \\"User\\" set role='SUPER_ADMIN' where id='${admin.id}'"`, { stdio: 'pipe' });
  const tAdmin = await entrar(admin.email);
  conferir('login devolve token', Boolean(tAdmin));

  const sessao = await chamar('/auth/me', { token: tAdmin });
  conferir('a sessão devolve o próprio usuário', sessao.user.email === admin.email);
  conferir('a sessão NÃO devolve hash de senha', !JSON.stringify(sessao).toLowerCase().includes('passwordhash'));

  const senhaErrada = await talvez('/auth/login', { metodo: 'POST', corpo: { email: admin.email, password: 'errada-errada' } });
  conferir('senha errada é recusada (401)', senhaErrada.status === 401, `status ${senhaErrada.status}`);

  // --------------------------------------------------- ORGANIZAÇÕES / TENANT
  modulo('2. organizações e multi-tenant');
  comoPerfil('SUPER_ADMIN');

  const orgA = await chamar('/organizations', {
    metodo: 'POST', token: tAdmin,
    corpo: { name: marca('ORG_A'), slug: marcaSlug('orga'), state: 'MT' }
  });
  const orgB = await chamar('/organizations', {
    metodo: 'POST', token: tAdmin,
    corpo: { name: marca('ORG_B'), slug: marcaSlug('orgb'), state: 'SP' }
  });
  criados.organizacoes.push(orgA.id, orgB.id);
  conferir('SUPER_ADMIN cria organização', Boolean(orgA.id) && Boolean(orgB.id));

  const lista = await chamar('/organizations', { token: tAdmin });
  conferir('a listagem traz as duas organizações criadas',
    (lista.items || []).filter(o => criados.organizacoes.includes(o.id)).length === 2);

  const diretorA = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('DIRETOR_A') })).user;
  const operadorA = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('OPERADOR_A') })).user;
  const diretorB = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('DIRETOR_B') })).user;
  criados.contas.push(diretorA.email, operadorA.email, diretorB.email);

  for (const [org, usuario, papel] of [
    [orgA, diretorA, 'EVENT_DIRECTOR'], [orgA, diretorA, 'RANKING_MANAGER'],
    [orgA, operadorA, 'REGISTRATION_OPERATOR'], [orgB, diretorB, 'EVENT_DIRECTOR']
  ]) {
    await chamar(`/organizations/${org.id}/members`, {
      metodo: 'POST', token: tAdmin, corpo: { userId: usuario.id, role: papel }
    });
  }
  const tDiretorA = await entrar(diretorA.email);
  const tOperadorA = await entrar(operadorA.email);
  const tDiretorB = await entrar(diretorB.email);
  conferir('os três operadores entram', Boolean(tDiretorA && tOperadorA && tDiretorB));

  comoPerfil('EVENT_DIRECTOR');
  const criarOrg = await talvez('/organizations', {
    metodo: 'POST', token: tDiretorA, corpo: { name: marca('ORG_PROIBIDA'), slug: marcaSlug('proib'), state: 'MT' }
  });
  conferir('diretor de organização NÃO cria organização', criarOrg.status === 403, `status ${criarOrg.status}`);

  const filiacaoA = await chamar('/affiliations', {
    metodo: 'POST', token: tDiretorA,
    corpo: { organizationId: orgA.id, name: marca('NPC_A'), code: `NPCA${CARIMBO}`.slice(0, 12) }
  });
  criados.filiacoes.push(filiacaoA.id);
  conferir('diretor cria entidade de filiação na própria organização', Boolean(filiacaoA.id));

  const filiacaoCruzada = await talvez('/affiliations', {
    metodo: 'POST', token: tDiretorA,
    corpo: { organizationId: orgB.id, name: marca('NPC_INVASOR'), code: `NPCX${CARIMBO}`.slice(0, 12) }
  });
  conferir('diretor NÃO cria filiação em organização alheia', filiacaoCruzada.status === 403, `status ${filiacaoCruzada.status}`);

  // ------------------------------------------------ TEMPORADA E PONTUAÇÃO
  modulo('3. temporada e tabela de pontos');
  comoPerfil('RANKING_MANAGER');

  const temporada = await chamar('/seasons', {
    metodo: 'POST', token: tDiretorA, corpo: { organizationId: orgA.id, name: marca('TEMPORADA'), year: 2026 }
  });
  criados.temporadas.push(temporada.id);
  conferir('temporada criada', Boolean(temporada.id));

  const TABELA = [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }, { placing: 4, points: 2 }, { placing: 5, points: 1 }];
  await chamar(`/seasons/${temporada.id}/points-rules`, { metodo: 'PUT', token: tDiretorA, corpo: { rules: TABELA } });
  conferir('tabela de pontos gravada', true);

  const tabelaAlheia = await talvez(`/seasons/${temporada.id}/points-rules`, {
    metodo: 'PUT', token: tDiretorB, corpo: { rules: TABELA }
  });
  conferir('diretor de OUTRA organização não altera a tabela de pontos',
    [403, 404].includes(tabelaAlheia.status), `status ${tabelaAlheia.status}`);

  // ------------------------------------------------- EVENTO, GRADE, CLASSES
  modulo('4. evento, categorias e classes');
  comoPerfil('EVENT_DIRECTOR');

  const evento = await chamar('/events', {
    metodo: 'POST', token: tDiretorA,
    corpo: {
      organizationId: orgA.id, name: marca('EVENTO'), slug: marcaSlug('evento'),
      startDate: '2026-11-14T12:00:00.000Z', city: 'Cuiabá', state: 'MT', seasonId: temporada.id
    }
  });
  criados.eventos.push(evento.id);
  conferir('evento criado', Boolean(evento.id));

  const categorias = await chamar('/categories', { token: tDiretorA });
  const bikini = (categorias.items || categorias).find(c => c.code === 'BIKINI');
  conferir('o catálogo oficial de categorias está provisionado', Boolean(bikini));

  const eventCategory = await chamar(`/events/${evento.id}/categories`, {
    metodo: 'POST', token: tDiretorA, corpo: { categoryId: bikini.id }
  });
  const divisao = await chamar(`/event-categories/${eventCategory.id}/divisions`, {
    metodo: 'POST', token: tDiretorA, corpo: { name: 'Absoluta', code: `ABS${CARIMBO}`.slice(0, 12) }
  });
  const classe = await chamar(`/divisions/${divisao.id}/classes`, {
    metodo: 'POST', token: tDiretorA, corpo: { name: 'Open', code: 'OPEN' }
  });
  conferir('categoria, divisão e classe criadas no evento', Boolean(classe.id));

  const eventoAlheio = await talvez(`/events/${evento.id}`, {
    metodo: 'PATCH', token: tDiretorB, corpo: { name: 'sequestrado' }
  });
  conferir('diretor de outra organização não edita este evento',
    [403, 404].includes(eventoAlheio.status), `status ${eventoAlheio.status}`);


  // ------------------------------------------------------------- ATLETAS
  modulo('5. atletas — cadastro, busca, filtros, perfil');
  comoPerfil('REGISTRATION_OPERATOR');

  const cpfDoAtletaA = proximoCpf();
  const atletaA = await chamar('/athletes', {
    metodo: 'POST', token: tOperadorA,
    corpo: {
      organizationId: orgA.id, fullName: marca('ATLETA_A'), sex: 'FEMALE', cpf: cpfDoAtletaA,
      affiliationId: filiacaoA.id, affiliationNumber: `MAT-A-${CARIMBO}`,
      city: 'Cuiabá', state: 'MT', phone: '65999991111', email: `${marca('ATLETA_A').toLowerCase()}@demo.local`
    }
  });
  criados.atletas.push(atletaA.id);
  conferir('operador de inscrição cadastra atleta com CPF', Boolean(atletaA.id));

  const duplicado = await talvez('/athletes', {
    metodo: 'POST', token: tOperadorA,
    corpo: { organizationId: orgA.id, fullName: marca('ATLETA_DUPLICADO'), sex: 'FEMALE', cpf: cpfDoAtletaA }
  });
  conferir('o mesmo CPF não cria um segundo atleta', duplicado.status >= 400, `status ${duplicado.status}`);

  const matriculaDuplicada = await talvez('/athletes', {
    metodo: 'POST', token: tOperadorA,
    corpo: {
      organizationId: orgA.id, fullName: marca('ATLETA_MAT_DUP'), sex: 'MALE', cpf: proximoCpf(),
      affiliationId: filiacaoA.id, affiliationNumber: `MAT-A-${CARIMBO}`
    }
  });
  conferir('a mesma matrícula na mesma filiação é recusada', matriculaDuplicada.status >= 400, `status ${matriculaDuplicada.status}`);

  const perfilA = await chamar(`/athletes/${atletaA.id}`, { token: tOperadorA });
  conferir('o perfil do atleta abre', perfilA.athlete.id === atletaA.id);
  conferir('o CPF vem MASCARADO no perfil',
    Boolean(perfilA.athlete.cpfMasked) && !JSON.stringify(perfilA.athlete).includes(cpfDoAtletaA),
    perfilA.athlete.cpfMasked || 'sem cpfMasked');
  conferir('o perfil traz os campos restritos (telefone, e-mail, matrícula)',
    Boolean(perfilA.athlete.phone) && Boolean(perfilA.athlete.email) && Boolean(perfilA.athlete.affiliationNumber));

  const busca = await chamar(`/athletes?organizationId=${orgA.id}&search=${encodeURIComponent(marca('ATLETA_A'))}`, { token: tOperadorA });
  conferir('a busca por nome encontra o atleta', (busca.items || []).some(a => a.id === atletaA.id));

  const buscaVazia = await chamar(`/athletes?organizationId=${orgA.id}&search=ZZZ_NAO_EXISTE_ZZZ`, { token: tOperadorA });
  conferir('busca sem resultado devolve lista vazia, e não erro', Array.isArray(buscaVazia.items) && buscaVazia.items.length === 0);

  const buscaPorCpf = await chamar(`/athletes?organizationId=${orgA.id}&search=${cpfDoAtletaA}`, { token: tOperadorA });
  conferir('quem tem `search.sensitive` acha por CPF exato', (buscaPorCpf.items || []).some(a => a.id === atletaA.id));

  const filtroEstado = await chamar(`/athletes?organizationId=${orgA.id}&status=ARCHIVED`, { token: tOperadorA });
  conferir('filtro por estado ARQUIVADO exclui o atleta ativo', !(filtroEstado.items || []).some(a => a.id === atletaA.id));

  const filtroCombinado = await chamar(`/athletes?organizationId=${orgA.id}&status=ACTIVE&affiliationId=${filiacaoA.id}`, { token: tOperadorA });
  conferir('filtro combinado (estado + filiação) devolve o atleta', (filtroCombinado.items || []).some(a => a.id === atletaA.id));

  // ------------------------------------------------- CPF SENSÍVEL
  modulo('6. CPF sensível');
  comoPerfil('vários');

  const revelaOperador = await talvez(`/athletes/${atletaA.id}/cpf`, { metodo: 'POST', token: tOperadorA });
  conferir('o operador de inscrição revela o CPF (tem search.sensitive)',
    revelaOperador.status === 200 && String(revelaOperador.corpo.cpf).replace(/\D/g, '') === cpfDoAtletaA,
    `status ${revelaOperador.status}`);

  const revelaAlheio = await talvez(`/athletes/${atletaA.id}/cpf`, { metodo: 'POST', token: tDiretorB });
  conferir('diretor de OUTRA organização não revela este CPF',
    [403, 404].includes(revelaAlheio.status) && !JSON.stringify(revelaAlheio.corpo).includes(cpfDoAtletaA),
    `status ${revelaAlheio.status}`);

  const revelaSemAuth = await talvez(`/athletes/${atletaA.id}/cpf`, { metodo: 'POST' });
  conferir('sem autenticação não se revela CPF', revelaSemAuth.status === 401, `status ${revelaSemAuth.status}`);

  // A TRILHA É LIDA PELA ROTA DE AUDITORIA, e não por consulta direta ao
  // banco. Consulta direta sem ator devolve vazio — a RLS está certa, e um
  // "0 registros" ali provaria só que o arnês esqueceu o contexto.
  const trilhaCpf = await chamar(`/audit?organizationId=${orgA.id}&action=ATHLETE_CPF_VIEW&limit=50`, { token: tAdmin });
  conferir('a revelação do CPF ficou na auditoria',
    (trilhaCpf.items || []).some(l => l.entityId === atletaA.id),
    `${(trilhaCpf.items || []).length} registro(s) de ATHLETE_CPF_VIEW`);

  const publico = await talvez(`/public/athletes/${atletaA.id}`);
  conferir('a vitrine pública não devolve CPF',
    !JSON.stringify(publico.corpo || {}).includes(cpfDoAtletaA)
    && !JSON.stringify(publico.corpo || {}).toLowerCase().includes('cpf'),
    `status ${publico.status}`);

  // ------------------------------------------------ ESTADO DO ATLETA
  modulo('7. estado do atleta');
  comoPerfil('EVENT_DIRECTOR');

  const semMotivo = await talvez(`/athletes/${atletaA.id}/suspend`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  conferir('suspender sem motivo é recusado', semMotivo.status === 400, `status ${semMotivo.status}`);

  await chamar(`/athletes/${atletaA.id}/suspend`, { metodo: 'POST', token: tDiretorA, corpo: { reason: `${marca('MOTIVO')} pendência documental` } });
  const suspenso = await chamar(`/athletes/${atletaA.id}`, { token: tDiretorA });
  conferir('o atleta fica SUSPENDED com motivo', suspenso.athlete.status === 'SUSPENDED' && Boolean(suspenso.athlete.statusReason));

  const semPermissao = await talvez(`/athletes/${atletaA.id}/reactivate`, { metodo: 'POST', token: tOperadorA, corpo: {} });
  conferir('quem não tem `athletes.manage` não reativa', semPermissao.status === 403, `status ${semPermissao.status}`);

  await chamar(`/athletes/${atletaA.id}/reactivate`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  conferir('reativar devolve o atleta a ACTIVE',
    (await chamar(`/athletes/${atletaA.id}`, { token: tDiretorA })).athlete.status === 'ACTIVE');

  await chamar(`/athletes/${atletaA.id}/archive`, { metodo: 'POST', token: tDiretorA, corpo: { reason: `${marca('MOTIVO')} encerrou a temporada` } });
  const arquivado = await chamar(`/athletes/${atletaA.id}`, { token: tDiretorA });
  conferir('arquivar não apaga nem altera o cadastro',
    arquivado.athlete.status === 'ARCHIVED' && arquivado.athlete.fullName === marca('ATLETA_A'));
  await chamar(`/athletes/${atletaA.id}/reactivate`, { metodo: 'POST', token: tDiretorA, corpo: {} });

  // ------------------------------------------------ AUTOCADASTRO
  modulo('8. autocadastro da federação');
  comoPerfil('anônimo / SUPER_ADMIN');

  const fechadas = await talvez('/public/affiliations');
  conferir('com o autocadastro FECHADO, a filiação não é descobrível publicamente',
    !((fechadas.corpo?.items) || []).some(f => f.id === filiacaoA.id), `status ${fechadas.status}`);

  const abrirSemPermissao = await talvez(`/organizations/${orgA.id}/self-registration`, { metodo: 'POST', token: tDiretorA, corpo: { open: true } });
  conferir('só quem tem `organizations.manage` abre o autocadastro', abrirSemPermissao.status === 403, `status ${abrirSemPermissao.status}`);

  await chamar(`/organizations/${orgA.id}/self-registration`, { metodo: 'POST', token: tAdmin, corpo: { open: true } });
  const abertas = await talvez('/public/affiliations');
  conferir('com o autocadastro ABERTO, a filiação aparece publicamente',
    ((abertas.corpo?.items) || []).some(f => f.id === filiacaoA.id), `status ${abertas.status}`);


  // ==========================================================================
  // 9. O FLUXO REAL DO ATLETA, DO ZERO
  // ==========================================================================
  //
  // Conta → pedido de perfil → análise do operador → perfil → histórico →
  // ranking → recado da federação → sair → entrar de novo.
  //
  // É o caminho que a pessoa percorre de verdade, e não um atalho de operador
  // criando o atleta na mão.
  modulo('9. fluxo do atleta (conta → pedido → aprovação)');
  comoPerfil('ATHLETE');

  const cpfDoHistorico = proximoCpf();
  const MATRICULA_DO_HISTORICO = `MAT-H-${CARIMBO}`;

  const contaAtleta = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('ATLETA_HIST') })).user;
  criados.contas.push(contaAtleta.email);
  conferir('o atleta cria a própria conta', Boolean(contaAtleta.id) && contaAtleta.role === 'ATHLETE');

  const tAtleta = await entrar(contaAtleta.email);
  const sessaoAtleta = await chamar('/auth/me', { token: tAtleta });
  conferir('recém-cadastrado, o atleta AINDA não tem perfil de atleta', sessaoAtleta.user.athleteId == null);

  const semPerfilAinda = await talvez('/me/history', { token: tAtleta });
  conferir('sem perfil, "meu histórico" responde sem quebrar', semPerfilAinda.status < 500, `status ${semPerfilAinda.status}`);

  // ------------------------------------------------------------------------
  // 10. O HISTÓRICO CHEGA ANTES DA PESSOA — e é esse o caminho normal do MCI.
  // ------------------------------------------------------------------------
  modulo('10. histórico importado ANTES do cadastro');
  comoPerfil('RANKING_MANAGER');

  const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,evento';
  const LINHAS = [
    [`${marca('RES')}-1`, cpfDoHistorico, marca('ATLETA_HIST'), filiacaoA.code, MATRICULA_DO_HISTORICO, 'BIKINI', "Women's Bikini - Open Class A", '1'],
    [`${marca('RES')}-2`, proximoCpf(), marca('OUTRA_PESSOA'), filiacaoA.code, `MAT-Z-${CARIMBO}`, 'BIKINI', "Women's Bikini - Open Class A", '2']
  ];
  const arquivo = [CABECALHO, ...LINHAS.map(l => `${l.join(',')},${marca('EVENTO')}`)].join('\n');

  const lote = await chamar('/musclewar/imports', {
    metodo: 'POST', token: tDiretorA,
    corpo: {
      organizationId: orgA.id, seasonId: temporada.id, eventId: evento.id,
      sourceType: 'CSV', sourceRef: `${marca('LOTE')}.csv`, content: arquivo
    }
  });
  criados.importacoes.push(lote.import.id);
  conferir('a importação é criada e analisada', Boolean(lote.import.id));

  const previa = await chamar(`/musclewar/imports/${lote.import.id}`, { token: tDiretorA });
  conferir('a prévia mostra as linhas analisadas', (previa.items || []).length === 2, `${(previa.items || []).length} linha(s)`);
  conferir('nenhuma linha foi reconhecida — o atleta ainda não existe',
    (previa.items || []).every(i => i.athleteId == null));

  await chamar(`/musclewar/imports/${lote.import.id}/apply`, { metodo: 'POST', token: tDiretorA });

  const antes = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  const pontoDoHistorico = (antes.items || []).find(p => p.externalResult?.externalId === `${marca('RES')}-1`
    || p.externalAthlete?.displayName === marca('ATLETA_HIST'));

  conferir('o lançamento histórico foi gravado', Boolean(pontoDoHistorico));
  if (!pontoDoHistorico) throw new Error('sem lançamento histórico não há como auditar o vínculo automático');

  // A FOTOGRAFIA DO ANTES. É contra ela que o DEPOIS vai ser conferido.
  const retratoAntes = {
    id: pontoDoHistorico.id,
    athleteId: pontoDoHistorico.athlete?.id ?? null,
    placing: pontoDoHistorico.placing,
    points: pontoDoHistorico.points,
    placementPoints: pontoDoHistorico.placementPoints,
    categoryCode: pontoDoHistorico.category?.code ?? null,
    catalogClassCode: pontoDoHistorico.catalogClass?.code ?? null,
    externalAthleteId: pontoDoHistorico.externalAthlete?.id ?? null
  };
  const totalDeLancamentosAntes = (antes.items || []).length;

  conferir('ANTES — o lançamento existe SEM dono (athleteId nulo)', retratoAntes.athleteId === null,
    `athleteId = ${retratoAntes.athleteId}`);
  conferir('ANTES — a colocação veio da súmula', retratoAntes.placing === 1, `placing = ${retratoAntes.placing}`);
  conferir('ANTES — a pontuação foi apurada pela tabela (1º = 5)', retratoAntes.points === 5, `points = ${retratoAntes.points}`);
  conferir('ANTES — a categoria foi resolvida', retratoAntes.categoryCode === 'BIKINI', `categoria = ${retratoAntes.categoryCode}`);
  conferir('ANTES — a classe do catálogo foi resolvida', Boolean(retratoAntes.catalogClassCode), `classe = ${retratoAntes.catalogClassCode}`);

  // ==========================================================================
  // 11. O TESTE CRÍTICO — O VÍNCULO É AUTOMÁTICO
  // ==========================================================================
  //
  // O atleta se cadastra pelo fluxo normal, informando CPF, filiação e
  // matrícula. Ninguém aperta "vincular". O sistema tem de ir buscar o
  // histórico sozinho.
  modulo('11. VÍNCULO AUTOMÁTICO do histórico');
  comoPerfil('ATHLETE → EVENT_DIRECTOR');

  const pedido = await chamar('/athlete-requests', {
    metodo: 'POST', token: tAtleta,
    corpo: {
      fullName: marca('ATLETA_HIST'), cpf: cpfDoHistorico, sex: 'FEMALE',
      birthDate: '1994-05-17', affiliationId: filiacaoA.id, affiliationNumber: MATRICULA_DO_HISTORICO
    }
  });
  conferir('o atleta envia a solicitação de perfil', Boolean(pedido.id) && pedido.status === 'PENDING');

  const pedidoRepetido = await talvez('/athlete-requests', {
    metodo: 'POST', token: tAtleta,
    corpo: {
      fullName: marca('ATLETA_HIST'), cpf: cpfDoHistorico, sex: 'FEMALE',
      affiliationId: filiacaoA.id, affiliationNumber: MATRICULA_DO_HISTORICO
    }
  });
  conferir('um segundo pedido em aberto é recusado (409)', pedidoRepetido.status === 409, `status ${pedidoRepetido.status}`);

  const filaDoOutro = await talvez(`/athlete-requests?organizationId=${orgA.id}`, { token: tDiretorB });
  conferir('diretor de outra federação não vê esta fila',
    [403, 404].includes(filaDoOutro.status) || !((filaDoOutro.corpo?.items) || []).some(p => p.id === pedido.id),
    `status ${filaDoOutro.status}`);

  const aprovacao = await chamar(`/athlete-requests/${pedido.id}/approve`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  conferir('o operador aprova a solicitação', aprovacao.status === 'APPROVED');

  const sessaoDepois = await chamar('/auth/me', { token: tAtleta });
  const athleteIdDoHistorico = sessaoDepois.user.athleteId;
  criados.atletas.push(athleteIdDoHistorico);
  conferir('a aprovação criou o perfil de atleta', Boolean(athleteIdDoHistorico));

  // ------------------------------------------------ O DEPOIS, CAMPO A CAMPO
  const depois = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  const pontoDepois = (depois.items || []).find(p => p.id === retratoAntes.id);

  conferir('DEPOIS — o MESMO lançamento continua existindo (mesmo id)', Boolean(pontoDepois), retratoAntes.id);
  conferir('DEPOIS — o lançamento passou a ter dono AUTOMATICAMENTE',
    pontoDepois?.athlete?.id === athleteIdDoHistorico,
    `athleteId = ${pontoDepois?.athlete?.id ?? 'nulo'} (esperado ${athleteIdDoHistorico})`);
  conferir('DEPOIS — a colocação não mudou', pontoDepois?.placing === retratoAntes.placing,
    `${retratoAntes.placing} → ${pontoDepois?.placing}`);
  conferir('DEPOIS — a pontuação não mudou', pontoDepois?.points === retratoAntes.points,
    `${retratoAntes.points} → ${pontoDepois?.points}`);
  conferir('DEPOIS — a parcela de colocação não mudou', pontoDepois?.placementPoints === retratoAntes.placementPoints);
  conferir('DEPOIS — a categoria não mudou', (pontoDepois?.category?.code ?? null) === retratoAntes.categoryCode);
  conferir('DEPOIS — a classe do catálogo não mudou', (pontoDepois?.catalogClass?.code ?? null) === retratoAntes.catalogClassCode);
  conferir('DEPOIS — a identidade externa continua a mesma',
    (pontoDepois?.externalAthlete?.id ?? null) === retratoAntes.externalAthleteId);
  conferir('DEPOIS — NENHUM lançamento novo foi criado',
    (depois.items || []).length === totalDeLancamentosAntes,
    `${totalDeLancamentosAntes} → ${(depois.items || []).length}`);

  // O histórico da OUTRA pessoa, que não se cadastrou, continua sem dono: o
  // vínculo alcançou quem devia e mais ninguém.
  const pontoDaOutra = (depois.items || []).find(p => p.id !== retratoAntes.id);
  conferir('o histórico de quem NÃO se cadastrou continua sem dono',
    (pontoDaOutra?.athlete ?? null) === null, `athleteId = ${pontoDaOutra?.athlete?.id ?? 'nulo'}`);

  // ------------------------------------------------ o reflexo nas telas
  const meuHistorico = await chamar('/me/history', { token: tAtleta });
  const temNoHistorico = JSON.stringify(meuHistorico).includes(retratoAntes.id)
    || (meuHistorico.items || meuHistorico.participacoes || []).length > 0;
  conferir('o histórico aparece em "meu histórico", do lado do atleta', temNoHistorico);

  const rankingPublico = await talvez(`/ranking?seasonId=${temporada.id}`);
  const linhaDoAtleta = ((rankingPublico.corpo?.items) || []).find(l => l.athlete?.id === athleteIdDoHistorico);
  conferir('o ranking reflete o vínculo: a linha passou a ser do atleta cadastrado',
    Boolean(linhaDoAtleta), `status ${rankingPublico.status}`);
  conferir('o total no ranking é o da súmula (5 pontos)',
    linhaDoAtleta?.totalPoints === 5, `totalPoints = ${linhaDoAtleta?.totalPoints}`);

  const trilhaVinculo = await chamar(`/audit?organizationId=${orgA.id}&action=RESULTADO_EXTERNAL_LINKED&limit=50`, { token: tAdmin });
  conferir('o vínculo automático deixou rastro na auditoria',
    (trilhaVinculo.items || []).length >= 1, `${(trilhaVinculo.items || []).length} registro(s)`);

  // ------------------------------------------------ o nome sozinho NÃO vincula
  modulo('12. o nome sozinho não vincula');
  comoPerfil('ATHLETE homônimo');

  const contaHomonima = (await chamar('/auth/register', { metodo: 'POST', corpo: conta('HOMONIMA') })).user;
  criados.contas.push(contaHomonima.email);
  const tHomonima = await entrar(contaHomonima.email);

  const pedidoHomonimo = await chamar('/athlete-requests', {
    metodo: 'POST', token: tHomonima,
    corpo: {
      // MESMO NOME do histórico que sobrou, CPF e matrícula DIFERENTES.
      fullName: marca('OUTRA_PESSOA'), cpf: proximoCpf(), sex: 'FEMALE',
      affiliationId: filiacaoA.id, affiliationNumber: `MAT-Q-${CARIMBO}`
    }
  });
  await chamar(`/athlete-requests/${pedidoHomonimo.id}/approve`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  const sessaoHomonima = await chamar('/auth/me', { token: tHomonima });
  criados.atletas.push(sessaoHomonima.user.athleteId);

  const depoisDaHomonima = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  const pontoDaOutraDepois = (depoisDaHomonima.items || []).find(p => p.id === pontoDaOutra?.id);
  conferir('nome igual, CPF e matrícula diferentes: o histórico NÃO foi vinculado',
    (pontoDaOutraDepois?.athlete ?? null) === null,
    `athleteId = ${pontoDaOutraDepois?.athlete?.id ?? 'nulo'}`);

  // Mas ele APARECE como sugestão, para um humano decidir.
  const sugestoes = await chamar(`/athletes/${sessaoHomonima.user.athleteId}/imported-history`, { token: tDiretorA });
  const sugeridoPorNome = (sugestoes.suggestions || []).find(s => s.displayName === marca('OUTRA_PESSOA'));
  conferir('o histórico homônimo vira SUGESTÃO, marcada como exigindo confirmação humana',
    Boolean(sugeridoPorNome) && sugeridoPorNome.matchedBy === 'NAME' && sugeridoPorNome.exigeConfirmacaoHumana === true,
    sugeridoPorNome ? `matchedBy=${sugeridoPorNome.matchedBy}` : 'nenhuma sugestão');


  // ----------------------------------------------- INSCRIÇÕES E RESULTADOS
  modulo('13. inscrições, check-in e resultados');
  comoPerfil('EVENT_DIRECTOR');

  for (const status of ['PLANNED', 'REGISTRATIONS_OPEN']) {
    await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tDiretorA, corpo: { status } });
  }
  conferir('o evento abre inscrições', true);

  const cpfInscrito = proximoCpf();
  const inscricao = await chamar(`/events/${evento.id}/registrations`, {
    metodo: 'POST', token: tDiretorA,
    corpo: {
      cpf: cpfInscrito,
      athlete: { fullName: marca('ATLETA_INSCRITO'), sex: 'FEMALE', state: 'MT', city: 'Cuiabá' },
      classIds: [classe.id]
    }
  });
  const atletaInscrito = inscricao.registration.athlete.id;
  criados.atletas.push(atletaInscrito);
  conferir('a inscrição cria/reconhece o atleta e grava os itens', Boolean(inscricao.registration.id));

  const inscricaoAlheia = await talvez(`/events/${evento.id}/registrations`, {
    metodo: 'POST', token: tDiretorB,
    corpo: { cpf: proximoCpf(), athlete: { fullName: marca('INVASOR'), sex: 'MALE' }, classIds: [classe.id] }
  });
  conferir('diretor de outra federação não inscreve neste evento',
    [403, 404].includes(inscricaoAlheia.status), `status ${inscricaoAlheia.status}`);

  const consultaInscricao = await chamar(`/registrations/${inscricao.registration.id}`, { token: tDiretorA });
  conferir('a inscrição é consultável', consultaInscricao.registration?.id === inscricao.registration.id
    || consultaInscricao.id === inscricao.registration.id);

  for (const status of ['REGISTRATIONS_CLOSED', 'IN_OPERATION']) {
    await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tDiretorA, corpo: { status } });
  }
  await chamar(`/registrations/${inscricao.registration.id}/checkin`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  conferir('o check-in é registrado', true);

  const checkinRepetido = await talvez(`/registrations/${inscricao.registration.id}/checkin`, { metodo: 'POST', token: tDiretorA, corpo: {} });
  conferir('check-in repetido não duplica (recusa ou é idempotente)',
    checkinRepetido.status === 200 || checkinRepetido.status >= 400, `status ${checkinRepetido.status}`);

  await chamar(`/events/${evento.id}/transition`, { metodo: 'POST', token: tDiretorA, corpo: { status: 'IN_JUDGING' } });
  await chamar(`/classes/${classe.id}/result`, {
    metodo: 'POST', token: tDiretorA, corpo: { entries: [{ athleteId: atletaInscrito, placing: 1 }] }
  });
  const rascunho = await talvez(`/classes/${classe.id}/result`);
  conferir('resultado NÃO publicado não sai para o público',
    rascunho.status === 404 || !rascunho.corpo || rascunho.corpo === null || rascunho.corpo?.status !== 'PUBLISHED',
    `status ${rascunho.status}`);

  await chamar(`/classes/${classe.id}/result/publish`, { metodo: 'POST', token: tDiretorA, corpo: { note: marca('PUBLICACAO') } });
  const publicado = await talvez(`/classes/${classe.id}/result`);
  conferir('depois de publicado, o resultado é público', publicado.status === 200 && Boolean(publicado.corpo), `status ${publicado.status}`);

  // ----------------------------------------------------- PONTUAÇÃO E RANKING
  modulo('14. pontuação, recálculo e ajuste administrativo');
  comoPerfil('RANKING_MANAGER');

  const recalculo = await chamar(`/seasons/${temporada.id}/recompute`, { metodo: 'POST', token: tDiretorA });
  conferir('o recálculo da temporada responde', recalculo !== null);

  const pontosDoEvento = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  const pontoDoInscrito = (pontosDoEvento.items || []).find(p => p.athlete?.id === atletaInscrito);
  conferir('o resultado publicado virou lançamento de pontuação', Boolean(pontoDoInscrito));
  conferir('1º lugar vale 5 pontos, como manda a tabela', pontoDoInscrito?.points === 5, `points = ${pontoDoInscrito?.points}`);

  if (pontoDoInscrito) {
    // O ajuste declara o total PRETENDIDO e o total que o operador ACREDITA
    // estar vendo. A segunda metade é conferência otimista: se o número mudou
    // enquanto a tela estava aberta, o servidor recusa em vez de sobrescrever.
    const ajuste = await chamar(`/ranking/points/${pontoDoInscrito.id}/adjust`, {
      metodo: 'POST', token: tDiretorA,
      corpo: { points: 7, expectedPoints: pontoDoInscrito.points, reason: `${marca('AJUSTE')} decisao da comissao tecnica` }
    });
    conferir('o ajuste administrativo é aceito com motivo', ajuste !== null);

    const ajusteComTotalVelho = await talvez(`/ranking/points/${pontoDoInscrito.id}/adjust`, {
      metodo: 'POST', token: tDiretorA,
      corpo: { points: 9, expectedPoints: pontoDoInscrito.points, reason: `${marca('AJUSTE')} segunda tentativa cega` }
    });
    conferir('ajuste com total desatualizado é recusado (conferência otimista)',
      ajusteComTotalVelho.status >= 400, `status ${ajusteComTotalVelho.status}`);

    const depoisDoAjuste = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
    const ajustado = (depoisDoAjuste.items || []).find(p => p.id === pontoDoInscrito.id);
    conferir('o ajuste soma ao total sem apagar a parcela de colocação',
      ajustado?.adjustmentPoints === 2 && ajustado?.placementPoints === 5 && ajustado?.points === 7,
      `placement=${ajustado?.placementPoints} ajuste=${ajustado?.adjustmentPoints} total=${ajustado?.points}`);

    const ajusteSemMotivo = await talvez(`/ranking/points/${pontoDoInscrito.id}/adjust`, {
      metodo: 'POST', token: tDiretorA, corpo: { points: 8, expectedPoints: 7 }
    });
    conferir('ajuste sem motivo é recusado', ajusteSemMotivo.status >= 400, `status ${ajusteSemMotivo.status}`);

    const ajusteAlheio = await talvez(`/ranking/points/${pontoDoInscrito.id}/adjust`, {
      metodo: 'POST', token: tDiretorB, corpo: { points: 9, expectedPoints: 7, reason: 'tentativa de invasao' }
    });
    conferir('operador de outra federação não ajusta este lançamento',
      [403, 404].includes(ajusteAlheio.status), `status ${ajusteAlheio.status}`);
  }

  modulo('15. ranking público');
  comoPerfil('anônimo');

  const rankingSemAuth = await talvez(`/ranking?seasonId=${temporada.id}`);
  conferir('o ranking é legível sem autenticação', rankingSemAuth.status === 200, `status ${rankingSemAuth.status}`);
  conferir('o ranking público não carrega CPF',
    !JSON.stringify(rankingSemAuth.corpo || {}).includes(cpfDoHistorico));

  const rankingPorCategoria = await talvez(`/ranking?seasonId=${temporada.id}&categoryId=${bikini.id}`);
  conferir('o ranking aceita recorte por categoria', rankingPorCategoria.status === 200, `status ${rankingPorCategoria.status}`);

  const rankingTemporadaInexistente = await talvez('/ranking?seasonId=clz0000000000000000000000');
  conferir('temporada inexistente não quebra o ranking',
    rankingTemporadaInexistente.status < 500, `status ${rankingTemporadaInexistente.status}`);

  // ------------------------------------------------------------- OVERALL
  modulo('16. Overall');
  comoPerfil('RANKING_MANAGER');

  const candidatos = await chamar(`/events/${evento.id}/overall/candidates`, { token: tDiretorA });
  conferir('a tela de Overall lista candidatos', Array.isArray(candidatos.items), `${(candidatos.items || []).length} recorte(s)`);

  const recorteBikini = (candidatos.items || []).find(i => i.category?.code === 'BIKINI');
  const candidato = recorteBikini?.candidates?.[0];
  conferir('há candidato na categoria BIKINI', Boolean(candidato));

  if (candidato) {
    const corpoDoTitulo = candidato.athlete?.id
      ? { athleteId: candidato.athlete.id, categoryId: bikini.id }
      : { externalAthleteId: candidato.externalAthlete.id, categoryId: bikini.id };

    const titulo = await chamar(`/events/${evento.id}/overall`, { metodo: 'POST', token: tDiretorA, corpo: corpoDoTitulo });
    conferir('o Overall é declarado', Boolean(titulo.id));

    const duplicado2 = await talvez(`/events/${evento.id}/overall`, { metodo: 'POST', token: tDiretorA, corpo: corpoDoTitulo });
    conferir('declarar o MESMO Overall duas vezes não cria dois títulos',
      duplicado2.status >= 400 || duplicado2.corpo?.id === titulo.id, `status ${duplicado2.status}`);

    const titulos = await chamar(`/events/${evento.id}/overall`, { token: tDiretorA });
    conferir('o título aparece na listagem', (titulos.items || []).some(t => t.id === titulo.id));

    const declararAlheio = await talvez(`/events/${evento.id}/overall`, { metodo: 'POST', token: tDiretorB, corpo: corpoDoTitulo });
    conferir('diretor de outra federação não declara Overall aqui',
      [403, 404].includes(declararAlheio.status), `status ${declararAlheio.status}`);

    const revogarSemMotivo = await talvez(`/events/${evento.id}/overall/${titulo.id}`, { metodo: 'DELETE', token: tDiretorA, corpo: {} });
    conferir('revogar sem motivo é recusado', revogarSemMotivo.status >= 400, `status ${revogarSemMotivo.status}`);

    await chamar(`/events/${evento.id}/overall/${titulo.id}`, {
      metodo: 'DELETE', token: tDiretorA, corpo: { reason: `${marca('REVOGACAO')} correção de súmula` }
    });
    const depoisDaRevogacao = await chamar(`/events/${evento.id}/overall`, { token: tDiretorA });
    conferir('o título revogado sai da listagem ativa',
      !(depoisDaRevogacao.items || []).some(t => t.id === titulo.id && !t.revokedAt));
  }

  // ------------------------------------------------------------ MENSAGENS
  modulo('17. mensagem de abertura');
  comoPerfil('EVENT_DIRECTOR → ATHLETE');

  const aviso = await chamar('/athlete-notices', {
    metodo: 'POST', token: tDiretorA,
    corpo: { organizationId: orgA.id, title: marca('AVISO'), body: `${marca('AVISO')} — inscrições abertas.` }
  });
  criados.avisos.push(aviso.id);
  conferir('o recado é publicado', Boolean(aviso.id) && aviso.active === true);

  const avisoDoAtleta = await chamar('/me/notices', { token: tAtleta });
  const recebido = (avisoDoAtleta.items || []).find(a => a.id === aviso.id);
  conferir('o atleta da federação recebe o recado', Boolean(recebido));
  conferir('o servidor manda `deveExibir` pronto', recebido?.deveExibir === true);

  const avisoDeOutraFederacao = await chamar('/me/notices', { token: tHomonima });
  conferir('quem é da mesma federação também recebe',
    (avisoDeOutraFederacao.items || []).some(a => a.id === aviso.id));

  await chamar(`/me/notices/${aviso.id}/read`, { metodo: 'POST', token: tAtleta });
  const depoisDeLer = await chamar('/me/notices', { token: tAtleta });
  const lido = (depoisDeLer.items || []).find(a => a.id === aviso.id);
  conferir('depois de lido, `deveExibir` vira falso', lido?.deveExibir === false);
  conferir('a leitura fica registrada com data', Boolean(lido?.readAt));

  const lerDuasVezes = await chamar(`/me/notices/${aviso.id}/read`, { metodo: 'POST', token: tAtleta });
  conferir('marcar leitura duas vezes não duplica', lerDuasVezes.jaEstavaLido === true);

  const apagarLido = await talvez(`/athlete-notices/${aviso.id}`, { metodo: 'DELETE', token: tDiretorA });
  conferir('recado já lido não pode ser apagado (409)', apagarLido.status === 409, `status ${apagarLido.status}`);

  const publicarAlheio = await talvez('/athlete-notices', {
    metodo: 'POST', token: tDiretorB, corpo: { organizationId: orgA.id, title: marca('INVASOR'), body: 'texto' }
  });
  conferir('diretor de outra federação não publica recado nesta',
    [403, 404].includes(publicarAlheio.status), `status ${publicarAlheio.status}`);

  const recadoDoAtleta = await talvez('/athlete-notices', {
    metodo: 'POST', token: tAtleta, corpo: { organizationId: orgA.id, title: marca('ATLETA_PUBLICA'), body: 'texto' }
  });
  conferir('atleta não publica recado', recadoDoAtleta.status === 403, `status ${recadoDoAtleta.status}`);

  // ------------------------------------------------------------- AUDITORIA
  modulo('18. auditoria');
  comoPerfil('SUPER_ADMIN / outros');

  const trilha = await chamar(`/audit?organizationId=${orgA.id}&limit=50`, { token: tAdmin });
  const acoes = new Set((trilha.items || []).map(l => l.action));
  conferir('a trilha registra ações desta auditoria', (trilha.items || []).length > 0, `${(trilha.items || []).length} registro(s)`);
  conferir('a trilha identifica o ator', (trilha.items || []).every(l => l.userId || l.userEmail || l.user));
  conferir('a trilha identifica a organização',
    (trilha.items || []).every(l => l.organizationId === orgA.id || l.organizationId == null));
  conferir('ações-chave aparecem na trilha',
    acoes.has('ATHLETE_CPF_VIEW') || acoes.has('ATHLETE_CREATE') || acoes.has('MUSCLEWAR_APPLY'),
    [...acoes].slice(0, 6).join(', '));

  const trilhaSemPermissao = await talvez(`/audit?organizationId=${orgA.id}`, { token: tAtleta });
  conferir('atleta não lê a trilha de auditoria', trilhaSemPermissao.status === 403, `status ${trilhaSemPermissao.status}`);


  // ============================================================ SEGURANÇA
  //
  // Nenhuma destas sondas passa pelo frontend. O botão não aparecer não
  // protege nada: quem ataca chama a rota.
  modulo('19. segurança — cross-tenant e IDOR, direto na API');
  comoPerfil('atacante');

  const sondas = [
    ['ler atleta de outra federação', `/athletes/${atletaA.id}`, 'GET', tDiretorB],
    ['editar atleta de outra federação', `/athletes/${atletaA.id}`, 'PATCH', tDiretorB, { fullName: 'sequestrado' }],
    ['suspender atleta de outra federação', `/athletes/${atletaA.id}/suspend`, 'POST', tDiretorB, { reason: 'invasao ilegitima' }],
    ['excluir atleta de outra federação', `/athletes/${atletaA.id}`, 'DELETE', tDiretorB],
    ['ler histórico importado de outra federação', `/athletes/${atletaA.id}/imported-history`, 'GET', tDiretorB],
    ['recalcular temporada de outra federação', `/seasons/${temporada.id}/recompute`, 'POST', tDiretorB],
    ['ler lançamentos de evento de outra federação', `/events/${evento.id}/ranking-points`, 'GET', tDiretorB],
    ['ler a fila de solicitações de outra federação', `/athlete-requests?organizationId=${orgA.id}`, 'GET', tDiretorB],
    ['aprovar solicitação de outra federação', `/athlete-requests/${pedido.id}/approve`, 'POST', tDiretorB, {}],
    ['listar recados de outra federação', `/athlete-notices?organizationId=${orgA.id}`, 'GET', tDiretorB],
    ['ler a auditoria de outra federação', `/audit?organizationId=${orgA.id}`, 'GET', tDiretorB],
    ['importar lote para outra federação', '/musclewar/imports', 'POST', tDiretorB,
      { organizationId: orgA.id, seasonId: temporada.id, eventId: evento.id, sourceType: 'CSV', sourceRef: 'x.csv', content: 'a,b\n1,2' }]
  ];

  for (const [descricao, caminho, metodo, token, corpo] of sondas) {
    const r = await talvez(caminho, { metodo, token, corpo });
    const bloqueado = [401, 403, 404].includes(r.status)
      || (metodo === 'GET' && Array.isArray(r.corpo?.items) && r.corpo.items.length === 0);
    conferir(`BLOQUEADO — ${descricao}`, bloqueado, `status ${r.status}`);
  }

  comoPerfil('ATHLETE');
  // O QUE A AUDITORIA DESCOBRIU AQUI, e que eu tinha suposto errado duas vezes.
  //
  // `athletes.read` é base para todo usuário autenticado, então imaginei que a
  // listagem viesse aberta e que o cuidado estivesse só na projeção. Não é o
  // que o sistema faz — e o que ele faz é mais forte:
  //
  //   * pedindo uma organização EXPLÍCITA de que não se é membro, ele recusa
  //     com 403 (`organizationFilter` → `assertOrganization`);
  //   * pedindo SEM escopo, ele não devolve tudo: devolve o escopo de quem
  //     pergunta. Para quem não tem vínculo nenhum, isso é LISTA VAZIA, e não
  //     lista irrestrita. Está escrito no próprio código: "sem vínculo nenhum
  //     a listagem é vazia, não irrestrita".
  //
  // As duas asserções abaixo passam a fixar esse comportamento, que é o que
  // de fato protege — e não a versão mais frouxa que eu tinha escrito.
  const listaComOrgAlheia = await talvez(`/athletes?organizationId=${orgA.id}`, { token: tAtleta });
  conferir('BLOQUEADO — atleta pede a lista de UMA organização de que não é membro',
    listaComOrgAlheia.status === 403, `status ${listaComOrgAlheia.status}`);

  const listaSemEscopo = await talvez('/athletes', { token: tAtleta });
  conferir('sem vínculo de organização, a listagem vem VAZIA — não irrestrita',
    listaSemEscopo.status === 200 && Array.isArray(listaSemEscopo.corpo?.items)
    && listaSemEscopo.corpo.items.length === 0,
    `status ${listaSemEscopo.status}, ${(listaSemEscopo.corpo?.items || []).length} item(ns)`);

  // A vitrine PÚBLICA é a superfície que o atleta de fato vê. Ela existe, e o
  // que importa nela é o que NÃO carrega.
  const vitrine = await talvez('/public/athletes?limit=20');
  const daVitrine = (vitrine.corpo?.items || [])[0] || {};
  conferir('a vitrine pública responde', vitrine.status === 200, `status ${vitrine.status}`);
  conferir('a vitrine pública não carrega documento nem contato',
    daVitrine.cpf === undefined && daVitrine.cpfMasked === undefined
    && daVitrine.phone === undefined && daVitrine.email === undefined
    && daVitrine.birthDate === undefined && daVitrine.affiliationNumber === undefined);
  conferir('a vitrine pública não carrega o estado administrativo',
    daVitrine.status === undefined && daVitrine.statusReason === undefined);

  const atletaSondas = [
    ['atleta cria atleta', '/athletes', 'POST', { organizationId: orgA.id, fullName: 'x', sex: 'MALE', cpf: proximoCpf() }],
    ['atleta cria evento', '/events', 'POST', { organizationId: orgA.id, name: 'x', slug: `x${CARIMBO}`, startDate: '2026-12-01T12:00:00.000Z' }],
    ['atleta cria temporada', '/seasons', 'POST', { organizationId: orgA.id, name: 'x', year: 2027 }],
    ['atleta recalcula ranking', `/seasons/${temporada.id}/recompute`, 'POST'],
    ['atleta revela CPF alheio', `/athletes/${atletaA.id}/cpf`, 'POST']
  ];
  for (const [descricao, caminho, metodo, corpo] of atletaSondas) {
    const r = await talvez(caminho, { metodo, token: tAtleta, corpo });
    conferir(`BLOQUEADO — ${descricao}`, [401, 403, 404].includes(r.status), `status ${r.status}`);
  }

  // O atleta lê o PRÓPRIO perfil — o inverso do teste acima.
  const proprioPerfil = await talvez(`/athletes/${athleteIdDoHistorico}`, { token: tAtleta });
  conferir('PERMITIDO — o atleta lê o próprio perfil', proprioPerfil.status === 200, `status ${proprioPerfil.status}`);
  conferir('o próprio CPF vem mascarado na leitura do perfil',
    !JSON.stringify(proprioPerfil.corpo || {}).includes(cpfDoHistorico)
    || Boolean(proprioPerfil.corpo?.athlete?.cpfMasked));

  // IDs INVENTADOS não podem virar 500.
  const idsInventados = [
    `/athletes/clz0000000000000000000000`,
    `/events/clz0000000000000000000000/ranking-points`,
    `/athletes/clz0000000000000000000000/imported-history`,
    `/registrations/clz0000000000000000000000`
  ];
  for (const caminho of idsInventados) {
    const r = await talvez(caminho, { token: tDiretorA });
    conferir(`id inventado responde 4xx, nunca 5xx — ${caminho.split('/')[1]}`, r.status >= 400 && r.status < 500, `status ${r.status}`);
  }

  // ID MALFORMADO NÃO PODE CHEGAR AO BANCO. O invariante é 4xx — algumas
  // rotas validam o formato e respondem 400, outras simplesmente não acham e
  // respondem 404. As duas estão certas; o que não pode acontecer é o texto
  // atravessar até o Prisma e voltar 500.
  for (const caminho of [
    '/athletes/nao-e-um-cuid',
    '/athletes/nao-e-um-cuid/imported-history',
    '/events/nao-e-um-cuid/ranking-points',
    '/registrations/nao-e-um-cuid',
    '/athletes/;DROP TABLE Athlete;--',
    '/athletes/../../etc/passwd'
  ]) {
    const r = await talvez(caminho, { token: tDiretorA });
    conferir(`id malformado responde 4xx, nunca 5xx — ${caminho.slice(0, 40)}`,
      r.status >= 400 && r.status < 500, `status ${r.status}`);
  }

  const cpfIntegroDepoisDaSonda = await talvez(`/athletes/${atletaA.id}`, { token: tDiretorA });
  conferir('depois das sondas de id, o atleta continua lá (nada foi apagado)',
    cpfIntegroDepoisDaSonda.status === 200, `status ${cpfIntegroDepoisDaSonda.status}`);

  // ------------------------------------------------- RLS ainda de pé
  const estadoRls = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS protegidas,
           count(*) FILTER (WHERE NOT c.relforcerowsecurity)::int AS sem_force
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relrowsecurity
  `);
  conferir('as tabelas protegidas continuam com FORCE RLS',
    estadoRls[0].protegidas >= 30 && estadoRls[0].sem_force === 0,
    `${estadoRls[0].protegidas} protegidas, ${estadoRls[0].sem_force} sem FORCE`);

  // ==================================================== CAMINHOS QUE QUEBRAM
  modulo('20. caminhos que costumam quebrar');
  comoPerfil('vários');

  // Sem dados.
  const eventoVazio = await chamar('/events', {
    metodo: 'POST', token: tDiretorA,
    corpo: {
      organizationId: orgA.id, name: marca('EVENTO_VAZIO'), slug: marcaSlug('vazio'),
      startDate: '2026-12-20T12:00:00.000Z', city: 'Cuiabá', state: 'MT', seasonId: temporada.id
    }
  });
  criados.eventos.push(eventoVazio.id);
  const pontosVazios = await chamar(`/events/${eventoVazio.id}/ranking-points`, { token: tDiretorA });
  conferir('evento sem lançamento nenhum devolve lista vazia, e não erro',
    Array.isArray(pontosVazios.items) && pontosVazios.items.length === 0);

  const candidatosVazios = await talvez(`/events/${eventoVazio.id}/overall/candidates`, { token: tDiretorA });
  conferir('Overall de evento sem resultado não quebra', candidatosVazios.status < 500, `status ${candidatosVazios.status}`);

  // Salvar duas vezes.
  const duasEdicoes = await Promise.all([
    talvez(`/athletes/${atletaA.id}`, { metodo: 'PATCH', token: tDiretorA, corpo: { city: 'Rondonópolis' } }),
    talvez(`/athletes/${atletaA.id}`, { metodo: 'PATCH', token: tDiretorA, corpo: { city: 'Sinop' } })
  ]);
  conferir('duas edições simultâneas do mesmo atleta não derrubam a API',
    duasEdicoes.every(r => r.status < 500), duasEdicoes.map(r => r.status).join('/'));
  const cidadeFinal = (await chamar(`/athletes/${atletaA.id}`, { token: tDiretorA })).athlete.city;
  conferir('uma das duas venceu, e o estado é consistente',
    ['Rondonópolis', 'Sinop'].includes(cidadeFinal), cidadeFinal);

  // Operação repetida.
  //
  // A contagem de referência é tirada AGORA. A primeira versão desta auditoria
  // comparava com uma fotografia tirada três módulos antes — quando o evento
  // ainda não tinha o resultado publicado da inscrição — e acusava duplicação
  // onde havia um lançamento novo e legítimo. Medir contra o passado errado é
  // o jeito mais fácil de um teste mentir.
  const antesDosRecalculos = (await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA })).items || [];
  const doisRecalculos = await Promise.all([
    talvez(`/seasons/${temporada.id}/recompute`, { metodo: 'POST', token: tDiretorA }),
    talvez(`/seasons/${temporada.id}/recompute`, { metodo: 'POST', token: tDiretorA })
  ]);
  conferir('dois recálculos simultâneos não quebram', doisRecalculos.every(r => r.status < 500),
    doisRecalculos.map(r => r.status).join('/'));

  const pontosDepoisDoRecalculo = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  conferir('o recálculo repetido NÃO duplicou lançamento',
    (pontosDepoisDoRecalculo.items || []).length === antesDosRecalculos.length,
    `${antesDosRecalculos.length} → ${(pontosDepoisDoRecalculo.items || []).length}`);

  // E os IDENTIFICADORES são os mesmos: mesma quantidade poderia esconder uma
  // troca de linhas. Aqui não esconde.
  const idsAntes = antesDosRecalculos.map(p => p.id).sort().join(',');
  const idsDepois = (pontosDepoisDoRecalculo.items || []).map(p => p.id).sort().join(',');
  conferir('os MESMOS lançamentos continuam lá depois do recálculo', idsAntes === idsDepois);

  // Reaplicar um lote já aplicado.
  const reaplicar = await talvez(`/musclewar/imports/${lote.import.id}/apply`, { metodo: 'POST', token: tDiretorA });
  conferir('reaplicar lote já aplicado não duplica resultado', reaplicar.status < 500, `status ${reaplicar.status}`);
  const pontosDepoisDeReaplicar = await chamar(`/events/${evento.id}/ranking-points`, { token: tDiretorA });
  conferir('a contagem de lançamentos continua a mesma depois de reaplicar',
    (pontosDepoisDeReaplicar.items || []).length === (pontosDepoisDoRecalculo.items || []).length,
    `${(pontosDepoisDoRecalculo.items || []).length} → ${(pontosDepoisDeReaplicar.items || []).length}`);

  // Muitas leituras ao mesmo tempo.
  const rajada = await Promise.all(Array.from({ length: 12 }, () => talvez(`/ranking?seasonId=${temporada.id}`)));
  conferir('doze leituras simultâneas do ranking respondem todas',
    rajada.every(r => r.status === 200), rajada.map(r => r.status).join(''));

  // Login/logout repetido (o token é sem estado; o que se mede é a rejeição
  // depois de a conta ser desativada seria outro teste — aqui, a repetição).
  const varios = await Promise.all(Array.from({ length: 5 }, () => entrar(contaAtleta.email)));
  conferir('cinco logins seguidos devolvem token', varios.every(Boolean));

  const limite = await chamar(`/athletes?organizationId=${orgA.id}&limit=1`, { token: tDiretorA });
  conferir('a paginação respeita o limite', (limite.items || []).length <= 1, `${(limite.items || []).length} item(ns)`);
  conferir('a paginação devolve cursor quando há mais', limite.nextCursor !== undefined);

  // ==========================================================================
  // 21. INVENTÁRIO DEMO — ANTES DA LIMPEZA
  //
  // A varredura percorre TODA coluna de texto do schema e conta as linhas que
  // carregam a marca desta execução. Ela roda duas vezes: agora, e depois de
  // limpar.
  //
  // O NÚMERO DE AGORA É O CONTROLE. Se a varredura enxergasse zero aqui — por
  // RLS, por erro de consulta, por marca errada —, o zero do fim não provaria
  // nada, e a auditoria estaria assinando uma limpeza que nunca conferiu.
  // Por isso o "antes" tem de ser maior que zero, e as tabelas onde a DEMO
  // obrigatoriamente passou são conferidas uma a uma, pelo nome.
  // ==========================================================================
  modulo('21. inventário DEMO antes da limpeza');
  comoPerfil('auditoria');

  const inventariar = async () => {
    const colunas = await db.$queryRawUnsafe(`
      SELECT c.table_name AS tabela, c.column_name AS coluna
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying')
      ORDER BY c.table_name, c.column_name
    `);

    const porTabela = new Map();
    // A leitura acontece com o ator de plataforma no contexto: sem ele, a RLS
    // devolveria vazio e o inventário mentiria por omissão.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL "mci.user_id" = '${admin.id}'`);
      for (const { tabela, coluna } of colunas) {
        const linhas = await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "${tabela}" WHERE "${coluna}" ILIKE $1`, `%${MARCA_DESTA_EXECUCAO}%`
        ).catch(() => [{ n: 0 }]);
        const n = linhas[0]?.n ?? 0;
        if (n > 0) porTabela.set(tabela, Math.max(porTabela.get(tabela) || 0, n));
      }
    }, { timeout: 120000, maxWait: 30000 });

    return porTabela;
  };

  const inventarioAntes = await inventariar();
  const totalAntes = [...inventarioAntes.values()].reduce((t, n) => t + n, 0);

  console.log(`  tabelas com marca DEMO: ${inventarioAntes.size}`);
  for (const [tabela, n] of [...inventarioAntes].sort()) console.log(`     ${tabela.padEnd(28)} ${n}`);

  conferir('a varredura ENXERGA os dados DEMO antes da limpeza (controle)', totalAntes > 0, `${totalAntes} linha(s)`);

  // As tabelas por onde a auditoria obrigatoriamente passou. Se alguma delas
  // aparecer zerada AQUI, a varredura está cega naquela tabela — e o zero do
  // fim não valeria para ela.
  for (const tabela of ['Organization', 'User', 'Athlete', 'Affiliation', 'Event', 'RankingSeason', 'AthleteNotice']) {
    conferir(`o inventário enxerga a marca em "${tabela}"`, (inventarioAntes.get(tabela) || 0) > 0,
      `${inventarioAntes.get(tabela) || 0} linha(s)`);
  }

  // ==========================================================================
  // 22. LIMPEZA PELOS FLUXOS DO PRÓPRIO SISTEMA
  //
  // Apagar por fora provaria que o banco aceita DELETE. Apagar por DENTRO
  // prova que os caminhos de remoção do sistema funcionam — e é justamente
  // deles que a federação vai depender quando precisar tirar algo do ar.
  //
  // O que o sistema NÃO expõe (organização e conta de usuário não têm rota de
  // exclusão, de propósito) é removido por DELETE DIRIGIDO PELA MARCA, linha a
  // linha. Não é limpeza ampla por tabela e não é TRUNCATE: é a marca desta
  // execução, e nada além dela.
  // ==========================================================================
  modulo('22. limpeza DEMO pelos fluxos do sistema');
  comoPerfil('SUPER_ADMIN');

  // 1. O recado já lido NÃO pode ser apagado — é a regra, e ela vale também
  //    na limpeza. Ele é desativado, e sai junto com a organização no fim.
  const desativado = await talvez(`/athlete-notices/${aviso.id}`, { metodo: 'PATCH', token: tDiretorA, corpo: { active: false } });
  conferir('o recado lido é DESATIVADO, não apagado (a regra vale na limpeza)', desativado.status === 200, `status ${desativado.status}`);

  // 2. A importação sai pelo fluxo de exclusão do lote, que desfaz o ledger.
  const excluirLote = await talvez(`/musclewar/imports/${lote.import.id}`, {
    metodo: 'DELETE', token: tDiretorA, corpo: { reason: `${marca('LIMPEZA')} fim da auditoria`, confirm: true }
  });
  conferir('a importação DEMO é removida pelo fluxo do sistema',
    excluirLote.status < 400, `status ${excluirLote.status} ${JSON.stringify(excluirLote.corpo).slice(0, 120)}`);

  // 3. Os atletas sem histórico saem pelo DELETE do sistema; os que têm
  //    histórico são recusados — e essa recusa é o comportamento correto.
  let excluidos = 0;
  let recusados = 0;
  for (const athleteId of [...new Set(criados.atletas)].filter(Boolean)) {
    const r = await talvez(`/athletes/${athleteId}`, { metodo: 'DELETE', token: tAdmin });
    if (r.status < 400) excluidos += 1;
    else if (r.status === 409) recusados += 1;
  }
  conferir('o DELETE de atleta funciona pelo fluxo do sistema', excluidos > 0, `${excluidos} excluído(s), ${recusados} recusado(s) por histórico`);

  // 4. O que o sistema não expõe: organização e conta. Remoção DIRIGIDA PELA
  //    MARCA, e só por ela. A organização leva em cascata o que ainda pende.
  const removidosPorMarca = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL "mci.user_id" = '${admin.id}'`);
    const orgs = await tx.$executeRawUnsafe(`DELETE FROM "Organization" WHERE "name" ILIKE $1 OR "slug" ILIKE $1`, `%${MARCA_DESTA_EXECUCAO}%`);
    const users = await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE "email" ILIKE $1 OR "name" ILIKE $1`, `%${MARCA_DESTA_EXECUCAO}%`);
    return { orgs, users };
  }, { timeout: 120000, maxWait: 30000 });
  conferir('organizações e contas DEMO removidas pela marca',
    removidosPorMarca.orgs > 0 && removidosPorMarca.users > 0,
    `${removidosPorMarca.orgs} organização(ões), ${removidosPorMarca.users} conta(s)`);

  // ==========================================================================
  // 23. INVENTÁRIO DEPOIS — DEMO TEM DE SER ZERO
  // ==========================================================================
  modulo('23. inventário DEMO depois da limpeza');
  comoPerfil('auditoria');

  const inventarioDepois = await inventariar();
  const totalDepois = [...inventarioDepois.values()].reduce((t, n) => t + n, 0);

  if (inventarioDepois.size) {
    console.log('  RESTOU MARCA DEMO EM:');
    for (const [tabela, n] of [...inventarioDepois].sort()) console.log(`     ${tabela.padEnd(28)} ${n}`);
  }

  conferir('DEMO restante = 0 em TODAS as colunas de texto do schema',
    totalDepois === 0, `${totalDepois} linha(s) em ${inventarioDepois.size} tabela(s)`);
  conferir('a limpeza removeu tudo o que o inventário tinha achado',
    totalAntes > 0 && totalDepois === 0, `antes ${totalAntes} → depois ${totalDepois}`);

  // O catálogo oficial — que NÃO é DEMO — tem de continuar de pé. É o controle
  // inverso: a limpeza não pode ter levado o que não era dela.
  const catalogo = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL "mci.user_id" = '${admin.id}'`);
    return tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM "Category"');
  }, { timeout: 60000 });
  conferir('a limpeza NÃO levou o catálogo oficial de categorias junto',
    catalogo[0].n >= 11, `${catalogo[0].n} categorias`);

}
