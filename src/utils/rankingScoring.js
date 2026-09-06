// ============================================================================
// Motor oficial de pontuação e desempate do ranking.
//
// Função pura: recebe linhas, devolve linhas ordenadas. Não conhece banco,
// requisição nem ator — o que a torna conferível pelo comitê técnico lendo os
// testes, sem subir nada.
//
// ------------------------------------ REGRA HOMOLOGADA (fase 11.1) ---------
//
// Pontuação por colocação:   1º=5  2º=4  3º=3  4º=2  5º=1
// Campeão Overall:           +10, SOMADOS aos pontos da colocação
// Equipes:                   a MESMA tabela, sem peso, multiplicador ou bônus
//                            próprio
//
// Desempate, nesta ordem exata:
//   1. mais títulos Overall
//   2. mais primeiros lugares
//   3. mais segundos lugares
//   4. mais terceiros lugares
//   5. mais quartos lugares
//   6. mais quintos lugares
//   7. TIE_UNRESOLVED
//
// Esgotada a hierarquia, o empate NÃO é quebrado. Nada de id, nome, data,
// ordem de inserção ou alfabética: os empatados ficam sem colocação e a
// decisão volta para quem tem competência de tomá-la. É a mesma postura do
// motor de apuração (src/utils/tabulation.js).
//
// ------------------------------------ PENDING HOMOLOGATION -----------------
//
// Não implementado por ausência de regra, e não presumido:
//   * COMO se determina o campeão Overall (entre quais classes, se por
//     categoria ou por evento, se apurado ou decidido). Aqui o título é um
//     fato registrado pela organização.
//   * quais resultados de atleta são "elegíveis" para a equipe. Sem regra de
//     descarte ou de teto, todos os resultados pontuados contam.
//   * pontuação para colocações a partir do 6º lugar.
// ============================================================================

// A tabela é DADO, não constante do motor: fica em RankingPointsRule, por
// temporada. Estes valores são o ponto de partida homologado, aplicados a uma
// temporada nova e substituíveis quando a tabela oficial em PDF/planilha
// chegar — sem alterar uma linha de código.
const TABELA_OFICIAL_COLOCACAO = Object.freeze([
  { placing: 1, points: 5 },
  { placing: 2, points: 4 },
  { placing: 3, points: 3 },
  { placing: 4, points: 2 },
  { placing: 5, points: 1 }
]);

// REGRA HOMOLOGADA: o bônus SOMA, não substitui.
const BONUS_OVERALL = 10;

// Ordem em que os critérios são consultados. A ordem é a regra: trocá-la muda
// o campeão, então ela fica declarada num lugar só.
const CRITERIOS_DESEMPATE = Object.freeze([
  'overallWins',
  'firstPlaceCount',
  'secondPlaceCount',
  'thirdPlaceCount',
  'fourthPlaceCount',
  'fifthPlaceCount'
]);

/**
 * Pontos de um resultado.
 *
 * @param {number|null} placing            Colocação obtida.
 * @param {Array}  tabela                  [{ placing, points }] da temporada.
 * @param {boolean} isOverallChampion      Se o atleta levou o Overall.
 */
function pontuarResultado(placing, tabela, isOverallChampion = false) {
  const regra = (tabela || []).find(item => item.placing === placing);
  const placementPoints = regra?.points ?? 0;
  const overallBonus = isOverallChampion ? BONUS_OVERALL : 0;

  return { placementPoints, overallBonus, points: placementPoints + overallBonus };
}

// Contadores de desempate a partir das linhas de ponto de um competidor.
function contadores(pontos) {
  const contagem = {
    overallWins: 0,
    firstPlaceCount: 0, secondPlaceCount: 0, thirdPlaceCount: 0,
    fourthPlaceCount: 0, fifthPlaceCount: 0
  };
  const porColocacao = [null, 'firstPlaceCount', 'secondPlaceCount', 'thirdPlaceCount', 'fourthPlaceCount', 'fifthPlaceCount'];

  for (const ponto of pontos) {
    if (ponto.isOverallChampion) contagem.overallWins += 1;
    const campo = porColocacao[ponto.placing];
    if (campo) contagem[campo] += 1;
  }
  return contagem;
}

// Compara dois competidores. Devolve <0 se `a` vem antes, 0 se a hierarquia
// oficial não os separou.
function compararOficial(a, b) {
  if (a.totalPoints !== b.totalPoints) return b.totalPoints - a.totalPoints;

  for (const criterio of CRITERIOS_DESEMPATE) {
    const diferenca = (b[criterio] ?? 0) - (a[criterio] ?? 0);
    if (diferenca !== 0) return diferenca;
  }
  return 0;
}

/**
 * Ordena e numera. Quem a hierarquia não separou sai sem posição, marcado
 * como empate não resolvido.
 *
 * @returns {Array} as mesmas linhas, com `position` (número ou null) e
 *                  `tieUnresolved` (boolean).
 */
function classificar(linhas) {
  const ordenadas = [...linhas].sort(compararOficial);

  // Agrupa quem a hierarquia deixou equivalente.
  const blocos = [];
  for (const linha of ordenadas) {
    const ultimo = blocos[blocos.length - 1];
    if (ultimo && compararOficial(ultimo[0], linha) === 0) ultimo.push(linha);
    else blocos.push([linha]);
  }

  const saida = [];
  let posicao = 1;

  for (const bloco of blocos) {
    if (bloco.length === 1) {
      saida.push({ ...bloco[0], position: posicao, tieUnresolved: false });
      posicao += 1;
      continue;
    }

    // Empate que a regra oficial não resolve: ninguém recebe a colocação.
    for (const linha of bloco) {
      saida.push({ ...linha, position: null, tieUnresolved: true });
    }
    posicao += bloco.length;
  }

  return saida;
}

module.exports = {
  TABELA_OFICIAL_COLOCACAO,
  BONUS_OVERALL,
  CRITERIOS_DESEMPATE,
  pontuarResultado,
  contadores,
  compararOficial,
  classificar
};
