// ===========================================================================
// DESVINCULAR A CONTA ADMINISTRATIVA DO ATLETA — OPERAÇÃO ÚNICA, AUDITADA.
//
// Usa o SERVIÇO OFICIAL (`athleteService.update`), o mesmo que a rota
// PATCH /athletes/:id usa: mesma autorização, mesma auditoria, mesma transação
// da requisição. Não é UPDATE direto no banco e não é caminho paralelo.
//
// ABORTA se qualquer pré-condição não bater. Não aceita id arbitrário.
// IDEMPOTENTE: se já estiver desvinculado, relata e sai sem escrever.
// ===========================================================================
const ATLETA_ESPERADO = process.env.ALVO_ATHLETE_ID;
const USER_ESPERADO   = process.env.ALVO_USER_ID;
const NOME_ESPERADO   = process.env.ALVO_NOME;
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
  const pedido = await tx.athleteProfileRequest.findFirst({
    where: { athleteId: ATLETA_ESPERADO },
    select: { id: true, status: true, userId: true, reviewedById: true }
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
    pedido
  };
}

function diferencas(a, b) {
  const saida = [];
  for (const k of Object.keys(a)) if (iso(a[k]) !== iso(b[k])) saida.push({ campo: k, de: iso(a[k]), para: iso(b[k]) });
  return saida;
}

(async () => {
  for (const [nome, valor] of [['ALVO_ATHLETE_ID', ATLETA_ESPERADO], ['ALVO_USER_ID', USER_ESPERADO], ['ALVO_NOME', NOME_ESPERADO]]) {
    if (!valor) { console.error(`ABORTADO: ${nome} não definida.`); process.exit(1); }
  }

  const ator = await prisma.user.findUnique({
    where: { id: USER_ESPERADO },
    select: { id: true, name: true, email: true, role: true, status: true }
  });
  if (!ator) { console.error(`ABORTADO: usuário ${USER_ESPERADO} não existe.`); process.exit(1); }
  if (ator.role !== 'SUPER_ADMIN' && ator.role !== 'ADMIN') {
    console.error(`ABORTADO: ${USER_ESPERADO} não é administrador (papel: ${ator.role}).`); process.exit(1);
  }

  const antes = await withUserContext(ator.id, () => retrato(prisma));
  if (!antes) { console.error(`ABORTADO: atleta ${ATLETA_ESPERADO} não encontrado.`); process.exit(1); }

  console.log('=== ESTADO ATUAL (somente leitura) ===');
  console.log(`athleteId          ${antes.atleta.id}`);
  console.log(`fullName           ${antes.atleta.fullName}`);
  console.log(`userId             ${antes.atleta.userId ?? 'null'}`);
  console.log(`organizationId     ${antes.atleta.organizationId}`);
  console.log(`affiliationId      ${antes.atleta.affiliationId ?? 'null'}`);
  console.log(`affiliationNumber  ${antes.atleta.affiliationNumber ?? 'null'}`);
  console.log(`status             ${antes.atleta.status}`);
  console.log(`AthleteIdentity    ${antes.identidade ? antes.identidade.cpfMarca : '(ausente)'}`);
  console.log(`RankingPoints      ${antes.pontos.length} linha(s), soma ${antes.pontos.reduce((t, p) => t + p.points, 0)} ponto(s)`);
  console.log(`  ids              ${antes.pontos.map(p => p.id).join(', ') || '(nenhum)'}`);
  console.log(`AthleteProfileReq  ${antes.pedido ? `${antes.pedido.id} status=${antes.pedido.status} revisadoPor=${antes.pedido.reviewedById ?? 'null'}` : '(nenhum)'}`);
  console.log(`ator da operação   ${ator.name} <${ator.email}> (${ator.role})`);

  console.log('\n=== PRÉ-CONDIÇÕES ===');
  const condicoes = [
    ['o atleta é o esperado', antes.atleta.id === ATLETA_ESPERADO],
    ['o nome confere exatamente', antes.atleta.fullName === NOME_ESPERADO],
    ['o userId atual é o esperado', antes.atleta.userId === USER_ESPERADO],
    ['há AthleteIdentity', Boolean(antes.identidade)],
    ['o status é ACTIVE', antes.atleta.status === 'ACTIVE']
  ];
  let todasOk = true;
  for (const [rotulo, ok] of condicoes) {
    console.log(`  ${ok ? 'OK    ' : 'FALHOU'}  ${rotulo}`);
    if (!ok) todasOk = false;
  }

  if (antes.atleta.userId === null) {
    console.log('\nJÁ DESVINCULADO: userId é null. Nada a fazer (idempotente).');
    process.exit(0);
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
  await withUserContext(ator.id, () => athletes.update(ATLETA_ESPERADO, { userId: null }, ator));

  const depois = await withUserContext(ator.id, () => retrato(prisma));

  console.log('\n=== VERIFICAÇÃO (somente leitura) ===');
  const mudancasNoAtleta = diferencas(antes.atleta, depois.atleta);
  console.log(`diferenças no atleta      ${JSON.stringify(mudancasNoAtleta)}`);
  console.log(`diferenças na identidade  ${JSON.stringify(diferencas(antes.identidade, depois.identidade))}`);
  console.log(`RankingPoints             ${antes.pontos.length} -> ${depois.pontos.length} linha(s)`);
  console.log(`soma de pontos            ${antes.pontos.reduce((t, p) => t + p.points, 0)} -> ${depois.pontos.reduce((t, p) => t + p.points, 0)}`);

  const ledgerIgual = JSON.stringify(antes.pontos.map(p => ({ ...p, voidedAt: iso(p.voidedAt) })))
    === JSON.stringify(depois.pontos.map(p => ({ ...p, voidedAt: iso(p.voidedAt) })));
  const pedidoIgual = JSON.stringify(antes.pedido) === JSON.stringify(depois.pedido);

  const trilha = await withUserContext(ator.id, () => prisma.auditLog.findFirst({
    where: { action: 'ATHLETE_UPDATE', entityId: ATLETA_ESPERADO },
    orderBy: { createdAt: 'desc' },
    select: { userId: true, userEmail: true, metadata: true, createdAt: true }
  }));

  const vereditos = [
    ['userId agora é null', depois.atleta.userId === null],
    ['SOMENTE userId mudou no atleta', mudancasNoAtleta.length === 1 && mudancasNoAtleta[0].campo === 'userId'],
    ['AthleteIdentity intacta', diferencas(antes.identidade, depois.identidade).length === 0],
    ['RankingPoint intacto, campo a campo', ledgerIgual],
    ['AthleteProfileRequest intacto', pedidoIgual],
    ['status continua ACTIVE', depois.atleta.status === 'ACTIVE'],
    ['matrícula inalterada', depois.atleta.affiliationNumber === antes.atleta.affiliationNumber],
    ['filiação inalterada', depois.atleta.affiliationId === antes.atleta.affiliationId],
    ['organização inalterada', depois.atleta.organizationId === antes.atleta.organizationId],
    ['auditoria ATHLETE_UPDATE registrada', Boolean(trilha) && (trilha.metadata?.fields ?? []).includes('userId')]
  ];
  console.log('');
  let tudoOk = true;
  for (const [rotulo, ok] of vereditos) {
    console.log(`  ${ok ? 'PASS  ' : 'FALHOU'}  ${rotulo}`);
    if (!ok) tudoOk = false;
  }
  if (trilha) console.log(`\nauditoria: ${trilha.action ?? 'ATHLETE_UPDATE'} por ${trilha.userEmail ?? trilha.userId} em ${iso(trilha.createdAt)} — fields ${JSON.stringify(trilha.metadata?.fields)}`);

  console.log(tudoOk ? '\nCONCLUÍDO — a correção foi aplicada e verificada.' : '\nATENÇÃO — alguma verificação reprovou. Ver acima.');
  process.exit(tudoOk ? 0 : 1);
})().catch(e => { console.error(`FALHOU: ${e.message}`); process.exit(1); });
