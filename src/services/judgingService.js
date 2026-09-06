const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { allowsJudging } = require('../utils/eventStates');
const audit = require('./auditService');

// Painéis, escalação de juízes, sessões e coleta de colocações.
// A apuração em si vive em resultService: julgar e apurar são etapas
// separadas, e é essa separação que permite recalcular sem reabrir fichas.

async function createPanel(eventId, data, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'judging.manage', event.organizationId);

  try {
    return await prisma.judgePanel.create({ data: { eventId, name: data.name } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'PANEL_NAME_IN_USE', 'Já existe painel com este nome no evento');
    throw error;
  }
}

async function addJudge(panelId, data, actor) {
  const panel = await prisma.judgePanel.findUnique({ where: { id: panelId }, include: { event: true } });
  if (!panel) throw new AppError(404, 'PANEL_NOT_FOUND', 'Painel não encontrado');
  assertCan(actor, 'judging.manage', panel.event.organizationId);

  // Os vínculos de organização precisam vir junto: a permissão de julgar
  // costuma ser papel de tenant, e sem eles a checagem abaixo veria apenas o
  // papel global e recusaria um juiz legitimamente escalado.
  const judge = await prisma.user.findUnique({
    where: { id: data.judgeId },
    include: { memberships: { select: { organizationId: true, role: true } } }
  });
  if (!judge) throw new AppError(404, 'JUDGE_NOT_FOUND', 'Juiz não encontrado');
  if (judge.status !== 'ACTIVE') throw new AppError(422, 'JUDGE_INACTIVE', 'Juiz com conta inativa');

  // Só entra no painel quem tem permissão de pontuar. Escalar quem não pode
  // julgar produziria uma sessão que nunca fecha.
  const { can } = require('../utils/permissions');
  if (!can(judge, 'judging.score', panel.event.organizationId)) {
    throw new AppError(422, 'NOT_A_JUDGE', 'Usuário não tem permissão para julgar nesta organização');
  }

  // Um painel tem um único juiz-chefe: dois quebrariam o desempate por
  // colocação do chefe.
  if (data.role === 'HEAD') {
    const chefeExistente = await prisma.panelJudge.findFirst({ where: { panelId, role: 'HEAD' } });
    if (chefeExistente) throw new AppError(409, 'HEAD_JUDGE_EXISTS', 'O painel já tem juiz-chefe');
  }

  try {
    return await prisma.panelJudge.create({ data: { panelId, judgeId: data.judgeId, seat: data.seat, role: data.role || 'JUDGE' } });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'JUDGE_ALREADY_IN_PANEL', 'Juiz ou assento já ocupado neste painel');
    throw error;
  }
}

async function removeJudge(panelId, judgeId, actor) {
  const panel = await prisma.judgePanel.findUnique({ where: { id: panelId }, include: { event: true } });
  if (!panel) throw new AppError(404, 'PANEL_NOT_FOUND', 'Painel não encontrado');
  assertCan(actor, 'judging.manage', panel.event.organizationId);

  // Tirar um juiz que já pontuou mudaria a apuração sem deixar rastro na
  // sessão. Fecha-se a sessão, corrige-se, e a nova versão fica auditada.
  const votos = await prisma.judgingScore.count({ where: { judgeId, session: { panelId } } });
  if (votos > 0) throw new AppError(422, 'JUDGE_HAS_SCORES', 'Juiz já pontuou; remova as sessões antes');

  await prisma.panelJudge.delete({ where: { panelId_judgeId: { panelId, judgeId } } });
  return { success: true };
}

async function listPanels(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'judging.read', event.organizationId);

  return prisma.judgePanel.findMany({
    where: { eventId },
    include: { judges: { include: { judge: { select: { id: true, name: true, email: true } } }, orderBy: { seat: 'asc' } } },
    orderBy: { name: 'asc' }
  });
}

async function carregarSessao(id) {
  const session = await prisma.judgingSession.findUnique({
    where: { id },
    include: {
      panel: { include: { event: true, judges: true } },
      competitionClass: { include: { division: { include: { eventCategory: { include: { event: true, category: true } } } } } }
    }
  });
  if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Sessão de julgamento não encontrada');
  return session;
}

async function openSession(data, actor) {
  const competitionClass = await prisma.competitionClass.findUnique({
    where: { id: data.classId },
    include: { division: { include: { eventCategory: { include: { event: true } } } } }
  });
  if (!competitionClass) throw new AppError(404, 'CLASS_NOT_FOUND', 'Classe não encontrada');

  const event = competitionClass.division.eventCategory.event;
  assertCan(actor, 'judging.manage', event.organizationId);

  if (!allowsJudging(event.status)) {
    throw new AppError(422, 'EVENT_NOT_IN_JUDGING', `Evento em ${event.status} não está em julgamento`);
  }

  const panel = await prisma.judgePanel.findUnique({ where: { id: data.panelId }, include: { judges: true } });
  if (!panel || panel.eventId !== event.id) throw new AppError(422, 'PANEL_INVALID', 'Painel não pertence a este evento');
  if (!panel.judges.length) throw new AppError(422, 'PANEL_EMPTY', 'Painel sem juízes escalados');

  if (data.batchId) {
    const batch = await prisma.stageBatch.findUnique({ where: { id: data.batchId } });
    if (!batch || batch.classId !== data.classId) throw new AppError(422, 'BATCH_INVALID', 'Bateria não pertence a esta classe');
  }

  try {
    return await prisma.judgingSession.create({
      data: { classId: data.classId, panelId: data.panelId, batchId: data.batchId ?? null, round: data.round || 'PREJUDGING' }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SESSION_EXISTS', 'Já existe sessão desta rodada para a classe');
    throw error;
  }
}

// Atletas que a sessão julga: inscritos confirmados na classe que fizeram
// check-in. Quem não apareceu não entra na ficha do juiz.
async function competitorsOf(session) {
  return prisma.registrationItem.findMany({
    where: {
      classId: session.classId,
      status: 'CONFIRMED',
      registration: { status: 'CONFIRMED', checkIn: { status: 'CHECKED_IN' } }
    },
    include: {
      registration: { include: { athlete: { select: { id: true, fullName: true, stageName: true, athleteNumber: true, photoKey: true } } } },
      stageOrders: session.batchId ? { where: { batchId: session.batchId } } : false
    },
    orderBy: { createdAt: 'asc' }
  });
}

async function sessionSheet(sessionId, actor) {
  const session = await carregarSessao(sessionId);
  assertCan(actor, 'judging.read', session.panel.event.organizationId);

  const competitors = await competitorsOf(session);

  const meusVotos = await prisma.judgingScore.findMany({
    where: { sessionId, judgeId: actor.id },
    select: { registrationItemId: true, placing: true, notes: true, submittedAt: true }
  });

  const progresso = await prisma.judgingScore.groupBy({
    by: ['judgeId'],
    where: { sessionId },
    _count: { _all: true }
  });

  return {
    session: {
      id: session.id, round: session.round, status: session.status,
      competitionClass: session.competitionClass, panel: { id: session.panel.id, name: session.panel.name }
    },
    competitors: competitors.map(item => ({
      registrationItemId: item.id,
      bibNumber: item.bibNumber,
      position: item.stageOrders?.[0]?.position ?? null,
      athlete: item.registration.athlete
    })),
    myScores: meusVotos,
    progress: session.panel.judges.map(judge => ({
      judgeId: judge.judgeId,
      seat: judge.seat,
      role: judge.role,
      scored: progresso.find(item => item.judgeId === judge.judgeId)?._count._all ?? 0,
      total: competitors.length
    }))
  };
}

/**
 * Um juiz envia a sua ficha inteira: uma colocação por atleta, sem repetição.
 * O envio é substitutivo — reenviar corrige a ficha daquele juiz e de mais
 * ninguém.
 */
async function submitScores(sessionId, { placings }, actor) {
  const session = await carregarSessao(sessionId);
  const event = session.panel.event;

  assertCan(actor, 'judging.score', event.organizationId);

  if (session.status === 'CLOSED') throw new AppError(422, 'SESSION_CLOSED', 'Sessão encerrada não aceita novas fichas');
  if (!allowsJudging(event.status)) throw new AppError(422, 'EVENT_NOT_IN_JUDGING', `Evento em ${event.status} não está em julgamento`);

  // Só julga quem está escalado neste painel. Um juiz do evento não vota em
  // painel de que não faz parte.
  const assento = session.panel.judges.find(judge => judge.judgeId === actor.id);
  if (!assento) throw new AppError(403, 'JUDGE_NOT_ASSIGNED', 'Você não está escalado neste painel');

  const competitors = await competitorsOf(session);
  const validos = new Set(competitors.map(item => item.id));

  const desconhecidos = placings.filter(item => !validos.has(item.registrationItemId));
  if (desconhecidos.length) throw new AppError(422, 'COMPETITOR_INVALID', 'Há atleta fora desta sessão na ficha');

  const posicoes = placings.map(item => item.placing);
  if (new Set(posicoes).size !== posicoes.length) {
    throw new AppError(422, 'DUPLICATE_PLACING', 'O mesmo juiz não pode dar a mesma colocação a dois atletas');
  }
  const atletas = placings.map(item => item.registrationItemId);
  if (new Set(atletas).size !== atletas.length) {
    throw new AppError(422, 'DUPLICATE_COMPETITOR', 'Atleta repetido na ficha');
  }
  if (Math.max(...posicoes) > competitors.length) {
    throw new AppError(422, 'PLACING_OUT_OF_RANGE', `Colocação acima do número de atletas da sessão (${competitors.length})`);
  }

  const agora = new Date();

  await prisma.$transaction(async tx => {
    // Substitutivo: apaga a ficha anterior deste juiz e grava a nova. Sem isso,
    // uma correção deixaria as duas versões somando na apuração.
    await tx.judgingScore.deleteMany({ where: { sessionId, judgeId: actor.id } });

    for (const item of placings) {
      const score = await tx.judgingScore.create({
        data: {
          sessionId, judgeId: actor.id, registrationItemId: item.registrationItemId,
          placing: item.placing, notes: item.notes ?? null, submittedAt: agora
        }
      });

      if (item.criteria?.length) {
        await tx.judgingScoreCriterion.createMany({
          data: item.criteria.map(criterio => ({ scoreId: score.id, criterionId: criterio.criterionId, value: criterio.value }))
        });
      }
    }

    if (session.status === 'OPEN') {
      await tx.judgingSession.update({ where: { id: sessionId }, data: { status: 'SCORING' } });
    }
  });

  await audit.record({
    actor, action: audit.ACTIONS.JUDGING_SCORE, entity: 'JudgingSession', entityId: sessionId,
    organizationId: event.organizationId,
    metadata: { classId: session.classId, round: session.round, count: placings.length, seat: assento.seat }
  });

  return { success: true, submitted: placings.length };
}

// Fecha a sessão. A partir daqui as fichas estão congeladas e a classe pode ser
// apurada.
async function closeSession(sessionId, actor) {
  const session = await carregarSessao(sessionId);
  assertCan(actor, 'judging.close', session.panel.event.organizationId);

  if (session.status === 'CLOSED') throw new AppError(422, 'SESSION_ALREADY_CLOSED', 'Sessão já encerrada');

  const competitors = await competitorsOf(session);
  if (!competitors.length) throw new AppError(422, 'NO_COMPETITORS', 'Sessão sem atletas para julgar');

  // Ficha incompleta impede o fechamento: apurar com juiz faltando mudaria a
  // soma de colocações e o resultado.
  const votos = await prisma.judgingScore.groupBy({ by: ['judgeId'], where: { sessionId }, _count: { _all: true } });
  const incompletos = session.panel.judges
    .map(judge => ({ judgeId: judge.judgeId, seat: judge.seat, scored: votos.find(v => v.judgeId === judge.judgeId)?._count._all ?? 0 }))
    .filter(judge => judge.scored !== competitors.length);

  if (incompletos.length) {
    const erro = new AppError(422, 'INCOMPLETE_SCORES', 'Há juízes com ficha incompleta');
    erro.details = incompletos.map(judge => ({ message: `Assento ${judge.seat}: ${judge.scored}/${competitors.length}` }));
    throw erro;
  }

  const atualizada = await prisma.judgingSession.update({
    where: { id: sessionId },
    data: { status: 'CLOSED', closedAt: new Date() }
  });

  await audit.record({
    actor, action: audit.ACTIONS.JUDGING_CLOSE, entity: 'JudgingSession', entityId: sessionId,
    organizationId: session.panel.event.organizationId, metadata: { classId: session.classId, round: session.round, judges: session.panel.judges.length, competitors: competitors.length }
  });

  return atualizada;
}

async function listSessions(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'judging.read', event.organizationId);

  return prisma.judgingSession.findMany({
    where: { panel: { eventId } },
    include: {
      panel: { select: { id: true, name: true } },
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } },
      _count: { select: { scores: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
}

module.exports = {
  createPanel, addJudge, removeJudge, listPanels,
  openSession, sessionSheet, submitScores, closeSession, listSessions,
  competitorsOf, carregarSessao
};
