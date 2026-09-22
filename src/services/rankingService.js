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
const { resolverClasseDoCatalogo } = require('../utils/classeDoCatalogo');

// Ranking e temporadas.
//
// Todo ponto tem proveniência: origem (EVENT ou MUSCLEWAR), evento, resultado
// ou resultado externo. O agregado `Ranking` é sempre derivado de
// `RankingPoint` — nunca escrito à mão — de modo que a soma pode ser refeita e
// conferida a qualquer momento.

// A materialização do ranking e a correção administrativa passaram a caber na
// mesma transação, e uma temporada inteira pode ter centenas de lançamentos.
// O padrão de 5s do Prisma foi dimensionado para escrita pontual, não para
// isso: estourá-lo abortaria a correção DEPOIS de o operador ter confirmado.
const OPCOES_TRANSACAO = Object.freeze({ timeout: 30_000, maxWait: 15_000 });

// SERIALIZA A TEMPORADA, E NÃO O LANÇAMENTO.
//
// A trava precisa cobrir as duas coisas que corriam soltas: a janela entre
// conferir `voidedAt` e escrever por cima dele, e o recálculo do agregado, que
// lê a temporada INTEIRA. Travar só a linha corrigida fecharia a primeira e
// deixaria a segunda aberta — duas correções em lançamentos diferentes da
// mesma temporada continuariam cruzando seus recálculos.
//
// `pg_advisory_xact_lock` porque o PostgreSQL a solta sozinho no fim da
// transação, commit ou rollback. A trava de sessão exigiria destravar à mão, e
// com pool de conexões o destravamento poderia cair em outra conexão que não
// tem a trava — deixando a temporada bloqueada até o processo reiniciar.
//
// `$executeRaw` e não `$queryRaw`: a função devolve void, e o Prisma recusa a
// leitura de um resultado que não existe.
async function travarTemporada(tx, seasonId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ranking:temporada:${seasonId}`}))`;
}

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
  // INVALIDADO NÃO CARREGA TÍTULO. A participação continua no histórico, mas
  // parou de pontuar por decisão administrativa registrada — receber +10
  // depois disso ressuscitaria o lançamento pela porta dos fundos, sem
  // ninguém ter restaurado nada.
  const candidatas = linhas.filter(linha => linha.superOverallEligible && !linha.voidedAt);
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
    where: { eventId }, select: { athleteId: true, externalAthleteId: true, categoryId: true }
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
    // O COMPETIDOR, E NÃO O ATLETA.
    //
    // O título pode ser de quem ainda não tem cadastro: o histórico oficial é
    // carregado antes de os atletas se inscreverem, e a identidade dessas
    // linhas vive em `ExternalAthlete`. Casar só por `athleteId` deixava o
    // +10 de um campeonato importado sem linha onde pousar.
    const doCompetidor = titulo.athleteId
      ? { athleteId: titulo.athleteId }
      : { externalAthleteId: titulo.externalAthleteId };

    const linhas = await tx.rankingPoint.findMany({
      where: {
        seasonId, eventId, ...doCompetidor,
        ...(titulo.categoryId ? { categoryId: titulo.categoryId } : {})
      },
      select: {
        id: true, placing: true, superOverallEligible: true, source: true,
        didNotShow: true, voidedAt: true,
        placementPoints: true, overallBonus: true, isOverallChampion: true,
        // `adjustmentPoints` ENTRA AQUI PORQUE ELE ENTRA NA CONTA.
        //
        // A fórmula do lançamento é `placementPoints + overallBonus +
        // adjustmentPoints` — é assim que `adjustRankingPoint` a escreve, e a
        // parcela de ajuste é guardada justamente para sobreviver a um
        // recálculo. Esta função somava só as duas primeiras: declarar ou
        // revogar um Overall no evento APAGAVA, em silêncio, a correção
        // administrativa de qualquer lançamento daquele atleta — com a
        // trilha de auditoria do ajuste continuando lá, apontando para um
        // número que o ledger já não tinha.
        adjustmentPoints: true,
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
      // INVALIDADO NÃO É REESCRITO POR ESTA FUNÇÃO.
      //
      // `placementPoints` continua guardando o que aconteceu no campeonato —
      // é o registro histórico, e a restauração depende dele. Mas a linha
      // invalidada vale ZERO por decisão administrativa registrada, e a conta
      // abaixo é `placementPoints + bônus`: sem esta guarda, declarar (ou
      // revogar) um Overall no evento devolvia a colocação à linha invalidada
      // e ressuscitava o lançamento sem ninguém ter restaurado nada.
      //
      // Ela também nunca é portadora: `escolherPortadoraDoBonus` já a exclui.
      // Pular aqui é o outro lado da mesma regra.
      if (linha.voidedAt) continue;

      const ehPortadora = Boolean(portadora) && linha.id === portadora.id;
      const overallBonus = ehPortadora ? BONUS_OVERALL : 0;
      // AS TRÊS PARCELAS. Ver a nota do `select` acima: somar só duas apagava
      // o ajuste administrativo a cada declaração ou revogação de Overall.
      const points = linha.placementPoints + overallBonus + linha.adjustmentPoints;
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
      seasonId, eventId, overallBonus: { gt: 0 }, voidedAt: null,
      ...(portadoras.size ? { id: { notIn: [...portadoras] } } : {})
    },
    select: { id: true, placementPoints: true, adjustmentPoints: true, superOverallEligible: true }
  });

  for (const linha of orfas) {
    // Perder o bônus não é perder o ajuste administrativo: só a parcela do
    // Overall sai da conta.
    const points = linha.placementPoints + linha.adjustmentPoints;
    await tx.rankingPoint.update({
      where: { id: linha.id },
      data: {
        overallBonus: 0,
        isOverallChampion: false,
        points,
        superOverallPoints: linha.superOverallEligible ? points : 0
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
  // A MESMA ORDEM DE RESOLUÇÃO DE TODO O RESTO: a classe DAQUELA CATEGORIA
  // manda; na ausência dela, vale a genérica da organização.
  //
  // Deixou de ser `findUnique` porque o par (organização, código) parou de
  // ser único: a mesma organização pode ter OPEN de Women's Physique e OPEN
  // de Men's Physique. A unicidade agora são duas — ver a migration
  // 20260922120000.
  const doCatalogo = (await prisma.classCatalog.findFirst({
    where: { organizationId: result.event.organizationId, categoryId, code: classe.code },
    select: { superOverallEligible: true }
  })) ?? await prisma.classCatalog.findFirst({
    where: { organizationId: result.event.organizationId, categoryId: null, code: classe.code },
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
    // A REPONTUAÇÃO NÃO REVOGA UMA INVALIDAÇÃO ADMINISTRATIVA.
    //
    // Achado de auditoria, e determinístico — não é corrida. O `deleteMany`
    // apagava TODAS as linhas do resultado e as recriava do zero, inclusive a
    // que um operador tinha invalidado. Como `results.override` repontua todo
    // resultado já publicado, o caminho era trivial: desclassificar um atleta,
    // corrigir a súmula da classe por outro motivo, e a desclassificação sumia.
    // O atleta voltava a pontuar no ranking publicado, sem aviso, e a entrada
    // de auditoria da invalidação passava a apontar para uma linha que não
    // existia mais.
    //
    // AS DUAS DECISÕES SÃO SOBRE COISAS DIFERENTES, e é isso que decide a
    // precedência:
    //
    //   · invalidar responde "esta participação vale?" — doping, expulsão,
    //     decisão da comissão. A súmula republicada não fala sobre isso, e por
    //     isso não pode desfazê-la. A linha invalidada SOBREVIVE;
    //   · corrigir a colocação responde "qual foi o resultado?" — e aí a
    //     súmula é a autoridade. Uma súmula corrigida SUBSTITUI a correção
    //     administrativa daquela colocação, de propósito: as duas convergem
    //     para a versão oficial, que é o desfecho desejado. O histórico da
    //     correção continua na auditoria.
    //
    // A linha preservada não vira duplicata: `@@unique([seasonId, athleteId,
    // resultId])` faz o `create` seguinte levantar P2002, que o `catch` abaixo
    // já trata como "já pontuado".
    if (recompute) {
      await tx.rankingPoint.deleteMany({ where: { seasonId, resultId, voidedAt: null } });
    }

    // QUEM SOBROU NÃO É RECRIADO — E A CONFERÊNCIA PRECISA SER ANTES.
    //
    // Depois do `deleteMany` seletivo, ainda existem linhas deste resultado:
    // as invalidadas, que acabaram de ser poupadas. Tentar criá-las de novo
    // levantaria P2002 — e P2002 AQUI é fatal, não recuperável.
    //
    // A requisição inteira roda numa transação (é assim que o contexto de RLS
    // é definido; ver withUserContext). A violação de unicidade ABORTA essa
    // transação, e todo comando seguinte falha com 25P02 ("current transaction
    // is aborted"). Medido: o `catch` de P2002 logo abaixo NÃO salva nada
    // nesse caso — o `create` do próximo atleta morre com 25P02 e a requisição
    // vira 500. Ele nunca tinha disparado porque o `deleteMany` antigo apagava
    // tudo, garantindo que não houvesse com o que conflitar.
    //
    // Por isso a duplicata é EVITADA, e não capturada. É a mesma lição do gate
    // de concorrência do /apply, que nasceu exatamente deste erro.
    const jaLancados = new Set(
      (await tx.rankingPoint.findMany({
        where: { seasonId, resultId }, select: { athleteId: true }
      })).map(ponto => ponto.athleteId)
    );

    // A CLASSE DO EVENTO, TAMBÉM NO CATÁLOGO DA ORGANIZAÇÃO.
    //
    // `classId` continua sendo a classe do evento e não muda de significado.
    // Esta é a mesma classe vista pelo catálogo — resolvida uma vez para o
    // resultado inteiro, porque um resultado é de uma classe só.
    //
    // Existe para que o recorte por classe responda a MESMA pergunta nos dois
    // caminhos: sem ela, `/ranking?catalogClassId=OPEN` mostraria o histórico
    // importado e esconderia o campeonato julgado no MCI, o que é pior do que
    // não ter o filtro.
    //
    // Não toca em pontuação: `superOverallEligible` já foi resolvido acima.
    const classeDoCatalogo = await resolverClasseDoCatalogo(tx, {
      organizationId: result.event.organizationId,
      categoryId,
      displayName: classe.name ?? classe.code,
      code: classe.code,
      criar: false
    });

    let total = 0;
    for (const entry of classificados) {
      // Lançamento preservado (invalidado) ou já existente: a decisão
      // administrativa fica de pé e a repontuação não o reescreve.
      if (jaLancados.has(entry.athleteId)) continue;

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
            // A organização, EXPLÍCITA. Aqui ela é a do evento — o caminho
            // interno nasce de um evento do MCI, e é dele que a linha é.
            organizationId: result.event.organizationId,
            source: 'EVENT', eventId: result.eventId, resultId,
            classId: result.classId,
            catalogClassId: classeDoCatalogo?.id ?? null,
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
        // ÚLTIMA REDE, e não a barreira. A barreira é o `jaLancados` acima:
        // dentro de uma transação interativa, P2002 já matou a transação e não
        // há o que engolir. Isto aqui só cobre a inserção concorrente de outra
        // requisição entre a leitura e a escrita — e mesmo aí a transação está
        // perdida; o que este ramo evita é mascarar a causa com outro erro.
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
//
// LEITURA E ESCRITA NA MESMA TRANSAÇÃO. Antes os pontos eram lidos fora de
// qualquer transação e só a materialização abria uma: entre a leitura e a
// escrita cabia outro recálculo inteiro, e o que ficava gravado era o do
// recálculo que lera primeiro e escrevera por último — o ranking publicado
// passava a mostrar uma colocação que o lançamento já não tinha. Recebendo o
// cliente transacional de fora, a função também pode ser chamada DENTRO do
// bloqueio que serializa a correção administrativa, sem soltá-lo no meio.
/**
 * O competidor que ainda NÃO tem cadastro no MCI, na forma que a tela espera.
 *
 * O histórico oficial é carregado antes de os atletas se inscreverem: por um
 * tempo — que pode ser longo — a linha do ranking existe, pontua e precisa ter
 * nome, sem haver `Athlete` nenhum por trás.
 *
 * `id` NULO é deliberado, e não um descuido: nada que consuma isto pode
 * construir um link para o perfil de um atleta que não existe. `pendingLink`
 * diz à tela que a pessoa está no ranking esperando o cadastro dela — não que
 * houve erro.
 */
function competidorExterno(linha) {
  if (!linha?.externalAthleteId && !linha?.displayName) return null;
  return {
    id: null,
    externalAthleteId: linha.externalAthleteId ?? null,
    fullName: linha.displayName ?? 'Atleta não cadastrado',
    stageName: null,
    state: null,
    team: null,
    pendingLink: true
  };
}

// ===========================================================================
// ETAPA A DO RECÁLCULO: A TABELA DA TEMPORADA VOLTA A ALCANÇAR OS LANÇAMENTOS.
// ===========================================================================
//
// O QUE ESTAVA ERRADO, MEDIDO NA BASE REAL DA FEDERAÇÃO
//
// "Recalcular" só reconstruía o AGREGADO: lia `RankingPoint.points` e somava.
// Se a linha valia zero, o ranking valia zero — e continuava valendo depois de
// quantos recálculos fossem.
//
// Os 191 do Ipiranga entraram antes de a temporada ter tabela de pontos.
// `pontuarResultado` não achou regra para colocação nenhuma e gravou zero nas
// 191, corretamente: sem tabela não há o que atribuir. Depois a tabela foi
// cadastrada (1=5, 2=4, 3=3, 4=2, 5=1) — e não havia caminho que a fizesse
// alcançar o que já estava gravado. O operador via a tabela certa na tela, o
// `placing` certo no lançamento, e zero ponto no ranking.
//
// Reimportar não resolvia: a idempotência do importador marca tudo como
// DUPLICATE, que é justamente a proteção que impede duplicar os 191.
//
// O QUE ESTA ETAPA FAZ
//
// Reaplica a tabela VIGENTE da temporada a cada lançamento, a partir do
// `placing` que já está gravado. É genérica: vale para qualquer tabela que o
// administrador configure, e não para o Ipiranga em particular.
//
//   placementPoints  <- tabela da temporada para aquela colocação
//   points           <- placementPoints + overallBonus + adjustmentPoints
//   superOverallPoints <- points onde a classe é elegível, zero nas demais
//
// O QUE ELA NÃO TOCA
//
// `placing`, `didNotShow`, `categoryId`, `catalogClassId`, `athleteId`,
// `eventId`, `source`, `externalResultId`, equipe, empresa e filiação. Nenhum
// lançamento é criado, nenhum é apagado. Só as parcelas derivadas de
// pontuação mudam.
//
// `adjustmentPoints` É PRESERVADO. Ele é a diferença que um operador registrou
// com motivo e trilha de auditoria; recalcular a tabela não revoga aquela
// decisão. Quem quiser desfazê-la usa o caminho do ajuste, que registra.
//
// O LANÇAMENTO INVALIDADO NÃO É TOCADO. Ele vale zero por decisão
// administrativa registrada, e `placementPoints` guarda o que aconteceu no
// campeonato para a restauração poder existir. Repontuá-lo aqui o
// ressuscitaria sem ninguém ter restaurado nada.
//
// TEMPORADA SEM TABELA NÃO ZERA NADA.
//
// Sem regra cadastrada esta etapa não roda e devolve o aviso. Zerar 191
// lançamentos porque a tabela sumiu seria destruir histórico por causa de uma
// configuração ausente — e é o oposto do que este reparo existe para fazer.
//
// IDEMPOTENTE: a escrita só acontece onde algum campo difere, então a segunda
// passada não altera nada e devolve `alterados: 0`.
// ===========================================================================
async function reconciliarPontuacao(tx, seasonId) {
  const tabela = await tx.rankingPointsRule.findMany({
    where: { seasonId }, select: { placing: true, points: true }, orderBy: { placing: 'asc' }
  });

  if (!tabela.length) {
    return { processados: 0, alterados: 0, semTabelaDePontos: true };
  }

  const pontos = await tx.rankingPoint.findMany({
    where: { seasonId, voidedAt: null },
    select: {
      id: true, placing: true, didNotShow: true, superOverallEligible: true,
      placementPoints: true, overallBonus: true, adjustmentPoints: true,
      points: true, superOverallPoints: true
    }
  });

  let alterados = 0;

  for (const ponto of pontos) {
    // A MESMA função que a apuração e a importação usam. Reimplementar a
    // consulta à tabela aqui criaria um segundo lugar onde a regra mora, e
    // dois lugares divergem.
    //
    // Ausência vale ZERO pela regra homologada: `didNotShow` entra como
    // colocação nula, e nula não acha regra.
    const { placementPoints } = pontuarResultado(
      ponto.didNotShow ? null : ponto.placing, tabela
    );

    // O BÔNUS NÃO É DECIDIDO AQUI. Quem o atribui é `normalizarBonusOverall`,
    // a partir dos títulos DECLARADOS pela organização — e ela roda logo
    // abaixo, já sobre o `placementPoints` corrigido.
    const points = placementPoints + ponto.overallBonus + ponto.adjustmentPoints;
    const superOverallPoints = ponto.superOverallEligible ? points : 0;

    const jaEstaCerto = ponto.placementPoints === placementPoints
      && ponto.points === points
      && ponto.superOverallPoints === superOverallPoints;
    if (jaEstaCerto) continue;

    await tx.rankingPoint.update({
      where: { id: ponto.id },
      data: { placementPoints, points, superOverallPoints }
    });
    alterados += 1;
  }

  return { processados: pontos.length, alterados, semTabelaDePontos: false };
}

async function recomputarEm(tx, seasonId) {
  // ETAPA A — a tabela da temporada volta a alcançar os lançamentos.
  const reconciliacao = await reconciliarPontuacao(tx, seasonId);

  // E o Overall DECLARADO volta a pousar, agora sobre a colocação corrigida.
  // Só os eventos que têm título declarado são varridos: sem declaração não há
  // bônus a normalizar, e varrer o resto seria trabalho sem efeito.
  if (!reconciliacao.semTabelaDePontos) {
    const comTitulo = await tx.rankingPoint.findMany({
      where: { seasonId, eventId: { not: null }, event: { overallTitles: { some: {} } } },
      select: { eventId: true }, distinct: ['eventId']
    });
    for (const { eventId } of comTitulo) {
      await normalizarBonusOverall(tx, { eventId, seasonId });
    }
  }

  // ETAPA B — materialização. A leitura vem DEPOIS da reconciliação: ler antes
  // materializaria o estado que a etapa A acabou de corrigir.
  const pontos = await tx.rankingPoint.findMany({
    where: { seasonId },
    select: {
      id: true,
      athleteId: true, externalAthleteId: true, organizationId: true,
      categoryId: true, points: true, placing: true,
      superOverallPoints: true, superOverallEligible: true, didNotShow: true,
      isOverallChampion: true, eventId: true, classId: true, catalogClassId: true,
      teamId: true, companyId: true, voidedAt: true, externalResultId: true,
      externalAthlete: { select: { id: true, displayName: true } }
    }
  });

  // O COMPETIDOR, e não o atleta. Um resultado histórico carregado antes de o
  // atleta se cadastrar não tem `athleteId` — e agrupar por uma coluna nula
  // juntaria num balde só todos os competidores sem cadastro da temporada.
  const competidorDe = ponto => ponto.athleteId ?? `X:${ponto.externalAthleteId}`;

  const acumulado = new Map();
  for (const ponto of pontos) {
    const competidor = competidorDe(ponto);
    const chave = `${competidor}::${ponto.categoryId ?? ''}`;
    if (!acumulado.has(chave)) {
      acumulado.set(chave, {
        competitorKey: competidor,
        athleteId: ponto.athleteId,
        externalAthleteId: ponto.externalAthleteId,
        organizationId: ponto.organizationId,
        displayName: ponto.externalAthlete?.displayName ?? null,
        categoryId: ponto.categoryId,
        totalPoints: 0, fontes: new Set(), pontos: []
      });
    }
    const linha = acumulado.get(chave);
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.eventId || ponto.externalResultId || 'externo');
    linha.pontos.push(ponto);
  }

  const athleteIds = [...new Set([...acumulado.values()].map(linha => linha.athleteId).filter(Boolean))];
  const atletas = athleteIds.length
    ? await tx.athlete.findMany({ where: { id: { in: athleteIds } }, select: { id: true, state: true, country: true } })
    : [];
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

  await tx.ranking.deleteMany({ where: { seasonId } });

  for (const linha of classificadas) {
    const atleta = linha.athleteId ? porAtleta.get(linha.athleteId) : null;
    await tx.ranking.create({
      data: {
        seasonId,
        organizationId: linha.organizationId,
        competitorKey: linha.competitorKey,
        athleteId: linha.athleteId ?? null,
        externalAthleteId: linha.externalAthleteId ?? null,
        // O nome da fonte só serve enquanto não há cadastro. Havendo, quem
        // manda é o cadastro, e a leitura o busca pela relação.
        displayName: linha.athleteId ? null : linha.displayName,
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

  await republicarProjecao(tx, seasonId, pontos, competidorDe);

  return {
    rows: classificadas.length,
    tieUnresolved: classificadas.filter(linha => linha.tieUnresolved).length,
    // Os números da ETAPA A, para a tela poder dizer o que aconteceu em vez de
    // "recalculado" — que não distingue "191 corrigidos" de "nada mudou".
    lancamentos: reconciliacao.processados,
    lancamentosAlterados: reconciliacao.alterados,
    semTabelaDePontos: reconciliacao.semTabelaDePontos
  };
}

/**
 * Reescreve a PROJEÇÃO PÚBLICA da temporada — uma linha por lançamento, só
 * com as colunas que são públicas.
 *
 * POR QUE ELA PRECISA EXISTIR, e por que não é um agregado
 *
 * `RankingPoint` passou a ter RLS de operador. Quatro rotas anônimas viviam de
 * lê-lo direto (`/ranking/super-overall`, `/ranking/by`, `/ranking/teams`,
 * `/ranking/companies`), e fechar a tabela sem mais nada as deixaria vazias
 * para o visitante.
 *
 * Materializar um AGREGADO por recorte significaria escrever a soma em vários
 * lugares, e cada um deles é uma chance de a pontuação divergir da regra
 * homologada. Uma linha por lançamento mantém um motor só: o mesmo código que
 * soma hoje continua somando, lendo de outro lugar.
 *
 * O lançamento invalidado CONTINUA AQUI, zerado, exatamente como está no
 * ledger — tirá-lo mudaria `eventCount`, que conta participação e não ponto.
 */
async function republicarProjecao(tx, seasonId, pontos, competidorDe) {
  await tx.publicRankingEntry.deleteMany({ where: { seasonId } });
  if (!pontos.length) return;

  await tx.publicRankingEntry.createMany({
    data: pontos.map(ponto => ({
      // O id do lançamento é o id da projeção: torna a correspondência entre
      // as duas tabelas conferível sem uma coluna de ligação a mais.
      id: ponto.id,
      seasonId,
      organizationId: ponto.organizationId,
      competitorKey: competidorDe(ponto),
      athleteId: ponto.athleteId ?? null,
      externalAthleteId: ponto.externalAthleteId ?? null,
      displayName: ponto.athleteId ? null : (ponto.externalAthlete?.displayName ?? null),
      categoryId: ponto.categoryId ?? null,
      eventId: ponto.eventId ?? null,
      classId: ponto.classId ?? null,
      // O recorte por classe do PÚBLICO. `classId` é nulo em todo
      // resultado histórico importado, porque ele aponta para a classe
      // de um evento do MCI; esta coluna é a do catálogo da organização,
      // que existe nos dois caminhos.
      catalogClassId: ponto.catalogClassId ?? null,
      teamId: ponto.teamId ?? null,
      companyId: ponto.companyId ?? null,
      placing: ponto.placing ?? null,
      points: ponto.points,
      superOverallPoints: ponto.superOverallPoints,
      superOverallEligible: ponto.superOverallEligible,
      isOverallChampion: ponto.isOverallChampion,
      didNotShow: ponto.didNotShow,
      voided: ponto.voidedAt != null,
      // O mesmo COALESCE que o SQL antigo contava como DISTINCT.
      sourceKey: ponto.eventId || ponto.externalResultId || 'externo'
    }))
  });
}

async function recompute_(seasonId) {
  return prisma.$transaction(tx => recomputarEm(tx, seasonId), OPCOES_TRANSACAO);
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
  // Projeção pública: a rota é anônima e `RankingPoint` tem RLS de operador.
  // `competitorKey` no lugar de `athleteId` porque o competidor sem cadastro
  // também compõe a equipe — o resultado histórico dele conta para ela.
  const pontos = await publico.publicRankingEntry.findMany({
    where: { seasonId, teamId: { not: null }, ...(categoryId ? { categoryId } : {}) },
    select: {
      teamId: true, competitorKey: true, points: true, placing: true, isOverallChampion: true,
      sourceKey: true
    }
  });

  const equipes = new Map(
    (await publico.team.findMany({
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
    // O COMPETIDOR, e não o atleta: quem ainda não se cadastrou também
    // compete pela equipe, e o resultado histórico dele conta para ela.
    linha.atletas.add(ponto.competitorKey);
    linha.fontes.add(ponto.sourceKey);
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

  // SOB A MESMA TRAVA DA CORREÇÃO ADMINISTRATIVA, e pelo mesmo motivo.
  //
  // A normalização lê as linhas do recorte, decide, e só então escreve. Entre
  // a leitura e a escrita cabe uma invalidação — e aí o +10 pousaria numa
  // linha que a organização acabou de tirar do ranking. O recálculo entra na
  // mesma transação porque lê a temporada inteira.
  //
  // REGISTRO HONESTO: escrevi o teste de 20 simultâneas (dez declarações
  // contra dez invalidações do mesmo lançamento) esperando ver a corrida, e
  // ela NÃO apareceu — o bloqueio de linha do PostgreSQL serializou as
  // escritas no caso medido. Não reproduzir não é o mesmo que não existir: a
  // janela entre a leitura e a escrita está no código, e depende de tempo.
  // A trava fecha a janela por construção, em vez de por sorte de escalonamento.
  await prisma.$transaction(async tx => {
    await travarTemporada(tx, seasonId);
    await normalizarBonusOverall(tx, { eventId, seasonId });
    await recomputarEm(tx, seasonId);
  }, OPCOES_TRANSACAO);
}

// MENSAGEM ADMINISTRATIVA, LITERAL E DEFINIDA PELO ORGANIZADOR.
//
// Ela não descreve um erro técnico: descreve uma DECISÃO QUE FALTA. O
// operador que a lê precisa entender que não errou, que a plataforma não
// quebrou, e que o caminho é homologar a regra — não tentar de novo.
const MENSAGEM_OVERALL_MULTIPLO = 'Este evento já possui uma declaração Overall '
  + 'para este atleta em outra categoria absoluta. A regra de pontuação para '
  + 'múltiplos títulos Overall neste mesmo evento ainda requer homologação.';

// ===========================================================================
// O COMPETIDOR DE UM TÍTULO: CADASTRADO OU NÃO, UM SÓ.
// ===========================================================================
//
// O MCI carrega histórico oficial ANTES de os atletas se cadastrarem — é o
// caminho normal, não a exceção. Um campeonato importado tem `athleteId` nulo
// nos lançamentos e a identidade em `ExternalAthlete`; exigir cadastro para
// declarar o Overall impediria a organização de registrar um fato que já
// aconteceu no palco.
//
// A conferência de organização é a mesma para os dois: competidor de outra
// federação não recebe título neste campeonato, tenha cadastro ou não.
async function resolverCompetidorDoTitulo({ athleteId, externalAthleteId }, event) {
  if (Boolean(athleteId) === Boolean(externalAthleteId)) {
    throw new AppError(
      422, 'OVERALL_COMPETITOR_REQUIRED',
      'Informe o atleta cadastrado OU o competidor do histórico importado — um, e apenas um'
    );
  }

  if (athleteId) {
    const athlete = await prisma.athlete.findUnique({
      where: { id: athleteId }, select: { id: true, organizationId: true }
    });
    if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
    if (athlete.organizationId !== event.organizationId) {
      throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Atleta de outra organização');
    }
    return { athleteId: athlete.id, externalAthleteId: null, doLedger: { athleteId: athlete.id } };
  }

  const externo = await prisma.externalAthlete.findUnique({
    where: { id: externalAthleteId }, select: { id: true, organizationId: true }
  });
  if (!externo) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Competidor do histórico não encontrado');
  if (externo.organizationId !== event.organizationId) {
    throw new AppError(422, 'ATHLETE_OTHER_ORGANIZATION', 'Competidor de outra organização');
  }
  return { athleteId: null, externalAthleteId: externo.id, doLedger: { externalAthleteId: externo.id } };
}

/**
 * A participação na ABSOLUTA, conferida no LEDGER.
 *
 * A conferência original lia `RegistrationItem` — a inscrição do campeonato
 * apurado dentro do MCI. Resultado importado NÃO tem inscrição: ele entra no
 * ledger já pronto, com a classe resolvida contra o catálogo da organização e
 * `superOverallEligible` marcado ali.
 *
 * O fato existe; mora em outro lugar. Esta função pergunta ao ledger a mesma
 * coisa que a outra pergunta à inscrição: este competidor disputou classe
 * absoluta neste campeonato, neste recorte?
 *
 * A linha INVALIDADA não conta: ela parou de pontuar por decisão registrada, e
 * dar título a partir dela a ressuscitaria pela porta dos fundos.
 */
async function disputouAbsolutaNoLedger(eventId, doLedger, categoryId) {
  const linha = await prisma.rankingPoint.findFirst({
    where: {
      eventId, ...doLedger, superOverallEligible: true, voidedAt: null,
      ...(categoryId ? { categoryId } : {})
    },
    select: { id: true }
  });
  return Boolean(linha);
}

async function declareOverall(eventId, { athleteId = null, externalAthleteId = null, categoryId = null, note = null }, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, organizationId: true, seasonId: true }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Evento não encontrado');
  assertCan(actor, 'ranking.manage', event.organizationId);

  const competidor = await resolverCompetidorDoTitulo({ athleteId, externalAthleteId }, event);

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
    // O CAMPEONATO IMPORTADO NÃO TEM `EventCategory`: ele não foi montado
    // dentro do MCI, foi carregado pronto. A categoria dele existe como FATO
    // no ledger, e é lá que a conferência olha quando a grade não existe.
    const noLedger = doEvento ? null : await prisma.rankingPoint.findFirst({
      where: { eventId, categoryId }, select: { id: true }
    });
    if (!doEvento && !noLedger) {
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
  // Só o competidor CADASTRADO tem inscrição: quem veio do histórico
  // importado nunca esteve nesta tabela.
  const absolutas = competidor.athleteId ? await prisma.registrationItem.findMany({
    where: {
      registration: { eventId, athleteId: competidor.athleteId },
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
  }) : [];

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
  )
    // OU o fato já gravado no LEDGER, que é onde o campeonato importado vive.
    // A regra não muda — o título continua sendo da absoluta e de mais
    // ninguém. O que muda é onde a plataforma procura a participação.
    || await disputouAbsolutaNoLedger(eventId, competidor.doLedger, categoryId);

  if (!disputouAbsoluta) {
    throw new AppError(
      422, 'OVERALL_REQUIRES_ABSOLUTE_CLASS',
      'O título Overall é da classe absoluta: o competidor não tem participação em classe absoluta neste evento'
    );
  }

  // A DECLARAÇÃO INTEIRA SOB UMA TRAVA DO EVENTO.
  //
  // As duas conferências abaixo leem antes de escrever, e a de recorte
  // cruzado não tem índice único que a socorra: dois títulos do mesmo atleta
  // em CATEGORIAS DIFERENTES são, para o banco, duas linhas perfeitamente
  // válidas. Sem serializar, duas declarações simultâneas atravessam juntas e
  // gravam exatamente o acúmulo que esta fase existe para impedir.
  let titulo;
  try {
    titulo = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`overall:evento:${eventId}`}))`;

      // DOIS TÍTULOS OVERALL PARA O MESMO ATLETA NO MESMO CAMPEONATO:
      // O SISTEMA NÃO DECIDE.
      //
      // A regra de pontuação para esse caso NÃO está homologada. +10 (é
      // campeão absoluto do evento, uma vez) e +20 (cada título vale o seu
      // bônus) são leituras defensáveis, e escolher uma aqui seria a
      // plataforma legislando regra esportiva.
      //
      // O QUE ACONTECIA ANTES, MEDIDO: a segunda declaração era aceita (201),
      // o evento ficava com dois títulos, e o pagamento dependia de acidente.
      // Na medição, um atleta 1º em Bodybuilding e 1º em Classic Physique
      // terminou com 20 pontos e bônus [0, 10] — o segundo título não achou
      // linha para pousar porque o `categoryId` daquele lançamento estava
      // nulo, e pagou ZERO em silêncio. Se o importador tivesse resolvido a
      // categoria, teria pago +20. Quer dizer: o total dependia de um detalhe
      // de importação, não de regra. Sorteio decidindo campeonato é pior que
      // qualquer das duas regras candidatas.
      //
      // Enquanto não houver homologação, a segunda declaração é RECUSADA com
      // mensagem administrativa — e não com erro genérico, que o operador
      // leria como defeito da plataforma.
      //
      // A comparação é feita em memória, e não por `NOT: { categoryId }`: no
      // Prisma isso vira `categoryId <> '...'`, que em SQL NÃO casa com nulo,
      // e deixaria passar exatamente o caso do título do evento inteiro
      // (recorte nulo) convivendo com um título de categoria.
      const doAtleta = await tx.eventOverallTitle.findMany({
        where: { eventId, ...competidor.doLedger }, select: { id: true, categoryId: true }
      });
      if (doAtleta.some(outro => outro.categoryId !== categoryId)) {
        throw new AppError(409, 'OVERALL_MULTIPLE_CATEGORIES_PENDING_RULE', MENSAGEM_OVERALL_MULTIPLO);
      }

      // `upsert` não serve aqui: o Prisma não aceita valor nulo dentro de chave
      // única composta, e o recorte nulo é justamente o Overall do evento inteiro.
      const existente = await tx.eventOverallTitle.findFirst({ where: { eventId, categoryId } });

      // TROCAR CAMPEÃO HOMOLOGADO NÃO É EFEITO COLATERAL DE UM POST REPETIDO.
      //
      // Antes, declarar outro atleta no mesmo recorte simplesmente substituía o
      // anterior — em silêncio, sem registro do que havia antes. Um título
      // esportivo homologado não se troca assim: quem errou revoga, com motivo, e
      // declara de novo. As duas operações ficam na trilha.
      // O MESMO competidor, cadastrado ou não: comparar só `athleteId`
      // deixaria dois títulos externos diferentes passarem como iguais,
      // porque nos dois `athleteId` é nulo.
      const mesmoCompetidor = existente
        && existente.athleteId === competidor.athleteId
        && existente.externalAthleteId === competidor.externalAthleteId;

      if (existente && !mesmoCompetidor) {
        throw new AppError(
          409, 'OVERALL_ALREADY_DECLARED',
          'Esta categoria já possui um Overall homologado. Revogue a homologação atual antes de declarar outro campeão.'
        );
      }

      // Repetir a MESMA homologação é idempotente: o operador que clica duas
      // vezes, ou dois operadores que confirmam o mesmo fato, não produzem dois
      // títulos — nem dois bônus.
      return existente
        ? tx.eventOverallTitle.update({
          where: { id: existente.id },
          data: { note: note ?? existente.note, declaredById: actor?.id ?? null, declaredAt: new Date() }
        })
        : tx.eventOverallTitle.create({
          data: {
            eventId, categoryId, note,
            athleteId: competidor.athleteId,
            externalAthleteId: competidor.externalAthleteId,
            declaredById: actor?.id ?? null
          }
        });
    }, OPCOES_TRANSACAO);
  } catch (erro) {
    // O índice único continua sendo a última linha, para a corrida que a trava
    // não cobrir (outra instância, outro processo). Ele impede DEPOIS: a
    // segunda escrita levanta P2002, e traduzir isso aqui é o que transforma
    // uma corrida perdida em resposta com sentido. Sem esta tradução a segunda
    // requisição respondia 500 — medido na FASE 13.
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
    metadata: {
      athleteId: competidor.athleteId,
      externalAthleteId: competidor.externalAthleteId,
      categoryId, bonus: BONUS_OVERALL
    }
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
/**
 * Os candidatos ao Overall de um campeonato que veio de importação.
 *
 * Agrupados por CATEGORIA, porque é esse o recorte do título. Dentro de cada
 * uma, quem disputou a classe absoluta, ordenado pela colocação — a colocação
 * é FATO da súmula, e não opinião da plataforma sobre quem deve levar.
 */
async function candidatosDoLedger(event, eventId) {
  const linhas = await prisma.rankingPoint.findMany({
    where: { eventId, superOverallEligible: true, voidedAt: null },
    select: {
      placing: true, didNotShow: true, categoryId: true,
      athleteId: true, externalAthleteId: true,
      athlete: { select: { id: true, fullName: true, stageName: true } },
      externalAthlete: { select: { id: true, displayName: true, affiliationNumber: true } },
      category: { select: { id: true, code: true, name: true } },
      catalogClass: { select: { id: true, code: true, displayName: true } }
    },
    orderBy: [{ placing: 'asc' }]
  });

  const titulos = await prisma.eventOverallTitle.findMany({
    where: { eventId },
    select: {
      id: true, athleteId: true, externalAthleteId: true, categoryId: true, declaredAt: true,
      athlete: { select: { id: true, fullName: true } },
      externalAthlete: { select: { id: true, displayName: true } }
    }
  });

  const porCategoria = new Map();
  for (const linha of linhas) {
    const chave = linha.categoryId ?? '';
    if (!porCategoria.has(chave)) {
      porCategoria.set(chave, { category: linha.category, catalogClass: linha.catalogClass, candidates: [] });
    }
    porCategoria.get(chave).candidates.push({
      placing: linha.placing,
      didNotShow: linha.didNotShow,
      // O competidor, na forma que a tela consome: `athlete` quando há
      // cadastro, `externalAthlete` quando ainda não há. Nunca os dois.
      athlete: linha.athlete
        ? { id: linha.athlete.id, fullName: linha.athlete.fullName, stageName: linha.athlete.stageName }
        : null,
      externalAthlete: linha.externalAthlete
        ? { id: linha.externalAthlete.id, displayName: linha.externalAthlete.displayName }
        : null,
      affiliationNumber: linha.externalAthlete?.affiliationNumber ?? null
    });
  }

  return {
    event,
    fromLedger: true,
    items: [...porCategoria.values()]
      .filter(grupo => grupo.category)
      .sort((a, b) => a.category.code.localeCompare(b.category.code))
      .map(grupo => ({
        competitionClass: grupo.catalogClass
          ? { id: grupo.catalogClass.id, name: grupo.catalogClass.displayName, code: grupo.catalogClass.code }
          : null,
        division: null,
        category: grupo.category,
        declaredTitle: titulos.find(t => t.categoryId === grupo.category.id)
          || titulos.find(t => t.categoryId === null) || null,
        candidates: grupo.candidates
      }))
  };
}

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

  // ===========================================================================
  // CAMPEONATO IMPORTADO NÃO TEM GRADE — E MESMO ASSIM TEM CAMPEÃO.
  // ===========================================================================
  //
  // `CompetitionClass` existe por divisão de um evento MONTADO no MCI. O
  // histórico oficial entra pronto: não há grade, não há inscrição, não há
  // `ResultEntry`. Antes, esta função devolvia `items: []` e a tela de Overall
  // ficava vazia para exatamente os campeonatos que mais precisam dela.
  //
  // Os candidatos desses eventos vêm do LEDGER, que é onde o fato está: quem
  // competiu em classe ABSOLUTA daquele campeonato, com a colocação que a
  // súmula registrou. A regra não muda — só participação na absoluta é
  // candidata, e linha invalidada fica de fora.
  if (!absolutas.length) return candidatosDoLedger(event, eventId);

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
    where: { eventId },
    select: {
      id: true, athleteId: true, externalAthleteId: true, categoryId: true, declaredAt: true,
      athlete: { select: { id: true, fullName: true } },
      externalAthlete: { select: { id: true, displayName: true } }
    }
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
            // O caminho interno é sempre de atleta cadastrado. O campo existe
            // para que a tela consuma UMA forma só nos dois caminhos.
            externalAthlete: null,
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
    select: {
      id: true, eventId: true, athleteId: true, externalAthleteId: true,
      categoryId: true, declaredById: true, declaredAt: true
    }
  });
  if (!titulo || titulo.eventId !== eventId) {
    throw new AppError(404, 'OVERALL_NOT_FOUND', 'Homologação não encontrada neste campeonato');
  }

  await prisma.eventOverallTitle.delete({ where: { id: titleId } });

  await audit.record({
    actor, action: 'OVERALL_REVOKE', entity: 'Event', entityId: eventId,
    organizationId: event.organizationId,
    metadata: {
      titleId, athleteId: titulo.athleteId, externalAthleteId: titulo.externalAthleteId,
      categoryId: titulo.categoryId,
      declaredById: titulo.declaredById, declaredAt: titulo.declaredAt,
      reason
    }
  });

  // Repontuar: tirar o título é fato novo sobre resultados que já existiam,
  // exatamente como declará-lo. A colocação não é tocada — só o bônus sai. E,
  // como na declaração, o alcance é dos dois caminhos: apuração interna e
  // importação.
  await aplicarTitulosDoEvento(eventId, event.seasonId, actor);

  return {
    revoked: true, titleId,
    athleteId: titulo.athleteId, externalAthleteId: titulo.externalAthleteId,
    categoryId: titulo.categoryId
  };
}

async function listOverall(eventId) {
  return publico.eventOverallTitle.findMany({
    where: { eventId },
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true } },
      // O competidor sem cadastro tem nome, e é ele que a tela mostra.
      externalAthlete: { select: { id: true, displayName: true } },
      category: { select: { id: true, code: true, name: true } },
      declaredBy: { select: { id: true, name: true } }
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
  const pontos = await publico.publicRankingEntry.findMany({
    where: { seasonId, companyId: { not: null }, ...(categoryId ? { categoryId } : {}) },
    select: {
      companyId: true, teamId: true, competitorKey: true, points: true, placing: true,
      isOverallChampion: true, sourceKey: true
    }
  });

  const empresas = new Map(
    (await publico.company.findMany({
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
    // O COMPETIDOR, e não o atleta: quem ainda não se cadastrou também
    // compete pela equipe, e o resultado histórico dele conta para ela.
    linha.atletas.add(ponto.competitorKey);
    if (ponto.teamId) linha.equipes.add(ponto.teamId);
    linha.fontes.add(ponto.sourceKey);
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
async function athleteRankingBy(seasonId, { classId = null, catalogClassId = null, eventId = null, divisionId = null, categoryId = null, limit = null, offset = 0 } = {}, actor = null) {
  const where = { seasonId, ...(categoryId ? { categoryId } : {}) };

  if (eventId) where.eventId = eventId;
  if (classId) where.classId = classId;
  // O recorte por classe DO CATÁLOGO. `classId` recorta a classe de um
  // evento do MCI e é nulo em todo resultado histórico importado; este
  // recorta a classe da organização, que existe nos dois caminhos.
  if (catalogClassId) where.catalogClassId = catalogClassId;

  if (divisionId) {
    const classes = await publico.competitionClass.findMany({ where: { divisionId }, select: { id: true } });
    // Divisão sem classe nenhuma não é "todas as classes": é conjunto vazio.
    where.classId = { in: classes.length ? classes.map(classe => classe.id) : ['__sem-classe__'] };
  }

  // A PROJEÇÃO PÚBLICA, e não o ledger: `RankingPoint` tem RLS de operador e
  // esta rota é anônima. Mesmos campos de pontuação, mesmas linhas, só as
  // colunas públicas. `sourceKey` substitui o `externalResultId` que era usado
  // para contar participações distintas.
  const pontos = await publico.publicRankingEntry.findMany({
    where,
    select: {
      competitorKey: true, athleteId: true, externalAthleteId: true, displayName: true,
      categoryId: true, points: true, superOverallPoints: true, placing: true,
      isOverallChampion: true, eventId: true, classId: true, catalogClassId: true, sourceKey: true
    }
  });

  // O nome de quem JÁ tem cadastro continua vindo do cadastro; `Athlete` tem
  // política própria e o anônimo já a atravessa.
  const idsDeAtleta = [...new Set(pontos.map(ponto => ponto.athleteId).filter(Boolean))];
  const atletas = new Map(
    (idsDeAtleta.length
      ? await publico.athlete.findMany({
        where: { id: { in: idsDeAtleta } },
        select: { id: true, fullName: true, stageName: true, state: true, team: { select: { id: true, name: true } } }
      })
      : []).map(atleta => [atleta.id, atleta])
  );

  const acumulado = new Map();
  for (const ponto of pontos) {
    // Agrupar por COMPETIDOR: resultado histórico sem cadastro não tem
    // `athleteId`, e agrupar por nulo juntaria todos num balde só.
    ponto.athleteId = ponto.athleteId ?? null;
    ponto.athlete = ponto.athleteId
      ? (atletas.get(ponto.athleteId) ?? null)
      : competidorExterno(ponto);
    if (!acumulado.has(ponto.competitorKey)) {
      acumulado.set(ponto.competitorKey, {
        competitorKey: ponto.competitorKey,
        athleteId: ponto.athleteId, athlete: ponto.athlete,
        totalPoints: 0, fontes: new Set(), pontos: []
      });
    }
    // PELA MESMA CHAVE COM QUE FOI GRAVADO.
    //
    // Isto lia `acumulado.get(ponto.athleteId)`. Para quem tem cadastro dava
    // certo por coincidência — `competitorKey` É o `athleteId` nesse caso.
    // Para o competidor SEM cadastro, que é todo o histórico importado, a
    // chave é `X:<identidade externa>` e `get(null)` devolvia `undefined`:
    // a linha seguinte estourava, e o recorte respondia 500 em cima
    // justamente das linhas que ele existe para mostrar.
    const linha = acumulado.get(ponto.competitorKey);
    // Recorte do CAMPEONATO: soma `points`, como o ranking principal. Trocar
    // por `superOverallPoints` aqui apagaria Estreante, Novice e Master.
    linha.totalPoints += ponto.points;
    linha.fontes.add(ponto.sourceKey);
    linha.pontos.push(ponto);
  }

  const linhas = [...acumulado.values()].map(linha => ({ ...linha, ...contadores(linha.pontos) }));

  // A categoria do RECORTE, resolvida uma vez. O recorte agrega o competidor
  // inteiro, então a linha não tem categoria própria — ela tem a do filtro.
  // Sem isto a tabela escreveria "Geral" numa lista que é, por definição, de
  // uma categoria só.
  const categoriaDoRecorte = categoryId
    ? await publico.category.findUnique({ where: { id: categoryId }, select: { id: true, code: true, name: true } })
    : null;

  return projetar(recortarParaOPublico(paginar(classificar(linhas), { limit, offset }), await vistaPublicaDaTemporada(seasonId, actor)), linha => ({
    // Chave estável da linha para a tela: o COMPETIDOR. A linha agregada não
    // existe como registro em lugar nenhum, e portanto não tem id de tabela.
    id: linha.competitorKey ?? linha.athleteId,
    position: linha.position,
    tieUnresolved: linha.tieUnresolved,
    athlete: linha.athlete,
    category: categoriaDoRecorte,
    state: linha.athlete?.state ?? null,
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

  const idsDeAtleta = agregadas.map(linha => linha.athleteId).filter(Boolean);
  const atletas = new Map(
    (idsDeAtleta.length
      ? await publico.athlete.findMany({
        where: { id: { in: idsDeAtleta } },
        select: { id: true, fullName: true, stageName: true, state: true, team: { select: { id: true, name: true } } }
      })
      : []).map(atleta => [atleta.id, atleta])
  );

  const linhas = agregadas.map(linha => ({
    athleteId: linha.athleteId,
    // Com cadastro, quem manda é o cadastro. Sem cadastro, o nome CONFORME A
    // FONTE — que é o que existe enquanto o atleta não se inscreveu no MCI.
    athlete: linha.athleteId
      ? (atletas.get(linha.athleteId) ?? null)
      : competidorExterno(linha),
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

  // LÊ A PROJEÇÃO PÚBLICA, e não o ledger.
  //
  // `RankingPoint` passou a ter RLS de operador — esta rota é anônima e não
  // enxergaria linha nenhuma. `PublicRankingEntry` tem os MESMOS campos de
  // pontuação, uma linha por lançamento, e só as colunas públicas. A soma é a
  // mesma; o que muda é de onde ela sai.
  //
  // `sourceKey` já é o `COALESCE(eventId, externalResultId, 'externo')` que
  // esta consulta contava — materializado, porque `externalResultId` é coluna
  // do ledger e não sai de lá.
  //
  // O agrupamento é por COMPETIDOR: um resultado histórico ainda sem cadastro
  // não tem `athleteId`, e agrupar por coluna nula juntaria todos eles numa
  // linha só.
  const consultar = async quantas => publico.$queryRaw`
    SELECT
      "competitorKey",
      MIN("athleteId")                                                 AS "athleteId",
      MIN("externalAthleteId")                                         AS "externalAthleteId",
      MIN("displayName")                                               AS "displayName",
      SUM("superOverallPoints")::int                                   AS "totalPoints",
      COUNT(DISTINCT "sourceKey")::int                                 AS "eventCount",
      SUM(CASE WHEN "isOverallChampion" THEN 1 ELSE 0 END)::int        AS "overallWins",
      SUM(CASE WHEN "placing" = 1 THEN 1 ELSE 0 END)::int              AS "firstPlaceCount",
      SUM(CASE WHEN "placing" = 2 THEN 1 ELSE 0 END)::int              AS "secondPlaceCount",
      SUM(CASE WHEN "placing" = 3 THEN 1 ELSE 0 END)::int              AS "thirdPlaceCount",
      SUM(CASE WHEN "placing" = 4 THEN 1 ELSE 0 END)::int              AS "fourthPlaceCount",
      SUM(CASE WHEN "placing" = 5 THEN 1 ELSE 0 END)::int              AS "fifthPlaceCount"
    FROM "PublicRankingEntry"
    WHERE ${where}
    GROUP BY "competitorKey"
    -- A ordem aqui e de PRE-SELECAO, nao de classificacao: ela serve para que
    -- o topo caiba no limite. Quem atribui posicao e declara empate continua
    -- sendo classificar(), no motor.
    ORDER BY "totalPoints" DESC, "overallWins" DESC, "firstPlaceCount" DESC,
             "secondPlaceCount" DESC, "thirdPlaceCount" DESC, "competitorKey" ASC
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

async function listClasses(organizationId, { categoryId = null } = {}, actor) {
  assertCan(actor, 'ranking.read', organizationId);
  return prisma.classCatalog.findMany({
    where: { organizationId, ...(categoryId ? { categoryId } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }]
  });
}

/**
 * As classes que servem de FILTRO para o ranking, por categoria.
 *
 * Lida pela projeção pública porque a tela do ranking é anônima. A política
 * `catalogo_leitura` já libera a leitura do catálogo; o recorte por
 * organização é feito aqui, e não pela política, porque o que se quer não é
 * esconder a lista dos outros — é não misturar as classes de duas
 * organizações no mesmo `<select>`.
 *
 * A CLASSE GENÉRICA ENTRA EM TODA CATEGORIA. ESTREANTE, NOVICE, OPEN e
 * MASTER são divisões e valem em qualquer uma; deixá-las de fora faria o
 * filtro de Women's Physique não ter "Open", que é a classe com mais
 * resultado de todas.
 *
 * `displayName` é o que a tela mostra. `code` viaja junto porque é a
 * identidade — mas não é o que se lê na tela.
 */
async function listClassesParaFiltro({ organizationId = null, categoryId = null, seasonId = null } = {}) {
  // A organização pode vir da temporada, que é o recorte que a tela do
  // ranking já tem na mão.
  const orgId = organizationId
    ?? (seasonId
      ? (await publico.rankingSeason.findUnique({ where: { id: seasonId }, select: { organizationId: true } }))?.organizationId
      : null)
    ?? (await temporadaPadrao(null))?.organizationId
    ?? null;

  if (!orgId) return { items: [] };

  const items = await publico.classCatalog.findMany({
    where: {
      organizationId: orgId,
      active: true,
      ...(categoryId ? { OR: [{ categoryId }, { categoryId: null }] } : {})
    },
    select: { id: true, code: true, name: true, displayName: true, categoryId: true, sortOrder: true },
    orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }]
  });

  return { items: items.map(classe => ({ ...classe, displayName: classe.displayName ?? classe.name })) };
}

/**
 * Uma classe de Women's Physique não filtra Figure.
 *
 * A conferência é do DADO, não de permissão: `categoryId` e `catalogClassId`
 * chegam os dois pela query, onde qualquer um escreve o que quiser, e a
 * interseção incoerente devolveria uma lista vazia que a tela leria como
 * "ninguém pontuou" — um erro silencioso, que é o pior tipo.
 *
 * A classe GENÉRICA (categoria nula) é coerente com qualquer categoria: é
 * exatamente o que "vale para todas" significa.
 *
 * Também confere a ORGANIZAÇÃO: classe de outra organização não recorta o
 * ranking desta, nem por engano nem por id adivinhado.
 */
async function conferirCoerenciaDaClasse(catalogClassId, { categoryId = null, organizationId = null } = {}) {
  const classe = await publico.classCatalog.findUnique({
    where: { id: catalogClassId },
    select: { id: true, categoryId: true, organizationId: true }
  });

  if (!classe) throw new AppError(404, 'CLASS_NOT_FOUND', 'Classe não encontrada');

  if (organizationId && classe.organizationId !== organizationId) {
    throw new AppError(404, 'CLASS_NOT_FOUND', 'Classe não encontrada');
  }

  if (categoryId && classe.categoryId && classe.categoryId !== categoryId) {
    throw new AppError(
      422, 'CLASS_CATEGORY_MISMATCH',
      'A classe informada pertence a outra categoria: o recorte pedido não existe'
    );
  }

  return classe;
}

async function upsertClass(organizationId, data, actor) {
  assertCan(actor, 'ranking.manage', organizationId);

  // Uma classe genérica e uma classe de categoria com o MESMO código são
  // duas linhas diferentes e legítimas. O que o operador está editando é a
  // que tem exatamente esta categoria — inclusive quando ela é nula.
  const categoryId = data.categoryId ?? null;
  const existente = await prisma.classCatalog.findFirst({
    where: { organizationId, categoryId, code: data.code }
  });

  const classe = existente
    ? await prisma.classCatalog.update({
      where: { id: existente.id },
      data: {
        name: data.name ?? existente.name,
        displayName: data.displayName ?? data.name ?? existente.displayName,
        superOverallEligible: data.superOverallEligible ?? existente.superOverallEligible,
        active: data.active ?? existente.active,
        sortOrder: data.sortOrder ?? existente.sortOrder
      }
    })
    : await prisma.classCatalog.create({
      data: {
        organizationId, categoryId, code: data.code, name: data.name ?? data.code,
        displayName: data.displayName ?? data.name ?? data.code,
        superOverallEligible: data.superOverallEligible ?? false,
        active: data.active ?? true,
        sortOrder: data.sortOrder ?? 0
      }
    });

  await audit.record({
    actor, action: 'CLASS_CATALOG_SET', entity: 'ClassCatalog', entityId: classe.id,
    organizationId, metadata: { code: classe.code, categoryId: classe.categoryId, superOverallEligible: classe.superOverallEligible, active: classe.active }
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

  // RECORTE POR CLASSE: OUTRO MOTOR, DE PROPÓSITO.
  //
  // `Ranking` é o agregado por (competidor, categoria) — ele não tem classe
  // nenhuma, e não teria como ter: a mesma linha soma Open e Masters do mesmo
  // atleta. Filtrar por classe exige voltar ao lançamento, que é o que
  // `athleteRankingBy` já faz, pela projeção pública e com a MESMA regra de
  // soma e o MESMO desempate. Um motor só, duas portas de entrada.
  if (filtros.catalogClassId) {
    await conferirCoerenciaDaClasse(filtros.catalogClassId, {
      categoryId: filtros.categoryId ?? null,
      organizationId: temporada?.organizationId ?? null
    });

    const items = await athleteRankingBy(where.seasonId, {
      catalogClassId: filtros.catalogClassId,
      categoryId: filtros.categoryId ?? null,
      limit: vistaPublica ? TOP_PUBLICO : (filtros.limit ?? null)
    }, actor);

    return {
      items,
      season: temporada ? { id: temporada.id, name: temporada.name, year: temporada.year } : null,
      // O recorte não pagina por cursor: ele agrega em memória, e um cursor
      // ancorado em id de linha agregada não existe.
      nextCursor: null,
      publicView: vistaPublica,
      publicLimit: TOP_PUBLICO
    };
  }

  const brutos = await publico.ranking.findMany({
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

  // O COMPETIDOR AINDA SEM CADASTRO tem linha no ranking e não tem `athlete`.
  // A relação obrigatória virou opcional no banco; aqui ela vira o retrato que
  // a tela sabe desenhar, com o nome CONFORME A FONTE e `id` nulo — nada pode
  // montar link para um perfil que não existe.
  const items = brutos.map(linha => (linha.athlete
    ? linha
    : { ...linha, athlete: competidorExterno(linha) }));

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


// ==========================================================================
// CORREÇÃO ADMINISTRATIVA DE LANÇAMENTO PUBLICADO.
//
// O caminho interno já tinha a sua: `results.override` grava um
// `ResultVersion` com snapshot e motivo, e a apuração é refeita do zero. O
// caminho IMPORTADO não tinha nenhuma — depois do `/apply`, um 3º que era 2º
// ficava errado para sempre, e a única "saída" seria escrever no ledger por
// fora, que é exatamente o que as regras da plataforma proíbem.
//
// Três decisões que moldam tudo o que vem abaixo:
//
//   1. OS PONTOS VÊM DO MOTOR, NUNCA DO CORPO DA REQUISIÇÃO. O operador
//      informa a COLOCAÇÃO; quem transforma colocação em ponto é a tabela
//      homologada da temporada. Aceitar um número digitado reabriria a porta
//      que a importação fechou ao recusar a coluna de pontos do arquivo.
//
//   2. INVALIDAR NÃO APAGA. Zera o que PONTUA e preserva o que ACONTECEU: a
//      linha continua no histórico do atleta, com quem invalidou, quando e por
//      quê. Apagá-la faria a participação desaparecer — e num campeonato
//      nacional "não pontuou" e "não competiu" são fatos diferentes.
//
//   3. MOTIVO É OBRIGATÓRIO. Seis meses depois, correção sem motivo é
//      indistinguível de adulteração.
// ==========================================================================

/** Campos que a correção pode tocar. O resto do lançamento é história. */
const CAMPOS_CORRIGIVEIS = Object.freeze(['placing', 'didNotShow']);

/**
 * Lançamentos de um campeonato, para a tela de correção.
 *
 * A "origem dos pontos" já respondia por ATLETA — serve para explicar um
 * acumulado. Corrigir é o movimento contrário: o operador tem a súmula do
 * campeonato na mão e precisa achar a linha errada entre as do evento.
 *
 * Exige `ranking.manage`, e não `ranking.read`: a resposta carrega motivo de
 * invalidação e quem invalidou, que é informação de administração, e a tela
 * que a consome é a que oferece as ações.
 */
async function eventRankingPoints(eventId, actor) {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, name: true, slug: true, startDate: true, organizationId: true, seasonId: true,
      season: { select: { id: true, name: true, year: true } }
    }
  });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'Campeonato não encontrado');

  assertCan(actor, 'ranking.manage', event.organizationId);

  const items = await prisma.rankingPoint.findMany({
    where: { eventId },
    select: {
      id: true, placing: true, placingOriginal: true, didNotShow: true,
      placementPoints: true, overallBonus: true, adjustmentPoints: true, points: true,
      superOverallPoints: true, superOverallEligible: true, isOverallChampion: true,
      source: true, externalResultId: true, seasonId: true,
      voidedAt: true, voidedById: true, voidReason: true,
      athlete: { select: { id: true, fullName: true, affiliationNumber: true } },
      // O COMPETIDOR SEM CADASTRO tem nome, e é o único nome que ele tem. Sem
      // isto a tela do operador mostrava linha em branco justamente para o
      // histórico importado — que é a maior parte das linhas que ele veio
      // conferir.
      externalAthlete: { select: { id: true, displayName: true } },
      category: { select: { id: true, code: true, name: true } },
      competitionClass: { select: { id: true, code: true, name: true } },
      // A classe do CATÁLOGO: é ela que existe no histórico importado, onde
      // `competitionClass` é sempre nula por não haver evento do MCI.
      catalogClass: { select: { id: true, code: true, name: true, displayName: true } },
      affiliation: { select: { id: true, code: true, name: true } }
    },
    // Ordem DECLARADA. Sem `orderBy` a resposta sai na ordem física do
    // PostgreSQL, e a tela reordenaria sozinha a cada correção — o operador
    // perderia de vista a linha em que estava trabalhando.
    orderBy: [{ categoryId: 'asc' }, { placing: 'asc' }, { id: 'asc' }]
  });

  return { event, items };
}

const CAMPOS_DO_LANCAMENTO = Object.freeze({
  id: true, seasonId: true, athleteId: true, eventId: true, source: true,
  externalResultId: true, placing: true, placingOriginal: true,
  placementPoints: true, overallBonus: true, adjustmentPoints: true, points: true,
  superOverallPoints: true, superOverallEligible: true,
  isOverallChampion: true, didNotShow: true,
  // O recorte viaja junto porque o modal de ajuste o EXIBE — o operador
  // precisa ver de qual categoria e de qual classe é a participação que ele
  // está prestes a alterar. São lidos, nunca escritos por este caminho.
  organizationId: true, categoryId: true, catalogClassId: true,
  voidedAt: true, voidedById: true, voidReason: true
});

// TUDO O QUE ESCREVE NO LANÇAMENTO PASSA POR AQUI.
//
// O desenho anterior era ler, decidir e escrever com três idas ao banco
// soltas, e a medição com 20 requisições simultâneas mostrou as duas falhas
// que isso abre — nenhuma das duas hipotética:
//
//   · 20 invalidações do mesmo lançamento: NOVE atravessaram a conferência de
//     `voidedAt` antes de qualquer uma gravar. O motivo que ficava registrado
//     era o da última a escrever, e a auditoria passava a dizer "engano do
//     operador" onde o administrador tinha escrito "atleta desclassificado".
//
//   · corrigir contra invalidar: a correção conferia `voidedAt`, a
//     invalidação commitava na janela, e a correção gravava pontos por cima —
//     o lançamento voltava a valer 3 com `voidedAt` preenchido. Invalidado e
//     pontuando ao mesmo tempo.
//
// Dentro da trava o estado é RELIDO do banco, e é o estado relido que decide.
// O que veio de `carregarLancamento` serve à autorização e à auditoria; nunca
// à decisão. O recálculo acontece antes de soltar a trava, porque ele lê a
// temporada inteira e soltá-la no meio devolveria a corrida pelo outro lado.
async function comTemporadaTravada(ponto, executar) {
  return prisma.$transaction(async tx => {
    await travarTemporada(tx, ponto.seasonId);

    const atual = await tx.rankingPoint.findUnique({
      where: { id: ponto.id }, select: CAMPOS_DO_LANCAMENTO
    });
    if (!atual) throw new AppError(404, 'RANKING_POINT_NOT_FOUND', 'Lançamento não encontrado');

    const saida = await executar(tx, { ...ponto, ...atual });
    await recomputarEm(tx, ponto.seasonId);
    return saida;
  }, OPCOES_TRANSACAO);
}

async function carregarLancamento(rankingPointId, actor) {
  // SEM `include` DE RELAÇÃO OBRIGATÓRIA. Medido com um operador de outra
  // organização: o RLS deixava ver a linha do RankingPoint e BLOQUEAVA o
  // Athlete relacionado — e o Prisma, ao receber nulo numa relação que o
  // schema declara obrigatória, levanta "Inconsistent query result" e a
  // requisição virava 500.
  //
  // Um 500 numa sonda cross-tenant é duas coisas ruins de uma vez: diz ao
  // invasor que ele encostou em ALGO, e polui o log de erro com o que é, na
  // verdade, a política de segurança funcionando. Carregar só escalares e
  // buscar o resto em consultas próprias devolve o 404 discreto que a negação
  // merece.
  const ponto = await prisma.rankingPoint.findUnique({
    where: { id: rankingPointId }, select: CAMPOS_DO_LANCAMENTO
  });
  if (!ponto) throw new AppError(404, 'RANKING_POINT_NOT_FOUND', 'Lançamento não encontrado');

  const temporada = await prisma.rankingSeason.findUnique({
    where: { id: ponto.seasonId }, select: { id: true, organizationId: true }
  });
  // Temporada invisível é o RLS negando a organização do lançamento. A resposta
  // é a mesma de "não existe": quem não pode ver não recebe confirmação.
  if (!temporada) throw new AppError(404, 'RANKING_POINT_NOT_FOUND', 'Lançamento não encontrado');

  assertCan(actor, 'ranking.manage', temporada.organizationId);

  // O atleta só é lido DEPOIS da autorização, e o nulo é tolerado: ele serve à
  // prévia, não à decisão.
  //
  // E O LANÇAMENTO PODE NÃO TER ATLETA NENHUM. Resultado histórico importado
  // antes do cadastro é o caso normal — são as 191 linhas do Ipiranga, todas
  // com `athleteId` nulo. `findUnique({ where: { id: null } })` não é uma
  // consulta que devolve nada: o Prisma a RECUSA, e a recusa subia como 500.
  // Na prática, corrigir ou invalidar um lançamento histórico era impossível.
  const athlete = ponto.athleteId
    ? await prisma.athlete.findUnique({
      where: { id: ponto.athleteId }, select: { id: true, fullName: true }
    })
    : null;

  return { ...ponto, season: temporada, athlete: athlete ?? { id: ponto.athleteId, fullName: null } };
}

/**
 * Calcula como o lançamento ficaria, sem gravar nada.
 * É a mesma função que a correção usa para decidir o novo estado — prévia e
 * gravação não podem discordar, e a única forma de garantir isso é não
 * existirem duas contas.
 */
async function projetarLancamento(ponto, mudanca, cliente = prisma) {
  const didNotShow = mudanca.didNotShow ?? (mudanca.placing != null ? false : ponto.didNotShow);
  const placing = didNotShow ? null : (mudanca.placing ?? ponto.placing);

  const tabela = await cliente.rankingPointsRule.findMany({
    where: { seasonId: ponto.seasonId }, select: { placing: true, points: true }
  });

  // O AJUSTE ADMINISTRATIVO ATRAVESSA A CORREÇÃO DE COLOCAÇÃO.
  //
  // Corrigir a colocação recalcula o que o MOTOR produz. O ajuste não saiu do
  // motor: saiu de uma decisão de homologação, com motivo registrado. Zerá-lo
  // aqui desfaria essa decisão de lado, sem ninguém pedir e sem aparecer em
  // lugar nenhum.
  //
  // Na ausência declarada ele também some, e some com razão: NS vale zero pela
  // regra homologada, e zero não comporta parcela.
  const ajuste = ponto.adjustmentPoints ?? 0;

  // Ausência vale zero por regra homologada, e o motor nem é consultado.
  if (didNotShow || placing == null) {
    return {
      placing: null, didNotShow: true,
      placementPoints: 0, overallBonus: 0, adjustmentPoints: 0,
      points: 0, superOverallPoints: 0,
      isOverallChampion: false
    };
  }

  // `superOverallPoints` do motor é descartado de propósito: com o ajuste na
  // conta, quem vale para o anual é o TOTAL ajustado, calculado logo abaixo
  // pela mesma regra — igual a `points` onde a classe é elegível, zero nas
  // demais. Duas contas para a mesma métrica é como elas passam a discordar.
  const { placementPoints, overallBonus, points } = pontuarResultado(
    placing, tabela, ponto.isOverallChampion, ponto.superOverallEligible
  );

  // O total nunca fica negativo: um ajuste para baixo maior que a nova
  // pontuação do motor pararia em zero, e não em dívida de pontos.
  const total = Math.max(0, points + ajuste);
  return {
    placing, didNotShow: false,
    placementPoints, overallBonus, adjustmentPoints: ajuste,
    points: total,
    superOverallPoints: ponto.superOverallEligible ? total : 0,
    isOverallChampion: ponto.isOverallChampion
  };
}

const retrato = ponto => ({
  placing: ponto.placing, didNotShow: ponto.didNotShow,
  placementPoints: ponto.placementPoints, overallBonus: ponto.overallBonus,
  adjustmentPoints: ponto.adjustmentPoints ?? 0,
  points: ponto.points, voided: Boolean(ponto.voidedAt)
});

/** Prévia do impacto: o antes, o depois e a diferença. Não grava. */
async function previewRankingPoint(rankingPointId, mudanca, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);
  const novo = await projetarLancamento(ponto, mudanca);
  return {
    atual: retrato(ponto),
    novo: { ...novo, voided: Boolean(ponto.voidedAt) },
    diferenca: novo.points - ponto.points,
    athlete: { id: ponto.athlete.id, fullName: ponto.athlete.fullName }
  };
}

async function editRankingPoint(rankingPointId, dados, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);
  if (ponto.voidedAt) {
    throw new AppError(409, 'RANKING_POINT_VOIDED',
      'Lançamento invalidado não se corrige: restaure antes de alterar');
  }

  // ATRIBUIÇÃO EM MASSA MORRE AQUI. Só o que está em CAMPOS_CORRIGIVEIS
  // atravessa; `eventId`, `athleteId`, `source`, `externalResultId` e `points`
  // enviados no corpo são simplesmente ignorados, e o teste de invasão confere
  // que continuam intactos depois da tentativa.
  const mudanca = Object.fromEntries(
    CAMPOS_CORRIGIVEIS.filter(campo => dados[campo] !== undefined).map(campo => [campo, dados[campo]])
  );
  if (!Object.keys(mudanca).length) {
    throw new AppError(422, 'NOTHING_TO_EDIT', 'Informe a colocação ou o não comparecimento');
  }

  let antes;
  const atualizado = await comTemporadaTravada(ponto, async (tx, atual) => {
    // Relido sob a trava: entre a conferência lá em cima e esta linha, uma
    // invalidação pode ter commitado. Escrever assim mesmo devolveria pontos
    // a um lançamento já invalidado.
    if (atual.voidedAt) {
      throw new AppError(409, 'RANKING_POINT_VOIDED',
        'Lançamento invalidado não se corrige: restaure antes de alterar');
    }

    antes = retrato(atual);
    const novo = await projetarLancamento(atual, mudanca, tx);

    return tx.rankingPoint.update({
      where: { id: rankingPointId },
      data: {
        placing: novo.placing, didNotShow: novo.didNotShow,
        placementPoints: novo.placementPoints, overallBonus: novo.overallBonus,
        adjustmentPoints: novo.adjustmentPoints,
        points: novo.points, superOverallPoints: novo.superOverallPoints,
        // A colocação de origem só é gravada na PRIMEIRA alteração: depois
        // disso ela já registra de onde o lançamento partiu, e reescrevê-la
        // apagaria justamente a informação que permite restaurar.
        placingOriginal: atual.placingOriginal ?? atual.placing
      }
    });
  });

  await audit.record({
    actor, action: audit.ACTIONS.RANKING_POINT_EDITED,
    entity: 'RankingPoint', entityId: rankingPointId,
    organizationId: ponto.season.organizationId,
    metadata: {
      reason: dados.reason, athleteId: ponto.athleteId, eventId: ponto.eventId,
      source: ponto.source, externalResultId: ponto.externalResultId,
      antes, depois: retrato(atualizado)
    }
  });

  return { ...retrato(atualizado), id: rankingPointId, diferenca: atualizado.points - antes.points };
}

/**
 * AJUSTE ADMINISTRATIVO DA PONTUAÇÃO — o ponto muda, o resto não.
 *
 * O QUE ESTA OPERAÇÃO NÃO FAZ, e é a metade mais importante da descrição:
 * não mexe em colocação, categoria, classe, evento, temporada, atleta nem
 * `ExternalResult`. Não declara, não revoga e não inventa Overall — o bônus
 * é da regra homologada e continua onde estava. O que ela altera é UM número.
 *
 * COMO O NÚMERO MUDA SEM QUEBRAR A AUDITORIA
 *
 * O total continua sendo a soma das parcelas. A diferença entre o valor
 * pedido e o que o motor produz vira `adjustmentPoints`, e é ela que carrega
 * a intervenção humana:
 *
 *   points = placementPoints + overallBonus + adjustmentPoints
 *
 * Assim o ledger continua dizendo quanto veio da colocação, quanto veio do
 * Overall e quanto veio de decisão de homologação — em vez de um total
 * sobrescrito que não se explica.
 *
 * CONCORRÊNCIA: `expectedPoints` é obrigatório. Ele é o valor que o operador
 * TINHA NA TELA quando decidiu. Se o lançamento mudou desde então — outro
 * operador ajustou, ou uma correção de colocação recalculou —, a gravação é
 * recusada e a tela pede atualização. É a mesma guarda que protege do duplo
 * clique: o segundo envio chega com um `expectedPoints` que já não vale.
 */
async function adjustRankingPoint(rankingPointId, { points, reason, expectedPoints }, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);

  if (ponto.voidedAt) {
    throw new AppError(409, 'RANKING_POINT_VOIDED',
      'Lançamento invalidado não se ajusta: restaure antes de alterar');
  }

  // Ausência vale ZERO pela regra homologada. Ajustar um NS para cima seria a
  // plataforma dizendo que alguém que não subiu no palco pontuou.
  if (ponto.didNotShow && points > 0) {
    throw new AppError(422, 'ADJUST_ON_DID_NOT_SHOW',
      'Não comparecimento vale zero pela regra homologada: corrija a colocação, não a pontuação');
  }

  let antes;
  let registro;

  const atualizado = await comTemporadaTravada(ponto, async (tx, atual) => {
    if (atual.voidedAt) {
      throw new AppError(409, 'RANKING_POINT_VOIDED',
        'Lançamento invalidado não se ajusta: restaure antes de alterar');
    }

    // A CONFERÊNCIA SOB A TRAVA, e não antes dela. Conferir fora da trava
    // deixaria passar exatamente a corrida que este parâmetro existe para
    // pegar: dois operadores lendo 5, os dois enviando, os dois passando.
    if (atual.points !== expectedPoints) {
      throw new AppError(409, 'RANKING_POINT_STALE',
        'Os pontos foram alterados por outro operador. Atualize antes de editar novamente.');
    }

    antes = retrato(atual);

    // A parcela é a DIFERENÇA para o que o motor produz, e não o valor
    // pedido: assim uma correção de colocação posterior recalcula as duas
    // primeiras parcelas e este ajuste continua valendo o mesmo tanto.
    const doMotor = atual.placementPoints + atual.overallBonus;

    const gravado = await tx.rankingPoint.update({
      where: { id: rankingPointId },
      data: {
        adjustmentPoints: points - doMotor,
        points,
        // A métrica anual segue a mesma regra de sempre: igual ao total onde
        // a classe é elegível, zero nas demais. O ajuste não muda a
        // elegibilidade — ela é atributo da classe.
        superOverallPoints: atual.superOverallEligible ? points : 0
      }
    });

    registro = await tx.rankingPointAdjustment.create({
      data: {
        organizationId: ponto.season.organizationId,
        rankingPointId,
        previousPoints: antes.points,
        newPoints: points,
        reason,
        createdById: actor?.id ?? null
      }
    });

    return gravado;
  });

  await audit.record({
    actor, action: audit.ACTIONS.RANKING_POINTS_ADJUSTED,
    entity: 'RankingPoint', entityId: rankingPointId,
    organizationId: ponto.season.organizationId,
    // SEM CPF, sem token, sem senha — e sem nome de pessoa. O log é lido por
    // mais gente e guardado por mais tempo do que o dado que o originou; os
    // identificadores bastam para reconstituir o caso.
    metadata: {
      adjustmentId: registro.id,
      rankingPointId,
      athleteId: ponto.athleteId ?? null,
      externalResultId: ponto.externalResultId ?? null,
      eventId: ponto.eventId ?? null,
      seasonId: ponto.seasonId,
      categoryId: ponto.categoryId ?? null,
      catalogClassId: ponto.catalogClassId ?? null,
      previousPoints: antes.points,
      newPoints: atualizado.points,
      adjustment: atualizado.points - antes.points,
      reason,
      antes, depois: retrato(atualizado)
    }
  });

  return {
    ...retrato(atualizado),
    id: rankingPointId,
    adjustmentId: registro.id,
    diferenca: atualizado.points - antes.points
  };
}

/** O histórico de ajustes de um lançamento, do mais recente para o mais antigo. */
async function listAdjustments(rankingPointId, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);

  const items = await prisma.rankingPointAdjustment.findMany({
    where: { rankingPointId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, previousPoints: true, newPoints: true, reason: true,
      createdAt: true, voidedAt: true, voidReason: true,
      createdBy: { select: { id: true, name: true } }
    }
  });

  return { rankingPoint: retrato(ponto), items };
}

async function voidRankingPoint(rankingPointId, { reason }, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);
  if (ponto.voidedAt) {
    throw new AppError(409, 'RANKING_POINT_ALREADY_VOIDED', 'Lançamento já invalidado');
  }

  let antes;
  const atualizado = await comTemporadaTravada(ponto, async (tx, atual) => {
    // A conferência que VALE é esta, sob a trava. A de cima só evita abrir
    // transação à toa; sozinha, ela deixava nove de vinte invalidações
    // simultâneas passarem, cada uma gravando o seu motivo por cima da
    // anterior.
    if (atual.voidedAt) {
      throw new AppError(409, 'RANKING_POINT_ALREADY_VOIDED', 'Lançamento já invalidado');
    }

    antes = retrato(atual);
    return tx.rankingPoint.update({
      where: { id: rankingPointId },
      data: {
        voidedAt: new Date(), voidedById: actor?.id ?? null, voidReason: reason,
        // Zera o que PONTUA. `placementPoints` guarda o que aconteceu, e
        // `placingOriginal` de onde partiu — as duas peças de que a restauração
        // precisa para não recalcular às cegas.
        overallBonus: 0, points: 0, superOverallPoints: 0, isOverallChampion: false,
        placingOriginal: atual.placingOriginal ?? atual.placing
      }
    });
  });

  await audit.record({
    actor, action: audit.ACTIONS.RANKING_POINT_VOIDED,
    entity: 'RankingPoint', entityId: rankingPointId,
    organizationId: ponto.season.organizationId,
    metadata: {
      reason, athleteId: ponto.athleteId, eventId: ponto.eventId,
      source: ponto.source, externalResultId: ponto.externalResultId,
      antes, depois: retrato(atualizado)
    }
  });

  return { ...retrato(atualizado), id: rankingPointId };
}

/**
 * Invalida DE UMA VEZ todos os lançamentos de uma lista, sob uma única trava
 * de temporada, com um recálculo só no fim.
 *
 * POR QUE NÃO CHAMAR `voidRankingPoint` EM LAÇO
 * ---------------------------------------------------------------------------
 * Ele abre a própria transação e recalcula a temporada a cada chamada. Num
 * lote de 191 linhas isso seriam 191 transações e 191 recálculos, com a
 * temporada destravada entre uma e outra — ou seja, uma janela por lançamento
 * em que outra operação entra no meio e vê o ranking pela metade.
 *
 * Aqui é a MESMA mecânica do caminho avulso — `travarTemporada`, os mesmos
 * campos zerados, `placingOriginal` preservado, `recomputarEm` no fim —, só
 * que aplicada ao conjunto inteiro dentro de uma transação. A auditoria
 * continua sendo uma linha RANKING_POINT_VOIDED POR LANÇAMENTO: quem audita
 * uma linha do ranking procura por ali, e não saberia procurar por um registro
 * de lote.
 *
 * Lançamentos já invalidados são PULADOS, não recusados: num lote, a metade
 * que ainda vale precisa ser invalidada mesmo que a outra metade já tenha sido
 * invalidada avulsa antes.
 */
async function voidRankingPoints(rankingPointIds, { reason }, actor, organizationId) {
  if (!rankingPointIds.length) return { voided: 0, pontos: [] };

  const alvos = await prisma.rankingPoint.findMany({
    where: { id: { in: rankingPointIds } }, select: CAMPOS_DO_LANCAMENTO
  });
  if (!alvos.length) return { voided: 0, pontos: [] };

  // Um lote vive numa temporada só; travar a de cada lançamento seria travar a
  // mesma várias vezes. O conjunto existe porque um lote antigo pode ter
  // lançamentos migrados, e nesse caso cada temporada é travada uma vez.
  const temporadas = [...new Set(alvos.map(ponto => ponto.seasonId))];

  const registrados = [];

  await prisma.$transaction(async tx => {
    for (const seasonId of temporadas) await travarTemporada(tx, seasonId);

    // RE-LEITURA SOB A TRAVA. A lista de cima foi montada fora dela, e entre
    // uma coisa e outra alguém pode ter invalidado a linha por outro caminho.
    const atuais = await tx.rankingPoint.findMany({
      where: { id: { in: alvos.map(ponto => ponto.id) } }, select: CAMPOS_DO_LANCAMENTO
    });

    for (const atual of atuais) {
      if (atual.voidedAt) continue;

      const atualizado = await tx.rankingPoint.update({
        where: { id: atual.id },
        data: {
          voidedAt: new Date(), voidedById: actor?.id ?? null, voidReason: reason,
          overallBonus: 0, points: 0, superOverallPoints: 0, isOverallChampion: false,
          placingOriginal: atual.placingOriginal ?? atual.placing
        }
      });
      registrados.push({ antes: retrato(atual), depois: retrato(atualizado), ponto: atual });
    }

    for (const seasonId of temporadas) await recomputarEm(tx, seasonId);
  }, OPCOES_TRANSACAO);

  // A auditoria fica FORA da transação, como no caminho avulso: ela não pode
  // ser desfeita por um rollback do ledger, e gravá-la dentro faria uma
  // transação longa ficar ainda mais longa.
  for (const { antes, depois, ponto } of registrados) {
    await audit.record({
      actor, action: audit.ACTIONS.RANKING_POINT_VOIDED,
      entity: 'RankingPoint', entityId: ponto.id,
      organizationId,
      metadata: {
        reason, athleteId: ponto.athleteId, eventId: ponto.eventId,
        source: ponto.source, externalResultId: ponto.externalResultId,
        antes, depois
      }
    });
  }

  return { voided: registrados.length, pontos: registrados.map(r => r.ponto.id) };
}

async function restoreRankingPoint(rankingPointId, { reason }, actor) {
  const ponto = await carregarLancamento(rankingPointId, actor);
  if (!ponto.voidedAt) {
    throw new AppError(409, 'RANKING_POINT_NOT_VOIDED', 'Lançamento não está invalidado');
  }

  let antes;
  const atualizado = await comTemporadaTravada(ponto, async (tx, atual) => {
    if (!atual.voidedAt) {
      throw new AppError(409, 'RANKING_POINT_NOT_VOIDED', 'Lançamento não está invalidado');
    }

    antes = retrato(atual);
    // Restaurar recalcula a partir da COLOCAÇÃO, e não de um total salvo: se a
    // tabela da temporada mudou entre a invalidação e a restauração, o que
    // volta é a regra vigente aplicada ao fato, não um número congelado.
    //
    // E a colocação que vale é a QUE ESTÁ NA LINHA, não `placingOriginal`.
    // Invalidar zera o que pontua e não toca em `placing`, então a linha já
    // guarda o estado de antes da invalidação — que é exatamente o que
    // restaurar promete devolver.
    //
    // Recalcular a partir de `placingOriginal` era um defeito medido: um
    // lançamento importado como 1º, corrigido para 3º e depois para 2º,
    // invalidado e restaurado voltava como 1º valendo 5. As duas correções do
    // operador eram descartadas em silêncio, e o ranking voltava a publicar a
    // colocação que a súmula já tinha desmentido. `placingOriginal` diz DE
    // ONDE o lançamento partiu — é proveniência para a auditoria, nunca o
    // destino da restauração.
    const novo = await projetarLancamento(
      atual, { placing: atual.placing, didNotShow: atual.didNotShow }, tx
    );

    return tx.rankingPoint.update({
      where: { id: rankingPointId },
      data: {
        voidedAt: null, voidedById: null, voidReason: null,
        placing: novo.placing, didNotShow: novo.didNotShow,
        placementPoints: novo.placementPoints, overallBonus: novo.overallBonus,
        points: novo.points, superOverallPoints: novo.superOverallPoints
      }
    });
  });

  await audit.record({
    actor, action: audit.ACTIONS.RANKING_POINT_RESTORED,
    entity: 'RankingPoint', entityId: rankingPointId,
    organizationId: ponto.season.organizationId,
    metadata: {
      reason, athleteId: ponto.athleteId, eventId: ponto.eventId,
      source: ponto.source, externalResultId: ponto.externalResultId,
      antes, depois: retrato(atualizado)
    }
  });

  return { ...retrato(atualizado), id: rankingPointId };
}

module.exports = {
  TOP_PUBLICO,
  createSeason, listSeasons, setPointsRules, pointsForPlacing, awardForResult,
  recompute, recompute_, list, athletePoints, teamRanking,
  declareOverall, listOverall, overallCandidates, overallPreview, revokeOverall,
  eventRankingPoints,
  previewRankingPoint, editRankingPoint, adjustRankingPoint, listAdjustments, voidRankingPoint, voidRankingPoints, restoreRankingPoint,
  superOverallRanking, listClasses, listClassesParaFiltro, conferirCoerenciaDaClasse, upsertClass, companyRanking,
  athleteRankingBy,
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL,
  // Exportada para medição: a pré-seleção tem um contrato próprio — trazer o
  // topo E o bloco de empate inteiro que encosta no corte — e esse contrato
  // não é observável pela resposta pública, que mostra só as cinco primeiras
  // linhas. Medi-lo pela porta da frente é impossível; medi-lo aqui é a única
  // forma de travar a promessa que o comentário da função faz.
  agregarSuperOverall
};
