const prisma = require('../config/prisma');
// Projeção pública: ranking, Super Overall, recortes e títulos Overall são
// lidos por este cliente de propósito. Ver src/config/prismaPublico.js — sem
// isso, quem está autenticado e não é membro da organização recebe MENOS que
// o visitante anônimo, porque a política do atleta libera a leitura só quando
// não há ator definido.
const publico = require('../config/prismaPublico');
const { AppError } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');
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
    include: {
      _count: { select: { events: true, points: true, pointsRules: true } },
      // A tabela vigente acompanha a temporada: a tela de edição precisa
      // mostrar o que ESTÁ valendo, e não uma sugestão inventada no frontend.
      pointsRules: { select: { placing: true, points: true }, orderBy: { placing: 'asc' } }
    },
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

  // Equipe e empresa registradas no momento da atribuição: uma troca posterior
  // não deve reescrever a história do ranking. A cadeia é
  // atleta → equipe → empresa.
  const vinculos = new Map(
    (await prisma.athlete.findMany({
      where: { id: { in: classificados.map(entry => entry.athleteId) } },
      select: { id: true, teamId: true, team: { select: { companyId: true } } }
    })).map(atleta => [atleta.id, { teamId: atleta.teamId, companyId: atleta.team?.companyId ?? null }])
  );

  const atribuidos = await prisma.$transaction(async tx => {
    if (recompute) await tx.rankingPoint.deleteMany({ where: { seasonId, resultId } });

    let total = 0;
    for (const entry of classificados) {
      const ehCampeaoOverall = campeoesOverall.has(entry.athleteId);
      const { placementPoints, overallBonus, points, superOverallPoints } =
        pontuarResultado(entry.placing, tabela, ehCampeaoOverall, superOverallEligible);

      // Colocação sem pontuação na tabela e sem Overall não gera linha: ponto
      // zero no histórico só faria ruído.
      if (!points) continue;

      try {
        await tx.rankingPoint.create({
          data: {
            seasonId, athleteId: entry.athleteId, categoryId,
            source: 'EVENT', eventId: result.eventId, resultId,
            classId: result.classId,
            teamId: vinculos.get(entry.athleteId)?.teamId ?? null,
            companyId: vinculos.get(entry.athleteId)?.companyId ?? null,
            placing: entry.placing,
            placementPoints, overallBonus, isOverallChampion: ehCampeaoOverall,
            superOverallEligible,
            points,
            superOverallPoints,
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
 * REGRA HOMOLOGADA (fase 11.4): a equipe usa a MESMA tabela de pontos, o MESMO
 * bônus de Overall e o MESMO desempate do atleta. Sem fórmula, peso ou
 * multiplicador próprio.
 *
 * PENDING HOMOLOGATION: quais resultados de atleta são "elegíveis" para a
 * equipe. Sem regra de descarte, de teto de atletas pontuando ou de mínimo por
 * equipe, TODOS os resultados pontuados contam — presumir qualquer corte seria
 * inventar regulamento.
 */
// Temporada adotada quando a consulta não escolhe uma: a ABERTA mais recente.
//
// Sem isto, `seasonId` ausente vai para o `where` como `undefined`, e o Prisma
// IGNORA a chave — a consulta varre todas as temporadas e devolve a soma dos
// anos. Medido: com 10 pontos em 2025 e 7 em 2026, o ranking de equipes sem
// temporada devolvia 17. Somar temporadas diferentes não significa nada, e a
// tela de Ranking pede exatamente isso na primeira renderização, porque nasce
// sem temporada escolhida.
//
// `publico` e não `prisma`: a temporada padrão é fato público e não pode
// depender de quem está olhando — é o mesmo caminho que `list()` já usa.
async function temporadaPadrao(organizationId = null) {
  return publico.rankingSeason.findFirst({
    where: { ...(organizationId ? { organizationId } : {}), status: 'OPEN' },
    orderBy: [{ year: 'desc' }, { createdAt: 'desc' }]
  });
}

async function teamRanking(seasonId, { categoryId = null, organizationId = null } = {}) {
  if (!seasonId) {
    const temporada = await temporadaPadrao(organizationId);
    if (!temporada) return [];
    seasonId = temporada.id;
  }

  // A equipe é buscada UMA vez, e não junto de cada ponto.
  //
  // Medido, não suposto: numa temporada de 24 mil lançamentos e 60 equipes, o
  // `include` da equipe materializava o mesmo objeto 24 mil vezes e sozinho
  // respondia por 750 dos 1180 ms da resposta. O banco resolve a mesma leitura
  // em 10 ms; o custo era transferir e desserializar a repetição.
  //
  // A agregação e o desempate abaixo não mudaram uma linha: a regra é
  // homologada, e o que se corrigiu foi o transporte.
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId, teamId: { not: null }, ...(categoryId ? { categoryId } : {}) },
    select: {
      teamId: true, athleteId: true, points: true, placing: true, isOverallChampion: true,
      eventId: true, externalResultId: true
    }
  });

  const equipes = new Map(
    (await prisma.team.findMany({
      where: { id: { in: [...new Set(pontos.map(ponto => ponto.teamId))] } },
      select: { id: true, name: true, city: true, state: true }
    })).map(equipe => [equipe.id, equipe])
  );

  const acumulado = new Map();
  for (const ponto of pontos) {
    if (!acumulado.has(ponto.teamId)) {
      acumulado.set(ponto.teamId, {
        teamId: ponto.teamId, team: equipes.get(ponto.teamId) ?? null,
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
 * REGRA HOMOLOGADA (fase 11.4): QUEM é o campeão Overall é FATO DECLARADO pela
 * organização — informado aqui ou trazido na importação —, e o sistema não deve
 * tentar descobri-lo sozinho. Não é lacuna de implementação: é a regra. Por
 * isso o título é registrado com autoria e data, nunca calculado.
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
  return publico.eventOverallTitle.findMany({
    where: { eventId },
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true } },
      category: { select: { id: true, code: true, name: true } }
    },
    orderBy: { declaredAt: 'desc' }
  });
}

/**
 * Ranking de empresas.
 *
 * REGRA HOMOLOGADA: a empresa entra com suas equipes, e a mesma tabela de
 * pontos e o mesmo desempate valem para ela. Sem peso, multiplicador ou bônus
 * próprio.
 *
 * Derivado de `RankingPoint.companyId`, como o de equipes: cada linha continua
 * apontando para o resultado do atleta que a originou, e não há um agregado
 * paralelo para manter sincronizado.
 */
async function companyRanking(seasonId, { categoryId = null, organizationId = null } = {}) {
  if (!seasonId) {
    const temporada = await temporadaPadrao(organizationId);
    if (!temporada) return [];
    seasonId = temporada.id;
  }

  // Mesma correção do ranking de equipes, pela mesma medição: poucas empresas
  // repetidas em muitos lançamentos.
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId, companyId: { not: null }, ...(categoryId ? { categoryId } : {}) },
    select: {
      companyId: true, teamId: true, athleteId: true, points: true, placing: true,
      isOverallChampion: true, eventId: true, externalResultId: true
    }
  });

  const empresas = new Map(
    (await prisma.company.findMany({
      where: { id: { in: [...new Set(pontos.map(ponto => ponto.companyId))] } },
      select: { id: true, name: true, city: true, state: true }
    })).map(empresa => [empresa.id, empresa])
  );

  const acumulado = new Map();
  for (const ponto of pontos) {
    if (!acumulado.has(ponto.companyId)) {
      acumulado.set(ponto.companyId, {
        companyId: ponto.companyId, company: empresas.get(ponto.companyId) ?? null,
        totalPoints: 0, atletas: new Set(), equipes: new Set(), fontes: new Set(), pontos: []
      });
    }
    const linha = acumulado.get(ponto.companyId);
    linha.totalPoints += ponto.points;
    linha.atletas.add(ponto.athleteId);
    if (ponto.teamId) linha.equipes.add(ponto.teamId);
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  return classificar(linhas).map(linha => ({
    position: linha.position,
    tieUnresolved: linha.tieUnresolved,
    company: linha.company,
    totalPoints: linha.totalPoints,
    teamCount: linha.equipes.size,
    athleteCount: linha.atletas.size,
    eventCount: linha.fontes.size,
    overallWins: linha.overallWins,
    firstPlaceCount: linha.firstPlaceCount,
    secondPlaceCount: linha.secondPlaceCount,
    thirdPlaceCount: linha.thirdPlaceCount
  }));
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
/**
 * Ranking de atletas por RECORTE: classe, evento ou divisão.
 *
 * O agregado `Ranking` é chaveado por (temporada, atleta, categoria) e não
 * expressa esses cortes. Aqui vale o mesmo padrão de equipes, empresas e Super
 * Overall: DERIVAR de RankingPoint com o MESMO motor — mesma tabela de pontos,
 * mesmos contadores, mesmo desempate. Nenhuma regra nova.
 *
 * A divisão não é coluna de RankingPoint: vem pela classe
 * (`classId → CompetitionClass.divisionId`). Como consequência, pontos vindos
 * da IMPORTAÇÃO externa não entram no recorte por divisão nem por classe — a
 * origem traz a classe como texto, sem vínculo com a classe de um evento do
 * MCI. É limite do dado recebido, não do motor.
 */
async function athleteRankingBy(seasonId, { classId = null, eventId = null, divisionId = null, categoryId = null, limit = null, offset = 0 } = {}) {
  const where = { seasonId, ...(categoryId ? { categoryId } : {}) };

  if (eventId) where.eventId = eventId;
  if (classId) where.classId = classId;

  if (divisionId) {
    const classes = await publico.competitionClass.findMany({ where: { divisionId }, select: { id: true } });
    // Divisão sem classe nenhuma não é "todas as classes": é conjunto vazio.
    where.classId = { in: classes.length ? classes.map(classe => classe.id) : ['__sem-classe__'] };
  }

  const pontos = await publico.rankingPoint.findMany({
    where,
    select: {
      athleteId: true, categoryId: true, points: true, superOverallPoints: true, placing: true,
      isOverallChampion: true, eventId: true, classId: true, externalResultId: true,
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
    // Recorte do CAMPEONATO: soma `points`, como o ranking principal. Trocar
    // por `superOverallPoints` aqui apagaria Estreante, Novice e Master.
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  return paginar(classificar(linhas), { limit, offset }).map(linha => ({
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

// Recorta a lista JÁ CLASSIFICADA. A ordem importa: fatiar antes de
// classificar mudaria a posição de quem sobrou, e um ranking paginado que
// discorda do ranking inteiro é pior que um ranking grande.
function paginar(classificados, { limit = null, offset = 0 } = {}) {
  if (limit == null && !offset) return classificados;
  return classificados.slice(offset, limit == null ? undefined : offset + limit);
}

async function superOverallRanking(seasonId, { categoryId = null, limit = null, offset = 0, organizationId = null } = {}) {
  if (!seasonId) {
    const temporada = await temporadaPadrao(organizationId);
    if (!temporada) return { items: [], season: null };
    seasonId = temporada.id;
  }

  // Mesma correção do ranking de equipes: o atleta é buscado uma vez por
  // atleta, não uma vez por lançamento.
  const pontos = await prisma.rankingPoint.findMany({
    where: { seasonId, superOverallEligible: true, ...(categoryId ? { categoryId } : {}) },
    select: {
      athleteId: true, categoryId: true, points: true, superOverallPoints: true, placing: true,
      isOverallChampion: true, eventId: true, externalResultId: true
    }
  });

  const atletas = new Map(
    (await publico.athlete.findMany({
      where: { id: { in: [...new Set(pontos.map(ponto => ponto.athleteId))] } },
      select: { id: true, fullName: true, stageName: true, state: true, team: { select: { id: true, name: true } } }
    })).map(atleta => [atleta.id, atleta])
  );

  const acumulado = new Map();
  for (const ponto of pontos) {
    if (!acumulado.has(ponto.athleteId)) {
      acumulado.set(ponto.athleteId, {
        athleteId: ponto.athleteId, athlete: atletas.get(ponto.athleteId) ?? null,
        totalPoints: 0, fontes: new Set(), pontos: []
      });
    }
    const linha = acumulado.get(ponto.athleteId);
    // O ranking anual soma os pontos ELEGÍVEIS, não os do campeonato. São
    // números diferentes de propósito: somar `points` aqui traria de volta,
    // por dentro, as classes que a regra exclui.
    linha.totalPoints += ponto.superOverallPoints;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  return paginar(classificar(linhas), { limit, offset }).map(linha => ({
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

async function list(filtros) {
  const where = {};
  if (filtros.seasonId) where.seasonId = filtros.seasonId;
  if (filtros.categoryId) where.categoryId = filtros.categoryId;
  if (filtros.state) where.state = filtros.state.toUpperCase();
  if (filtros.country) where.country = filtros.country.toUpperCase();

  // Sem temporada escolhida, o ranking é o da temporada aberta mais recente:
  // somar temporadas diferentes não significaria nada.
  if (!where.seasonId) {
    // A temporada padrão não pode depender de QUEM está olhando. Antes, o
    // ator autenticado caía em `organizationFilter`, que devolve um sentinela
    // que não casa com nada quando a pessoa não tem organização — e a home
    // do atleta logado mostrava ranking VAZIO enquanto o visitante anônimo,
    // na mesma rota, via a tabela cheia. `organizationId` passa a ser um
    // filtro comum, válido para todo mundo do mesmo jeito (antes ele era
    // simplesmente ignorado para o anônimo).
    const temporada = await temporadaPadrao(filtros.organizationId);
    if (!temporada) return { items: [], season: null, nextCursor: null };
    where.seasonId = temporada.id;
  }

  const items = await publico.ranking.findMany({
    where,
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, photoKey: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } },
      category: { select: { id: true, code: true, name: true } },
      season: { select: { id: true, name: true, year: true } }
    },
    // A posição já carrega o desempate oficial; o total entra só como
    // critério secundário de leitura.
    //
    // O `id` fecha a ordenação. Sem ele, duas linhas empatadas (ambas com
    // `position` nula) ficariam na ordem física da tabela, e a paginação por
    // cursor — que é ancorada no `id` — poderia repetir ou pular uma delas
    // entre duas páginas. Não é desempate: quem está empatado continua com
    // `position` nula e `tieUnresolved` verdadeiro.
    orderBy: [{ position: 'asc' }, { totalPoints: 'desc' }, { id: 'asc' }],
    take: filtros.limit,
    ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items,
    season: items[0]?.season ?? await publico.rankingSeason.findUnique({ where: { id: where.seasonId }, select: { id: true, name: true, year: true } }),
    nextCursor: items.length === filtros.limit ? items[items.length - 1].id : null
  };
}

// Detalhamento dos pontos de um atleta: cada linha aponta de onde veio.
async function athletePoints(athleteId, seasonId, actor) {
  // Escopo de TENANT, não só permissão. `assertPermission` sozinho respondia
  // 200 para o gerente de ranking de uma organização consultando atleta de
  // OUTRA: a permissão existia, e ninguém perguntava de quem era o atleta.
  // Todo o resto deste service usa `assertCan`, que exige as duas condições.
  const athlete = await prisma.athlete.findUnique({
    where: { id: athleteId }, select: { organizationId: true }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');

  assertCan(actor, 'ranking.read', athlete.organizationId);

  return prisma.rankingPoint.findMany({
    where: { athleteId, ...(seasonId ? { seasonId } : {}) },
    include: {
      event: { select: { id: true, name: true, slug: true } },
      category: { select: { id: true, code: true, name: true } },
      season: { select: { id: true, name: true, year: true } },
      // A classe fecha a explicação: é ela que responde por que um lançamento
      // vale no campeonato e não vale no Super Overall.
      competitionClass: { select: { id: true, name: true, code: true } },
      externalResult: { select: { id: true, source: true, externalId: true, eventName: true, eventDate: true } }
    },
    orderBy: { awardedAt: 'desc' }
  });
}

module.exports = {
  createSeason, listSeasons, setPointsRules, pointsForPlacing, awardForResult,
  recompute, recompute_, list, athletePoints, teamRanking,
  declareOverall, listOverall, superOverallRanking, listClasses, upsertClass, companyRanking,
  athleteRankingBy,
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL
};
