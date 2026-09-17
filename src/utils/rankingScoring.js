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
// Campeão Overall:           +10, SOMADOS aos pontos da colocação, e SOMENTE
//                            na classe ABSOLUTA (a marcada como elegível)
// Equipes:                   a MESMA tabela, sem peso, multiplicador ou bônus
//                            próprio
//
// Desempate, nesta ordem exata:
//   1. mais títulos Overall
//   2. mais primeiros lugares
//   3. mais segundos lugares
//   4. mais terceiros lugares
//   5. TIE_UNRESOLVED
//
// A cadeia PARA no terceiro lugar, e isso é DEFINITIVO (fase 11.4). A fase 11.1
// ia até o quinto; a 11.2 encurtou por decisão do organizador. Os contadores de
// 4º e 5º continuam mantidos — servem à auditoria, e aquelas colocações
// pontuam —, mas NÃO participam do desempate. Pontuação e desempate são
// conceitos diferentes: 4º vale 2 pontos e não desempata; 5º vale 1 e não
// desempata.
//
// Super Overall anual:
//   Todas as classes pontuam no campeonato. Só as marcadas como elegíveis —
//   pela REGRA HOMOLOGADA, a OPEN — alimentam o ranking classificatório do
//   Super Overall. A marca é atributo da classe, e não o código "OPEN" escrito
//   aqui: é o que permite criar e desativar classes sem tocar neste arquivo.
//
// ------------------------------ O BÔNUS DE OVERALL EXIGE A ABSOLUTA --------
//
// REGRA VIGENTE, homologada pelo responsável e substituindo a leitura da fase
// 11.4: o +10 é do campeão da OPEN/ABSOLUTA, e de mais ninguém.
//
// A fase 11.4 dizia que o bônus somava no campeonato em QUALQUER classe, e que
// só o Super Overall anual era restrito. Essa leitura está REVOGADA. Nunca
// Novice, Masters, Junior, Teenage, True Novice, Special ou qualquer outra
// divisão recebe o +10, mesmo que o título esteja declarado para o atleta.
//
// A MESMA marca de elegibilidade identifica a absoluta: é ela que já define
// qual classe alimenta o Super Overall, e é a classe absoluta que dá o título.
// Continuar lendo a marca — em vez de comparar o texto "OPEN" — mantém a
// promessa de que o operador governa a lista de classes sem tocar em programa.
//
// O que a restrição NÃO faz: tirar pontos de colocação de ninguém. Novice,
// Master e as demais continuam valendo 5/4/3/2/1 no campeonato, exatamente
// como antes. O que muda é só quem pode receber o bônus.
//
// Esgotada a hierarquia, o empate NÃO é quebrado. Nada de id, nome, CPF, data,
// timestamp, ordem de inserção, alfabética ou sorteio: os empatados ficam sem
// colocação e a decisão volta para quem tem competência de tomá-la. É a mesma
// postura do motor de apuração (src/utils/tabulation.js).
//
// Colocações a partir do 6º valem ZERO. É regra homologada, não lacuna: a
// tabela oficial termina no 5º, e zero é o valor definido — não um valor
// extrapolado da progressão nem uma pendência.
//
// Equipes e empresas: a MESMA tabela, o MESMO bônus e o MESMO desempate. Não
// há fórmula, peso ou multiplicador próprio, e a elegibilidade ao Super
// Overall também é a mesma — só a OPEN.
//
// ------------------------------------ PENDING HOMOLOGATION -----------------
//
// O que segue sem regra, e por isso não é presumido:
//   * COMO se determina o campeão Overall (entre quais classes, se por
//     categoria ou por evento, se apurado ou decidido). Não é lacuna de
//     implementação: por decisão do organizador o título é FATO DECLARADO, e o
//     sistema não deve tentar descobri-lo sozinho.
//   * quais resultados de atleta são "elegíveis" para a equipe. Sem regra de
//     descarte ou de teto, todos os resultados pontuados contam.
// ============================================================================

// A tabela é DADO, não constante do motor: fica em RankingPointsRule, por
// temporada. Estes são os valores HOMOLOGADOS, aplicados a toda temporada
// nova, e continuam substituíveis por configuração — sem alterar uma linha de
// código — caso o organizador reveja a tabela numa temporada futura.
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
  'thirdPlaceCount'
]);

/**
 * Pontos de um resultado.
 *
 * @param {number|null} placing            Colocação obtida.
 * @param {Array}  tabela                  [{ placing, points }] da temporada.
 * @param {boolean} isOverallChampion      Se o atleta levou o Overall.
 * @param {boolean} superOverallEligible    Se a participação é na ABSOLUTA.
 *                                          Condição necessária para o bônus.
 */
function pontuarResultado(placing, tabela, isOverallChampion = false, superOverallEligible = false) {
  const regra = (tabela || []).find(item => item.placing === placing);
  // Colocação fora da tabela vale ZERO — não um valor extrapolado. Pela regra
  // homologada a tabela vai até o 5º, então do 6º em diante é zero.
  const placementPoints = regra?.points ?? 0;

  // REGRA VIGENTE: as duas condições, e não só o título. Um Overall declarado
  // para uma participação fora da absoluta não vale bônus — nem no campeonato,
  // nem no anual.
  const overallBonus = isOverallChampion && superOverallEligible ? BONUS_OVERALL : 0;
  const points = placementPoints + overallBonus;

  // As duas métricas, calculadas juntas e devolvidas separadas. Como o bônus
  // só existe onde a participação é elegível, ele acompanha `points` para o
  // anual sem precisar de regra própria.
  return {
    placementPoints,
    overallBonus,
    points,
    superOverallPoints: superOverallEligible ? points : 0
  };
}

/**
 * Confere uma pontuação vinda de fora contra a regra oficial da temporada.
 *
 * O operador importa resultados, e o arquivo é redigido fora da plataforma. Um
 * número de pontos que possa ser DERIVADO de colocação, Overall e temporada
 * não é fonte: é uma afirmação a conferir. Divergir não pode ser resolvido em
 * silêncio — nem sobrescrevendo o arquivo, nem confiando nele.
 *
 * @param {boolean} superOverallEligible Se a participação é na ABSOLUTA — parte
 *        da regra, porque o bônus de Overall só existe lá.
 * @returns {null|{importedPoints,calculatedPoints,difference}} null quando não
 *          há divergência (ou quando não há o que comparar).
 */
function conferirPontuacaoImportada(placing, tabela, isOverallChampion, pontosImportados, superOverallEligible = false) {
  // Sem colocação não há regra a aplicar, e sem número informado não há o que
  // conferir: nos dois casos, nada a divergir.
  if (placing == null || pontosImportados == null) return null;

  // A elegibilidade da classe é PARTE da regra desde que o bônus passou a
  // exigir a absoluta: conferir sem ela calcularia 5 onde o arquivo informa 15
  // e acusaria conflito onde não há.
  const { points } = pontuarResultado(placing, tabela, isOverallChampion, superOverallEligible);
  if (points === pontosImportados) return null;

  return {
    importedPoints: pontosImportados,
    calculatedPoints: points,
    difference: pontosImportados - points
  };
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

// Chave de SEQUENCIAMENTO, não de desempate.
//
// `compararOficial` devolve 0 para quem a regra oficial não separa, e nesse
// ponto a ordem de saída passava a ser a ordem de ENTRADA — que é a ordem
// física das linhas no PostgreSQL. Um `pg_restore` reescreve essa ordem
// física, e a FASE 12.3 flagrou o efeito: o mesmo Super Overall, antes e
// depois do backup, devolvia dois atletas empatados trocados de lugar.
//
// Duas consequências reais: um relatório deixa de bater byte a byte com o
// emitido antes do restore, e a paginação — que fatia a lista JÁ classificada
// — pode repetir ou perder um competidor entre duas requisições.
//
// Fixar a sequência NÃO desempata nada: todo mundo do bloco continua saindo
// com `position: null` e `tieUnresolved: true`. A colocação segue indefinida,
// como manda a regra homologada; o que deixa de variar é só a ordem de
// leitura da lista.
function chaveDeSequencia(linha) {
  return String(linha.athleteId ?? linha.teamId ?? linha.companyId ?? linha.id ?? '');
}

// Comparação de string byte a byte. `localeCompare` depende do locale do
// processo e do ICU disponível — o que reintroduziria, por outra porta, a
// não-determinação que esta função existe para eliminar.
function compararChave(a, b) {
  const x = chaveDeSequencia(a), y = chaveDeSequencia(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Ordena e numera. Quem a hierarquia não separou sai sem posição, marcado
 * como empate não resolvido.
 *
 * @returns {Array} as mesmas linhas, com `position` (número ou null) e
 *                  `tieUnresolved` (boolean).
 */
function classificar(linhas) {
  // O agrupamento abaixo continua usando SÓ `compararOficial`: a chave de
  // sequência ordena, mas nunca separa um bloco de empatados.
  const ordenadas = [...linhas].sort((a, b) => compararOficial(a, b) || compararChave(a, b));

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
  conferirPontuacaoImportada,
  contadores,
  compararOficial,
  classificar
};
