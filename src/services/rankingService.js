const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter, assertPermission } = require('../utils/tenant');
const audit = require('./auditService');

// Ranking e temporadas.
//
// Todo ponto tem proveniência: origem (EVENT ou MUSCLEWAR), evento, resultado
// ou resultado externo. O agregado `Ranking` é sempre derivado de
// `RankingPoint` — nunca escrito à mão — de modo que a soma pode ser refeita e
// conferida a qualquer momento.

async function createSeason(data, actor) {
  assertCan(actor, 'ranking.manage', data.organizationId);

  try {
    return await prisma.rankingSeason.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        year: data.year,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        scoringRuleSetId: data.scoringRuleSetId ?? null
      }
    });
  } catch (error) {
    if (error.code === 'P2002') throw new AppError(409, 'SEASON_EXISTS', 'Já existe temporada com este nome na organização');
    throw error;
  }
}

async function listSeasons(filtros, actor) {
  const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
  return prisma.rankingSeason.findMany({
    where: escopo,
    include: { _count: { select: { events: true, points: true, pointsRules: true } } },
    orderBy: [{ year: 'desc' }, { name: 'asc' }]
  });
}

// Tabela de pontos por colocação. É dado do regulamento, não constante do
// código: sem regra cadastrada, nenhum ponto é atribuído.
async function setPointsRules(seasonId, { rules }, actor) {
  const season = await prisma.rankingSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new AppError(404, 'SEASON_NOT_FOUND', 'Temporada não encontrada');
  assertCan(actor, 'ranking.manage', season.organizationId);

  const colocacoes = rules.map(regra => regra.placing);
  if (new Set(colocacoes).size !== colocacoes.length) throw new AppError(422, 'DUPLICATE_PLACING', 'Colocação repetida na tabela de pontos');

  await prisma.$transaction(async tx => {
    await tx.rankingPointsRule.deleteMany({ where: { seasonId } });
    await tx.rankingPointsRule.createMany({ data: rules.map(regra => ({ seasonId, placing: regra.placing, points: regra.points })) });
  });

  await audit.record({ actor, action: 'RANKING_RULES_SET', entity: 'RankingSeason', entityId: seasonId, organizationId: season.organizationId, metadata: { rules: rules.length } });

  return prisma.rankingPointsRule.findMany({ where: { seasonId }, orderBy: { placing: 'asc' } });
}

async function pointsForPlacing(seasonId, placing) {
  if (placing == null) return 0;
  const regra = await prisma.rankingPointsRule.findUnique({ where: { seasonId_placing: { seasonId, placing } } });
  return regra?.points ?? 0;
}

/**
 * Atribui pontos de ranking a partir de um resultado publicado.
 * Idempotente: a constraint (seasonId, athleteId, resultId) impede que a mesma
 * apuração pontue duas vezes; `recompute` refaz os pontos após uma correção.
 */
async function awardForResult(resultId, actor, { recompute = false } = {}) {
  const result = await prisma.result.findUnique({
    where: { id: resultId },
    include: {
      event: { select: { id: true, organizationId: true, seasonId: true } },
      competitionClass: { include: { division: { include: { eventCategory: { select: { categoryId: true } } } } } },
      entries: { select: { athleteId: true, placing: true, status: true } }
    }
  });
  if (!result) throw new AppError(404, 'RESULT_NOT_FOUND', 'Resultado não encontrado');

  if (result.status !== 'PUBLISHED') return { awarded: 0, reason: 'Resultado não publicado' };
  if (!result.event.seasonId) return { awarded: 0, reason: 'Evento não vinculado a temporada' };

  const seasonId = result.event.seasonId;
  const categoryId = result.competitionClass.division.eventCategory.categoryId;

  const classificados = result.entries.filter(entry => entry.status === 'RANKED' && entry.placing != null);

  const atribuidos = await prisma.$transaction(async tx => {
    if (recompute) await tx.rankingPoint.deleteMany({ where: { seasonId, resultId } });

    let total = 0;
    for (const entry of classificados) {
      const regra = await tx.rankingPointsRule.findUnique({ where: { seasonId_placing: { seasonId, placing: entry.placing } } });
      const points = regra?.points ?? 0;
      if (!points) continue;

      try {
        await tx.rankingPoint.create({
          data: {
            seasonId, athleteId: entry.athleteId, categoryId,
            source: 'EVENT', eventId: result.eventId, resultId,
            placing: entry.placing, points
          }
        });
        total += 1;
      } catch (error) {
        // Já pontuado: a constraint é a garantia de não duplicar.
        if (error.code !== 'P2002') throw error;
      }
    }
    return total;
  });

  await recompute_(seasonId);

  await audit.record({
    actor, action: audit.ACTIONS.RANKING_UPDATE, entity: 'Result', entityId: resultId,
    organizationId: result.event.organizationId, metadata: { seasonId, awarded: atribuidos, recompute }
  });

  return { awarded: atribuidos, seasonId };
}

// Recalcula o agregado a partir dos pontos. Sempre derivado: se `RankingPoint`
// mudar, `Ranking` reflete; se divergirem, a fonte é sempre a linha de ponto.
async function recompute_(seasonId) {
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId },
    select: { athleteId: true, categoryId: true, points: true, eventId: true, externalResultId: true }
  });

  const acumulado = new Map();
  for (const ponto of pontos) {
    const chave = `${ponto.athleteId}::${ponto.categoryId ?? ''}`;
    if (!acumulado.has(chave)) {
      acumulado.set(chave, { athleteId: ponto.athleteId, categoryId: ponto.categoryId, totalPoints: 0, fontes: new Set() });
    }
    const linha = acumulado.get(chave);
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
  }

  const athleteIds = [...new Set([...acumulado.values()].map(linha => linha.athleteId))];
  const atletas = await prisma.athlete.findMany({ where: { id: { in: athleteIds } }, select: { id: true, state: true, country: true } });
  const porAtleta = new Map(atletas.map(atleta => [atleta.id, atleta]));

  const linhas = [...acumulado.values()].sort((a, b) => b.totalPoints - a.totalPoints);

  // Posição por categoria: cada recorte tem a sua numeração.
  const posicaoPorCategoria = new Map();

  await prisma.$transaction(async tx => {
    await tx.ranking.deleteMany({ where: { seasonId } });

    for (const linha of linhas) {
      const chaveCategoria = linha.categoryId ?? '__geral__';
      const proxima = (posicaoPorCategoria.get(chaveCategoria) ?? 0) + 1;
      posicaoPorCategoria.set(chaveCategoria, proxima);

      const atleta = porAtleta.get(linha.athleteId);
      await tx.ranking.create({
        data: {
          seasonId,
          athleteId: linha.athleteId,
          categoryId: linha.categoryId,
          totalPoints: linha.totalPoints,
          eventCount: linha.fontes.size,
          position: proxima,
          state: atleta?.state ?? null,
          country: atleta?.country ?? null
        }
      });
    }
  });

  return { rows: linhas.length };
}

async function recompute(seasonId, actor) {
  const season = await prisma.rankingSeason.findUnique({ where: { id: seasonId } });
  if (!season) throw new AppError(404, 'SEASON_NOT_FOUND', 'Temporada não encontrada');
  assertCan(actor, 'ranking.manage', season.organizationId);

  const resultado = await recompute_(seasonId);
  await audit.record({ actor, action: audit.ACTIONS.RANKING_UPDATE, entity: 'RankingSeason', entityId: seasonId, organizationId: season.organizationId, metadata: resultado });
  return resultado;
}

async function list(filtros, actor) {
  const where = {};
  if (filtros.seasonId) where.seasonId = filtros.seasonId;
  if (filtros.categoryId) where.categoryId = filtros.categoryId;
  if (filtros.state) where.state = filtros.state.toUpperCase();
  if (filtros.country) where.country = filtros.country.toUpperCase();

  // Sem temporada escolhida, o ranking é o da temporada aberta mais recente:
  // somar temporadas diferentes não significaria nada.
  if (!where.seasonId) {
    const escopo = actor ? organizationFilter(actor, filtros.organizationId) : {};
    const temporada = await prisma.rankingSeason.findFirst({
      where: { ...escopo, status: 'OPEN' },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }]
    });
    if (!temporada) return { items: [], season: null, nextCursor: null };
    where.seasonId = temporada.id;
  }

  const items = await prisma.ranking.findMany({
    where,
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } },
      category: { select: { id: true, code: true, name: true } },
      season: { select: { id: true, name: true, year: true } }
    },
    orderBy: [{ totalPoints: 'desc' }, { position: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items,
    season: items[0]?.season ?? await prisma.rankingSeason.findUnique({ where: { id: where.seasonId }, select: { id: true, name: true, year: true } }),
    nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null
  };
}

// Detalhamento dos pontos de um atleta: cada linha aponta de onde veio.
async function athletePoints(athleteId, seasonId, actor) {
  assertPermission(actor, 'ranking.read');

  return prisma.rankingPoint.findMany({
    where: { athleteId, ...(seasonId ? { seasonId } : {}) },
    include: {
      event: { select: { id: true, name: true, slug: true } },
      category: { select: { id: true, code: true, name: true } },
      season: { select: { id: true, name: true, year: true } },
      externalResult: { select: { id: true, source: true, externalId: true, eventName: true, eventDate: true } }
    },
    orderBy: { awardedAt: 'desc' }
  });
}

module.exports = { createSeason, listSeasons, setPointsRules, pointsForPlacing, awardForResult, recompute, recompute_, list, athletePoints };
