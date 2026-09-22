const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { normalizeCpf, somenteDigitos, formatCpf } = require('../utils/cpf');
const { assertCan, organizationFilter, assertPermission } = require('../utils/tenant');
const { can } = require('../utils/permissions');
const { athleteFor, athletePublic } = require('../utils/visibility');
const audit = require('./auditService');
const notifications = require('./notificationService');
const muscleWar = require('./muscleWarService');
const logger = require('../utils/logger');

// `identity` traz o CPF, que vive em tabela própria com política restrita. Se
// o ator não puder lê-la, o RLS simplesmente não devolve a linha e o
// serializador recebe `identity: null` — o CPF some sozinho, sem depender de
// ninguém lembrar de removê-lo da projeção.
const INCLUDE_PERFIL = Object.freeze({
  team: { select: { id: true, name: true } },
  coach: { select: { id: true, name: true } },
  gym: { select: { id: true, name: true } },
  affiliation: { select: { id: true, name: true, code: true } },
  identity: { select: { cpf: true } }
});

// Localiza o atleta pelo CPF dentro de uma organização. É o coração do
// reconhecimento: inscrição e importação MuscleWar entram por aqui, e é o que
// impede o mesmo atleta virar dois perfis.
async function findByCpf(organizationId, cpfBruto) {
  const cpf = normalizeCpf(cpfBruto);

  const identidade = await prisma.athleteIdentity.findUnique({
    where: { organizationId_cpf: { organizationId, cpf } },
    select: { athleteId: true }
  });
  if (!identidade) return null;

  return prisma.athlete.findUnique({
    where: { id: identidade.athleteId },
    include: INCLUDE_PERFIL
  });
}

// Consulta de reconhecimento usada pelo balcão de inscrição.
async function lookup({ organizationId, cpf }, actor) {
  assertCan(actor, 'athletes.read_sensitive', organizationId);

  const athlete = await findByCpf(organizationId, cpf);

  // Consultar CPF é acesso a dado restrito: fica registrado quem consultou.
  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_CPF_VIEW, entity: 'Athlete',
    entityId: athlete?.id || null, organizationId, metadata: { found: Boolean(athlete) }
  });

  if (!athlete) return { found: false, athlete: null };
  return { found: true, athlete: athleteFor(athlete, actor, organizationId) };
}

// ============================================================================
// A MATRÍCULA IDENTIFICA UMA PESSOA DENTRO DA FEDERAÇÃO.
//
// POR QUE ISTO PRECISOU VIRAR REGRA, E NÃO SÓ DEFESA
//
// O sistema aceitava dois cadastros com a MESMA matrícula na MESMA filiação.
// O vínculo tardio lidava com isso defensivamente: ao encontrar dois donos,
// recusava vincular e marcava CONFLITO para o operador decidir. Correto — e
// insuficiente, porque a ambiguidade podia aparecer DEPOIS.
//
// A sequência que quebrava: o operador cadastra a primeira pessoa com a
// matrícula NPC-123; naquele instante ela é dona única, o vínculo é inequívoco
// e o histórico vai para ela. Semanas depois alguém cadastra a segunda pessoa
// com a mesma matrícula. Agora há dois donos — e o histórico já foi creditado
// ao primeiro, por ordem de chegada, que é exatamente o que este projeto trata
// como regra absoluta a não quebrar.
//
// Recusar o vínculo no momento em que a ambiguidade nasce não resolve: o ponto
// já está somando no ranking de quem talvez não tenha competido.
//
// A correção é impedir o estado, e não reagir a ele. Matrícula repetida na
// mesma filiação não é um dado difícil: é um dado ERRADO — ou o número foi
// digitado errado, ou é a mesma pessoa cadastrada duas vezes, ou a federação
// reaproveitou o número e isso precisa de decisão humana ANTES, não depois.
//
// FORA DESTA REGRA: matrícula nula. Atleta sem filiação registrada continua
// existindo aos montes, e todos eles têm `affiliationNumber` nulo.
// ============================================================================

async function assertMatriculaLivre({ organizationId, affiliationId, affiliationNumber }, exceto = null) {
  if (!affiliationId || !affiliationNumber) return;

  const jaTem = await prisma.athlete.findFirst({
    where: {
      organizationId,
      affiliationId,
      affiliationNumber,
      ...(exceto ? { id: { not: exceto } } : {})
    },
    select: { id: true, fullName: true }
  });

  if (jaTem) {
    throw new AppError(409, 'AFFILIATION_NUMBER_IN_USE',
      `A matrícula ${affiliationNumber} já pertence a ${jaTem.fullName} nesta filiação. `
      + 'Uma matrícula identifica um atleta: confira o número, ou corrija o cadastro existente '
      + 'antes de criar outro.');
  }
}

async function create(data, actor) {
  assertCan(actor, 'athletes.create', data.organizationId);

  const cpf = normalizeCpf(data.cpf);

  const existente = await prisma.athleteIdentity.findUnique({
    where: { organizationId_cpf: { organizationId: data.organizationId, cpf } }
  });
  if (existente) throw new AppError(409, 'ATHLETE_CPF_EXISTS', 'Já existe um atleta com este CPF nesta organização');

  await validarVinculos(data, data.organizationId);
  await assertMatriculaLivre(data);

  try {
    const athlete = await prisma.athlete.create({
      data: {
        organizationId: data.organizationId,
        userId: data.userId ?? null,
        fullName: data.fullName,
        stageName: data.stageName ?? null,
        identity: { create: { organizationId: data.organizationId, cpf } },
        birthDate: data.birthDate ?? null,
        sex: data.sex,
        country: data.country || 'BR',
        state: data.state ?? null,
        city: data.city ?? null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        athleteNumber: data.athleteNumber ?? null,
        affiliationId: data.affiliationId ?? null,
        affiliationNumber: data.affiliationNumber ?? null,
        // O vínculo com equipe é criado logo abaixo, junto da linha de
        // AthleteTeamMembership. Este campo é o espelho do vínculo corrente e
        // não deve ser escrito por outro caminho.
        teamId: data.teamId ?? null,
        coachId: data.coachId ?? null,
        gymId: data.gymId ?? null,
        createdById: actor.id
      },
      include: INCLUDE_PERFIL
    });

    // Atleta novo nunca tem vínculo anterior, então a criação do vínculo aqui
    // é sempre possível — e faz o histórico começar no primeiro dia, em vez de
    // aparecer só na primeira transferência.
    if (data.teamId) {
      const equipe = await prisma.team.findUnique({ where: { id: data.teamId }, select: { companyId: true } });
      await prisma.athleteTeamMembership.create({
        data: {
          athleteId: athlete.id, teamId: data.teamId, companyId: equipe?.companyId ?? null,
          createdById: actor?.id ?? null, activeAthleteId: athlete.id
        }
      });
    }

    await audit.record({
      actor, action: audit.ACTIONS.ATHLETE_CREATE, entity: 'Athlete', entityId: athlete.id,
      organizationId: data.organizationId, metadata: { fullName: athlete.fullName, affiliationId: athlete.affiliationId }
    });

    // O HISTÓRICO VAI ATRÁS DO CADASTRO TAMBÉM POR ESTA PORTA — AGORA QUE DÁ.
    //
    // Esta chamada já existiu e foi REVERTIDA numa fase anterior, e o motivo
    // da reversão é o que precisa ser lido antes de mexer aqui de novo: com a
    // matrícula podendo ter dois donos, vincular no instante da criação era
    // vínculo por ORDEM DE CHEGADA. O primeiro cadastrado levava o histórico
    // porque naquele momento era dono único; o segundo aparecia depois, e o
    // ponto já estava somando no ranking de quem talvez não tivesse competido.
    //
    // O que mudou não foi esta linha: foi a regra embaixo dela. Matrícula
    // repetida na mesma filiação não é mais um estado possível — há guarda no
    // serviço e índice único parcial no banco. Sem ambiguidade futura, o
    // vínculo no cadastro deixa de escolher e volta a apenas reconhecer.
    //
    // Fora da transação de propósito, como na aprovação de pedido: se o
    // vínculo falhar, o atleta continua criado e correto, e a operação é
    // idempotente. Dentro dela, uma falha em resultado antigo desfaria um
    // cadastro válido.
    try {
      await muscleWar.vincularPendentesDoAtleta(athlete, actor);
    } catch (erro) {
      logger.error({ erro: erro.message, athleteId: athlete.id },
        'atleta criado, mas o vínculo de resultados pendentes falhou');
    }

    return athleteFor(athlete, actor, data.organizationId);
  } catch (error) {
    // Duas inscrições simultâneas com o mesmo CPF: a constraint decide.
    if (error.code === 'P2002') {
      const alvo = String(error.meta?.target || '');
      // Dois cadastros simultâneos com a mesma matrícula: a conferência acima
      // pode ter passado nos dois, e quem decide é o índice único.
      if (alvo.includes('affiliationNumber')) {
        throw new AppError(409, 'AFFILIATION_NUMBER_IN_USE',
          'Esta matrícula acabou de ser usada por outro cadastro nesta filiação.');
      }
      if (alvo.includes('athleteNumber')) throw new AppError(409, 'ATHLETE_NUMBER_IN_USE', 'Número de atleta já utilizado');
      throw new AppError(409, 'ATHLETE_CPF_EXISTS', 'Já existe um atleta com este CPF nesta organização');
    }
    throw error;
  }
}

// Vínculos precisam pertencer à mesma organização: aceitar uma equipe de outro
// tenant seria vazamento silencioso entre organizações.
async function validarVinculos(data, organizationId) {
  if (data.affiliationId) {
    const filiacao = await prisma.affiliation.findUnique({ where: { id: data.affiliationId } });
    if (!filiacao || filiacao.organizationId !== organizationId) throw new AppError(422, 'AFFILIATION_INVALID', 'Filiação inválida para esta organização');
  }
  if (data.teamId) {
    const equipe = await prisma.team.findUnique({ where: { id: data.teamId } });
    if (!equipe || equipe.organizationId !== organizationId) throw new AppError(422, 'TEAM_INVALID', 'Equipe inválida para esta organização');
  }
  if (data.gymId) {
    const academia = await prisma.gym.findUnique({ where: { id: data.gymId } });
    if (!academia || academia.organizationId !== organizationId) throw new AppError(422, 'GYM_INVALID', 'Academia inválida para esta organização');
  }
  if (data.coachId) {
    const coach = await prisma.coach.findUnique({ where: { id: data.coachId } });
    if (!coach) throw new AppError(422, 'COACH_INVALID', 'Coach inválido');
  }
}

async function update(id, data, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  // O próprio atleta edita o seu perfil; qualquer outro precisa de permissão.
  const ehODono = athlete.userId && athlete.userId === actor?.id;
  if (!ehODono) assertCan(actor, 'athletes.update', athlete.organizationId);

  // A equipe NÃO se troca por edição de perfil. `athleteUpdate` já não aceita
  // `teamId`, mas a regra não pode depender de uma única linha de schema: se
  // esta porta reabrisse, a troca aconteceria sem vínculo, sem histórico e sem
  // a permissão de transferência.
  if (data.teamId !== undefined) {
    throw new AppError(422, 'TEAM_CHANGE_NOT_ALLOWED_HERE',
      'A equipe do atleta não muda por edição de perfil. '
      + 'Use POST /athletes/:id/team para vincular um atleta sem equipe, '
      + 'ou POST /athletes/:id/team/transfer — que exige o operador da Muscle Contest.');
  }

  await validarVinculos(data, athlete.organizationId);

  // A conferência usa o estado RESULTANTE, e não o recebido: editar só o
  // número mantendo a filiação, ou só a filiação mantendo o número, muda o par
  // do mesmo jeito. Olhar apenas o que veio no corpo deixaria a segunda forma
  // passar direto para o índice único — que recusa, mas com a mensagem
  // genérica de "registro já existe", sem dizer de quem é a matrícula.
  await assertMatriculaLivre({
    organizationId: athlete.organizationId,
    affiliationId: data.affiliationId ?? athlete.affiliationId,
    affiliationNumber: data.affiliationNumber ?? athlete.affiliationNumber
  }, id);

  // Vínculo esportivo e número de atleta não são autoedição: mudam a
  // elegibilidade e só saem por operador.
  // `affiliationNumber` entra na lista pelo mesmo motivo que `affiliationId`:
  // é a outra metade da filiação, e é por ela que o resultado oficial
  // reconhece o atleta. Atleta que editasse o próprio número de registro
  // poderia se apropriar do histórico de outra pessoa.
  const camposRestritos = ['affiliationId', 'affiliationNumber', 'teamId', 'coachId', 'gymId', 'athleteNumber', 'userId'];
  const payload = { ...data };
  if (ehODono && !can(actor, 'athletes.update', athlete.organizationId)) {
    for (const campo of camposRestritos) delete payload[campo];
  }

  const atualizado = await prisma.athlete.update({ where: { id }, data: payload, include: INCLUDE_PERFIL });

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_UPDATE, entity: 'Athlete', entityId: id,
    organizationId: athlete.organizationId, metadata: { fields: Object.keys(payload) }
  });

  return athleteFor(atualizado, actor, athlete.organizationId);
}

async function list(filtros, actor) {
  const escopo = organizationFilter(actor, filtros.organizationId);

  const where = { ...escopo };
  // O FILTRO POR ESTADO. Sem ele, a lista de uma federação grande mistura
  // quem está em circulação com quem foi suspenso ou arquivado — e o operador
  // não tem como separar.
  if (filtros.status) where.status = filtros.status;
  if (filtros.proStatus) where.proStatus = filtros.proStatus;
  if (filtros.affiliationId) where.affiliationId = filtros.affiliationId;
  if (filtros.teamId) where.teamId = filtros.teamId;

  if (filtros.search) {
    const termo = filtros.search.trim();
    const or = [
      { fullName: { contains: termo, mode: 'insensitive' } },
      { stageName: { contains: termo, mode: 'insensitive' } }
    ];
    // CPF só entra na busca para quem pode ver dado sensível — e mesmo assim
    // como igualdade exata, nunca como prefixo que permita varredura.
    const digitos = somenteDigitos(termo);
    if (digitos.length === 11 && can(actor, 'search.sensitive', filtros.organizationId || null)) {
      or.push({ identity: { cpf: digitos } });
    }
    where.OR = or;
  }

  const items = await prisma.athlete.findMany({
    where,
    include: INCLUDE_PERFIL,
    orderBy: { fullName: 'asc' },
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items: items.map(item => athleteFor(item, actor, item.organizationId)),
    nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null
  };
}

async function findById(id, actor) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    include: {
      ...INCLUDE_PERFIL,
      proHistory: { orderBy: { effectiveAt: 'desc' }, take: 20 },
      registrations: {
        select: {
          id: true, status: true, createdAt: true,
          event: { select: { id: true, name: true, slug: true, status: true, startDate: true } },
          items: { select: { id: true, status: true, bibNumber: true, competitionClass: { select: { id: true, name: true, division: { select: { name: true, eventCategory: { select: { category: { select: { code: true, name: true } } } } } } } } } }
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      }
    }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  // Só resultados publicados compõem o histórico visível.
  const resultados = await prisma.resultEntry.findMany({
    where: { athleteId: id, result: { status: 'PUBLISHED' } },
    include: {
      result: { select: { id: true, publishedAt: true, event: { select: { id: true, name: true, slug: true } } } },
      registrationItem: { select: { competitionClass: { select: { id: true, name: true, division: { select: { name: true, eventCategory: { select: { category: { select: { code: true, name: true } } } } } } } } } }
    },
    orderBy: { result: { publishedAt: 'desc' } },
    take: 50
  });

  const pontos = await prisma.ranking.findMany({
    where: { athleteId: id },
    include: { season: { select: { id: true, name: true, year: true } }, category: { select: { id: true, code: true, name: true } } },
    orderBy: { totalPoints: 'desc' }
  });

  return {
    athlete: athleteFor(athlete, actor, athlete.organizationId),
    registrations: athlete.registrations,
    proHistory: athlete.proHistory,
    results: resultados.map(entry => ({
      placing: entry.placing,
      status: entry.status,
      event: entry.result.event,
      publishedAt: entry.result.publishedAt,
      competitionClass: entry.registrationItem.competitionClass
    })),
    rankings: pontos
  };
}

// ------------------------------------------------------------------ ATLETA PRO
async function setProStatus(id, data, actor) {
  const athlete = await prisma.athlete.findUnique({ where: { id } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  assertCan(actor, 'pro.manage', athlete.organizationId);

  if (data.eventId) {
    const evento = await prisma.event.findUnique({ where: { id: data.eventId } });
    if (!evento || evento.organizationId !== athlete.organizationId) throw new AppError(422, 'EVENT_INVALID', 'Evento inválido para esta organização');
  }

  const [atualizado] = await prisma.$transaction([
    prisma.athlete.update({
      where: { id },
      data: {
        proStatus: data.status,
        // A data de virada PRO é gravada uma vez e não se reescreve a cada
        // mudança de situação: histórico é o que conta a trajetória.
        proSince: data.status === 'ACTIVE' && !athlete.proSince ? new Date() : athlete.proSince
      },
      include: INCLUDE_PERFIL
    }),
    prisma.athleteProHistory.create({
      data: {
        athleteId: id,
        status: data.status,
        reason: data.reason,
        eventId: data.eventId ?? null,
        title: data.title ?? null,
        createdById: actor.id
      }
    })
  ]);

  await audit.record({
    actor, action: audit.ACTIONS.PRO_STATUS_CHANGE, entity: 'Athlete', entityId: id,
    organizationId: athlete.organizationId, metadata: { from: athlete.proStatus, to: data.status, reason: data.reason }
  });

  if (athlete.userId) {
    await notifications.notify({
      userIds: [athlete.userId], type: notifications.TYPES.PRO_STATUS,
      title: 'Situação PRO atualizada', message: `Sua situação PRO agora é ${data.status}.`,
      entityType: 'Athlete', entityId: id, actorId: actor.id
    });
  }

  return athleteFor(atualizado, actor, athlete.organizationId);
}

async function listPro(filtros, actor) {
  assertPermission(actor, 'pro.read');
  const escopo = organizationFilter(actor, filtros.organizationId);

  const items = await prisma.athlete.findMany({
    where: { ...escopo, proStatus: { in: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED'] }, ...(filtros.proStatus ? { proStatus: filtros.proStatus } : {}) },
    include: { ...INCLUDE_PERFIL, proHistory: { orderBy: { effectiveAt: 'desc' }, take: 1 } },
    orderBy: [{ proStatus: 'asc' }, { fullName: 'asc' }],
    take: filtros.limit
  });

  return { items: items.map(item => ({ ...athletePublic(item), proHistory: item.proHistory })) };
}

// ===========================================================================
// O ESTADO DO ATLETA — E O QUE ELE NUNCA TOCA.
// ===========================================================================
//
// SUSPENDER e ARQUIVAR são decisões administrativas sobre o que o atleta pode
// fazer DAQUI PARA FRENTE. Elas não apagam, não escondem e não alteram nada do
// que já aconteceu no palco: pontuação, colocação, categoria, classe,
// inscrições, títulos e vínculos históricos continuam inteiros.
//
// Isso não é detalhe de implementação — é a razão de o estado existir. Antes,
// a única forma de tirar alguém de circulação era apagar o cadastro, e apagar
// leva o histórico esportivo junto.
//
// O MOTIVO É OBRIGATÓRIO nas duas transições que restringem. Um ato que muda a
// situação de um atleta e não diz por quê é, seis meses depois, indefensável.
const TRANSICOES = Object.freeze({
  SUSPENDED: { acao: 'ATHLETE_SUSPEND', exigeMotivo: true },
  ARCHIVED: { acao: 'ATHLETE_ARCHIVE', exigeMotivo: true },
  ACTIVE: { acao: 'ATHLETE_REACTIVATE', exigeMotivo: false }
});

// ============================================================================
// REVELAR O CPF — a única porta pela qual o número inteiro sai por id.
//
// A tela administrativa mostra o CPF MASCARADO. Quando o operador precisa do
// número inteiro — conferir um documento, casar um histórico — ele pede, e
// quem decide é aqui, nunca o frontend:
//
//   * `athletes.read_sensitive` dá acesso ao perfil restrito;
//   * `search.sensitive` é o que libera o DOCUMENTO em si.
//
// AS DUAS SÃO CONFERIDAS, e hoje a segunda não recusa ninguém que a primeira
// tenha deixado passar: na matriz atual, TODO papel com
// `athletes.read_sensitive` também tem `search.sensitive` — e é coerente que
// seja assim, porque quem opera check-in, pesagem e inscrição confere
// documento na porta. `tests/revelar-cpf.test.mjs` fixa esse fato, e reprova
// no dia em que ele mudar.
//
// A segunda conferência fica porque é ela que EXPRESSA a regra: ver o cadastro
// restrito e ver o documento são autorizações distintas. No dia em que a
// matriz criar um papel que separe as duas, esta linha passa a morder sem que
// ninguém precise lembrar de acrescentá-la. Tirá-la agora não mudaria nenhum
// comportamento observável — e essa é exatamente a razão de o mutante que a
// remove ser declarado equivalente, com o teste da matriz como contrapeso.
//
// O CPF NUNCA entra na URL nem em parâmetro de consulta — o id do atleta vai
// no caminho, e o número volta no CORPO da resposta. Em URL ele ficaria no
// histórico do navegador, no cabeçalho Referer e no log de acesso do
// servidor, que são três lugares fora do alcance do RLS.
//
// Toda revelação deixa rastro: `ATHLETE_CPF_VIEW` com quem pediu, qual atleta
// e quando. Ver documento alheio é ato auditável, e não consulta trivial.
// ============================================================================
async function revealCpf(id, actor) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    select: { id: true, organizationId: true, identity: { select: { cpf: true } } }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  assertCan(actor, 'athletes.read_sensitive', athlete.organizationId);
  assertCan(actor, 'search.sensitive', athlete.organizationId);

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_CPF_VIEW, entity: 'Athlete',
    entityId: athlete.id, organizationId: athlete.organizationId, metadata: { via: 'reveal' }
  });

  // Ausência de CPF é resposta legítima: a identidade pode nunca ter sido
  // preenchida, ou o RLS pode não ter devolvido a linha. Nos dois casos a
  // resposta é `null`, e não erro — inventar 404 aqui ensinaria o operador a
  // ler "não encontrado" como "não pode", que são coisas diferentes.
  return { cpf: athlete.identity?.cpf ? formatCpf(athlete.identity.cpf) : null };
}

async function setStatus(id, { status, reason = null }, actor) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    select: { id: true, organizationId: true, status: true, fullName: true }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  // `athletes.manage` e não `athletes.update`: mudar o estado de um atleta não
  // é editar o cadastro dele. O próprio atleta NUNCA se suspende nem se
  // reativa — não há caminho de dono aqui, de propósito.
  assertCan(actor, 'athletes.manage', athlete.organizationId);

  const transicao = TRANSICOES[status];
  if (!transicao) throw new AppError(422, 'ATHLETE_STATUS_INVALID', 'Estado de atleta inválido');

  if (transicao.exigeMotivo && !String(reason || '').trim()) {
    throw new AppError(422, 'ATHLETE_STATUS_REASON_REQUIRED',
      'Informe o motivo: mudar a situação de um atleta sem dizer por quê deixa a decisão sem defesa');
  }

  // Repetir o MESMO estado é idempotente, e não erro: dois operadores
  // confirmando o mesmo fato não produzem duas suspensões.
  if (athlete.status === status) {
    return prisma.athlete.findUnique({ where: { id }, include: INCLUDE_PERFIL })
      .then(atual => athleteFor(atual, actor, athlete.organizationId));
  }

  const atualizado = await prisma.athlete.update({
    where: { id },
    data: {
      status,
      statusReason: transicao.exigeMotivo ? String(reason).trim() : (reason ? String(reason).trim() : null),
      statusChangedAt: new Date(),
      statusChangedById: actor?.id ?? null
    },
    include: INCLUDE_PERFIL
  });

  await audit.record({
    actor, action: transicao.acao, entity: 'Athlete', entityId: id,
    organizationId: athlete.organizationId,
    // SEM nome de pessoa: o log é lido por mais gente e guardado por mais
    // tempo do que o dado que o originou.
    metadata: { de: athlete.status, para: status, reason: reason ? String(reason).trim() : null }
  });

  return athleteFor(atualizado, actor, athlete.organizationId);
}

// ===========================================================================
// APAGAR ATLETA COM HISTÓRICO ESPORTIVO NÃO É UMA OPÇÃO.
// ===========================================================================
//
// O `RankingPoint` é o ledger da federação. Apagar o atleta apaga a linha do
// ranking, a projeção pública, o resultado da súmula e o título que ele
// levou — e nada disso volta. Nenhuma tela administrativa pode oferecer essa
// porta, e o backend não pode confiar que a tela a escondeu.
//
// A conferência é por CONTAGEM, em cada tabela que guarda fato esportivo.
// Havendo qualquer um, a resposta nomeia o que impede e aponta o caminho que
// existe: ARQUIVAR, que tira de circulação e preserva tudo.
const DEPENDENCIAS_HISTORICAS = Object.freeze([
  ['rankingPoint', 'lançamento de ranking'],
  ['ranking', 'linha de ranking'],
  ['publicRankingEntry', 'linha da projeção pública'],
  ['resultEntry', 'resultado de campeonato'],
  ['registration', 'inscrição'],
  ['externalResult', 'resultado histórico importado'],
  ['eventOverallTitle', 'título Overall']
]);

async function remove(id, actor) {
  const athlete = await prisma.athlete.findUnique({
    where: { id },
    select: { id: true, organizationId: true, status: true }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  assertCan(actor, 'athletes.manage', athlete.organizationId);

  const encontradas = [];
  for (const [modelo, rotulo] of DEPENDENCIAS_HISTORICAS) {
    const quantos = await prisma[modelo].count({ where: { athleteId: id } });
    if (quantos) encontradas.push({ rotulo, quantos });
  }

  if (encontradas.length) {
    const resumo = encontradas.map(d => `${d.quantos} ${d.rotulo}${d.quantos > 1 ? '(s)' : ''}`).join(', ');
    throw new AppError(
      409, 'ATHLETE_HAS_HISTORY',
      `Este atleta possui histórico esportivo e não pode ser apagado: ${resumo}. `
      + 'Arquive o atleta — o histórico permanece e ele sai de circulação.'
    );
  }

  await prisma.athlete.delete({ where: { id } });

  await audit.record({
    actor, action: 'ATHLETE_DELETE', entity: 'Athlete', entityId: id,
    organizationId: athlete.organizationId,
    metadata: { status: athlete.status, semHistorico: true }
  });

  return { deleted: true, id };
}

module.exports = {
  findByCpf, lookup, create, update, list, findById, setProStatus, listPro,
  setStatus, remove, revealCpf, INCLUDE_PERFIL
};
