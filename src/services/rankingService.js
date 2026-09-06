const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter, assertPermission } = require('../utils/tenant');
const audit = require('./auditService');
const {
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL, pontuarResultado, contadores, classificar
} = require('../utils/rankingScoring');

// Ranking e temporadas.
//
// Todo ponto tem proveniência: origem (EVENT ou MUSCLEWAR), evento, resultado
// ou resultado externo. O agregado `Ranking` é sempre derivado de
// `RankingPoint` — nunca escrito à mão — de modo que a soma pode ser refeita e
// conferida a qualquer momento.

async function createSeason(data, actor) {
  assertCan(actor, 'ranking.manage', data.organizationId);

  try {
    // A temporada nasce com a tabela homologada já cadastrada — como DADO, na
    // mesma tabela que `setPointsRules` reescreve. Sem isso, uma temporada nova
    // não pontuaria nada até alguém lembrar de configurá-la; e como o valor
    // vive em RankingPointsRule, substituí-lo pela tabela oficial definitiva
    // não exige tocar em código.
    const temporada = await prisma.rankingSeason.create({
      data: {
        organizationId: data.organizationId,
        name: data.name,
        year: data.year,
        startDate: data.startDate ?? null,
        endDate: data.endDate ?? null,
        scoringRuleSetId: data.scoringRuleSetId ?? null,
        pointsRules: { create: TABELA_OFICIAL_COLOCACAO.map(regra => ({ ...regra })) }
      }
    });

    await audit.record({
      actor, action: 'RANKING_RULES_SET', entity: 'RankingSeason', entityId: temporada.id,
      organizationId: data.organizationId,
      metadata: { origem: 'tabela homologada', rules: TABELA_OFICIAL_COLOCACAO.length }
    });

    return temporada;
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

  const tabela = await prisma.rankingPointsRule.findMany({
    where: { seasonId }, select: { placing: true, points: true }
  });

  // Elegibilidade ao Super Overall: atributo da CLASSE, resolvido agora e
  // gravado em cada lançamento. Nunca o código "OPEN" comparado aqui — assim o
  // operador cria e desativa classes sem que este arquivo mude.
  //
  // A classe do evento manda; na ausência da marca nela, vale o catálogo da
  // organização, que é onde o operador governa a lista.
  const classe = result.competitionClass;
  const doCatalogo = await prisma.classCatalog.findUnique({
    where: { organizationId_code: { organizationId: result.event.organizationId, code: classe.code } },
    select: { superOverallEligible: true }
  });

  const superOverallEligible = classe.superOverallEligible || Boolean(doCatalogo?.superOverallEligible);

  // Títulos Overall declarados para este evento — o do recorte da categoria e o
  // do evento inteiro. O critério de determinação não é do sistema: o título é
  // registrado pela organização (ver EventOverallTitle).
  const titulos = await prisma.eventOverallTitle.findMany({
    where: { eventId: result.eventId, OR: [{ categoryId }, { categoryId: null }] },
    select: { athleteId: true }
  });
  const campeoesOverall = new Set(titulos.map(titulo => titulo.athleteId));

  // Equipe registrada no momento da atribuição: uma troca posterior não deve
  // reescrever a história do ranking.
  const equipes = new Map(
    (await prisma.athlete.findMany({
      where: { id: { in: classificados.map(entry => entry.athleteId) } },
      select: { id: true, teamId: true }
    })).map(atleta => [atleta.id, atleta.teamId])
  );

  const atribuidos = await prisma.$transaction(async tx => {
    if (recompute) await tx.rankingPoint.deleteMany({ where: { seasonId, resultId } });

    let total = 0;
    for (const entry of classificados) {
      const ehCampeaoOverall = campeoesOverall.has(entry.athleteId);
      const { placementPoints, overallBonus, points } = pontuarResultado(entry.placing, tabela, ehCampeaoOverall);

      // Colocação sem pontuação na tabela e sem Overall não gera linha: ponto
      // zero no histórico só faria ruído.
      if (!points) continue;

      try {
        await tx.rankingPoint.create({
          data: {
            seasonId, athleteId: entry.athleteId, categoryId,
            source: 'EVENT', eventId: result.eventId, resultId,
            classId: result.classId,
            teamId: equipes.get(entry.athleteId) ?? null,
            placing: entry.placing,
            placementPoints, overallBonus, isOverallChampion: ehCampeaoOverall,
            superOverallEligible,
            points,
            resultVersion: result.version,
            awardedById: actor?.id ?? null
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
//
// A ordenação usa a hierarquia oficial de desempate (src/utils/rankingScoring.js),
// e não apenas o total de pontos. Os contadores ficam materializados para que o
// ranking seja auditável sem reabrir cada lançamento.
async function recompute_(seasonId) {
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId },
    select: {
      athleteId: true, categoryId: true, points: true, placing: true,
      isOverallChampion: true, eventId: true, externalResultId: true
    }
  });

  const acumulado = new Map();
  for (const ponto of pontos) {
    const chave = `${ponto.athleteId}::${ponto.categoryId ?? ''}`;
    if (!acumulado.has(chave)) {
      acumulado.set(chave, { athleteId: ponto.athleteId, categoryId: ponto.categoryId, totalPoints: 0, fontes: new Set(), pontos: [] });
    }
    const linha = acumulado.get(chave);
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const athleteIds = [...new Set([...acumulado.values()].map(linha => linha.athleteId))];
  const atletas = await prisma.athlete.findMany({ where: { id: { in: athleteIds } }, select: { id: true, state: true, country: true } });
  const porAtleta = new Map(atletas.map(atleta => [atleta.id, atleta]));

  const comContadores = [...acumulado.values()].map(linha => ({
    ...linha,
    ...contadores(linha.pontos)
  }));

  // A numeração é por categoria: cada recorte tem a sua disputa, e o desempate
  // vale dentro dele.
  const porCategoria = new Map();
  for (const linha of comContadores) {
    const chave = linha.categoryId ?? '__geral__';
    if (!porCategoria.has(chave)) porCategoria.set(chave, []);
    porCategoria.get(chave).push(linha);
  }

  const classificadas = [...porCategoria.values()].flatMap(linhas => classificar(linhas));

  await prisma.$transaction(async tx => {
    await tx.ranking.deleteMany({ where: { seasonId } });

    for (const linha of classificadas) {
      const atleta = porAtleta.get(linha.athleteId);
      await tx.ranking.create({
        data: {
          seasonId,
          athleteId: linha.athleteId,
          categoryId: linha.categoryId,
          totalPoints: linha.totalPoints,
          eventCount: linha.fontes.size,
          overallWins: linha.overallWins,
          firstPlaceCount: linha.firstPlaceCount,
          secondPlaceCount: linha.secondPlaceCount,
          thirdPlaceCount: linha.thirdPlaceCount,
          fourthPlaceCount: linha.fourthPlaceCount,
          fifthPlaceCount: linha.fifthPlaceCount,
          tieUnresolved: linha.tieUnresolved,
          position: linha.position,
          state: atleta?.state ?? null,
          country: atleta?.country ?? null
        }
      });
    }
  });

  return {
    rows: classificadas.length,
    tieUnresolved: classificadas.filter(linha => linha.tieUnresolved).length
  };
}

/**
 * Ranking de equipes.
 *
 * REGRA HOMOLOGADA: a equipe usa exatamente a mesma tabela de pontos e o mesmo
 * desempate do atleta. Não há peso, multiplicador nem bônus próprio de equipe.
 *
 * Derivado, e não materializado: a pontuação da equipe é a soma dos pontos dos
 * seus atletas, e cada linha continua apontando para o resultado que a
 * originou. Guardar um agregado próprio criaria uma segunda verdade para
 * manter sincronizada sem necessidade.
 *
 * PENDING HOMOLOGATION: quais resultados de atleta são "elegíveis" para a
 * equipe. Sem regra de descarte, de teto de atletas pontuando ou de mínimo por
 * equipe, TODOS os resultados pontuados contam — presumir qualquer corte seria
 * inventar regulamento.
 */
async function teamRanking(seasonId, { categoryId = null } = {}) {
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId, teamId: { not: null }, ...(categoryId ? { categoryId } : {}) },
    select: {
      teamId: true, athleteId: true, points: true, placing: true, isOverallChampion: true,
      eventId: true, externalResultId: true,
      team: { select: { id: true, name: true, city: true, state: true } }
    }
  });

  const acumulado = new Map();
  for (const ponto of pontos) {
    if (!acumulado.has(ponto.teamId)) {
      acumulado.set(ponto.teamId, {
        teamId: ponto.teamId, team: ponto.team,
        totalPoints: 0, atletas: new Set(), fontes: new Set(), pontos: []
      });
    }
    const linha = acumulado.get(ponto.teamId);
    linha.totalPoints += ponto.points;
    linha.atletas.add(ponto.athleteId);
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  return classificar(linhas).map(linha => ({
    position: linha.position,
    tieUnresolved: linha.tieUnresolved,
    team: linha.team,
    totalPoints: linha.totalPoints,
    athleteCount: linha.atletas.size,
    eventCount: linha.fontes.size,
    overallWins: linha.overallWins,
    firstPlaceCount: linha.firstPlaceCount,
    secondPlaceCount: linha.secondPlaceCount,
    thirdPlaceCount: linha.thirdPlaceCount,
    fourthPlaceCount: linha.fourthPlaceCount,
    fifthPlaceCount: linha.fifthPlaceCount
  }));
}

/**
 * Registra o campeão Overall de um evento.
 *
 * REGRA HOMOLOGADA: o título vale +10 pontos, somados aos da colocação, e conta
 * como primeiro critério de desempate.
 *
 * PENDING HOMOLOGATION: o critério de determinação do campeão. Por isso aqui o
 * título é DECLARADO por quem opera o evento, com autoria e data registradas —
 * calculá-lo exigiria uma regra que ninguém definiu.
 */
async function declareOverall(eventId, { athleteId, categoryId = null, note = null }, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizationId: true, seasonId: true }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'ranking.manage', event.organizationId);

  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId }, select: { id: true, organizationId: true } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  if (athlete.organizationId !== event.organizationId) {
    throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Atleta de outra organização');
  }

  // `upsert` não serve aqui: o Prisma não aceita valor nulo dentro de chave
  // única composta, e o recorte nulo é justamente o Overall do evento inteiro.
  const existente = await prisma.eventOverallTitle.findFirst({ where: { eventId, categoryId } });

  const titulo = existente
    ? await prisma.eventOverallTitle.update({
      where: { id: existente.id },
      data: { athleteId, note, declaredById: actor?.id ?? null, declaredAt: new Date() }
    })
    : await prisma.eventOverallTitle.create({
      data: { eventId, athleteId, categoryId, note, declaredById: actor?.id ?? null }
    });

  await audit.record({
    actor, action: 'OVERALL_DECLARE', entity: 'Event', entityId: eventId,
    organizationId: event.organizationId,
    metadata: { athleteId, categoryId, bonus: BONUS_OVERALL }
  });

  // O bônus só entra no ranking depois que os resultados publicados do evento
  // forem repontuados: declarar o título é um fato novo sobre resultados que
  // já existiam.
  const publicados = await prisma.result.findMany({
    where: { eventId, status: 'PUBLISHED' }, select: { id: true }
  });
  for (const resultado of publicados) {
    await awardForResult(resultado.id, actor, { recompute: true });
  }

  return titulo;
}

async function listOverall(eventId) {
  return prisma.eventOverallTitle.findMany({
    where: { eventId },
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true } },
      category: { select: { id: true, code: true, name: true } }
    },
    orderBy: { declaredAt: 'desc' }
  });
}

/**
 * Ranking classificatório do Super Overall anual.
 *
 * REGRA HOMOLOGADA: todas as classes pontuam no campeonato, mas somente os
 * pontos das classes marcadas como elegíveis — pela regra, a OPEN — contam
 * para a classificação que leva ao Super Overall no fim do ano.
 *
 * É o MESMO motor: mesma tabela de pontos, mesmo desempate. O que muda é só o
 * conjunto de lançamentos considerado. Duas coisas que o modelo mantém
 * separadas de propósito: "pontuou no evento" e "é elegível ao Super Overall".
 */
async function superOverallRanking(seasonId, { categoryId = null } = {}) {
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId, superOverallEligible: true, ...(categoryId ? { categoryId } : {}) },
    select: {
      athleteId: true, categoryId: true, points: true, placing: true,
      isOverallChampion: true, eventId: true, externalResultId: true,
      athlete: { select: { id: true, fullName: true, stageName: true, state: true, team: { select: { id: true, name: true } } } }
    }
  });

  const acumulado = new Map();
  for (const ponto of pontos) {
    if (!acumulado.has(ponto.athleteId)) {
      acumulado.set(ponto.athleteId, {
        athleteId: ponto.athleteId, athlete: ponto.athlete,
        totalPoints: 0, fontes: new Set(), pontos: []
      });
    }
    const linha = acumulado.get(ponto.athleteId);
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  return classificar(linhas).map(linha => ({
    position: linha.position,
    tieUnresolved: linha.tieUnresolved,
    athlete: linha.athlete,
    totalPoints: linha.totalPoints,
    eventCount: linha.fontes.size,
    overallWins: linha.overallWins,
    firstPlaceCount: linha.firstPlaceCount,
    secondPlaceCount: linha.secondPlaceCount,
    thirdPlaceCount: linha.thirdPlaceCount
  }));
}

// ------------------------------------------------------ catálogo de classes
//
// O operador governa a lista aqui: cria, edita e desativa classes, e marca
// quais alimentam o Super Overall. O motor de pontuação lê a marca; nenhum
// código de classe está escrito nele.

async function listClasses(organizationId, actor) {
  assertCan(actor, 'ranking.read', organizationId);
  return prisma.classCatalog.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }]
  });
}

async function upsertClass(organizationId, data, actor) {
  assertCan(actor, 'ranking.manage', organizationId);

  const existente = await prisma.classCatalog.findUnique({
    where: { organizationId_code: { organizationId, code: data.code } }
  });

  const classe = existente
    ? await prisma.classCatalog.update({
      where: { id: existente.id },
      data: {
        name: data.name ?? existente.name,
        superOverallEligible: data.superOverallEligible ?? existente.superOverallEligible,
        active: data.active ?? existente.active,
        sortOrder: data.sortOrder ?? existente.sortOrder
      }
    })
    : await prisma.classCatalog.create({
      data: {
        organizationId, code: data.code, name: data.name ?? data.code,
        superOverallEligible: data.superOverallEligible ?? false,
        active: data.active ?? true,
        sortOrder: data.sortOrder ?? 0
      }
    });

  await audit.record({
    actor, action: 'CLASS_CATALOG_SET', entity: 'ClassCatalog', entityId: classe.id,
    organizationId, metadata: { code: classe.code, superOverallEligible: classe.superOverallEligible, active: classe.active }
  });

  return classe;
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
    // A posição já carrega o desempate oficial; o total entra só como
    // critério secundário de leitura.
    orderBy: [{ position: 'asc' }, { totalPoints: 'desc' }],
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

module.exports = {
  createSeason, listSeasons, setPointsRules, pointsForPlacing, awardForResult,
  recompute, recompute_, list, athletePoints, teamRanking,
  declareOverall, listOverall, superOverallRanking, listClasses, upsertClass,
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL
};
