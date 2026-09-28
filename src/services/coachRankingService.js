const prisma = require('../config/prisma');
const { AppError } = require('../utils/errors');
const { can } = require('../utils/permissions');
const ranking = require('./rankingService');

// ============================================================================
// RANKING DE TREINADORES — A FÓRMULA NÃO ESTÁ HOMOLOGADA, E ESTE ARQUIVO NÃO A
// INVENTA.
//
// O escopo aprovado é explícito: a fórmula do ranking de treinadores, seus
// pesos, multiplicadores, bônus, recortes e critérios de desempate NÃO foram
// homologados pela MuscleContest. Enquanto não forem, é proibido escolhê-los —
// e escolher inclui o caminho discreto, que é somar os pontos das equipes e
// chamar o resultado de classificação.
//
// O QUE ESTE SERVIÇO ENTREGA, ENTÃO:
//
//   1. A ELEGIBILIDADE, que é regra APROVADA (R-01): quais equipes respondem
//      pelo treinador e, dentro de cada uma, quais lançamentos pertencem ao
//      vínculo que existia na data oficial do evento. Isso não é fórmula: é a
//      pergunta "o que conta", que a decisão R-01 já respondeu.
//
//   2. A PROJEÇÃO, feita SÓ de números que já são oficiais: o total de cada
//      equipe vem do ranking de equipes homologado (`rankingService.teamRanking`),
//      sem recálculo aqui. Nenhum número novo é produzido.
//
//   3. A AUSÊNCIA, dita em voz alta: não há total do treinador, não há posição,
//      não há empate resolvido. `homologado: false` e a frase "Ranking em
//      homologação" viajam na resposta, e a interface as mostra.
//
// O QUE ESTE SERVIÇO NÃO FAZ, E POR QUÊ ISSO ESTÁ ESCRITO AQUI: não soma os
// totais das equipes num total do treinador. Somar PARECE neutro e não é —
// pressupõe que a contribuição de cada equipe entra com peso 1, que todas as
// categorias entram, que equipe com um atleta vale o mesmo que equipe com
// trinta, e que o treinador de duas equipes concorre com o de uma somando as
// duas. São quatro decisões esportivas, e nenhuma delas foi tomada pela
// MuscleContest.
//
// COMO ISTO SAI DO BLOQUEIO, quando a fórmula for homologada: a função
// `classificacao` abaixo é o único ponto que precisa nascer, e ela recusa
// explicitamente enquanto `FORMULA_HOMOLOGADA` for falso. A elegibilidade e a
// projeção já estarão prontas e testadas.
// ============================================================================

// ============================================================================
// A FOTO É REQUISITO DE ENTRADA NO RANKING OFICIAL — decisão da foto obrigatória.
//
// O QUE ISSO PODE SER, DADO O BLOQUEIO DE §8.3: a fórmula do ranking de
// treinadores NÃO está homologada, então não existe classificação a filtrar. O
// requisito entra onde ele PODE existir sem inventar nada:
//
//   * na ELEGIBILIDADE — `apto` passa a ser falso e `impedimentos` diz por quê. É
//     a resposta à pergunta "este treinador entra no ranking oficial?", que é
//     exatamente a pergunta que a decisão responde;
//   * na PROJEÇÃO — o mesmo impedimento viaja, para a tela não exibir base de
//     ranking de quem não entra nele;
//   * e em `classificacao`, quando ela nascer: o filtro já está escrito aqui, num
//     lugar só, em vez de espalhado por quem for montar a lista.
//
// O QUE ISSO NÃO FAZ, e é o limite que a decisão impõe: não apaga ponto, não
// apaga resultado, não desfaz vínculo e não muda fórmula nenhuma. Os lançamentos
// das equipes continuam onde estão, contados e somados como sempre — o que falta
// é a ENTRADA do treinador no ranking dele, e ela volta no instante em que a foto
// chegar.
// ============================================================================
const FOTO_EXIGIDA_NO_RANKING = 'Envie uma foto de perfil para aparecer no ranking oficial de treinadores. '
  + 'Sua pontuação, seus resultados e seus vínculos continuam preservados.';

const impedimentosDoRanking = coach => {
  const achados = [];
  if (coach.status !== 'APPROVED') {
    achados.push({ codigo: 'COACH_NOT_APPROVED', mensagem: 'Cadastro de treinador não está aprovado.' });
  }
  if (!coach.photoKey) {
    achados.push({ codigo: 'COACH_PHOTO_REQUIRED', mensagem: FOTO_EXIGIDA_NO_RANKING });
  }
  return achados;
};

const FORMULA_HOMOLOGADA = false;
const AVISO = 'Ranking em homologação. A fórmula de pontuação de treinadores ainda não foi homologada pela MuscleContest.';

// ============================================================================
// QUEM PODE CONSULTAR A BASE DE UM TREINADOR.
//
// O DEFEITO CORRIGIDO AQUI, medido antes da correção: as duas rotas
// (`/coaches/:id/ranking/eligibility` e `/.../projection`) exigiam apenas
// sessão. `elegibilidade` conferia `if (!actor) 401` e `projecao` não conferia
// nada — então QUALQUER conta autenticada, inclusive um atleta recém-cadastrado,
// lia o `status` do cadastro de qualquer treinador e a lista nominal das equipes
// dele. E os ids não são secretos: `GET /coaches` é o catálogo público do
// módulo, o que torna a varredura trivial.
//
// O ALCANCE CORRETO são três atores, e nenhum a mais:
//
//   1. O DONO DO CADASTRO. A conferência é pelo `userId` DO CADASTRO, não por
//      um id que veio da URL — a URL é do atacante, o `userId` é do banco.
//   2. A MESA CENTRAL (`coaches.approve`), que analisa o cadastro (R-03).
//
// E SÓ. A primeira versão desta guarda admitia também `ranking.manage`, pensando
// na homologação — e estava larga, por uma razão que não é óbvia: numa pergunta
// SEM organização, `effectivePermissions` soma as permissões de TODAS as
// filiações do ator (é o `if (organizationId && ...) continue`, que não corta
// nada quando o escopo é nulo). Então `can(actor, 'ranking.manage')` respondia sim
// para o gestor de ranking de QUALQUER federação, e ele passaria a ler o `status`
// da análise cadastral de treinador de outra federação — vazamento cross-tenant
// de dado de R-03, criado pela própria guarda que fecha A-01.
//
// A homologação não perde nada: quem conduz a análise cadastral tem
// `coaches.approve`, e a conferência de R-01, que é sobre PONTO e não sobre
// cadastro, continua em `divergencias`, com `ranking.manage`.
//
// A RECUSA É 404, E NÃO 403, e isso é deliberado: um 403 responderia "este
// treinador existe, mas não é seu" — que é precisamente o oráculo que a
// enumeração por `GET /coaches` precisa. Treinador inexistente e treinador de
// outra pessoa produzem a MESMA resposta, byte a byte.
//
// Não há cláusula de federação aqui. Seria tentador liberar o operador da
// federação em que o treinador atua, mas nenhuma tela pede isso, e permissão que
// nenhuma tela usa é superfície sem dono.
// ============================================================================
async function assertPodeConsultar(coachId, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (can(actor, 'coaches.approve')) return;

  const proprio = await prisma.coach.findFirst({
    where: { id: coachId, userId: actor.id },
    select: { id: true }
  });
  if (proprio) return;

  throw new AppError(404, 'COACH_NOT_FOUND', 'Treinador não encontrado');
}

/**
 * A base elegível do treinador numa temporada.
 *
 * Devolve as equipes dele e, por equipe, os lançamentos atribuídos a ela — que
 * são os lançamentos cujo `RankingPoint.teamId` é aquela equipe. A atribuição
 * congelada já É a regra R-01: `teamId` guarda a equipe da ÉPOCA (ver o
 * comentário da coluna no schema e a resolução em `rankingService` e em
 * `muscleWarService`), então não há recálculo temporal a fazer aqui — há a
 * conferência de que o congelado e o vínculo da época coincidem, que é o que a
 * função `divergencias` faz.
 */
async function elegibilidade({ coachId, seasonId }, actor) {
  await assertPodeConsultar(coachId, actor);
  if (!seasonId) throw new AppError(422, 'SEASON_REQUIRED', 'Informe a temporada');

  const coach = await prisma.coach.findUnique({
    where: { id: coachId },
    select: {
      id: true, name: true, status: true, photoKey: true,
      teams: { select: { id: true, name: true, organizationId: true } }
    }
  });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Treinador não encontrado');

  const impedimentos = impedimentosDoRanking(coach);
  // `hasPhoto`, e não a chave: a tela decide o aviso com o booleano, e caminho de
  // armazenamento não vai para o navegador.
  const identidade = { id: coach.id, name: coach.name, status: coach.status, hasPhoto: Boolean(coach.photoKey) };

  const idsDasEquipes = coach.teams.map(equipe => equipe.id);
  if (!idsDasEquipes.length) {
    return {
      coach: identidade, seasonId, teams: [],
      apto: false,
      impedimentos: [...impedimentos, { codigo: 'COACH_NO_TEAM', mensagem: 'Nenhuma equipe sob sua responsabilidade.' }],
      homologado: FORMULA_HOMOLOGADA, aviso: AVISO
    };
  }

  // Agrupado pelo banco: a pergunta é de contagem, e trazer lançamento por
  // lançamento para contar em JavaScript é o padrão que já custou 750 ms na
  // projeção do ranking de equipes (ver `rankingService`).
  const porEquipe = await prisma.rankingPoint.groupBy({
    by: ['teamId'],
    where: { seasonId, teamId: { in: idsDasEquipes }, voidedAt: null },
    _count: { _all: true }
  });
  const contagem = new Map(porEquipe.map(linha => [linha.teamId, linha._count._all]));

  return {
    coach: identidade,
    seasonId,
    teams: coach.teams.map(equipe => ({
      ...equipe,
      // A CONTAGEM de lançamentos elegíveis — um fato, não uma pontuação. Ela
      // continua sendo devolvida mesmo com impedimento: o ponto existe e não foi
      // apagado; o que está barrado é a ENTRADA no ranking.
      lancamentosElegiveis: contagem.get(equipe.id) ?? 0
    })),
    apto: impedimentos.length === 0,
    impedimentos,
    homologado: FORMULA_HOMOLOGADA,
    aviso: AVISO
  };
}

/**
 * A projeção pública do treinador: as equipes dele com os totais que o ranking
 * de EQUIPES já publica, e nada além.
 *
 * `totalPoints` de cada equipe é lido do ranking homologado, não recalculado
 * aqui. Não há `totalDoTreinador`, não há `position`: é o que o bloqueio de §8.3
 * proíbe, e a ausência é o comportamento correto, não uma pendência de
 * implementação.
 */
async function projecao({ coachId, seasonId, categoryId = null, organizationId = null }, actor = null) {
  await assertPodeConsultar(coachId, actor);

  const coach = await prisma.coach.findUnique({
    where: { id: coachId },
    select: {
      id: true, name: true, status: true, photoKey: true,
      teams: { select: { id: true, name: true } }
    }
  });
  if (!coach) throw new AppError(404, 'COACH_NOT_FOUND', 'Treinador não encontrado');
  if (!seasonId) throw new AppError(422, 'SEASON_REQUIRED', 'Informe a temporada');

  // A assinatura de `teamRanking` é posicional (`seasonId`, opções, ator): a
  // chamada segue exatamente a dela para que a projeção do treinador nunca
  // receba um recorte diferente do que o ranking público mostra.
  const equipes = await ranking.teamRanking(seasonId, { categoryId, organizationId }, actor);
  const linhas = Array.isArray(equipes) ? equipes : equipes?.items ?? [];
  const meus = new Set(coach.teams.map(equipe => equipe.id));

  return {
    coach: { id: coach.id, name: coach.name, status: coach.status, hasPhoto: Boolean(coach.photoKey) },
    seasonId,
    // Cada linha é a linha oficial da equipe, copiada. Nenhum número é criado.
    teams: linhas.filter(linha => meus.has(linha.teamId)),
    // O MESMO IMPEDIMENTO DA ELEGIBILIDADE viaja aqui, para a tela não exibir
    // base de ranking de quem não entra nele. As linhas das equipes continuam
    // vindo: o ponto existe, e não é ele que está barrado.
    apto: impedimentosDoRanking(coach).length === 0,
    impedimentos: impedimentosDoRanking(coach),
    // As duas ausências, nomeadas — para que a tela não tenha de adivinhar por
    // que não há total nem posição, e para que um cliente futuro que procure
    // esses campos encontre a razão em vez de um `undefined`.
    totalDoTreinador: null,
    posicao: null,
    homologado: FORMULA_HOMOLOGADA,
    aviso: AVISO
  };
}

/**
 * CONFERÊNCIA DE R-01: o `teamId` congelado no lançamento confere com o vínculo
 * que existia na data oficial do evento?
 *
 * Diagnóstico, e só. Não corrige nada — corrigir atribuição de ponto é ato
 * administrativo de R-02, com autorização formal, e não efeito colateral de uma
 * consulta. A lista serve para a homologação enxergar divergência antes de
 * decidir o que fazer com ela.
 */
async function divergencias({ seasonId, teamId = null, limit = 200 }, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  const { assertPermission } = require('../utils/tenant');
  assertPermission(actor, 'ranking.manage');
  if (!seasonId) throw new AppError(422, 'SEASON_REQUIRED', 'Informe a temporada');

  const lancamentos = await prisma.rankingPoint.findMany({
    where: { seasonId, voidedAt: null, athleteId: { not: null }, ...(teamId ? { teamId } : {}) },
    select: {
      id: true, athleteId: true, teamId: true, eventId: true, awardedAt: true,
      event: { select: { id: true, name: true, startDate: true } },
      externalResult: { select: { eventDate: true } }
    },
    orderBy: { awardedAt: 'desc' },
    take: Math.min(Number(limit) || 200, 1000)
  });

  const memberships = require('./membershipService');
  const achados = [];

  for (const lancamento of lancamentos) {
    // A data oficial, na ordem em que o domínio a conhece: o evento do MCI
    // primeiro, o resultado externo depois. Sem data não há pergunta temporal a
    // fazer, e a linha é simplesmente ignorada — não acusada.
    const data = lancamento.event?.startDate ?? lancamento.externalResult?.eventDate ?? null;
    if (!data) continue;

    const daEpoca = await memberships.vinculoNaData(lancamento.athleteId, data);
    const esperado = daEpoca?.teamId ?? null;
    if (esperado === lancamento.teamId) continue;

    achados.push({
      rankingPointId: lancamento.id,
      athleteId: lancamento.athleteId,
      eventId: lancamento.eventId,
      dataOficial: data,
      teamIdRegistrado: lancamento.teamId,
      teamIdDoVinculoNaData: esperado
    });
  }

  return { seasonId, analisados: lancamentos.length, divergencias: achados };
}

/**
 * A classificação. Não existe, e a recusa é o comportamento correto.
 *
 * Está aqui, e não ausente, porque uma função que recusa com motivo é mais
 * honesta do que uma rota 404: quem chamar descobre que o bloqueio é de
 * homologação, não de implementação.
 */
async function classificacao() {
  if (!FORMULA_HOMOLOGADA) {
    throw new AppError(409, 'COACH_RANKING_NOT_HOMOLOGATED',
      'A fórmula do ranking de treinadores não foi homologada pela MuscleContest. '
      + 'Não há classificação oficial de treinadores a exibir.');
  }
  /* c8 ignore next */
  throw new AppError(501, 'NOT_IMPLEMENTED', 'Classificação de treinadores não implementada');
}

module.exports = {
  FORMULA_HOMOLOGADA, AVISO,
  FOTO_EXIGIDA_NO_RANKING, impedimentosDoRanking,
  assertPodeConsultar, elegibilidade, projecao, divergencias, classificacao
};
