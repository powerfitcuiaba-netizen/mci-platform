const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
// Projeção pública: ranking, Super Overall, recortes e títulos Overall são
// lidos por este cliente de propósito. Ver src/config/prismaPublico.js — sem
// isso, quem está autenticado e não é membro da organização recebe MENOS que
// o visitante anônimo, porque a política do atleta libera a leitura só quando
// não há ator definido.
const publico = require('../config/prismaPublico');
const { AppError, ehViolacaoDeUnicidade } = require('../utils/errors');
const { assertCan, organizationFilter } = require('../utils/tenant');
const { can, belongsToOrganization } = require('../utils/permissions');
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

// ---------------------------------------------------------------------------
// O BÔNUS OVERALL VALE UMA VEZ.
//
// `awardForResult` pontua UM resultado — uma classe. Ele não enxerga as outras
// participações do mesmo atleta no mesmo evento, então, quando o título
// Overall estava declarado, cada classe inscrita recebia o seu próprio +10: um
// atleta em três classes somava 30 de bônus. Isso premiava quem se inscreve
// mais, não quem vence, e não é a regra homologada.
//
// A correção não pode morar na criação da linha (que é cega para as demais),
// e sim numa passada de normalização sobre TODAS as linhas do atleta naquele
// evento. Ela roda dentro da mesma transação, é idempotente e converge para o
// mesmo estado qualquer que seja a ordem em que as classes foram pontuadas —
// porque sempre lê o conjunto completo, nunca o incremento.
//
// A colocação continua acumulando normalmente: 5 + 4 + 5 = 14. O que deixa de
// acumular é o bônus, que é UM título.
//
// Qual participação carrega o bônus (escolha de LOCALIZAÇÃO, não de mérito —
// o total do atleta é o mesmo em qualquer uma):
//   1. só participações na classe ABSOLUTA são candidatas. REGRA VIGENTE: o
//      +10 é do campeão da absoluta e de mais ninguém, então uma participação
//      em Novice, Master ou qualquer outra divisão NUNCA carrega o bônus —
//      nem como último recurso. Sem participação na absoluta não há bônus;
//   2. entre as candidatas, a melhor colocação;
//   3. persistindo o empate, o menor id em comparação byte a byte — pelo mesmo
//      motivo de `chaveDeSequencia` em rankingScoring.js: sem isso a escolha
//      passaria a depender da ordem física das linhas no PostgreSQL, e um
//      `pg_restore` moveria o bônus de lugar.
function escolherPortadoraDoBonus(linhas) {
  const candidatas = linhas.filter(linha => linha.superOverallEligible);
  if (!candidatas.length) return null;

  return [...candidatas].sort((a, b) => {
    const colocacaoA = a.placing ?? Number.MAX_SAFE_INTEGER;
    const colocacaoB = b.placing ?? Number.MAX_SAFE_INTEGER;
    if (colocacaoA !== colocacaoB) return colocacaoA - colocacaoB;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  })[0];
}

async function normalizarBonusOverall(tx, { eventId, seasonId }) {
  const titulos = await tx.eventOverallTitle.findMany({
    where: { eventId }, select: { athleteId: true, categoryId: true }
  });

  // REVOGAR TAMBÉM É NORMALIZAR.
  //
  // Sem títulos a função voltava cedo, e no caminho interno isso funcionava por
  // acidente: `awardForResult` apaga e reescreve os pontos do evento, então o
  // bônus sumia junto. Ponto IMPORTADO não é reescrito — ele fica no ledger
  // como o importador o gravou. Retornar aqui deixava o +10 de um título já
  // revogado colado na linha, e o ranking continuava mostrando 15 onde a
  // súmula diz 5.
  //
  // A varredura abaixo é a que fecha isso: tudo o que carrega bônus neste
  // evento e NÃO é portador legítimo volta a valer só a colocação.
  const portadoras = new Set();

  for (const titulo of titulos) {
    // Título com recorte de categoria alcança só as linhas daquela categoria;
    // título do evento inteiro (categoryId nulo) alcança todas.
    // O TÍTULO É DO EVENTO, NÃO DA ORIGEM DO RESULTADO.
    //
    // Antes a consulta filtrava `source: 'EVENT'`, e o efeito era silencioso:
    // um campeonato cujos resultados entraram por importação MuscleWare
    // recebia a declaração oficial, gravava o título, registrava a auditoria —
    // e o +10 não chegava a lugar nenhum. Pior, não havia como corrigir depois:
    // reimportar o arquivo com a coluna Overall esbarra na idempotência, que
    // marca tudo como DUPLICATE. A mesma barreira que protege o ranking de
    // duplicação impedia a correção.
    //
    // Quem decide se a linha recebe o bônus continua sendo a REGRA, não a
    // origem: `escolherPortadoraDoBonus` só olha participações elegíveis à
    // absoluta, e uma linha fora dela segue com zero.
    const linhas = await tx.rankingPoint.findMany({
      where: {
        seasonId, eventId, athleteId: titulo.athleteId,
        ...(titulo.categoryId ? { categoryId: titulo.categoryId } : {})
      },
      select: {
        id: true, placing: true, superOverallEligible: true, source: true,
        didNotShow: true,
        placementPoints: true, overallBonus: true, isOverallChampion: true,
        points: true, superOverallPoints: true
      },
      // Ordem DECLARADA — um `findMany` sem `orderBy` devolve a ordem física
      // do PostgreSQL, que é justamente o que não pode influenciar a escolha.
      // E declarada ao CONTRÁRIO da chave de seleção de propósito: se o
      // desempate por id for perdido, o `sort` estável do V8 preserva esta
      // ordem e passa a escolher o MAIOR id — a regressão aparece no teste em
      // vez de coincidir em silêncio com a ordem da consulta.
      orderBy: { id: 'desc' }
    });
    if (!linhas.length) continue;

    // Nula quando o atleta não tem nenhuma participação na absoluta: aí o
    // título existe, mas não gera bônus em lugar nenhum.
    const portadora = escolherPortadoraDoBonus(linhas);

    if (portadora) portadoras.add(portadora.id);

    for (const linha of linhas) {
      const ehPortadora = Boolean(portadora) && linha.id === portadora.id;
      const overallBonus = ehPortadora ? BONUS_OVERALL : 0;
      const points = linha.placementPoints + overallBonus;
      const superOverallPoints = linha.superOverallEligible ? points : 0;

      // Linha que só existia por causa de um bônus que agora mudou de lugar
      // some: manter ponto zero no histórico é o mesmo ruído que a criação já
      // evita. Sem o título ela nunca teria sido escrita.
      //
      // MAS SÓ VALE PARA O QUE ESTA FUNÇÃO PODERIA TER CRIADO. `awardForResult`
      // não escreve linha de zero ponto, então uma linha `EVENT` que zerou de
      // fato nasceu do bônus. Já a IMPORTAÇÃO escreve a participação inteira,
      // inclusive a que vale zero: o não comparecimento é `didNotShow: true`,
      // `placing: null`, zero ponto — e é um FATO do campeonato, não um
      // resquício. Apagá-lo transformaria "não subiu no palco" em "não
      // participou", e o histórico do atleta perderia a etapa.
      const nasceuDoBonus = linha.source === 'EVENT';
      if (!points && nasceuDoBonus) {
        await tx.rankingPoint.delete({ where: { id: linha.id } });
        continue;
      }

      const jaEstaCerta = linha.overallBonus === overallBonus
        && linha.isOverallChampion === ehPortadora
        && linha.points === points
        && linha.superOverallPoints === superOverallPoints;
      if (jaEstaCerta) continue;

      await tx.rankingPoint.update({
        where: { id: linha.id },
        data: { overallBonus, isOverallChampion: ehPortadora, points, superOverallPoints }
      });
    }
  }

  // O QUE SOBROU COM BÔNUS E NÃO É PORTADOR PERDE O BÔNUS.
  //
  // Alcança o título revogado, o campeão trocado e a linha que deixou de ser
  // elegível. Só toca em quem tem bônus a perder, então repetir a normalização
  // não escreve nada — é essa propriedade que a torna idempotente.
  const orfas = await tx.rankingPoint.findMany({
    where: {
      seasonId, eventId, overallBonus: { gt: 0 },
      ...(portadoras.size ? { id: { notIn: [...portadoras] } } : {})
    },
    select: { id: true, placementPoints: true, superOverallEligible: true }
  });

  for (const linha of orfas) {
    await tx.rankingPoint.update({
      where: { id: linha.id },
      data: {
        overallBonus: 0,
        isOverallChampion: false,
        points: linha.placementPoints,
        superOverallPoints: linha.superOverallEligible ? linha.placementPoints : 0
      }
    });
  }
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
  const atletasClassificados = classificados.map(entry => entry.athleteId);

  // A FILIAÇÃO DA ÉPOCA.
  //
  // A inscrição é a fonte preferida: `Registration.affiliationId` é a entidade
  // pela qual o atleta ENTROU naquele evento, congelada no ato da inscrição.
  // Ler o cadastro na hora da consulta faria uma troca de federação transferir
  // para a nova entidade os pontos que a antiga ganhou.
  //
  // O cadastro entra como recurso: a inscrição não guarda a MATRÍCULA, só a
  // entidade, e há o caso em que o atleta nasce na própria inscrição e se
  // filia depois, antes da publicação do resultado. Nesse caso a inscrição não
  // tem entidade nenhuma, e o cadastro no momento da atribuição é o melhor
  // retrato disponível — não um palpite: é o que vale quando o ponto nasce.
  const inscricoes = new Map(
    (await prisma.registration.findMany({
      where: { eventId: result.eventId, athleteId: { in: atletasClassificados } },
      select: { athleteId: true, affiliationId: true }
    })).map(inscricao => [inscricao.athleteId, inscricao.affiliationId])
  );

  const vinculos = new Map(
    (await prisma.athlete.findMany({
      where: { id: { in: atletasClassificados } },
      select: {
        id: true, teamId: true, team: { select: { companyId: true } },
        affiliationId: true, affiliationNumber: true
      }
    })).map(atleta => {
      const daInscricao = inscricoes.get(atleta.id) ?? null;
      const affiliationId = daInscricao ?? atleta.affiliationId ?? null;
      return [atleta.id, {
        teamId: atleta.teamId,
        companyId: atleta.team?.companyId ?? null,
        affiliationId,
        // A matrícula só acompanha quando é da MESMA entidade. Copiar o número
        // de uma federação para outra produziria uma matrícula que não existe.
        affiliationNumber: affiliationId && affiliationId === atleta.affiliationId
          ? atleta.affiliationNumber ?? null
          : null
      }];
    })
  );

  const atribuidos = await prisma.$transaction(async tx => {
    if (recompute) await tx.rankingPoint.deleteMany({ where: { seasonId, resultId } });

    let total = 0;
    for (const entry of classificados) {
      const ehCampeaoOverall = campeoesOverall.has(entry.athleteId);
      // `pontuarResultado` já aplica a regra vigente: o bônus exige a absoluta.
      // A normalização abaixo cuida do resto — que ele não se repita entre as
      // participações do mesmo atleta.
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
            affiliationId: vinculos.get(entry.athleteId)?.affiliationId ?? null,
            affiliationNumber: vinculos.get(entry.athleteId)?.affiliationNumber ?? null,
            placing: entry.placing,
            // A marca segue o BÔNUS, não o título: ela diz "esta linha carrega
            // o +10", que é o que os contadores de desempate precisam contar.
            //
            // Mutante equivalente conhecido: trocar por `ehCampeaoOverall` não
            // é observável, porque `normalizarBonusOverall` reescreve o campo
            // em toda linha alcançada por algum título — e uma linha só recebe
            // `ehCampeaoOverall = true` se existir o título que a alcança.
            // Fica a expressão mais honesta das duas.
            placementPoints, overallBonus, isOverallChampion: overallBonus > 0,
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

    // Depois de escrever as linhas desta classe, reconcilia o bônus do evento
    // inteiro: é o único ponto do fluxo que enxerga todas as participações do
    // campeão ao mesmo tempo.
    await normalizarBonusOverall(tx, { eventId: result.eventId, seasonId });

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

async function teamRanking(seasonId, { categoryId = null, organizationId = null } = {}, actor = null) {
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

  return projetar(recortarParaOPublico(classificar(linhas), await vistaPublicaDaTemporada(seasonId, actor)), linha => ({
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
/**
 * Aplica ao ledger o efeito de um título declarado ou revogado.
 *
 * `awardForResult` cobre o caminho interno: resultado publicado, repontuado do
 * zero, com a normalização do bônus no fim. Resultado IMPORTADO não passa por
 * ali — ele já está no ledger como `RankingPoint(source: MUSCLEWAR)`, escrito
 * pelo importador, e nenhum `Result` existe para reprocessar.
 *
 * Esta função fecha exatamente essa lacuna: reprocessa o que é reprocessável e
 * normaliza o resto. Chamar as duas coisas é seguro porque a normalização é
 * idempotente por construção — ela CALCULA o estado correto e só escreve
 * quando o que está gravado difere, em vez de somar.
 */
async function aplicarTitulosDoEvento(eventId, seasonId, actor) {
  const publicados = await prisma.result.findMany({
    where: { eventId, status: 'PUBLISHED' }, select: { id: true }
  });
  for (const resultado of publicados) {
    await awardForResult(resultado.id, actor, { recompute: true });
  }

  // Sem temporada não há ranking a mexer: o resultado entra no histórico, mas
  // não pontua.
  if (!seasonId) return;

  await prisma.$transaction(async tx => {
    await normalizarBonusOverall(tx, { eventId, seasonId });
  });
  await recompute_(seasonId);
}

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

  // A CATEGORIA precisa ser deste evento.
  //
  // Antes, um recorte de outro campeonato simplesmente não encontrava
  // participação e caía no erro de classe absoluta — que manda o operador
  // procurar o problema no lugar errado. Erro semântico é o que permite
  // corrigir a causa em vez de adivinhá-la.
  if (categoryId) {
    const doEvento = await prisma.eventCategory.findFirst({
      where: { eventId, categoryId }, select: { id: true }
    });
    if (!doEvento) {
      throw new AppError(
        422, 'CATEGORY_NOT_IN_EVENT',
        'A categoria informada não faz parte deste campeonato'
      );
    }
  }

  // REGRA VIGENTE: o Overall é o título da ABSOLUTA. Um atleta que não disputou
  // a classe absoluta não pode receber o título — nem por engano de digitação,
  // nem por decisão informal de operador.
  //
  // A conferência é FACTUAL, não de mérito: pergunta se o atleta ESTÁ INSCRITO
  // numa classe marcada como absoluta neste evento. O sistema continua sem
  // opinar sobre quem venceu — isso segue sendo fato declarado. O que ele
  // recusa é declarar campeão da absoluta quem não estava nela.
  //
  // A verificação usa a INSCRIÇÃO, e não o resultado: no momento de declarar, o
  // resultado pode ainda não estar publicado, e exigir publicação prévia
  // inverteria a ordem real do trabalho do operador.
  const absolutas = await prisma.registrationItem.findMany({
    where: {
      registration: { eventId, athleteId },
      status: { not: 'CANCELLED' },
      competitionClass: {
        ...(categoryId ? { division: { eventCategory: { categoryId } } } : {})
      }
    },
    select: {
      competitionClass: {
        select: {
          code: true, superOverallEligible: true,
          division: { select: { eventCategory: { select: { categoryId: true } } } }
        }
      }
    }
  });

  const catalogo = new Map(
    (await prisma.classCatalog.findMany({
      where: { organizationId: event.organizationId },
      select: { code: true, superOverallEligible: true }
    })).map(classe => [classe.code, classe.superOverallEligible])
  );

  // A classe do evento manda; na ausência da marca nela, vale o catálogo da
  // organização — exatamente a mesma resolução que `awardForResult` usa, para
  // que declarar e pontuar nunca discordem sobre o que é a absoluta.
  const disputouAbsoluta = absolutas.some(item =>
    item.competitionClass.superOverallEligible || Boolean(catalogo.get(item.competitionClass.code))
  );

  if (!disputouAbsoluta) {
    throw new AppError(
      422, 'OVERALL_REQUIRES_ABSOLUTE_CLASS',
      'O título Overall é da classe absoluta: o atleta não tem participação em classe absoluta neste evento'
    );
  }

  // `upsert` não serve aqui: o Prisma não aceita valor nulo dentro de chave
  // única composta, e o recorte nulo é justamente o Overall do evento inteiro.
  const existente = await prisma.eventOverallTitle.findFirst({ where: { eventId, categoryId } });

  // TROCAR CAMPEÃO HOMOLOGADO NÃO É EFEITO COLATERAL DE UM POST REPETIDO.
  //
  // Antes, declarar outro atleta no mesmo recorte simplesmente substituía o
  // anterior — em silêncio, sem registro do que havia antes. Um título
  // esportivo homologado não se troca assim: quem errou revoga, com motivo, e
  // declara de novo. As duas operações ficam na trilha.
  if (existente && existente.athleteId !== athleteId) {
    throw new AppError(
      409, 'OVERALL_ALREADY_DECLARED',
      'Esta categoria já possui um Overall homologado. Revogue a homologação atual antes de declarar outro campeão.'
    );
  }

  // Repetir a MESMA homologação é idempotente: o operador que clica duas vezes,
  // ou dois operadores que confirmam o mesmo fato, não produzem dois títulos —
  // nem dois bônus.
  // A CORRIDA. Dois operadores na mesma sala, ou duas abas do mesmo operador:
  // ambos leem "não existe título" e ambos tentam criar. O `findFirst` acima
  // não impede nada — entre ele e o `create` cabe a outra requisição.
  //
  // Quem impede é o índice único no banco, e ele impede DEPOIS: a segunda
  // escrita levanta P2002. Traduzir isso aqui é o que transforma uma corrida
  // perdida em resposta com sentido. Sem esta tradução a segunda requisição
  // respondia 500 — medido na FASE 13, disparando as duas em paralelo.
  let titulo;
  try {
    titulo = existente
      ? await prisma.eventOverallTitle.update({
        where: { id: existente.id },
        data: { note: note ?? existente.note, declaredById: actor?.id ?? null, declaredAt: new Date() }
      })
      : await prisma.eventOverallTitle.create({
        data: { eventId, athleteId, categoryId, note, declaredById: actor?.id ?? null }
      });
  } catch (erro) {
    if (!ehViolacaoDeUnicidade(erro)) throw erro;

    // Perdeu a corrida, e NÃO dá para reler aqui dentro.
    //
    // A requisição inteira roda numa transação — é assim que o contexto de RLS
    // é definido (ver withUserContext). A violação de unicidade ABORTA essa
    // transação, e qualquer consulta seguinte falha com 25P02 ("current
    // transaction is aborted"). A primeira tentativa de correção fazia
    // exatamente isso: relia o vencedor para decidir entre idempotência e
    // conflito, e trocava um 500 por outro.
    //
    // A resposta honesta é o conflito: alguém declarou este recorte enquanto
    // esta requisição estava a caminho. Repetir a chamada agora encontra o
    // título pelo caminho normal e responde idempotente.
    throw new AppError(
      409, 'OVERALL_ALREADY_DECLARED',
      'Esta categoria já possui um Overall homologado. Revogue a homologação atual antes de declarar outro campeão.'
    );
  }

  await audit.record({
    actor, action: 'OVERALL_DECLARE', entity: 'Event', entityId: eventId,
    organizationId: event.organizationId,
    metadata: { athleteId, categoryId, bonus: BONUS_OVERALL }
  });

  // O bônus só entra no ranking depois que os resultados do evento forem
  // repontuados: declarar o título é um fato novo sobre resultados que já
  // existiam. Vale para os dois caminhos — apuração interna e importação.
  await aplicarTitulosDoEvento(eventId, event.seasonId, actor);

  return titulo;
}

/**
 * Candidatos à homologação: as classes ABSOLUTAS do evento e quem competiu
 * nelas, com a colocação como FATO.
 *
 * A tela não destaca vencedor. A colocação aparece porque é informação
 * factual do resultado publicado — mas nenhum campo diz "este é o Overall",
 * porque o sistema não sabe e não deve sugerir. Quem declara é o operador.
 *
 * `select` explícito e mínimo: nome, matrícula e filiação bastam para
 * identificar quem está em questão. CPF, telefone e endereço não entram — a
 * tela resolve homologação, não consulta cadastro.
 */
async function overallCandidates(eventId, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, name: true, slug: true, startDate: true, organizationId: true,
      season: { select: { id: true, name: true, year: true } },
      organization: { select: { id: true, name: true } }
    }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'ranking.manage', event.organizationId);

  const catalogo = new Map(
    (await prisma.classCatalog.findMany({
      where: { organizationId: event.organizationId },
      select: { code: true, superOverallEligible: true }
    })).map(classe => [classe.code, classe.superOverallEligible])
  );

  const classes = await prisma.competitionClass.findMany({
    where: { division: { eventCategory: { eventId } } },
    select: {
      id: true, name: true, code: true, superOverallEligible: true,
      division: {
        select: {
          id: true, name: true, code: true,
          eventCategory: { select: { categoryId: true, category: { select: { id: true, code: true, name: true } } } }
        }
      }
    },
    orderBy: [{ code: 'asc' }, { id: 'asc' }]
  });

  // A MESMA resolução de `awardForResult` e `declareOverall`: a marca da classe
  // manda, e na ausência dela vale o catálogo. Três lugares discordando sobre o
  // que é a absoluta seria pior que não ter a tela.
  const absolutas = classes.filter(classe =>
    classe.superOverallEligible || Boolean(catalogo.get(classe.code)));

  if (!absolutas.length) return { event, items: [] };

  // UMA consulta para todas as classes absolutas, e não uma por classe.
  const entradas = await prisma.resultEntry.findMany({
    where: {
      result: { status: 'PUBLISHED', classId: { in: absolutas.map(c => c.id) } },
      status: 'RANKED'
    },
    select: {
      placing: true, status: true,
      result: { select: { classId: true } },
      athlete: {
        select: {
          id: true, fullName: true, stageName: true, affiliationNumber: true,
          affiliation: { select: { id: true, name: true, code: true } }
        }
      }
    },
    orderBy: [{ placing: 'asc' }]
  });

  const titulos = await prisma.eventOverallTitle.findMany({
    where: { eventId }, select: { id: true, athleteId: true, categoryId: true, declaredAt: true }
  });

  return {
    event,
    items: absolutas.map(classe => {
      const categoryId = classe.division.eventCategory.categoryId;
      const titulo = titulos.find(t => t.categoryId === categoryId) || titulos.find(t => t.categoryId === null) || null;

      return {
        competitionClass: { id: classe.id, name: classe.name, code: classe.code },
        division: { id: classe.division.id, name: classe.division.name, code: classe.division.code },
        category: classe.division.eventCategory.category,
        // O título JÁ homologado deste recorte, se houver: é o que permite a
        // tela mostrar "HOMOLOGADO" em vez de oferecer o botão de novo.
        declaredTitle: titulo,
        candidates: entradas
          .filter(entrada => entrada.result.classId === classe.id)
          .map(entrada => ({
            placing: entrada.placing,
            status: entrada.status,
            athlete: { id: entrada.athlete.id, fullName: entrada.athlete.fullName, stageName: entrada.athlete.stageName },
            affiliationNumber: entrada.athlete.affiliationNumber ?? null,
            affiliation: entrada.athlete.affiliation
          }))
      };
    })
  };
}

/**
 * Prévia da homologação: o impacto exato, SEM gravar nada.
 *
 * Existe porque o operador precisa ver a conta antes de assinar. Todas as
 * validações da declaração rodam aqui — categoria do evento, organização do
 * atleta, participação na absoluta —, de modo que a prévia que responde 200 é
 * uma declaração que vai passar.
 */
async function overallPreview(eventId, { athleteId, categoryId = null }, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, name: true, organizationId: true, seasonId: true }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'ranking.manage', event.organizationId);

  const athlete = await prisma.athlete.findUnique({
    where: { id: athleteId },
    select: {
      id: true, fullName: true, stageName: true, organizationId: true, affiliationNumber: true,
      affiliation: { select: { id: true, name: true, code: true } }
    }
  });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  if (athlete.organizationId !== event.organizationId) {
    throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Atleta de outra organização');
  }

  const candidatos = await overallCandidates(eventId, actor);
  const grupos = categoryId
    ? candidatos.items.filter(grupo => grupo.category?.id === categoryId)
    : candidatos.items;

  const grupo = grupos.find(g => g.candidates.some(c => c.athlete.id === athleteId));
  if (!grupo) {
    throw new AppError(
      422, 'OVERALL_REQUIRES_ABSOLUTE_CLASS',
      'O título Overall é da classe absoluta: o atleta não tem participação publicada em classe absoluta neste evento'
    );
  }

  const participacao = grupo.candidates.find(c => c.athlete.id === athleteId);

  // Os pontos JÁ lançados daquela participação. Ler em vez de recalcular
  // mantém a prévia honesta: ela mostra o que existe, e o que o +10 fará por
  // cima — não um cálculo paralelo que pode divergir do motor.
  const ponto = event.seasonId
    ? await prisma.rankingPoint.findFirst({
      where: { seasonId: event.seasonId, athleteId, eventId, classId: grupo.competitionClass.id },
      select: { placementPoints: true, overallBonus: true, points: true }
    })
    : null;

  const placementPoints = ponto?.placementPoints ?? 0;
  const jaTemBonus = (ponto?.overallBonus ?? 0) > 0;

  return {
    event: { id: event.id, name: event.name },
    athlete: {
      id: athlete.id, fullName: athlete.fullName, stageName: athlete.stageName,
      affiliationNumber: athlete.affiliationNumber ?? null, affiliation: athlete.affiliation
    },
    category: grupo.category,
    competitionClass: grupo.competitionClass,
    overallBonus: BONUS_OVERALL,
    participation: {
      placing: participacao.placing,
      placementPoints,
      pointsBefore: ponto?.points ?? placementPoints,
      pointsAfter: placementPoints + BONUS_OVERALL
    },
    // Quanto o acumulado da temporada sobe. Zero quando o bônus já está lá —
    // homologar de novo não soma, e a prévia diz isso antes de o operador
    // clicar.
    seasonImpact: jaTemBonus ? 0 : BONUS_OVERALL,
    alreadyDeclared: Boolean(grupo.declaredTitle)
  };
}

/**
 * Revogação do título.
 *
 * Existe porque a alternativa era pior: antes, declarar outro atleta
 * SUBSTITUÍA o campeão em silêncio, sem registro do que havia. Corrigir uma
 * homologação é ato administrativo — tem autor, data e MOTIVO, e as duas
 * operações ficam na trilha.
 *
 * O título é apagado da tabela de títulos (ele deixou de existir), mas a
 * auditoria guarda quem era, quem revogou e por quê. Histórico de auditoria
 * nunca é apagado.
 */
async function revokeOverall(eventId, titleId, { reason }, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId }, select: { id: true, organizationId: true, seasonId: true }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'ranking.manage', event.organizationId);

  const titulo = await prisma.eventOverallTitle.findUnique({
    where: { id: titleId },
    select: { id: true, eventId: true, athleteId: true, categoryId: true, declaredById: true, declaredAt: true }
  });
  if (!titulo || titulo.eventId !== eventId) {
    throw new AppError(404, 'OVERALL_NOT_FOUND', 'Homologação não encontrada neste campeonato');
  }

  await prisma.eventOverallTitle.delete({ where: { id: titleId } });

  await audit.record({
    actor, action: 'OVERALL_REVOKE', entity: 'Event', entityId: eventId,
    organizationId: event.organizationId,
    metadata: {
      titleId, athleteId: titulo.athleteId, categoryId: titulo.categoryId,
      declaredById: titulo.declaredById, declaredAt: titulo.declaredAt,
      reason
    }
  });

  // Repontuar: tirar o título é fato novo sobre resultados que já existiam,
  // exatamente como declará-lo. A colocação não é tocada — só o bônus sai. E,
  // como na declaração, o alcance é dos dois caminhos: apuração interna e
  // importação.
  await aplicarTitulosDoEvento(eventId, event.seasonId, actor);

  return { revoked: true, titleId, athleteId: titulo.athleteId, categoryId: titulo.categoryId };
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
async function companyRanking(seasonId, { categoryId = null, organizationId = null } = {}, actor = null) {
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

  return projetar(recortarParaOPublico(classificar(linhas), await vistaPublicaDaTemporada(seasonId, actor)), linha => ({
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
async function athleteRankingBy(seasonId, { classId = null, eventId = null, divisionId = null, categoryId = null, limit = null, offset = 0 } = {}, actor = null) {
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

  return projetar(recortarParaOPublico(paginar(classificar(linhas), { limit, offset }), await vistaPublicaDaTemporada(seasonId, actor)), linha => ({
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

async function superOverallRanking(seasonId, { categoryId = null, limit = null, offset = 0, organizationId = null } = {}, actor = null) {
  if (!seasonId) {
    const temporada = await temporadaPadrao(organizationId);
    if (!temporada) return { items: [], season: null };
    seasonId = temporada.id;
  }

  const vistaPublica = await vistaPublicaDaTemporada(seasonId, actor);

  // A AGREGAÇÃO ACONTECE NO BANCO.
  //
  // Medido na FASE 13: com 10.000 atletas e 100.000 pontos, o caminho antigo
  // trazia 25.000 LINHAS para somar em memória e devolver CINCO — p50 de 224ms
  // contra 6,5ms do ranking comum, numa rota que o anônimo dispara à vontade.
  //
  // O que NÃO mudou de lugar: a regra esportiva. Colocação e empate continuam
  // saindo de `classificar()`. O SQL só soma e conta — e, na vista pública,
  // pré-seleciona o topo. Duplicar a hierarquia de desempate em SQL seria criar
  // uma segunda fonte da verdade, que um dia divergiria da primeira.
  const { linhas: agregadas, lidas } = await agregarSuperOverall({
    seasonId, categoryId, limite: vistaPublica ? TOP_PUBLICO : null
  });

  const atletas = new Map(
    (await publico.athlete.findMany({
      where: { id: { in: agregadas.map(linha => linha.athleteId) } },
      select: { id: true, fullName: true, stageName: true, state: true, team: { select: { id: true, name: true } } }
    })).map(atleta => [atleta.id, atleta])
  );

  const linhas = agregadas.map(linha => ({
    athleteId: linha.athleteId,
    athlete: atletas.get(linha.athleteId) ?? null,
    // O ranking anual soma os pontos ELEGÍVEIS, não os do campeonato. São
    // números diferentes de propósito: somar `points` aqui traria de volta,
    // por dentro, as classes que a regra exclui.
    totalPoints: linha.totalPoints,
    eventCount: linha.eventCount,
    overallWins: linha.overallWins,
    firstPlaceCount: linha.firstPlaceCount,
    secondPlaceCount: linha.secondPlaceCount,
    thirdPlaceCount: linha.thirdPlaceCount,
    fourthPlaceCount: linha.fourthPlaceCount,
    fifthPlaceCount: linha.fifthPlaceCount
  }));

  const saida = projetar(recortarParaOPublico(paginar(classificar(linhas), { limit, offset }), vistaPublica), linha => ({
    position: linha.position,
    tieUnresolved: linha.tieUnresolved,
    athlete: linha.athlete,
    totalPoints: linha.totalPoints,
    eventCount: linha.eventCount,
    overallWins: linha.overallWins,
    firstPlaceCount: linha.firstPlaceCount,
    secondPlaceCount: linha.secondPlaceCount,
    thirdPlaceCount: linha.thirdPlaceCount
  }));

  // Quantas linhas o banco precisou materializar para produzir esta resposta.
  // Observabilidade, não enfeite: é o número que denuncia uma rota que voltou a
  // ler a temporada inteira, e é o que o teste de carga cobra.
  Object.defineProperty(saida, 'rowsRead', { value: lidas, enumerable: false });
  return saida;
}

/**
 * Agrega o Super Overall no banco: uma linha por atleta, com as somas e os
 * contadores que a hierarquia de desempate consulta.
 *
 * `limite` nulo devolve todos os atletas — é o que a vista administrativa
 * precisa para paginar. Com limite, a consulta traz o topo E TODOS OS
 * EMPATADOS COM O ÚLTIMO: cortar no meio de um bloco de empate faria
 * `classificar()` enxergar menos gente do que existe e atribuir colocação a
 * quem a regra manda deixar sem.
 */
async function agregarSuperOverall({ seasonId, categoryId, limite }) {
  const where = categoryId
    ? Prisma.sql`"seasonId" = ${seasonId} AND "superOverallEligible" = true AND "categoryId" = ${categoryId}`
    : Prisma.sql`"seasonId" = ${seasonId} AND "superOverallEligible" = true`;

  const consultar = async quantas => publico.$queryRaw`
    SELECT
      "athleteId",
      SUM("superOverallPoints")::int                                   AS "totalPoints",
      COUNT(DISTINCT COALESCE("eventId", "externalResultId", 'externo'))::int AS "eventCount",
      SUM(CASE WHEN "isOverallChampion" THEN 1 ELSE 0 END)::int        AS "overallWins",
      SUM(CASE WHEN "placing" = 1 THEN 1 ELSE 0 END)::int              AS "firstPlaceCount",
      SUM(CASE WHEN "placing" = 2 THEN 1 ELSE 0 END)::int              AS "secondPlaceCount",
      SUM(CASE WHEN "placing" = 3 THEN 1 ELSE 0 END)::int              AS "thirdPlaceCount",
      SUM(CASE WHEN "placing" = 4 THEN 1 ELSE 0 END)::int              AS "fourthPlaceCount",
      SUM(CASE WHEN "placing" = 5 THEN 1 ELSE 0 END)::int              AS "fifthPlaceCount"
    FROM "RankingPoint"
    WHERE ${where}
    GROUP BY "athleteId"
    -- A ordem aqui e de PRE-SELECAO, nao de classificacao: ela serve para que
    -- o topo caiba no limite. Quem atribui posicao e declara empate continua
    -- sendo classificar(), no motor.
    ORDER BY "totalPoints" DESC, "overallWins" DESC, "firstPlaceCount" DESC,
             "secondPlaceCount" DESC, "thirdPlaceCount" DESC, "athleteId" ASC
    ${quantas ? Prisma.sql`LIMIT ${quantas}` : Prisma.empty}
  `;

  if (!limite) {
    const linhas = await consultar(null);
    return { linhas, lidas: linhas.length };
  }

  // Estende o corte até que a última linha trazida seja DIFERENTE da primeira
  // descartada. Dobrar termina: no pior caso volta ao conjunto inteiro.
  const mesmaChave = (a, b) => a && b
    && a.totalPoints === b.totalPoints
    && a.overallWins === b.overallWins
    && a.firstPlaceCount === b.firstPlaceCount
    && a.secondPlaceCount === b.secondPlaceCount
    && a.thirdPlaceCount === b.thirdPlaceCount;

  // UMA CONSULTA, COM TETO.
  //
  // Medido, e nesta ordem:
  //
  //   1. ler tudo e agregar em memoria: 25.000 linhas, 224ms;
  //   2. agregar no banco DOBRANDO o limite ate fechar o bloco de empate:
  //      11.138 linhas em 6 consultas, 347ms -- PIOR que o ponto de partida,
  //      porque o custo esta no GROUP BY e nao no LIMIT, e dobrar pagava o
  //      mesmo GROUP BY seis vezes;
  //   3. uma consulta so, com teto: 578 linhas.
  //
  // O teto existe porque o bloco de empate pode ser enorme. Parar nele NAO
  // altera nenhuma linha exibida: quando o corte cai dentro de um empate, a
  // regra ja manda que TODOS os empatados saiam sem colocacao, e as cinco
  // primeiras saem com position nula e tieUnresolved verdadeiro tendo o bloco
  // 6 ou 6.000 membros. O que ficaria por saber e so quantos vem depois delas,
  // que a vista publica nao mostra de qualquer jeito.
  //
  // A ordem dentro do bloco continua sendo a sequencia estavel por id, que
  // rankingScoring.js documenta como SEQUENCIAMENTO, nao desempate.
  const TETO = Math.max(200, limite * 20);
  const trazidas = await consultar(TETO);

  // Corte limpo: a linha seguinte a ultima que interessa e diferente, entao o
  // bloco de empate nao foi partido e o excedente pode ser descartado.
  if (trazidas.length > limite && !mesmaChave(trazidas[limite - 1], trazidas[limite])) {
    return { linhas: trazidas.slice(0, limite + 1), lidas: trazidas.length };
  }

  return { linhas: trazidas, lidas: trazidas.length };
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

// ---------------------------------------------------------------------------
// VISTA PÚBLICA: TOP 5.
//
// Decisão homologada: a superfície pública do ranking mostra os cinco
// primeiros. O que a regra NÃO alcança, e o que está provado em
// tests/ranking-publico-top5.test.mjs:
//
//   * o ledger (RankingPoint) e o agregado (Ranking), que seguem inteiros;
//   * o ranking administrativo de quem opera a temporada;
//   * o histórico individual do atleta, que tem rota e autorização próprias;
//   * os filtros e a paginação do operador.
//
// Quem é "público" NÃO é "quem não está logado". É quem não tem `ranking.read`
// na organização dona da temporada: um atleta autenticado de outra federação
// vê o mesmo que o visitante anônimo. Privilégio vem do vínculo, nunca do
// fato de haver um token — é a mesma regra do resto da plataforma.
//
// O corte é DECLARADO na resposta, nunca silencioso: quem consome precisa
// saber que está vendo parte. E `nextCursor` volta nulo, porque oferecer
// paginação para uma página que a regra não entrega seria convidar a pedir o
// que não existe.
const TOP_PUBLICO = 5;

// A organização dona da TEMPORADA é quem decide se a vista é pública — nunca a
// informada na query, que qualquer um pode escrever.
async function vistaPublicaDaTemporada(seasonId, actor) {
  if (!seasonId) return true;
  const temporada = await publico.rankingSeason.findUnique({
    where: { id: seasonId }, select: { organizationId: true }
  });
  return ehVistaPublica(actor, temporada?.organizationId ?? null);
}

// MEDIDO, não suposto: `ranking.read` sozinho NÃO separa operador de público.
// Ela está em BASE_AUTENTICADO (src/utils/permissions.js) — todo mundo que se
// cadastra a recebe, seja qual for o papel. Um atleta de outra federação
// passaria no teste e veria a tabela inteira. Foi o que o teste
// "autenticado SEM vínculo com a organização também é público" flagrou.
//
// O que separa é o VÍNCULO com a organização dona da temporada, que é o
// sentido de "operador autorizado". `belongsToOrganization` já trata
// SUPER_ADMIN e ADMIN como cross-tenant. A permissão continua sendo exigida
// junto: vínculo sem permissão de leitura de ranking não abre a tabela.
function ehVistaPublica(actor, organizationId) {
  if (!actor || !organizationId) return true;
  return !(belongsToOrganization(actor, organizationId) && can(actor, 'ranking.read', organizationId));
}

// Aplica o teto quando a vista é pública. Recorta a lista JÁ classificada:
// não reordena, não desempata e não mexe em `position` — quem estava empatado
// continua empatado, com `position` nula, exatamente como saiu do motor.
//
// A marca `publicView` vai como propriedade NÃO ENUMERÁVEL: `JSON.stringify`
// de um array ignora propriedades próprias, então o contrato de resposta segue
// idêntico, e o controller tem como declarar o corte sem DEDUZIR pela
// quantidade de linhas — deduzir rotularia como "cortada" uma lista que por
// acaso tem cinco.
function recortarParaOPublico(linhas, publico) {
  return marcarVista(publico ? linhas.slice(0, TOP_PUBLICO) : linhas, publico);
}

function marcarVista(linhas, publico) {
  Object.defineProperty(linhas, 'publicView', { value: publico === true, enumerable: false });
  return linhas;
}

// `Array.prototype.map` devolve um array NOVO, e a marca não atravessa — foi
// exatamente assim que o cabeçalho sumiu na primeira tentativa. Projetar por
// aqui mantém a marca do lado de fora da projeção.
function projetar(linhas, projecao) {
  return marcarVista(linhas.map(projecao), linhas.publicView);
}

async function list(filtros, actor = null) {
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
    if (!temporada) return { items: [], season: null, nextCursor: null, publicView: true, publicLimit: TOP_PUBLICO };
    where.seasonId = temporada.id;
  }

  // A organização dona da TEMPORADA decide quem é público — não a informada na
  // query, que qualquer um pode escrever.
  const temporada = await publico.rankingSeason.findUnique({
    where: { id: where.seasonId }, select: { id: true, name: true, year: true, organizationId: true }
  });
  const vistaPublica = ehVistaPublica(actor, temporada?.organizationId ?? null);

  const items = await publico.ranking.findMany({
    where,
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, state: true, city: true, proStatus: true, team: { select: { id: true, name: true } } } },
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
    // O teto do público entra no `take`: não adianta buscar 100 para devolver
    // 5, e o cursor é ignorado porque a vista pública não pagina.
    take: vistaPublica ? TOP_PUBLICO : filtros.limit,
    ...(!vistaPublica && filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
  });

  return {
    items,
    season: items[0]?.season
      ?? (temporada ? { id: temporada.id, name: temporada.name, year: temporada.year } : null),
    nextCursor: !vistaPublica && items.length === filtros.limit ? items[items.length - 1].id : null,
    publicView: vistaPublica,
    publicLimit: TOP_PUBLICO
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
      // A filiação da época viaja com o ponto. Sem ela o histórico responderia
      // com a federação de HOJE para um resultado de ontem.
      affiliation: { select: { id: true, code: true, name: true, state: true } },
      externalResult: { select: { id: true, source: true, externalId: true, eventName: true, eventDate: true } }
    },
    orderBy: { awardedAt: 'desc' }
  });
}

module.exports = {
  TOP_PUBLICO,
  createSeason, listSeasons, setPointsRules, pointsForPlacing, awardForResult,
  recompute, recompute_, list, athletePoints, teamRanking,
  declareOverall, listOverall, overallCandidates, overallPreview, revokeOverall,
  superOverallRanking, listClasses, upsertClass, companyRanking,
  athleteRankingBy,
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL,
  // Exportada para medição: a pré-seleção tem um contrato próprio — trazer o
  // topo E o bloco de empate inteiro que encosta no corte — e esse contrato
  // não é observável pela resposta pública, que mostra só as cinco primeiras
  // linhas. Medi-lo pela porta da frente é impossível; medi-lo aqui é a única
  // forma de travar a promessa que o comentário da função faz.
  agregarSuperOverall
};
