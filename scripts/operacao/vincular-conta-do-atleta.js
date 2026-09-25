// ===========================================================================
// VINCULAR A CONTA DO PRÓPRIO ATLETA AO MESMO Athlete — OPERAÇÃO ÚNICA,
// AUDITADA, E SEM CRIAR NADA.
//
// Usa o SERVIÇO OFICIAL (`athleteService.update`), o mesmo que a rota
// PATCH /athletes/:id usa: mesma autorização (`athletes.update`), mesma
// auditoria (ATHLETE_UPDATE), mesma transação. Não é UPDATE direto no banco.
//
// NÃO cria Athlete. NÃO cria AthleteIdentity. NÃO cria RankingPoint. NÃO cria
// conta e NÃO define senha: a conta tem de existir, criada pelo próprio atleta.
// ABORTA se qualquer pré-condição não bater. IDEMPOTENTE.
// ===========================================================================
const ATLETA_ESPERADO = process.env.ALVO_ATHLETE_ID;
const NOME_ESPERADO   = process.env.ALVO_NOME;
const EMAIL_DO_ATLETA = (process.env.ALVO_EMAIL || '').trim().toLowerCase();
const ADMIN_ID        = process.env.ADMIN_USER_ID;
const APLICAR         = process.env.APLICAR === 'sim';

// A RAIZ DA APLICAÇÃO — e por que ela é procurada, e não assumida.
//
// Este arquivo tem DOIS lugares de vida legítimos: aqui, dentro do repositório
// (`scripts/operacao/`, que o Dockerfile copia para a imagem), e uma cópia
// colada num diretório qualquer do shell de produção, para o caso em que a
// imagem em execução ainda não tem este arquivo. Nos dois casos o que precisa
// ser carregado é o CÓDIGO DA APLICAÇÃO, e um `require` relativo resolveria
// contra a pasta DO ARQUIVO — que na cópia colada não tem `src/` nenhum.
//
// Então a raiz é a primeira candidata em que `src/config/prisma.js` existe de
// fato: a variável, depois o repositório acima deste arquivo, depois o
// diretório atual (no contêiner do Render, `/app`).
const fs = require('node:fs');
const path = require('node:path');

function raizDaAplicacao() {
  const candidatas = [process.env.MCI_APP_ROOT, path.resolve(__dirname, '..', '..'), process.cwd()];
  for (const candidata of candidatas) {
    if (candidata && fs.existsSync(path.join(candidata, 'src', 'config', 'prisma.js'))) return candidata;
  }
  console.error('ABORTADO: não encontrei o código da aplicação a partir deste diretório.');
  console.error('Rode de dentro do diretório da aplicação (no Render, /app) ou defina MCI_APP_ROOT.');
  process.exit(1);
}

const RAIZ = raizDaAplicacao();
const daAplicacao = modulo => require(path.join(RAIZ, modulo));

const prisma = daAplicacao('src/config/prisma');
const athletes = daAplicacao('src/services/athleteService');
const meService = daAplicacao('src/services/meService');
const { withUserContext } = daAplicacao('src/config/rlsSession');

const CAMPOS = ['id', 'userId', 'organizationId', 'fullName', 'stageName', 'sex',
  'birthDate', 'affiliationId', 'affiliationNumber', 'athleteNumber', 'teamId',
  'coachId', 'gymId', 'status', 'statusReason', 'proStatus', 'proSince', 'country',
  'state', 'city', 'phone', 'email', 'photoKey', 'createdById', 'createdAt'];
const selecao = Object.fromEntries(CAMPOS.map(c => [c, true]));
const iso = v => (v instanceof Date ? v.toISOString() : v);

async function retrato(tx) {
  const a = await tx.athlete.findUnique({ where: { id: ATLETA_ESPERADO }, select: selecao });
  if (!a) return null;
  const identidade = await tx.athleteIdentity.findUnique({
    where: { athleteId: ATLETA_ESPERADO },
    select: { athleteId: true, organizationId: true, cpf: true, createdAt: true }
  });
  const pontos = await tx.rankingPoint.findMany({
    where: { athleteId: ATLETA_ESPERADO },
    select: { id: true, points: true, placing: true, placementPoints: true,
      overallBonus: true, adjustmentPoints: true, superOverallPoints: true,
      categoryId: true, catalogClassId: true, classId: true, eventId: true,
      seasonId: true, externalResultId: true, voidedAt: true, source: true },
    orderBy: { id: 'asc' }
  });
  // QUANTOS ATLETAS existem com esta matrícula nesta federação. O gate contra
  // "criou um segundo atleta": este número não pode mudar, e não pode ser > 1.
  const homonimos = await tx.athlete.count({
    where: { organizationId: a.organizationId, affiliationId: a.affiliationId,
      affiliationNumber: a.affiliationNumber }
  });
  return {
    atleta: a,
    // O CPF é COMPARADO, nunca impresso: sai só a impressão digital.
    identidade: identidade && {
      athleteId: identidade.athleteId,
      organizationId: identidade.organizationId,
      cpfMarca: `${String(identidade.cpf).length} dígitos, termina em ${String(identidade.cpf).slice(-2)}`,
      cpfHash: require('node:crypto').createHash('sha256').update(String(identidade.cpf)).digest('hex').slice(0, 16),
      createdAt: iso(identidade.createdAt)
    },
    pontos,
    homonimos
  };
}

function diferencas(a, b) {
  const saida = [];
  for (const k of Object.keys(a ?? {})) if (iso(a[k]) !== iso(b?.[k])) saida.push({ campo: k, de: iso(a[k]), para: iso(b?.[k]) });
  return saida;
}

(async () => {
  for (const [nome, valor] of [['ALVO_ATHLETE_ID', ATLETA_ESPERADO], ['ALVO_NOME', NOME_ESPERADO],
    ['ALVO_EMAIL', EMAIL_DO_ATLETA], ['ADMIN_USER_ID', ADMIN_ID]]) {
    if (!valor) { console.error(`ABORTADO: ${nome} não definida.`); process.exit(1); }
  }

  const ator = await prisma.user.findUnique({
    where: { id: ADMIN_ID },
    select: { id: true, name: true, email: true, role: true, status: true }
  });
  if (!ator) { console.error(`ABORTADO: usuário ${ADMIN_ID} não existe.`); process.exit(1); }
  if (ator.role !== 'SUPER_ADMIN' && ator.role !== 'ADMIN') {
    console.error(`ABORTADO: ${ADMIN_ID} não é administrador (papel: ${ator.role}).`); process.exit(1);
  }

  // A CONTA DO ATLETA TEM DE JÁ EXISTIR. Este comando NÃO cria conta e NÃO
  // define senha: quem cria é o próprio atleta, com a senha dele.
  const conta = await prisma.user.findFirst({
    where: { email: EMAIL_DO_ATLETA },
    select: { id: true, name: true, email: true, role: true, status: true, createdAt: true }
  });
  if (!conta) {
    console.error(`ABORTADO: não existe conta com o e-mail informado.`);
    console.error('O PRÓXIMO PASSO É DO ATLETA: ele precisa criar a conta dele no site');
    console.error('(Criar conta / Cadastre-se), com a senha dele. Ninguém mais pode fazer isso por ele.');
    process.exit(1);
  }

  const jaVinculado = await prisma.athlete.findUnique({
    where: { userId: conta.id }, select: { id: true, fullName: true }
  });

  const antes = await withUserContext(ator.id, () => retrato(prisma));
  if (!antes) { console.error(`ABORTADO: atleta ${ATLETA_ESPERADO} não encontrado.`); process.exit(1); }

  console.log('=== ESTADO ATUAL (somente leitura) ===');
  console.log(`athleteId          ${antes.atleta.id}`);
  console.log(`fullName           ${antes.atleta.fullName}`);
  console.log(`userId do atleta   ${antes.atleta.userId ?? 'null'}`);
  console.log(`matrícula          ${antes.atleta.affiliationNumber ?? 'null'} (filiação ${antes.atleta.affiliationId ?? 'null'})`);
  console.log(`status             ${antes.atleta.status}`);
  console.log(`AthleteIdentity    ${antes.identidade ? antes.identidade.cpfMarca : '(ausente)'}`);
  console.log(`RankingPoints      ${antes.pontos.length} linha(s), soma ${antes.pontos.reduce((t, p) => t + p.points, 0)} ponto(s)`);
  console.log(`atletas c/ matríc. ${antes.homonimos}`);
  console.log(`conta do atleta    ${conta.id} <${conta.email}> papel=${conta.role} status=${conta.status}`);
  console.log(`  já é atleta de   ${jaVinculado ? `${jaVinculado.id} (${jaVinculado.fullName})` : '(nenhum)'}`);
  console.log(`ator da operação   ${ator.name} <${ator.email}> (${ator.role})`);

  if (antes.atleta.userId === conta.id) {
    console.log('\nJÁ VINCULADO a esta conta. Nada a fazer (idempotente).');
    process.exit(0);
  }

  console.log('\n=== PRÉ-CONDIÇÕES ===');
  const condicoes = [
    ['o atleta é o esperado', antes.atleta.id === ATLETA_ESPERADO],
    ['o nome confere exatamente', antes.atleta.fullName === NOME_ESPERADO],
    ['o atleta está SEM conta (userId null)', antes.atleta.userId === null],
    ['a conta do atleta existe', Boolean(conta)],
    ['a conta está ativa', conta.status === 'ACTIVE'],
    ['a conta NÃO é administrativa', conta.role !== 'SUPER_ADMIN' && conta.role !== 'ADMIN'],
    ['a conta não é de outro atleta', jaVinculado === null],
    ['há AthleteIdentity (o CPF já é dele)', Boolean(antes.identidade)],
    ['há exatamente 1 atleta com esta matrícula', antes.homonimos === 1],
    ['o status é ACTIVE', antes.atleta.status === 'ACTIVE']
  ];
  let todasOk = true;
  for (const [rotulo, ok] of condicoes) {
    console.log(`  ${ok ? 'OK    ' : 'FALHOU'}  ${rotulo}`);
    if (!ok) todasOk = false;
  }
  if (!todasOk) {
    // A MENSAGEM DIZ A VERDADE SOBRE O MODO. Em leitura, nada seria escrito de
    // qualquer jeito, e o estado real acabou de ser impresso: o operador tem o
    // valor certo na tela para repetir a chamada.
    console.error(APLICAR
      ? '\nABORTADO: pré-condição não satisfeita. NADA foi escrito.'
      : '\nPRÉ-CONDIÇÃO NÃO SATISFEITA. Nada foi escrito (modo leitura). '
        + 'Compare com o ESTADO ATUAL impresso acima, corrija os valores e repita.');
    process.exit(1);
  }

  if (!APLICAR) {
    console.log('\nMODO LEITURA. Nada foi escrito. Para aplicar, repita com APLICAR=sim.');
    process.exit(0);
  }

  // A ESCRITA, PELO SERVIÇO OFICIAL — autorização, auditoria e transação dele.
  await withUserContext(ator.id, () => athletes.update(ATLETA_ESPERADO, { userId: conta.id }, ator));

  const depois = await withUserContext(ator.id, () => retrato(prisma));

  // "MEU HISTÓRICO" DO ATLETA, pelo serviço real, no contexto dele.
  const meu = await withUserContext(conta.id, () =>
    meService.history({ id: conta.id, name: conta.name, role: conta.role }, {}));

  const mudancas = diferencas(antes.atleta, depois.atleta);
  const ledgerIgual = JSON.stringify(antes.pontos.map(p => ({ ...p, voidedAt: iso(p.voidedAt) })))
    === JSON.stringify(depois.pontos.map(p => ({ ...p, voidedAt: iso(p.voidedAt) })));

  const trilha = await withUserContext(ator.id, () => prisma.auditLog.findFirst({
    where: { action: 'ATHLETE_UPDATE', entityId: ATLETA_ESPERADO },
    orderBy: { createdAt: 'desc' },
    select: { userId: true, userEmail: true, metadata: true, createdAt: true }
  }));

  console.log('\n=== VERIFICAÇÃO (somente leitura) ===');
  console.log(`diferenças no atleta      ${JSON.stringify(mudancas)}`);
  console.log(`RankingPoints             ${antes.pontos.length} -> ${depois.pontos.length} linha(s)`);
  console.log(`soma de pontos            ${antes.pontos.reduce((t, p) => t + p.points, 0)} -> ${depois.pontos.reduce((t, p) => t + p.points, 0)}`);
  console.log(`atletas com a matrícula   ${antes.homonimos} -> ${depois.homonimos}`);
  console.log(`Meu Histórico do atleta   atleta=${meu.athlete?.id ?? 'null'} lançamentos=${meu.total} pontos=${meu.totals?.points ?? 0}`);

  const vereditos = [
    ['userId agora é a conta do atleta', depois.atleta.userId === conta.id],
    ['SOMENTE userId mudou no atleta', mudancas.length === 1 && mudancas[0].campo === 'userId'],
    ['é o MESMO Athlete (o id não mudou)', depois.atleta.id === ATLETA_ESPERADO],
    ['NENHUM atleta novo foi criado', depois.homonimos === antes.homonimos && depois.homonimos === 1],
    ['AthleteIdentity intacta', diferencas(antes.identidade, depois.identidade).length === 0],
    ['RankingPoint intacto, campo a campo', ledgerIgual],
    ['nenhum ponto duplicado', depois.pontos.length === antes.pontos.length],
    ['"Meu Histórico" dele resolve ESTE atleta', meu.athlete?.id === ATLETA_ESPERADO],
    ['e mostra o histórico existente', meu.total === antes.pontos.length],
    ['matrícula e filiação inalteradas', depois.atleta.affiliationNumber === antes.atleta.affiliationNumber
      && depois.atleta.affiliationId === antes.atleta.affiliationId],
    ['auditoria ATHLETE_UPDATE registrada', Boolean(trilha) && (trilha.metadata?.fields ?? []).includes('userId')]
  ];
  console.log('');
  let tudoOk = true;
  for (const [rotulo, ok] of vereditos) {
    console.log(`  ${ok ? 'PASS  ' : 'FALHOU'}  ${rotulo}`);
    if (!ok) tudoOk = false;
  }
  if (trilha) console.log(`\nauditoria: ATHLETE_UPDATE por ${trilha.userEmail ?? trilha.userId} em ${iso(trilha.createdAt)} — fields ${JSON.stringify(trilha.metadata?.fields)}`);

  console.log(tudoOk ? '\nCONCLUÍDO — a conta do atleta foi vinculada ao mesmo atleta e verificada.' : '\nATENÇÃO — alguma verificação reprovou. Ver acima.');
  process.exit(tudoOk ? 0 : 1);
})().catch(e => { console.error(`FALHOU: ${e.message}`); process.exit(1); });
