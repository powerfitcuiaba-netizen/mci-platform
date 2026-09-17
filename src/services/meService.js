const prisma = require('../config/prisma');

// ============================================================================
// A SUPERFÍCIE DO PRÓPRIO ATLETA.
//
// "Minha Filiação" e "Meu Histórico" respondem sobre QUEM PEDE. O atleta é
// derivado do token — `Athlete.userId = actor.id` —, e não de um id no
// caminho, na query ou no corpo.
//
// Essa escolha não é estilística. Uma rota `/athletes/:id/history` precisa
// defender-se de IDOR a cada requisição, e a defesa é código que pode ser
// esquecido numa refatoração. Uma rota sem id não tem o que defender: não
// existe parâmetro capaz de apontar para outra pessoa. Os testes provam isso
// pelo negativo, mandando `athleteId`, `organizationId` e `affiliationId` na
// query e conferindo que a resposta continua sendo a do dono do token.
//
// Por que não reaproveitar `rankingService.athletePoints`: ela exige
// `ranking.read` COM VÍNCULO na organização, e atleta não é membro da
// federação — `OrganizationMember` é para operadores. Aquela rota responde
// 403/404 justamente para o dono dos próprios pontos, e afrouxá-la abriria a
// leitura do histórico de terceiros para todo mundo que tem conta. As duas
// superfícies coexistem: a do operador, com id e autorização; a do atleta, sem
// id e sem autorização a checar.
// ============================================================================

// Projeção do atleta: só o que estas telas mostram. Nada de CPF, telefone,
// e-mail ou endereço — o histórico não precisa deles, e o que não é carregado
// não vaza.
const ATLETA_MINIMO = Object.freeze({ id: true, fullName: true, stageName: true });

async function atletaDoAtor(actor) {
  if (!actor?.id) return null;
  return prisma.athlete.findUnique({
    where: { userId: actor.id },
    select: {
      ...ATLETA_MINIMO,
      organizationId: true,
      affiliationNumber: true,
      organization: { select: { id: true, name: true, slug: true } },
      affiliation: { select: { id: true, name: true, code: true, state: true, active: true } }
    }
  });
}

/**
 * Minha Filiação.
 *
 * Conta sem perfil de atleta é resposta legítima, não erro: quem ainda não foi
 * aprovado pela federação tem conta e não tem filiação. Devolver 404 faria a
 * tela tratar "ainda não" como falha.
 */
async function affiliation(actor) {
  const athlete = await atletaDoAtor(actor);
  if (!athlete) {
    return { athlete: null, affiliation: null, affiliationNumber: null, organization: null };
  }

  return {
    athlete: { id: athlete.id, fullName: athlete.fullName, stageName: athlete.stageName },
    organization: athlete.organization,
    affiliation: athlete.affiliation,
    // A matrícula do atleta DENTRO da entidade. Filiação são as duas coisas:
    // a entidade sozinha não diz por qual registro os resultados oficiais o
    // reconhecem.
    affiliationNumber: athlete.affiliationNumber ?? null
  };
}

/**
 * Meu Histórico.
 *
 * Toda participação pontuada do atleta, sem o teto da vista pública: o TOP 5 é
 * regra da vitrine, e a carreira de alguém não é vitrine.
 *
 * `totals` é agregado no BANCO, sobre o conjunto inteiro — não somado sobre a
 * página. Somar a página devolveria um total que muda conforme o tamanho do
 * recorte, que é o defeito que a paginação da FASE 2.4 existiu para corrigir
 * em outro lugar.
 */
async function history(actor, filtros = {}) {
  const athlete = await atletaDoAtor(actor);
  if (!athlete) {
    return {
      athlete: null, items: [], total: 0, nextCursor: null,
      totals: { participations: 0, placementPoints: 0, overallBonus: 0, points: 0 }
    };
  }

  const limite = filtros.limit ?? 20;
  const where = { athleteId: athlete.id, ...(filtros.seasonId ? { seasonId: filtros.seasonId } : {}) };

  // Uma consulta para a página, uma para o total e uma para as somas. Nada de
  // N+1: as relações vêm por `select` na mesma ida, e o atleta foi buscado uma
  // única vez acima.
  const [items, total, somas] = await Promise.all([
    prisma.rankingPoint.findMany({
      where,
      select: {
        id: true, placing: true,
        placementPoints: true, overallBonus: true, points: true,
        superOverallPoints: true, superOverallEligible: true, isOverallChampion: true,
        source: true, awardedAt: true,
        // A filiação DA ÉPOCA, gravada no ponto. Nula em lançamentos anteriores
        // à coluna: nulo significa "snapshot histórico indisponível", e não a
        // filiação de hoje. Preencher com a atual reescreveria o passado.
        affiliationNumber: true,
        affiliation: { select: { id: true, name: true, code: true, state: true } },
        event: { select: { id: true, name: true, slug: true, startDate: true } },
        season: { select: { id: true, name: true, year: true } },
        category: { select: { id: true, code: true, name: true } },
        competitionClass: { select: { id: true, name: true, code: true } },
        externalResult: { select: { id: true, source: true, eventName: true, eventDate: true } }
      },
      // Ordem declarada e estável: sem o `id` como último critério, dois pontos
      // do mesmo instante ficariam na ordem física da tabela e a paginação por
      // cursor poderia repetir ou pular um deles entre duas páginas.
      orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
      take: limite,
      ...(filtros.cursor ? { cursor: { id: filtros.cursor }, skip: 1 } : {})
    }),
    prisma.rankingPoint.count({ where }),
    prisma.rankingPoint.aggregate({
      where, _sum: { placementPoints: true, overallBonus: true, points: true }
    })
  ]);

  return {
    athlete: { id: athlete.id, fullName: athlete.fullName, stageName: athlete.stageName },
    items,
    total,
    totals: {
      participations: total,
      placementPoints: somas._sum.placementPoints ?? 0,
      overallBonus: somas._sum.overallBonus ?? 0,
      points: somas._sum.points ?? 0
    },
    nextCursor: items.length === limite ? items[items.length - 1].id : null
  };
}

module.exports = { affiliation, history };
