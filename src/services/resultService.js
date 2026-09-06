const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { tabulate, REGRA_PADRAO } = require('../utils/tabulation');
const { resultFor } = require('../utils/visibility');
const audit = require('./auditService');
const notifications = require('./notificationService');
const ranking = require('./rankingService');

// Apuração, publicação e versionamento de resultados.
//
// O resultado publicado é protegido: qualquer alteração posterior cria uma
// nova versão, guarda a anterior íntegra e registra motivo, autor e momento.

// Toda mudança de estado do resultado vira uma versão: o número em
// `result.version` e a linha em `ResultVersion` andam juntos, e nenhuma versão
// é sobrescrita. É isto que torna a correção de um resultado publicado
// auditável em vez de silenciosa.
async function registrarVersao(tx, { resultId, version, status, checksum, reason, createdById, entries }) {
  return tx.resultVersion.create({
    data: {
      resultId,
      version,
      reason,
      createdById,
      snapshot: {
        status,
        checksum,
        entries: entries.map(entry => ({
          registrationItemId: entry.registrationItemId,
          athleteId: entry.athleteId,
          placing: entry.placing,
          status: entry.status,
          score: entry.score,
          rawScore: entry.rawScore
        }))
      }
    }
  });
}

async function carregarClasse(classId) {
  const competitionClass = await prisma.competitionClass.findUnique({
    where: { id: classId },
    include: {
      division: { include: { eventCategory: { include: { category: true, event: { include: { scoringRuleSet: true, season: { include: { scoringRuleSet: true } } } } } } } }
    }
  });
  if (!competitionClass) throw new AppError(404, 'CLASS_NOT_FOUND', 'Classe não encontrada');
  return competitionClass;
}

// Regra de apuração vigente: a do evento, senão a da temporada, senão o padrão
// conservador (soma de colocações, sem descarte, sem desempate automático).
function regraVigente(event) {
  const regra = event.scoringRuleSet || event.season?.scoringRuleSet;
  if (!regra) return { ...REGRA_PADRAO };
  return {
    method: regra.method,
    dropHighLow: regra.dropHighLow,
    dropHighLowMinJudges: regra.dropHighLowMinJudges,
    tieBreakers: regra.tieBreakers || []
  };
}

/**
 * Calcula (ou recalcula) o resultado de uma classe a partir das fichas
 * encerradas. Determinístico: mesma entrada, mesmo checksum, mesma saída.
 */
async function calculate(classId, actor) {
  const competitionClass = await carregarClasse(classId);
  const event = competitionClass.division.eventCategory.event;

  assertCan(actor, 'results.calculate', event.organizationId);

  // A rodada que vale é a final, se existir; senão a pré-julgamento. Comparação
  // isolada não decide colocação sozinha.
  const sessoes = await prisma.judgingSession.findMany({
    where: { classId, status: 'CLOSED' },
    include: { panel: { include: { judges: true } } },
    orderBy: { createdAt: 'asc' }
  });

  if (!sessoes.length) throw new AppError(422, 'NO_CLOSED_SESSION', 'Nenhuma sessão de julgamento encerrada para esta classe');

  const sessao = sessoes.find(item => item.round === 'FINALS') || sessoes.find(item => item.round === 'PREJUDGING') || sessoes[0];

  const chefes = new Set(sessao.panel.judges.filter(judge => judge.role === 'HEAD').map(judge => judge.judgeId));

  const votos = await prisma.judgingScore.findMany({
    where: { sessionId: sessao.id },
    select: { judgeId: true, registrationItemId: true, placing: true }
  });

  if (!votos.length) throw new AppError(422, 'NO_SCORES', 'Sessão encerrada sem fichas registradas');

  const regra = regraVigente(event);
  const apuracao = tabulate(votos.map(voto => ({ ...voto, isHeadJudge: chefes.has(voto.judgeId) })), regra);

  const itens = await prisma.registrationItem.findMany({
    where: { id: { in: apuracao.entries.map(entry => entry.registrationItemId) } },
    select: { id: true, registration: { select: { athleteId: true } } }
  });
  const athletePorItem = new Map(itens.map(item => [item.id, item.registration.athleteId]));

  const existente = await prisma.result.findUnique({ where: { eventId_classId: { eventId: event.id, classId } } });

  // Resultado já publicado não é recalculado por esta porta: correção é
  // override versionado.
  if (existente?.status === 'PUBLISHED') {
    throw new AppError(422, 'RESULT_PUBLISHED', 'Resultado publicado: use a correção versionada');
  }

  const result = await prisma.$transaction(async tx => {
    const base = existente
      ? await tx.result.update({
        where: { id: existente.id },
        data: {
          status: 'DRAFT',
          // Reapuração é uma nova versão, não uma sobrescrita da anterior.
          version: existente.version + 1,
          checksum: apuracao.checksum,
          hasUnresolvedTie: apuracao.hasUnresolvedTie,
          computedAt: new Date()
        }
      })
      : await tx.result.create({
        data: { eventId: event.id, classId, status: 'DRAFT', checksum: apuracao.checksum, hasUnresolvedTie: apuracao.hasUnresolvedTie }
      });

    await tx.resultEntry.deleteMany({ where: { resultId: base.id } });

    const entradas = apuracao.entries.map(entry => ({
      resultId: base.id,
      registrationItemId: entry.registrationItemId,
      athleteId: athletePorItem.get(entry.registrationItemId),
      placing: entry.placing,
      status: entry.status,
      score: entry.score,
      rawScore: entry.rawScore,
      breakdown: {
        placings: entry.placings,
        countback: entry.countback,
        judgeVotes: entry.judgeVotes,
        dropped: entry.dropped,
        headJudgePlacing: entry.headJudgePlacing
      }
    }));

    await tx.resultEntry.createMany({ data: entradas });

    await registrarVersao(tx, {
      resultId: base.id,
      version: base.version,
      status: base.status,
      checksum: base.checksum,
      reason: existente ? 'Reapuração a partir das fichas encerradas' : 'Apuração inicial',
      createdById: actor.id,
      entries: entradas
    });

    return base;
  });

  await audit.record({
    actor, action: audit.ACTIONS.RESULT_CALCULATION, entity: 'Result', entityId: result.id,
    organizationId: event.organizationId,
    metadata: {
      classId, sessionId: sessao.id, round: sessao.round, checksum: apuracao.checksum,
      judgeCount: apuracao.judgeCount, hasUnresolvedTie: apuracao.hasUnresolvedTie, ruleSet: apuracao.ruleSet
    }
  });

  return findByClass(classId, actor);
}

async function findByClass(classId, actor) {
  const result = await prisma.result.findFirst({
    where: { classId },
    include: {
      entries: {
        include: { athlete: { include: { team: true, coach: true, gym: true, affiliation: true } } },
        orderBy: [{ placing: 'asc' }, { score: 'asc' }]
      },
      event: { select: { id: true, name: true, slug: true, organizationId: true, status: true } },
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } }
    }
  });
  if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não calculado para esta classe');

  const visivel = resultFor(result, actor, result.event.organizationId);
  if (!visivel) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não disponível');

  return { ...visivel, event: result.event, competitionClass: result.competitionClass };
}

/**
 * Publica o resultado. A publicação congela a versão 1 na trilha de versões e
 * dispara a pontuação de ranking do evento.
 */
async function publish(classId, { reason }, actor) {
  const competitionClass = await carregarClasse(classId);
  const event = competitionClass.division.eventCategory.event;

  assertCan(actor, 'results.publish', event.organizationId);

  const result = await prisma.result.findUnique({
    where: { eventId_classId: { eventId: event.id, classId } },
    include: { entries: true }
  });
  if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não calculado');
  if (result.status === 'PUBLISHED') throw new AppError(422, 'ALREADY_PUBLISHED', 'Resultado já publicado');

  // Empate não resolvido é decisão pendente da organização, não detalhe de
  // exibição: publicar assim entregaria uma classificação sem colocação.
  if (result.hasUnresolvedTie) {
    throw new AppError(422, 'TIE_UNRESOLVED', 'Há empate não resolvido: aplique a correção versionada antes de publicar');
  }

  const publicado = await prisma.$transaction(async tx => {
    const atualizado = await tx.result.update({
      where: { id: result.id },
      data: { status: 'PUBLISHED', version: result.version + 1, publishedAt: new Date(), publishedById: actor.id }
    });

    await registrarVersao(tx, {
      resultId: result.id,
      version: atualizado.version,
      status: 'PUBLISHED',
      checksum: result.checksum,
      reason: reason || 'Publicação do resultado',
      createdById: actor.id,
      entries: result.entries
    });

    return atualizado;
  });

  await audit.record({
    actor, action: audit.ACTIONS.RESULT_PUBLICATION, entity: 'Result', entityId: result.id,
    organizationId: event.organizationId, metadata: { classId, version: publicado.version, checksum: result.checksum, reason: reason ?? null }
  });

  // Pontuação de ranking sai do resultado publicado. Se o evento não estiver
  // vinculado a temporada, não há o que pontuar — e isso não é erro.
  const pontuacao = await ranking.awardForResult(result.id, actor);

  const audiencia = await notifications.eventAudience(event.id);
  await notifications.notify({
    userIds: audiencia.everyone, type: notifications.TYPES.RESULT_PUBLISHED,
    title: 'Resultado publicado',
    message: `${competitionClass.name} — ${event.name}.`,
    entityType: 'Result', entityId: result.id, link: `#events/${event.slug}`, actorId: actor.id
  });

  return { result: await findByClass(classId, actor), ranking: pontuacao };
}

/**
 * Correção de resultado publicado. Não sobrescreve: cria a versão seguinte,
 * preserva a anterior e exige motivo.
 */
async function override(classId, { reason, entries }, actor) {
  const competitionClass = await carregarClasse(classId);
  const event = competitionClass.division.eventCategory.event;

  assertCan(actor, 'results.override', event.organizationId);

  const result = await prisma.result.findUnique({
    where: { eventId_classId: { eventId: event.id, classId } },
    include: { entries: true }
  });
  if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não calculado');

  const porItem = new Map(result.entries.map(entry => [entry.registrationItemId, entry]));
  const desconhecidos = entries.filter(entry => !porItem.has(entry.registrationItemId));
  if (desconhecidos.length) throw new AppError(422, 'ENTRY_INVALID', 'Há atleta fora deste resultado na correção');

  const colocacoes = entries.map(entry => entry.placing).filter(valor => valor != null);
  if (new Set(colocacoes).size !== colocacoes.length) {
    throw new AppError(422, 'DUPLICATE_PLACING', 'Duas colocações iguais na correção');
  }

  const atualizado = await prisma.$transaction(async tx => {
    for (const entry of entries) {
      await tx.resultEntry.update({
        where: { resultId_registrationItemId: { resultId: result.id, registrationItemId: entry.registrationItemId } },
        data: { placing: entry.placing ?? null, status: entry.status }
      });
    }

    const novasEntradas = await tx.resultEntry.findMany({ where: { resultId: result.id } });
    const aindaEmpatado = novasEntradas.some(entry => entry.status === 'TIE_UNRESOLVED');

    const novo = await tx.result.update({
      where: { id: result.id },
      data: { version: result.version + 1, hasUnresolvedTie: aindaEmpatado, computedAt: new Date() }
    });

    // O estado anterior já está gravado como a versão corrente antes desta:
    // basta acrescentar a nova, com o motivo da correção.
    await registrarVersao(tx, {
      resultId: result.id,
      version: novo.version,
      status: novo.status,
      checksum: novo.checksum,
      reason,
      createdById: actor.id,
      entries: novasEntradas
    });

    return novo;
  });

  await audit.record({
    actor, action: audit.ACTIONS.RESULT_OVERRIDE, entity: 'Result', entityId: result.id,
    organizationId: event.organizationId,
    metadata: { classId, fromVersion: result.version, toVersion: atualizado.version, reason, changed: entries.length }
  });

  // Resultado já publicado que muda precisa repontuar o ranking, senão o
  // ranking segue refletindo a versão corrigida.
  if (atualizado.status === 'PUBLISHED') await ranking.awardForResult(result.id, actor, { recompute: true });

  return findByClass(classId, actor);
}

async function versions(classId, actor) {
  const competitionClass = await carregarClasse(classId);
  const event = competitionClass.division.eventCategory.event;
  assertCan(actor, 'results.read_unpublished', event.organizationId);

  const result = await prisma.result.findUnique({ where: { eventId_classId: { eventId: event.id, classId } } });
  if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não calculado');

  return prisma.resultVersion.findMany({
    where: { resultId: result.id },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
    orderBy: { version: 'desc' }
  });
}

async function listByEvent(eventId, actor) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');

  const { can } = require('../utils/permissions');
  const podeVerRascunho = actor ? can(actor, 'results.read_unpublished', event.organizationId) : false;

  return prisma.result.findMany({
    where: { eventId, ...(podeVerRascunho ? {} : { status: 'PUBLISHED' }) },
    include: {
      competitionClass: { include: { division: { include: { eventCategory: { include: { category: true } } } } } },
      entries: {
        include: { athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true, state: true, city: true } } },
        orderBy: [{ placing: 'asc' }, { score: 'asc' }]
      }
    },
    orderBy: { computedAt: 'asc' }
  });
}

module.exports = { calculate, findByClass, publish, override, versions, listByEvent, regraVigente };
