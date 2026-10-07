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

/**
 * AS PARTICIPAÇÕES PUBLICADAS DE UM ATLETA, pelas DUAS origens.
 *
 * POR QUE ISTO EXISTE
 *
 * O cartão da organização já somava as duas origens — foi para isso que este
 * arquivo nasceu. O PERFIL DO ATLETA ficou para trás: ele lia só
 * `ResultEntry`, e por isso um atleta com campeonato inteiro importado
 * mostrava "Resultados publicados: 0" e "Histórico esportivo: vazio" ao lado
 * de "30 pontos somados" no mesmo bloco de métricas. Os dois números estavam
 * certos para as suas próprias fontes, e a tela ficava se contradizendo.
 *
 * A REGRA É A MESMA, E É UMA SÓ
 *
 * Publicado = participação recebida com resultado PUBLISHED
 *           + participação importada cujo lançamento ainda vale.
 *
 * Nada aqui afrouxa o filtro de publicação. Rascunho e resultado em revisão
 * continuam de fora; lote invalidado continua de fora, porque a projeção
 * carrega `voided`.
 *
 * POR QUE A PROJEÇÃO, E NÃO O LEDGER
 *
 * Esta leitura serve a rota ANÔNIMA. `RankingPoint` tem política de operador:
 * o visitante contaria zero. `PublicRankingEntry` é a projeção pública, e é o
 * que o visitante de fato enxerga — a mesma escolha de `paraOPublico`.
 *
 * `classId: null` é o discriminador de origem já documentado neste arquivo:
 * o caminho importado nunca grava `classId`, e o recebido sempre grava.
 *
 * O EVENTO ENTRA PELA VISIBILIDADE PÚBLICA, NÃO PELO VÍNCULO
 *
 * Uma participação importada cujo evento não está publicamente visível não
 * ganha link — e continua contando, porque ela É um resultado publicado do
 * atleta. Esconder a linha faria o histórico discordar do ranking de novo;
 * dar link para uma página que o visitante não pode abrir seria mentira de
 * navegação. Então: linha presente, link ausente.
 */
async function participacoesDoAtleta(athleteId, { eventosVisiveis = [] } = {}) {
  const [recebidas_, importadas] = await Promise.all([
    prisma.resultEntry.findMany({
      where: { athleteId, ...recebidas({}) },
      select: {
        id: true, placing: true, status: true,
        result: {
          select: {
            publishedAt: true,
            event: { select: { id: true, name: true, slug: true, startDate: true, status: true } }
          }
        },
        registrationItem: {
          select: {
            competitionClass: {
              select: {
                id: true, name: true,
                division: {
                  select: {
                    eventCategory: { select: { category: { select: { id: true, name: true } } } }
                  }
                }
              }
            }
          }
        }
      },
      orderBy: { result: { publishedAt: 'desc' } },
      take: 200
    }),
    prisma.publicRankingEntry.findMany({
      where: { athleteId, classId: null, voided: false },
      select: {
        id: true, eventId: true, placing: true, points: true,
        isOverallChampion: true, didNotShow: true,
        categoryId: true, catalogClassId: true, seasonId: true
      },
      take: 200
    })
  ]);

  // Os nomes vêm em DUAS consultas em lote, e não uma por linha: o histórico
  // de um atleta veterano pode ter dezenas de participações, e uma consulta
  // por linha seria N+1 numa rota pública e anônima.
  const idsDeEvento = [...new Set(importadas.map(e => e.eventId).filter(Boolean))];
  const idsDeCategoria = [...new Set(importadas.map(e => e.categoryId).filter(Boolean))];
  const idsDeClasse = [...new Set(importadas.map(e => e.catalogClassId).filter(Boolean))];

  const [eventos, categorias, classes] = await Promise.all([
    idsDeEvento.length
      ? prisma.event.findMany({
        where: { id: { in: idsDeEvento } },
        select: { id: true, name: true, slug: true, startDate: true, status: true }
      })
      : [],
    idsDeCategoria.length
      ? prisma.category.findMany({ where: { id: { in: idsDeCategoria } }, select: { id: true, name: true } })
      : [],
    idsDeClasse.length
      ? prisma.classCatalog.findMany({
        where: { id: { in: idsDeClasse } },
        select: { id: true, name: true, displayName: true }
      })
      : []
  ]);

  const porEvento = new Map(eventos.map(e => [e.id, e]));
  const porCategoria = new Map(categorias.map(c => [c.id, c]));
  const porClasse = new Map(classes.map(c => [c.id, c]));
  const visivel = evento => Boolean(evento) && eventosVisiveis.includes(evento.status);

  const deRecebida = entrada => {
    const evento = entrada.result?.event ?? null;
    const classe = entrada.registrationItem?.competitionClass ?? null;
    const categoria = classe?.division?.eventCategory?.category ?? null;
    return {
      chave: `recebido:${entrada.id}`,
      origem: 'RECEBIDO',
      placing: entrada.placing,
      status: entrada.status,
      points: null,
      isOverallChampion: false,
      event: evento ? { id: evento.id, name: evento.name, slug: evento.slug, startDate: evento.startDate } : null,
      eventoNavegavel: visivel(evento),
      categoryName: categoria?.name ?? null,
      className: classe?.name ?? null,
      date: entrada.result?.publishedAt ?? evento?.startDate ?? null
    };
  };

  const deImportada = entrada => {
    const evento = entrada.eventId ? porEvento.get(entrada.eventId) ?? null : null;
    const classe = entrada.catalogClassId ? porClasse.get(entrada.catalogClassId) ?? null : null;
    return {
      chave: `importado:${entrada.id}`,
      origem: 'IMPORTADO',
      placing: entrada.placing,
      status: entrada.didNotShow ? 'NO_SHOW' : null,
      points: entrada.points,
      isOverallChampion: entrada.isOverallChampion,
      event: evento ? { id: evento.id, name: evento.name, slug: evento.slug, startDate: evento.startDate } : null,
      eventoNavegavel: visivel(evento),
      categoryName: entrada.categoryId ? porCategoria.get(entrada.categoryId)?.name ?? null : null,
      className: classe ? classe.displayName ?? classe.name : null,
      date: evento?.startDate ?? null
    };
  };

  // Mais recente primeiro. Participação sem data vai para o fim: ela existe,
  // conta, e não tem como disputar ordem com quem tem data.
  const tudo = [...recebidas_.map(deRecebida), ...importadas.map(deImportada)];
  tudo.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });

  return tudo;
}

module.exports = { paraOOperador, paraOPublico, participacoesDoAtleta };
