const prisma = require('../config/prisma');

// ============================================================================
// "RESULTADOS PUBLICADOS" — A DEFINIÇÃO, EM UM LUGAR SÓ.
//
// O DEFEITO QUE ORIGINOU ESTE ARQUIVO
//
// Dois cartões — o da vitrine pública e o do painel administrativo — mostravam
// "Resultados publicados" contando a MESMA coisa:
//
//     prisma.result.count({ where: { status: 'PUBLISHED' } })
//
// `Result` é a apuração RECEBIDA pelo MCI: uma linha por (evento, classe), com
// `ResultEntry` por participação, e cada entrada amarrada a uma
// `RegistrationItem`. Só `resultService` escreve nessa tabela.
//
// O histórico IMPORTADO não passa por ali, e não passa por projeto: o MCI
// carrega campeonato que já aconteceu, muitas vezes antes de existir um único
// atleta cadastrado. Esse caminho grava `ExternalResult` + `RankingPoint`, e
// `muscleWarService` nunca toca em `Result` — conferido: os únicos `create` do
// importador são de `MuscleWarImport`, `MuscleWarImportItem`, `ExternalAthlete`,
// `ExternalResult` e `RankingPoint`.
//
// Consequência medida, e não deduzida: uma etapa inteira importada e APLICADA
// deixava os dois cartões em ZERO. Foi o que aconteceu com o Ipiranga.
//
// A DEFINIÇÃO QUE PASSA A VALER
//
//   resultados publicados = PARTICIPAÇÕES com resultado publicado
//                         = as recebidas pelo MCI
//                         + as do histórico importado que ainda valem
//
// A unidade é a PARTICIPAÇÃO, e não o documento de apuração da classe. É essa
// escolha que torna as duas origens somáveis: contar `Result` (uma linha por
// classe) junto de `ExternalResult` (uma linha por competidor) produziria um
// número sem significado.
//
// POR QUE "QUE AINDA VALEM", E NÃO "QUE EXISTEM"
//
// `ExternalResult` NÃO é removido quando um lote é invalidado — ele é a chave
// de idempotência, e apagá-lo faria a reimportação do mesmo arquivo pontuar de
// novo. Quem registra a invalidação é o lançamento: `RankingPoint.voidedAt`.
// Contar `ExternalResult` chamaria de publicado exatamente o resultado que a
// federação acabou de tirar do ar.
//
// POR QUE SÃO DUAS CONSULTAS DIFERENTES PARA A MESMA PERGUNTA
//
// A parte importada é lida de tabelas diferentes conforme quem pergunta, e
// isso é a RLS funcionando, não um contorno dela:
//
//   · `RankingPoint` tem política de OPERADOR (`mci_operator_of`). Um visitante
//     anônimo conta zero ali — foi para isso que a projeção pública nasceu.
//   · `PublicRankingEntry` é a projeção: uma linha por lançamento, só com
//     coluna pública, legível por `mci_operator_of(org) OR
//     mci_ranking_publicado(season)` — e `mci_ranking_publicado` é "a
//     organização da temporada está ativa".
//
// Então o operador conta do LEDGER, que é a fonte, e o público conta da
// PROJEÇÃO, que é o que ele de fato enxerga. Os dois números coincidem
// enquanto a organização está ativa e a projeção está em dia; divergir é
// informação verdadeira, não defeito — e há teste comparando os dois.
//
// O DISCRIMINADOR DE ORIGEM NA PROJEÇÃO
//
// `PublicRankingEntry` não tem a coluna `source`; `RankingPoint` tem. O que a
// projeção carrega é `classId`, e ele separa as duas origens com exatidão:
//
//   · caminho interno  — `awardForResult` grava `classId: result.classId`, e
//     `Result.classId` é obrigatório: nunca nulo;
//   · caminho importado — o importador nunca grava `classId`. A classe do
//     arquivo é texto, e a que acompanha o ponto é `catalogClassId`.
//
// É o que o próprio schema já declarava sobre a coluna: "`classId` é nulo em
// todo resultado histórico importado". Como a afirmação passou a ser
// LOAD-BEARING, ela deixou de ser comentário e virou teste: a suíte confere,
// contra o ledger, que importado ⇒ `classId` nulo e recebido ⇒ `classId`
// preenchido, e confere que o número do público bate com o do operador. Se
// alguém passar a gravar `classId` no caminho importado, a suíte reprova antes
// de o cartão voltar a mentir.
//
// O QUE ESTE NÚMERO NÃO É
//
// Não é "existem resultados". Uma participação recebida entra aqui quando o
// resultado da classe está PUBLISHED — rascunho e em revisão não entram, e a
// RLS de `Result` já garante que o visitante não os veja. Uma participação
// importada entra quando o lote foi APLICADO e o lançamento não foi
// invalidado.
//
// E não é contagem de PONTOS. Participação de zero ponto — 6º lugar em diante,
// e NS — é resultado publicado do mesmo jeito: ela existe no histórico do
// atleta. Confundir as duas coisas é o que fez o cartão de "pontos 0" custar
// uma investigação inteira antes.
// ============================================================================

/**
 * As participações RECEBIDAS: uma linha por `ResultEntry` de resultado
 * publicado.
 *
 * Inclui desclassificado, ausente e empate não resolvido. Todos são linha de
 * um resultado publicado, e todos aparecem na tela pública do evento — omiti-los
 * faria o cartão discordar da página que ele abre.
 *
 * O escopo do operador chega pelo evento, que é onde a organização mora.
 */
function recebidas(escopo) {
  return Object.keys(escopo).length
    ? { result: { status: 'PUBLISHED', event: escopo } }
    : { result: { status: 'PUBLISHED' } };
}

/** Do LEDGER. Para quem opera: é a fonte, e ela responde por organização. */
async function paraOOperador(escopo = {}) {
  const [recebidos, importados] = await Promise.all([
    prisma.resultEntry.count({ where: recebidas(escopo) }),
    prisma.rankingPoint.count({ where: { ...escopo, source: 'MUSCLEWAR', voidedAt: null } })
  ]);

  return { total: recebidos + importados, received: recebidos, imported: importados };
}

/**
 * Da PROJEÇÃO. Para o público: é o que o visitante enxerga, e a rota é anônima.
 *
 * Sem escopo de organização de propósito — a vitrine é da plataforma inteira,
 * como já era o resto do resumo público. A RLS é que recorta: a projeção só se
 * abre ao anônimo nas temporadas de organização ativa.
 */
async function paraOPublico() {
  const [recebidos, importados] = await Promise.all([
    prisma.resultEntry.count({ where: recebidas({}) }),
    prisma.publicRankingEntry.count({ where: { classId: null, voided: false } })
  ]);

  return { total: recebidos + importados, received: recebidos, imported: importados };
}

module.exports = { paraOOperador, paraOPublico };
