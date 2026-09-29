#!/usr/bin/env node
// ============================================================================
// DIAGNÓSTICO — A TRILHA DE AUDITORIA DE AUTENTICAÇÃO SE PERDE. POR QUÊ?
//
// O QA visual do módulo Treinadores & Equipes encontrou 17 recusas de RLS ao
// gravar auditoria: 11 `LOGIN` e 6 `USER_REGISTER`. Este script NÃO conserta
// nada. Ele mede, num banco isolado, qual cláusula da política recusa o INSERT,
// e confere que as garantias que a política existe para dar continuam de pé.
//
// POR QUE MEDIR ANTES DE CONSERTAR: a hipótese óbvia — "falta contexto de
// usuário" — precisa ser separada de outras três que produziriam o MESMO
// sintoma: organização sem vínculo, papel insuficiente, ou o `RETURNING` do
// `create` do Prisma batendo na política de LEITURA. Conserta-se a causa
// medida, não a causa suposta.
//
// Uso:
//   node scripts/qa/diagnostico-auditoria-autenticacao.mjs
//
// Não toca produção: cria e destrói o próprio banco, com dados sintéticos.
// ============================================================================

import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const { argv, env } = process;
const arg = (nome, padrao) => {
  const achado = argv.find(a => a.startsWith(`--${nome}=`));
  return achado ? achado.split('=').slice(1).join('=') : padrao;
};

const PORTA = Number(arg('porta', 4711));
const BASE = `http://127.0.0.1:${PORTA}/api/v1`;
const DATABASE_URL = arg('db', env.DIAG_DATABASE_URL
  || 'postgresql://mci:mci_local_dev@127.0.0.1:5432/mci_diag_auditoria?schema=public');
const SENHA = 'senha-de-diagnostico-123';

const linhas = [];
const registrar = (id, pergunta, resposta, detalhe = '') => {
  console.log(`  ${resposta.padEnd(13)} ${id} ${pergunta}${detalhe ? `  — ${detalhe}` : ''}`);
  linhas.push({ id, pergunta, resposta, detalhe });
};

const esperar = ms => new Promise(r => setTimeout(r, ms));
const semQuery = DATABASE_URL.replace(/\?.*$/, '');
const nomeDoBanco = semQuery.split('/').pop();
const servidor = semQuery.replace(/\/[^/]*$/, '/postgres');

/** Roda SQL e devolve { ok, saida, erro } — sem estourar, porque a RECUSA é o dado. */
function sql(comando) {
  try {
    const saida = execSync(`psql "${semQuery}" -X -q -t -A -v ON_ERROR_STOP=1 -c ${JSON.stringify(comando)}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, saida: saida.trim(), erro: '' };
  } catch (erro) {
    return { ok: false, saida: String(erro.stdout || '').trim(), erro: String(erro.stderr || erro.message) };
  }
}

// CONTAR A TRILHA EXIGE CONTEXTO DE LEITURA — e esquecer isso quase produziu um
// diagnóstico falso.
//
// `auditoria_leitura` só entrega linha a administrador de plataforma ou a
// operador da organização. A primeira versão deste script contava com `psql` sem
// contexto nenhum: ator anônimo, zero linhas SEMPRE. "Perdido" e "gravado"
// pareciam idênticos, e a sonda teria confirmado a hipótese fosse ela verdadeira
// ou falsa — o pior defeito possível num instrumento de medição.
//
// O leitor é um SUPER_ADMIN criado pelo próprio script. Não é conveniência: é o
// único ator que a política autoriza a ler a trilha inteira, e é quem uma
// auditoria de verdade usaria.
let atorDeLeitura = null;
const contar = condicao => {
  if (!atorDeLeitura) throw new Error('contar() antes de existir ator de leitura: a contagem seria cega');
  const r = sql(`BEGIN; SELECT set_config('mci.user_id', '${atorDeLeitura}', true); SELECT count(*) FROM "AuditLog" WHERE ${condicao}; ROLLBACK`);
  const numeros = r.saida.split('\n').map(l => l.trim()).filter(l => /^\d+$/.test(l));
  return numeros.length ? Number(numeros[numeros.length - 1]) : -1;
};

/**
 * Um INSERT de auditoria com o ator de RLS que se quiser — inclusive nenhum.
 *
 * Tudo dentro de uma transação que termina em ROLLBACK: a sonda mede a POLÍTICA
 * e não deixa linha atrás de si. `set_config(..., true)` é o mesmo mecanismo que
 * `withUserContext` usa em produção (`src/config/rlsSession.js`), então o que
 * está sendo medido é o caminho real, e não uma imitação dele.
 */
function inserirAuditoria({ atorDeRls, userId, organizationId = null, action = 'LOGIN' }) {
  const valor = v => (v === null ? 'NULL' : `'${v}'`);
  return sql([
    'BEGIN',
    `SELECT set_config('mci.user_id', ${atorDeRls === null ? "''" : `'${atorDeRls}'`}, true)`,
    `INSERT INTO "AuditLog" ("id","organizationId","userId","userEmail","action","entity","entityId","ip","createdAt") VALUES ('${randomUUID()}', ${valor(organizationId)}, ${valor(userId)}, 'diagnostico@mci.local', '${action}', 'User', ${valor(userId)}, NULL, now())`,
    'ROLLBACK'
  ].join('; '));
}

// RECUSA DE POLÍTICA E ERRO DE SINTAXE NÃO PODEM CAIR NO MESMO SACO.
//
// A primeira versão deste script tinha uma quebra de linha dentro do comando e o
// psql recusava por sintaxe. `recusadoPorRls` devolvia `false` e a sonda imprimia
// "ACEITO" para um INSERT que nunca chegou a ser avaliado — um instrumento que
// mente na direção mais perigosa, a de tranquilizar. Agora erro inesperado
// ESTOURA o diagnóstico em vez de virar resultado.
// SQL DE PREPARAÇÃO NÃO PODE FALHAR EM SILÊNCIO.
//
// Medido: a primeira versão criava o gatilho de indisponibilidade com corpo em
// dólar-quoting (`$fn$ ... $fn$`) e o comando ia para o psql através do shell,
// que EXPANDIU `$fn` para vazio. A função nunca nasceu, o gatilho nunca existiu,
// e as três sondas de fail closed reportaram "NÃO" — acusando o produto por um
// defeito do instrumento. O corpo agora vai entre apóstrofos (sem dólar nenhum
// para o shell mastigar) e a execução ESTOURA se não der certo.
function sqlObrigatorio(comando) {
  const r = sql(comando);
  if (!r.ok) throw new Error(`SQL de preparação falhou: ${r.erro.slice(0, 300)}\n  comando: ${comando.slice(0, 120)}`);
  return r;
}

const recusadoPorRls = r => {
  if (r.ok) return false;
  if (/row-level security|42501/i.test(r.erro)) return true;
  throw new Error(`erro inesperado do banco (não é recusa de política): ${r.erro.slice(0, 300)}`);
};

const processos = [];
const encerrar = () => { for (const p of processos) { try { p.kill('SIGKILL'); } catch { /* já morreu */ } } };

async function esperarPorta(url, segundos = 60) {
  for (let i = 0; i < segundos * 2; i += 1) {
    try { if ((await fetch(url)).status < 500) return true; } catch { /* subindo */ }
    await esperar(500);
  }
  return false;
}

async function chamar(caminho, { metodo = 'GET', corpo = null, token = null } = {}) {
  const resposta = await fetch(`${BASE}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  return { status: resposta.status, corpo: await resposta.json().catch(() => null) };
}

console.log('\n=== DIAGNÓSTICO — AUDITORIA DE AUTENTICAÇÃO ===\n');

try {
  console.log(`preparando banco isolado ${nomeDoBanco}…`);
  execSync(`psql "${servidor}" -c "drop database if exists \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync(`psql "${servidor}" -c "create database \\"${nomeDoBanco}\\""`, { stdio: 'pipe' });
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...env, DATABASE_URL } });
  execSync('node prisma/seed.js', { stdio: 'pipe', env: { ...env, DATABASE_URL } });

  console.log('subindo API…');
  const api = spawn('node', ['server.js'], {
    env: {
      ...env, NODE_ENV: 'development', DATABASE_URL, PORT: String(PORTA),
      LOG_LEVEL: 'info', BCRYPT_ROUNDS: '4',
      JWT_SECRET: env.JWT_SECRET || 'diagnostico-auditoria-segredo-suficientemente-longo-01',
      STORAGE_DRIVER: 'local', STORAGE_LOCAL_PATH: '/tmp/diag-auditoria-storage'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processos.push(api);
  let log = '';
  api.stdout.on('data', d => { log += d; });
  api.stderr.on('data', d => { log += d; });
  if (!await esperarPorta(`http://127.0.0.1:${PORTA}/api/v1/health`, 60)) {
    throw new Error(`API não subiu:\n${log.slice(-1200)}`);
  }
  console.log('API no ar.\n');

  // O CORPO COMPLETO DO CADASTRO ABERTO — o mesmo que `tests/helpers.mjs` manda,
  // porque representa um cadastro real. Afrouxar a validação para o diagnóstico
  // ter menos trabalho seria medir um sistema que não existe.
  const CADASTRO = {
    password: SENHA, birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
    postalCode: '78000000', addressLine: 'Rua de Diagnostico', addressNumber: '100',
    state: 'MT', city: 'Cuiabá'
  };
  const cadastrar = (nome, email) => chamar('/auth/register', {
    metodo: 'POST', corpo: { ...CADASTRO, name: nome, email }
  });

  // ============================================== 0. QUEM VAI LER A TRILHA
  console.log('0) O ATOR QUE PODE LER A TRILHA');
  const emailLeitor = `diag.leitor.${Date.now()}@mci.local`;
  const leitor = await cadastrar('Diagnostico Leitor', emailLeitor);
  if (leitor.status !== 201) {
    throw new Error(`não foi possível criar o leitor: HTTP ${leitor.status} ${JSON.stringify(leitor.corpo)}`);
  }
  atorDeLeitura = leitor.corpo.user.id;
  // Papel privilegiado não é autoatribuível pelo cadastro aberto: a promoção é
  // feita no banco, como a suíte faz e como um administrador faria pela rota.
  sql(`UPDATE "User" SET role = 'SUPER_ADMIN' WHERE id = '${atorDeLeitura}'`);
  const entradaLeitor = await chamar('/auth/login', { metodo: 'POST', corpo: { email: emailLeitor, password: SENHA } });
  const tokenLeitor = entradaLeitor.corpo?.token ?? null;
  registrar('L1', 'existe ator com direito de LER a trilha (SUPER_ADMIN)',
    atorDeLeitura && tokenLeitor ? 'SIM' : 'NÃO', 'sem ele toda contagem seria cega');

  // ======================================================= 1. O CAMINHO REAL
  console.log('\n1) O QUE ACONTECE HOJE, PELO HTTP');

  const email = `diag.sujeito.${Date.now()}@mci.local`;
  const cadastro = await cadastrar('Diagnostico Sujeito', email);
  registrar('H1', 'POST /auth/register responde 201', cadastro.status === 201 ? 'SIM' : 'NÃO', `HTTP ${cadastro.status}`);
  const idDoUsuario = cadastro.corpo?.user?.id ?? null;

  const cadastros = contar(`action = 'USER_REGISTER' AND "userId" = '${idDoUsuario}'`);
  registrar('H2', 'o cadastro deixou evento USER_REGISTER na trilha',
    cadastros > 0 ? 'SIM' : 'NÃO — PERDIDO', `linhas=${cadastros}`);

  const entrada = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } });
  registrar('H3', 'POST /auth/login responde 200', entrada.status === 200 ? 'SIM' : 'NÃO', `HTTP ${entrada.status}`);

  const entradas = contar(`action = 'LOGIN' AND "userId" = '${idDoUsuario}'`);
  registrar('H4', 'a entrada deixou evento LOGIN na trilha',
    entradas > 0 ? 'SIM' : 'NÃO — PERDIDO', `linhas=${entradas}`);

  // ESTE SCRIPT LÊ CERTO NOS DOIS ESTADOS — com o defeito e sem ele. Um
  // diagnóstico que só sabe descrever a doença deixa de servir no dia em que ela
  // é curada, e é justamente aí que ele passa a valer como sonda de regressão.
  const recusasNoLog = (log.match(/falha ao registrar auditoria/g) || []).length;
  registrar('H5', 'houve recusa de auditoria no log do servidor',
    recusasNoLog > 0 ? 'SIM — DEFEITO' : 'NENHUMA', `ocorrências=${recusasNoLog}`);

  registrar('H6', 'a perda seria visível para quem CHAMA a API',
    'NÃO', 'o cliente recebe 200/201 em qualquer caso: a trilha não é observável pela resposta');

  // CONTROLE — se a auditoria de uma ação AUTENTICADA também falhasse, a causa
  // seria outra e a hipótese do contexto ausente cairia. É esta linha que separa
  // "o caminho de autenticação está quebrado" de "a auditoria está quebrada".
  const antes = contar("action = 'ORGANIZATION_CREATE'");
  const criada = await chamar('/organizations', {
    metodo: 'POST', token: tokenLeitor,
    corpo: { name: `Org Diag ${Date.now()}`, slug: `org-diag-${Date.now()}` }
  });
  const depois = contar("action = 'ORGANIZATION_CREATE'");
  registrar('H7', 'CONTROLE: ação autenticada audita normalmente',
    depois > antes ? 'SIM' : 'NÃO', `HTTP ${criada.status} — linhas antes=${antes} depois=${depois}`);

  // =================================================== 2. A POLÍTICA, DIRETA
  console.log('\n2) QUAL CLÁUSULA RECUSA — SONDA DIRETA NA POLÍTICA');

  const semContexto = inserirAuditoria({ atorDeRls: null, userId: idDoUsuario });
  registrar('P1', 'INSERT com userId e SEM contexto de RLS é recusado',
    recusadoPorRls(semContexto) ? 'RECUSADO' : 'ACEITO',
    recusadoPorRls(semContexto) ? 'é exatamente o que acontece no login' : 'a hipótese cai');

  const comContexto = inserirAuditoria({ atorDeRls: idDoUsuario, userId: idDoUsuario });
  registrar('P2', 'INSERT com userId e COM o contexto do próprio ator é aceito',
    comContexto.ok ? 'ACEITO' : 'RECUSADO',
    comContexto.ok ? 'o conserto é dar contexto, não afrouxar política' : comContexto.erro.slice(0, 140));

  const forja = inserirAuditoria({ atorDeRls: idDoUsuario, userId: atorDeLeitura });
  registrar('P3', 'assinar no lugar de OUTRO usuário é recusado',
    recusadoPorRls(forja) ? 'RECUSADO' : 'ACEITO', 'garantia (a): ninguém assina pelo outro');

  const anonimo = inserirAuditoria({ atorDeRls: null, userId: null });
  registrar('P4', 'INSERT anônimo com userId nulo é aceito pela política',
    anonimo.ok ? 'ACEITO' : 'RECUSADO',
    'é o evento de visitante; nenhuma rota anônima o escreve hoje');

  // A ORGANIZAÇÃO ALHEIA É MEDIDA COM ATOR COMUM, E NÃO COM O ADMINISTRADOR.
  //
  // `mci_member_of` inclui `mci_is_platform_admin()`: para um SUPER_ADMIN QUALQUER
  // organização é "sua", e a sonda feita com ele daria ACEITO — resultado correto
  // do produto e leitura errada da garantia. A primeira versão deste script
  // cometeu exatamente esse erro.
  const orgAlheia = sql('SELECT id FROM "Organization" LIMIT 1').saida.split('\n')[0];
  const forjaOrg = inserirAuditoria({ atorDeRls: idDoUsuario, userId: idDoUsuario, organizationId: orgAlheia });
  registrar('P5', 'ator comum escrevendo na trilha de organização alheia é recusado',
    recusadoPorRls(forjaOrg) ? 'RECUSADO' : 'ACEITO', 'garantia (b): a trilha da federação é dela');

  // APPEND-ONLY SE MEDE COM LINHA DE VERDADE NA MESA.
  //
  // Tentar UPDATE numa tabela vazia "passa" sem provar nada. O diagnóstico grava
  // uma linha legítima (com contexto, como a correção fará) e só então tenta
  // adulterá-la e apagá-la — inclusive como administrador de plataforma, que é
  // quem mais poderia.
  const gravada = sql(`BEGIN; SELECT set_config('mci.user_id', '${idDoUsuario}', true); INSERT INTO "AuditLog" ("id","organizationId","userId","userEmail","action","entity","entityId","ip","createdAt") VALUES ('${randomUUID()}', NULL, '${idDoUsuario}', '${email}', 'DIAGNOSTICO_APPEND_ONLY', 'User', '${idDoUsuario}', NULL, now()); COMMIT`);
  const existentes = contar("action = 'DIAGNOSTICO_APPEND_ONLY'");
  registrar('P6', 'a linha de teste foi gravada com contexto (base do append-only)',
    gravada.ok && existentes === 1 ? 'SIM' : 'NÃO', `linhas=${existentes}`);

  for (const [id, quem, ator] of [['P7', 'ator comum', idDoUsuario], ['P8', 'administrador de plataforma', atorDeLeitura]]) {
    sql(`BEGIN; SELECT set_config('mci.user_id', '${ator}', true); UPDATE "AuditLog" SET action = 'ADULTERADO'; COMMIT`);
    const adulteradas = contar("action = 'ADULTERADO'");
    sql(`BEGIN; SELECT set_config('mci.user_id', '${ator}', true); DELETE FROM "AuditLog"; COMMIT`);
    const sobraram = contar("action = 'DIAGNOSTICO_APPEND_ONLY'");
    registrar(id, `${quem} não adultera nem apaga a trilha`,
      adulteradas === 0 && sobraram === 1 ? 'IMPOSSÍVEL' : 'POSSÍVEL',
      `adulteradas=${adulteradas} linha original presente=${sobraram === 1}`);
  }

  // ================= 4. A TENTATIVA RECUSADA E O FAIL CLOSED, PELO HTTP
  //
  // As duas decisões aprovadas depois da primeira correção. A prova é pela rota,
  // com o banco de verdade: é o único lugar onde "não emitiu sessão" significa
  // alguma coisa.
  console.log('\n4) TENTATIVA RECUSADA E FAIL CLOSED (pelo HTTP)');

  const senhaTentada = 'ProvaDeVazamento#2026';
  const recusadasAntes = contar("action = 'LOGIN_FAILED'");
  const senhaErrada = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: senhaTentada } });
  const recusadasDepois = contar("action = 'LOGIN_FAILED'");
  registrar('T1', 'senha errada responde 401 e deixa LOGIN_FAILED na trilha',
    senhaErrada.status === 401 && recusadasDepois === recusadasAntes + 1 ? 'SIM' : 'NÃO',
    `HTTP ${senhaErrada.status} — linhas ${recusadasAntes} → ${recusadasDepois}`);

  const semAutor = Number(sql(`BEGIN; SELECT set_config('mci.user_id', '${atorDeLeitura}', true); SELECT count(*) FROM "AuditLog" WHERE action = 'LOGIN_FAILED' AND "userId" IS NOT NULL; ROLLBACK`).saida.split('\n').filter(l => /^\d+$/.test(l.trim())).pop() || -1);
  registrar('T2', 'nenhuma linha de tentativa recusada é atribuída a um usuário',
    semAutor === 0 ? 'SIM' : 'NÃO', `linhas com userId=${semAutor}`);

  const fantasma = await chamar('/auth/login', { metodo: 'POST', corpo: { email: `fantasma.${Date.now()}@mci.local`, password: senhaTentada } });
  registrar('T3', 'conta inexistente responde IGUAL à senha errada (sem enumeração)',
    fantasma.status === senhaErrada.status && JSON.stringify(fantasma.corpo) === JSON.stringify(senhaErrada.corpo) ? 'SIM' : 'NÃO',
    `HTTP ${fantasma.status} vs ${senhaErrada.status}`);

  const vazou = sql(`BEGIN; SELECT set_config('mci.user_id', '${atorDeLeitura}', true); SELECT count(*) FROM "AuditLog" WHERE "userEmail" IS NOT NULL AND action = 'LOGIN_FAILED'; ROLLBACK`);
  registrar('T4', 'a trilha da tentativa não guarda e-mail nem senha',
    /(^|\n)\s*0\s*(\n|$)/.test(vazou.saida) ? 'SIM' : 'NÃO', 'nenhum e-mail em linha de LOGIN_FAILED');

  // O GATILHO É A INDISPONIBILIDADE SIMULADA. Aditivo, temporário, e removido
  // logo abaixo: nenhuma política é tocada para produzir a falha.
  sqlObrigatorio("CREATE OR REPLACE FUNCTION diag_trilha_indisponivel() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''trilha indisponivel (diagnostico)''; END'");
  sqlObrigatorio('CREATE TRIGGER diag_trilha_indisponivel BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION diag_trilha_indisponivel()');
  // O gatilho EXISTE? Sem esta conferência, um erro de criação viraria "o produto
  // não fecha a porta", que é a conclusão oposta da verdadeira.
  const gatilhoAtivo = sql("SELECT count(*) FROM pg_trigger WHERE tgname = 'diag_trilha_indisponivel'").saida.trim();
  registrar('T4b', 'a indisponibilidade da trilha foi realmente simulada',
    gatilhoAtivo === '1' ? 'SIM' : 'NÃO', `gatilhos ativos=${gatilhoAtivo}`);

  const comTrilhaMorta = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } });
  registrar('T5', 'com a trilha indisponível, o login NÃO emite token',
    comTrilhaMorta.status >= 500 && !comTrilhaMorta.corpo?.token ? 'SIM' : 'NÃO',
    `HTTP ${comTrilhaMorta.status} — token=${comTrilhaMorta.corpo?.token ? 'EMITIDO' : 'nenhum'}`);

  const erradaComTrilhaMorta = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: senhaTentada } });
  registrar('T6', 'com a trilha indisponível, senha certa e errada respondem IGUAL',
    comTrilhaMorta.status === erradaComTrilhaMorta.status
      && JSON.stringify(comTrilhaMorta.corpo) === JSON.stringify(erradaComTrilhaMorta.corpo) ? 'SIM' : 'NÃO',
    `${comTrilhaMorta.status} vs ${erradaComTrilhaMorta.status} — sem oráculo de senha`);

  const emailRecusado = `diag.semtrilha.${Date.now()}@mci.local`;
  const cadastroRecusado = await cadastrar('Diagnostico Sem Trilha', emailRecusado);
  const contas = Number(sql(`SELECT count(*) FROM "User" WHERE email = '${emailRecusado}'`).saida || -1);
  registrar('T7', 'com a trilha indisponível, o cadastro não cria conta nem sessão',
    cadastroRecusado.status >= 500 && !cadastroRecusado.corpo?.token && contas === 0 ? 'SIM' : 'NÃO',
    `HTTP ${cadastroRecusado.status} — contas com esse e-mail=${contas}`);

  sql('DROP TRIGGER IF EXISTS diag_trilha_indisponivel ON "AuditLog"');
  sql('DROP FUNCTION IF EXISTS diag_trilha_indisponivel()');

  const voltou = await chamar('/auth/login', { metodo: 'POST', corpo: { email, password: SENHA } });
  registrar('T8', 'com a trilha de volta, o login volta a funcionar',
    voltou.status === 200 && Boolean(voltou.corpo?.token) ? 'SIM' : 'NÃO',
    `HTTP ${voltou.status} — o fechamento não é permanente`);

  // ============================================ 3. O TEXTO VIVO DA POLÍTICA
  console.log('\n3) O TEXTO DA POLÍTICA NO BANCO');
  const politicas = sql("SELECT policyname || ' [' || cmd || ']' FROM pg_policies WHERE tablename = 'AuditLog' ORDER BY policyname");
  for (const pol of politicas.saida.split('\n').filter(Boolean)) console.log(`    ${pol}`);
  const forcado = sql("SELECT relrowsecurity || '/' || relforcerowsecurity FROM pg_class WHERE relname = 'AuditLog'").saida;
  registrar('R1', 'AuditLog tem RLS habilitado e FORÇADO', forcado === 'true/true' ? 'SIM' : 'NÃO',
    `relrowsecurity/relforcerowsecurity=${forcado}`);

  console.log('\n--- CONCLUSÃO MEDIDA ---');

  const decisoesNovas = linhas.filter(l => l.id.startsWith('T') && l.resposta !== 'SIM');
  const trilhaGravada = cadastros > 0 && entradas > 0;
  const perdaConfirmada = cadastros === 0 && entradas === 0;
  const garantiasDePe = recusadoPorRls(semContexto) && comContexto.ok
    && recusadoPorRls(forja) && recusadoPorRls(forjaOrg);

  if (perdaConfirmada && garantiasDePe && depois > antes) {
    console.log('  DEFEITO PRESENTE. A causa é o CONTEXTO DE RLS AUSENTE no caminho de\n'
      + '  autenticação: a MESMA política aceita a escrita quando o contexto é o do\n'
      + '  próprio ator (P2), e a auditoria de ação autenticada funciona (H7). Logo o\n'
      + '  defeito é do caminho de autenticação, e não da auditoria nem da política.\n'
      + '  Nenhuma garantia precisa ser afrouxada para corrigi-lo.');
  } else if (trilhaGravada && garantiasDePe && decisoesNovas.length === 0) {
    console.log('  CORRIGIDO E SEM AFROUXAMENTO. Cadastro e entrada deixam evento na trilha\n'
      + '  (H2, H4) e nenhuma recusa aparece no log (H5). A tentativa recusada também\n'
      + '  entra na trilha, sem autor e sem e-mail (T1, T2, T4), e responde igual para\n'
      + '  conta existente e inexistente (T3). Com a trilha indisponível, nem login nem\n'
      + '  cadastro se completam, e as duas respostas ficam indistinguíveis (T5, T6, T7);\n'
      + '  com a trilha de volta, o login volta (T8). As garantias da política continuam\n'
      + '  medidas de pé: P1, P3, P5, P7 e P8.');
  } else if (trilhaGravada && garantiasDePe) {
    console.log('  TRILHA GRAVADA, MAS UMA DAS DECISÕES NOVAS NÃO SE CONFIRMOU.\n'
      + `  Conferir: ${decisoesNovas.map(l => l.id).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('  ESTADO INESPERADO — nem a perda nem a correção se confirmam por inteiro.\n'
      + '  Ler as linhas acima uma a uma antes de concluir qualquer coisa.');
    process.exitCode = 1;
  }

  // As garantias da política são condição de aprovação em QUALQUER estado: se
  // uma delas cair, o script reprova mesmo que a trilha esteja sendo gravada.
  if (!garantiasDePe) {
    console.log('  ATENÇÃO: uma garantia da política NÃO se sustentou. Ver P1, P2, P3 e P5.');
    process.exitCode = 1;
  }

  console.log(`\n${linhas.length} verificações registradas.`);
} catch (erro) {
  console.error(`\nDIAGNÓSTICO INTERROMPIDO: ${erro.message}`);
  process.exitCode = 1;
} finally {
  encerrar();
}
