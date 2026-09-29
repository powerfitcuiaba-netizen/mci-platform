const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, assertPermission } = require('../utils/tenant');
const { can } = require('../utils/permissions');
const audit = require('./auditService');
const notifications = require('./notificationService');
const memberships = require('./membershipService');
const coaches = require('./coachService');

// ============================================================================
// SOLICITAÇÃO DE VÍNCULO — o treinador pede, o ATLETA decide.
//
// A REGRA QUE ESTE ARQUIVO EXISTE PARA CUMPRIR: enviar solicitação não vincula
// ninguém. O vínculo nasce da confirmação do atleta, e quem o grava é
// `membershipService`, que já carrega a trava de unicidade do banco. Não há
// segundo caminho de escrita de vínculo aqui — de propósito.
//
// TRÊS PORTAS, TRÊS AUTORIDADES DIFERENTES:
//
//   solicitar            treinador aprovado e autorizado na federação, ou
//                        operador com `athletes.update`
//   confirmar/rejeitar   SOMENTE o atleta, pela titularidade da conta
//   aprovarPorDecisao    `athletes.transfer` — o caso excepcional de R-01/R-02,
//                        com justificativa obrigatória e trilha própria
//
// O QUE NÃO ENTRA NA RESPOSTA DA BUSCA: CPF (nem mascarado), documento, data de
// nascimento, telefone, e-mail. A decisão R-05 vale desde a primeira tela do
// fluxo — inclusive na busca, que é onde um vazamento seria mais barato.
// ============================================================================

// O que a busca por matrícula devolve. É deliberadamente curto: o treinador
// precisa CONFERIR que achou a pessoa certa e saber se ela já tem equipe. Mais
// que isso é dado pessoal sem função no fluxo.
const SELECT_LOCALIZACAO = Object.freeze({
  id: true, fullName: true, stageName: true, status: true,
  affiliationNumber: true,
  affiliation: { select: { id: true, name: true, code: true } }
});

const SELECT_PEDIDO = Object.freeze({
  id: true, athleteId: true, teamId: true, coachId: true, status: true,
  requestedAt: true, decidedAt: true, reason: true, membershipId: true,
  athlete: { select: { id: true, fullName: true, stageName: true } },
  team: {
    select: {
      id: true, name: true, organizationId: true,
      company: { select: { id: true, name: true } },
      coach: { select: { id: true, name: true } }
    }
  }
});

/**
 * Localiza atleta por MATRÍCULA dentro de uma federação.
 *
 * Por que uma permissão própria (`athletes.lookup_affiliation`) e não
 * `athletes.read_sensitive`: são perguntas diferentes. Esta identifica; aquela
 * abre o cadastro. O treinador precisa da primeira e não pode ter a segunda.
 *
 * ANTIENUMERAÇÃO. A matrícula é um número curto e sequencial em muitas
 * federações, então a rota é, por natureza, varrível. Três coisas contêm isso, e
 * nenhuma delas sozinha bastaria:
 *
 *   a) a matrícula tem de vir COMPLETA — não há busca por prefixo, nem por
 *      nome, nem paginação. Uma consulta, um resultado ou nada;
 *   b) cada consulta é auditada com autor e se achou, o que torna a varredura
 *      visível depois do fato;
 *   c) a rota tem teto de requisições próprio (ver `src/routes/index.js`).
 *
 * A resposta é a MESMA forma quando acha e quando não acha (`found`), e nunca
 * distingue "matrícula inexistente" de "matrícula de outra federação": as duas
 * são `found: false`. Distingui-las transformaria a rota em oráculo de
 * pertencimento.
 */
async function localizarAtleta({ organizationId, affiliationNumber, affiliationId = null }, actor) {
  // `assertPodeAtuarNaOrganizacao` e não `assertCan`: o treinador não é membro
  // da federação, e o tenant dele é `CoachOrganization` (R-04). Ver o comentário
  // da função em `coachService`.
  await coaches.assertPodeAtuarNaOrganizacao(actor, 'athletes.lookup_affiliation', organizationId);

  const matricula = String(affiliationNumber || '').trim();
  if (!matricula) throw new AppError(422, 'AFFILIATION_NUMBER_REQUIRED', 'Informe a matrícula');

  const atleta = await prisma.athlete.findFirst({
    where: {
      organizationId,
      affiliationNumber: matricula,
      ...(affiliationId ? { affiliationId } : {})
    },
    select: SELECT_LOCALIZACAO
  });

  await audit.record({
    actor, action: audit.ACTIONS.ATHLETE_LOOKUP_AFFILIATION, entity: 'Athlete',
    entityId: atleta?.id ?? null, organizationId,
    metadata: { affiliationNumber: matricula, affiliationId, found: Boolean(atleta) }
  });

  if (!atleta) return { found: false, athlete: null };

  // O vínculo atual é informação NECESSÁRIA: sem ela o treinador envia um pedido
  // que vai ser recusado, e não entende por quê. O nome da equipe atual já é
  // revelado pela recusa 409 de `membershipService` desde antes deste módulo —
  // aqui a informação apenas chega antes, no lugar em que resolve.
  const vinculo = await memberships.vinculoAtivo(atleta.id);
  const pendente = await prisma.teamMembershipRequest.findFirst({
    where: { athleteId: atleta.id, status: 'PENDING' },
    select: { id: true, teamId: true, requestedAt: true }
  });

  return {
    found: true,
    athlete: atleta,
    currentTeam: vinculo ? { id: vinculo.teamId, name: vinculo.team?.name ?? null, since: vinculo.startedAt } : null,
    hasPendingRequest: Boolean(pendente)
  };
}

// Quem pode pedir vínculo para esta equipe, e sob que autoridade.
//
// Dois caminhos, conferidos na ordem em que a realidade os produz. O treinador é
// o caso comum; o operador da federação é o caso de mesa, que existe porque
// atleta sem conta não confirma nada e alguém precisa registrar o pedido.
async function autorizarSolicitacao(team, actor) {
  // O TENANT vem de `assertPodeAtuarNaOrganizacao`: para o treinador é
  // `CoachOrganization` (R-04); para o operador é `OrganizationMember`, como
  // sempre. `assertCan` recusaria o treinador por não achá-lo em
  // `OrganizationMember` — e foi o que ela fez, medido, antes desta correção.
  const { coach: estado } = await coaches.assertPodeAtuarNaOrganizacao(actor, 'teams.request_membership', team.organizationId) ?? {};

  // Conta SEM cadastro de treinador: só segue se for operador com poder de
  // mexer em atleta naquela federação. Sem isso, qualquer papel que ganhasse
  // `teams.request_membership` pediria vínculo para equipe de terceiros.
  if (!estado) {
    assertCan(actor, 'athletes.update', team.organizationId);
    return { coachId: team.coachId ?? null, viaOperador: true };
  }

  if (!estado.autorizado) coaches.recusarTreinadorInativo(estado);

  // A equipe tem de ser DELE. `teams.request_membership` diz que o papel pede
  // vínculo; não diz para qual equipe — e sem esta linha o treinador A povoaria
  // a equipe do treinador B.
  if (team.coachId !== estado.id) {
    if (can(actor, 'athletes.update', team.organizationId)) return { coachId: team.coachId ?? null, viaOperador: true };
    throw new AppError(403, 'TEAM_OTHER_COACH', 'Esta equipe é de outro treinador');
  }

  return { coachId: estado.id, viaOperador: false };
}

async function solicitar({ athleteId, teamId, reason = null }, actor) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { id: true, name: true, organizationId: true, coachId: true }
  });
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'Equipe não encontrada');

  const { coachId } = await autorizarSolicitacao(team, actor);

  const atleta = await prisma.athlete.findUnique({
    where: { id: athleteId },
    select: { id: true, fullName: true, organizationId: true, userId: true, status: true }
  });
  if (!atleta) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  if (atleta.organizationId !== team.organizationId) {
    throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Atleta de outra federação');
  }
  if (atleta.status !== 'ACTIVE') {
    throw new AppError(422, 'ATHLETE_NOT_ACTIVE', 'Atleta não está ativo nesta federação');
  }

  // Elegibilidade conferida ANTES para dar mensagem útil; a garantia continua
  // sendo do banco, na confirmação. Recusar aqui evita o pedido que nasce morto.
  const vinculo = await memberships.vinculoAtivo(athleteId);
  if (vinculo) {
    throw new AppError(409, 'ATHLETE_ALREADY_LINKED',
      `Este atleta está vinculado a ${vinculo.team?.name ?? 'outra equipe'}. `
      + 'Para mudar de equipe, solicite a alteração ao operador da Muscle Contest.',
      { currentTeamId: vinculo.teamId });
  }

  let pedido;
  try {
    pedido = await prisma.teamMembershipRequest.create({
      data: {
        athleteId, teamId, coachId, reason,
        requestedById: actor.id, status: 'PENDING',
        // A trava é do BANCO. Entre a consulta acima e este INSERT cabe a
        // transação de outro treinador, e é exatamente essa janela que dois
        // pedidos simultâneos usariam para disputar a mesma pessoa.
        pendingAthleteId: athleteId
      },
      select: SELECT_PEDIDO
    });
  } catch (error) {
    if (error.code === 'P2002') {
      throw new AppError(409, 'REQUEST_ALREADY_PENDING',
        'Já existe uma solicitação de vínculo pendente para este atleta. Aguarde a resposta dele.');
    }
    throw error;
  }

  await audit.record({
    actor, action: audit.ACTIONS.MEMBERSHIP_REQUEST_CREATE, entity: 'TeamMembershipRequest', entityId: pedido.id,
    organizationId: team.organizationId, metadata: { athleteId, teamId, coachId, reason }
  });

  if (atleta.userId) {
    await notifications.notify({
      userIds: [atleta.userId], actorId: actor.id,
      type: notifications.TYPES.MEMBERSHIP_REQUEST,
      title: 'Convite para equipe',
      message: `A equipe ${team.name} quer incluir você. Confirme ou recuse na sua área.`,
      entityType: 'TeamMembershipRequest', entityId: pedido.id, link: '/minha-equipe'
    });
  }

  return pedido;
}

// Os atletas desta conta. Um usuário pode ser atleta em mais de uma federação,
// então é lista, não um registro.
async function atletasDaConta(actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  return prisma.athlete.findMany({ where: { userId: actor.id }, select: { id: true, organizationId: true } });
}

/** Os pedidos dirigidos ao atleta desta conta. */
async function meusPedidos(actor) {
  const atletas = await atletasDaConta(actor);
  if (!atletas.length) return [];

  return prisma.teamMembershipRequest.findMany({
    where: { athleteId: { in: atletas.map(atleta => atleta.id) } },
    select: SELECT_PEDIDO,
    orderBy: { requestedAt: 'desc' },
    take: 50
  });
}

// Carrega o pedido e confere que quem responde é o DONO da conta do atleta.
async function carregarPedidoDoAtleta(id, actor) {
  const pedido = await prisma.teamMembershipRequest.findUnique({
    where: { id },
    select: { ...SELECT_PEDIDO, athlete: { select: { id: true, fullName: true, userId: true, organizationId: true } } }
  });
  // 404 e não 403: um pedido de outra pessoa não vira sonda de ids válidos.
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  if (!pedido.athlete.userId || pedido.athlete.userId !== actor?.id) {
    throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  }
  if (pedido.status !== 'PENDING') {
    throw new AppError(422, 'REQUEST_NOT_PENDING', 'Esta solicitação já foi respondida', { status: pedido.status });
  }
  return pedido;
}

// Avisa o treinador. `coachId` pode ser nulo (pedido de mesa), e aí quem recebe
// é quem abriu o pedido.
async function avisarSolicitante(pedido, { type, title, message }, actor) {
  const alvos = [];
  if (pedido.coachId) {
    const coach = await prisma.coach.findUnique({ where: { id: pedido.coachId }, select: { userId: true } });
    if (coach?.userId) alvos.push(coach.userId);
  }
  if (pedido.requestedById) alvos.push(pedido.requestedById);
  if (!alvos.length) return;

  await notifications.notify({
    userIds: alvos, actorId: actor.id, type, title, message,
    entityType: 'TeamMembershipRequest', entityId: pedido.id, link: '/treinador/equipe'
  });
}

/**
 * O ATLETA confirma — e é a confirmação que autoriza o vínculo.
 *
 * O pedido é fechado e o vínculo é criado na MESMA transação. Sem isso, uma
 * falha no meio deixaria pedido confirmado sem vínculo (o atleta acha que está
 * na equipe e não está) ou vínculo sem pedido fechado (o `pendingAthleteId`
 * continuaria travando pedidos futuros).
 *
 * A requisição inteira já corre dentro de UMA transação interativa aberta por
 * `withUserContext` — ver `src/config/prisma.js`, cujo `$transaction` interno
 * reaproveita a transação da requisição. Então a atomicidade aqui é do desenho,
 * e o `$transaction` explícito documenta a intenção sem criar uma segunda.
 */
async function confirmar(id, actor) {
  const pedido = await carregarPedidoDoAtleta(id, actor);

  const resultado = await prisma.$transaction(async tx => {
    const vinculo = await memberships.vincularPorConfirmacao(
      pedido.athleteId, { teamId: pedido.teamId, reason: pedido.reason }, actor
    );

    const fechado = await tx.teamMembershipRequest.update({
      where: { id },
      data: {
        status: 'CONFIRMED', decidedById: actor.id, decidedAt: new Date(),
        membershipId: vinculo.id,
        // Decidido deixa de ser pendente: a coluna vira NULL e a vaga da trava
        // reabre para um pedido futuro.
        pendingAthleteId: null
      },
      select: SELECT_PEDIDO
    });

    return { request: fechado, membership: vinculo };
  });

  await audit.record({
    actor, action: audit.ACTIONS.MEMBERSHIP_REQUEST_CONFIRM, entity: 'TeamMembershipRequest', entityId: id,
    organizationId: pedido.team.organizationId,
    metadata: { athleteId: pedido.athleteId, teamId: pedido.teamId, membershipId: resultado.membership.id }
  });

  await avisarSolicitante(pedido, {
    type: notifications.TYPES.MEMBERSHIP_CONFIRMED,
    title: 'Vínculo confirmado',
    message: `${pedido.athlete.fullName} confirmou o vínculo com ${pedido.team.name}.`
  }, actor);

  return resultado;
}

/** O ATLETA recusa. O pedido fica registrado — recusa é informação, não silêncio. */
async function rejeitar(id, { reason = null }, actor) {
  const pedido = await carregarPedidoDoAtleta(id, actor);

  const recusado = await prisma.teamMembershipRequest.update({
    where: { id },
    data: { status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), reason: reason ?? pedido.reason, pendingAthleteId: null },
    select: SELECT_PEDIDO
  });

  await audit.record({
    actor, action: audit.ACTIONS.MEMBERSHIP_REQUEST_REJECT, entity: 'TeamMembershipRequest', entityId: id,
    organizationId: pedido.team.organizationId, metadata: { athleteId: pedido.athleteId, teamId: pedido.teamId, reason }
  });

  await avisarSolicitante(pedido, {
    type: notifications.TYPES.MEMBERSHIP_REJECTED,
    title: 'Vínculo recusado',
    message: `${pedido.athlete.fullName} não confirmou o vínculo com ${pedido.team.name}.`
  }, actor);

  return recusado;
}

/** O solicitante desiste. Não é resposta do atleta — é retirada do pedido. */
async function cancelar(id, { reason = null }, actor) {
  const pedido = await prisma.teamMembershipRequest.findUnique({
    where: { id },
    select: { ...SELECT_PEDIDO, requestedById: true }
  });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  if (pedido.status !== 'PENDING') {
    throw new AppError(422, 'REQUEST_NOT_PENDING', 'Esta solicitação já foi respondida', { status: pedido.status });
  }

  const estado = await coaches.treinadorAtivoDaConta(actor, pedido.team.organizationId);
  const ehOSolicitante = pedido.requestedById === actor?.id
    || (estado?.autorizado && pedido.coachId && pedido.coachId === estado.id);

  if (!ehOSolicitante) assertCan(actor, 'athletes.update', pedido.team.organizationId);

  const cancelado = await prisma.teamMembershipRequest.update({
    where: { id },
    data: { status: 'CANCELLED', decidedById: actor.id, decidedAt: new Date(), reason: reason ?? pedido.reason, pendingAthleteId: null },
    select: SELECT_PEDIDO
  });

  await audit.record({
    actor, action: audit.ACTIONS.MEMBERSHIP_REQUEST_CANCEL, entity: 'TeamMembershipRequest', entityId: id,
    organizationId: pedido.team.organizationId, metadata: { athleteId: pedido.athleteId, teamId: pedido.teamId, reason }
  });

  return cancelado;
}

/**
 * APROVAÇÃO POR DECISÃO ADMINISTRATIVA — o caso excepcional de R-01 e R-02.
 *
 * Substitui a vontade do atleta, e por isso não é permissão de operador de
 * federação: exige `athletes.transfer`, que nenhum papel recebe por construção
 * desde R-02 e que depende de delegação central viva. Justificativa obrigatória,
 * ação própria na trilha (`MEMBERSHIP_REQUEST_ADMIN_APPROVE`), e o atleta é
 * avisado — a decisão é sobre ele e não pode ser silenciosa.
 *
 * Existe porque atleta sem conta na plataforma não tem como confirmar nada, e a
 * alternativa seria deixar o vínculo real fora do sistema.
 */
async function aprovarPorDecisaoAdministrativa(id, { reason }, actor) {
  const pedido = await prisma.teamMembershipRequest.findUnique({ where: { id }, select: SELECT_PEDIDO });
  if (!pedido) throw new AppError(404, 'REQUEST_NOT_FOUND', 'Solicitação não encontrada');
  if (pedido.status !== 'PENDING') {
    throw new AppError(422, 'REQUEST_NOT_PENDING', 'Esta solicitação já foi respondida', { status: pedido.status });
  }

  assertCan(actor, 'athletes.transfer', pedido.team.organizationId);
  if (!reason) throw new AppError(422, 'REASON_REQUIRED', 'Informe a justificativa da decisão administrativa');

  const resultado = await prisma.$transaction(async tx => {
    const vinculo = await memberships.vincularPorDecisaoAdministrativa(
      pedido.athleteId, { teamId: pedido.teamId, reason }, actor
    );

    const fechado = await tx.teamMembershipRequest.update({
      where: { id },
      data: {
        status: 'CONFIRMED', decidedById: actor.id, decidedAt: new Date(),
        membershipId: vinculo.id, reason, pendingAthleteId: null
      },
      select: SELECT_PEDIDO
    });

    return { request: fechado, membership: vinculo };
  });

  await audit.record({
    actor, action: audit.ACTIONS.MEMBERSHIP_REQUEST_ADMIN_APPROVE, entity: 'TeamMembershipRequest', entityId: id,
    organizationId: pedido.team.organizationId,
    metadata: { athleteId: pedido.athleteId, teamId: pedido.teamId, membershipId: resultado.membership.id, reason }
  });

  const atleta = await prisma.athlete.findUnique({ where: { id: pedido.athleteId }, select: { userId: true } });
  if (atleta?.userId) {
    await notifications.notify({
      userIds: [atleta.userId], actorId: actor.id,
      type: notifications.TYPES.MEMBERSHIP_CONFIRMED,
      title: 'Vínculo registrado pela administração',
      message: `O seu vínculo com ${pedido.team.name} foi registrado por decisão administrativa. Motivo: ${reason}`,
      entityType: 'TeamMembershipRequest', entityId: id, link: '/minha-equipe'
    });
  }

  return resultado;
}

/** Os pedidos de uma equipe. O treinador vê os seus; o operador vê os da federação. */
async function listarDaEquipe(filtros, actor) {
  if (!filtros?.teamId) throw new AppError(422, 'TEAM_REQUIRED', 'Informe a equipe');

  const team = await prisma.team.findUnique({
    where: { id: filtros.teamId },
    select: { id: true, organizationId: true, coachId: true }
  });
  if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'Equipe não encontrada');

  const estado = await coaches.treinadorAtivoDaConta(actor, team.organizationId);
  const ehOTreinador = estado?.autorizado && team.coachId && team.coachId === estado.id;
  if (!ehOTreinador) assertCan(actor, 'registrations.read', team.organizationId);
  else assertPermission(actor, 'teams.read_own');

  return prisma.teamMembershipRequest.findMany({
    where: { teamId: team.id, ...(filtros.status ? { status: filtros.status } : {}) },
    select: SELECT_PEDIDO,
    orderBy: { requestedAt: 'desc' },
    take: Math.min(Number(filtros.limit) || 50, 200)
  });
}

module.exports = {
  localizarAtleta, solicitar, meusPedidos, confirmar, rejeitar, cancelar,
  aprovarPorDecisaoAdministrativa, listarDaEquipe
};
