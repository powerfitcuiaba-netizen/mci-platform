#!/usr/bin/env node
/**
 * DIAGNÓSTICO — OS RESULTADOS DE UM ATLETA, UM A UM, COM A ORIGEM DE CADA UM.
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * O diagnóstico de identidade classificou dois resultados da matrícula NPC 2932
 * como DUPLICADO e, na mesma tela, imprimiu `evento = —` e `resultado = —`.
 * As duas coisas juntas são suspeitas, e a razão está no próprio código:
 *
 *   assinaturaDoResultado = eventName | className | placing
 *
 * `ExternalResult.eventName` é `String?`. Quando ele é NULO — e ele é nulo
 * sempre que o lote não preencheu o nome do evento na linha —, a assinatura de
 * DOIS resultados distintos vira a MESMA string vazia `"||"`, e a regra de
 * repetição dispara sem que nada esteja repetido. O relatório já avisa, com
 * estas palavras, que DUPLICADO é SINAL e não prova. Este script existe para
 * resolver o sinal com a evidência que falta.
 *
 * A EVIDÊNCIA CERTA NÃO É O NOME DO EVENTO
 *
 * Para um resultado importado, a identidade do evento mora em dois lugares
 * confiáveis — e `ExternalResult` não é nenhum deles:
 *
 *   * `RankingPoint.eventId`  — o lançamento aponta para o evento de verdade;
 *   * `MuscleWarImport.eventId` — o LOTE declara para qual evento foi importado.
 *
 * `ExternalResult.eventName` é uma cópia em texto livre, útil para leitura
 * humana e inútil para decidir identidade. Por isso este relatório compara
 * `eventId`, e trata o nome como descrição.
 *
 * O QUE ELE NÃO FAZ
 *
 * Não escreve. Nenhuma linha, em nenhuma tabela. Não cria, não vincula, não
 * desvincula, não recalcula ponto, não apaga, não faz backfill. É leitura e
 * relatório. A decisão é de quem lê.
 *
 * POR QUE EXIGE UM ATOR
 *
 * `Athlete`, `ExternalAthlete`, `ExternalResult` e `RankingPoint` têm política
 * de leitura por organização. Um cliente cru não passa por `withUserContext` e
 * não tem `mci.user_id`: as consultas voltariam VAZIAS e o relatório diria "não
 * há registro" quando o que houve foi "não consigo ver". O contexto é o mesmo
 * `set_config('mci.user_id', $1, true)` de qualquer requisição autenticada —
 * nenhum BYPASSRLS, nenhum SECURITY DEFINER, nenhuma política afrouxada.
 *
 * USO
 *
 *   node scripts/diagnostico-dois-resultados-do-atleta.js \
 *     --atleta <athleteId> --email <seu e-mail do MCI> [--json]
 *
 * `--email` é a forma recomendada, e é a mesma dos outros diagnósticos deste
 * repositório: ninguém decora o próprio userId. `--ator <userId>` continua
 * aceito para quem já tem o identificador em mãos.
 *
 * A DATABASE_URL não é impressa, nem parcialmente. CPF não é consultado.
 */
const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');
const { resolverAtor, listarOperadores } = require('./lib/ator');

const arg = nome => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
};
const temBandeira = nome => process.argv.includes(`--${nome}`);

const traco = v => (v === null || v === undefined || v === '' ? '—' : String(v));
const data = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const linha = (rotulo, valor) => console.log(`${rotulo.padEnd(30)} ${traco(valor)}`);

async function coletar(atorId, athleteId) {
  return withUserContext(atorId, async tx => {
    const atleta = await tx.athlete.findUnique({
      where: { id: athleteId },
      select: {
        id: true, fullName: true, stageName: true, status: true,
        organizationId: true, affiliationNumber: true,
        affiliation: { select: { id: true, code: true, name: true } }
      }
    });
    if (!atleta) return { atleta: null };

    // As identidades externas que apontam para este cadastro. A chave é o
    // ponteiro `athleteId`, nunca o nome.
    const identidades = await tx.externalAthlete.findMany({
      where: { athleteId },
      select: {
        id: true, identityKey: true, displayName: true, source: true,
        affiliationId: true, affiliationNumber: true, linkedAt: true, linkedById: true
      },
      orderBy: { createdAt: 'asc' }
    });

    // Os resultados chegam pelos DOIS caminhos possíveis, unidos: o ponteiro
    // direto para o cadastro e o ponteiro para a identidade externa. Procurar
    // só por um deles esconderia metade do histórico.
    const resultados = await tx.externalResult.findMany({
      where: {
        OR: [
          { athleteId },
          ...(identidades.length ? [{ externalAthleteId: { in: identidades.map(i => i.id) } }] : [])
        ]
      },
      select: {
        id: true, source: true, externalId: true, seasonId: true,
        athleteId: true, externalAthleteId: true, importItemId: true,
        categoryCode: true, className: true, placing: true, points: true,
        eventName: true, eventDate: true, appliedAt: true
      },
      orderBy: [{ eventDate: 'asc' }, { id: 'asc' }]
    });

    const lancamentos = await tx.rankingPoint.findMany({
      where: {
        OR: [
          { athleteId },
          ...(identidades.length ? [{ externalAthleteId: { in: identidades.map(i => i.id) } }] : [])
        ]
      },
      select: {
        id: true, seasonId: true, eventId: true, resultId: true, externalResultId: true,
        athleteId: true, externalAthleteId: true, source: true, placing: true,
        placementPoints: true, overallBonus: true, adjustmentPoints: true,
        points: true, superOverallPoints: true, isOverallChampion: true,
        superOverallEligible: true, categoryId: true, classId: true
      }
    });

    // O ITEM DE IMPORTAÇÃO guarda o que a fonte disse E o que foi corrigido.
    // É a única tabela onde o par original/corrigido coexiste.
    const idsDeItem = resultados.map(r => r.importItemId).filter(Boolean);
    const itens = idsDeItem.length
      ? await tx.muscleWarImportItem.findMany({
        where: { id: { in: idsDeItem } },
        select: {
          id: true, importId: true, rowNumber: true, athleteName: true,
          memberNumber: true, affiliationCode: true,
          correctedMemberNumber: true, correctedAffiliationCode: true,
          correctionReason: true, correctedAt: true, correctedById: true,
          matchStatus: true, athleteId: true, externalResultId: true
        }
      })
      : [];

    // O LOTE declara o evento. Para resultado importado, é a fonte de verdade
    // mais confiável do que o texto livre em `ExternalResult.eventName`.
    const idsDeLote = [...new Set(itens.map(i => i.importId))];
    const lotes = idsDeLote.length
      ? await tx.muscleWarImport.findMany({
        where: { id: { in: idsDeLote } },
        select: { id: true, sourceRef: true, eventId: true, seasonId: true, status: true, appliedAt: true }
      })
      : [];

    const idsDeEvento = [...new Set([
      ...lancamentos.map(l => l.eventId),
      ...lotes.map(l => l.eventId)
    ].filter(Boolean))];
    const eventos = idsDeEvento.length
      ? await tx.event.findMany({
        where: { id: { in: idsDeEvento } },
        select: { id: true, name: true, startDate: true, city: true, state: true, seasonId: true }
      })
      : [];

    return { atleta, identidades, resultados, lancamentos, itens, lotes, eventos };
  });
}

function montar(dados) {
  const porItem = new Map(dados.itens.map(i => [i.id, i]));
  const porLote = new Map(dados.lotes.map(l => [l.id, l]));
  const porEvento = new Map(dados.eventos.map(e => [e.id, e]));
  const porResultado = new Map(dados.lancamentos.filter(l => l.externalResultId)
    .map(l => [l.externalResultId, l]));
  const porIdentidade = new Map(dados.identidades.map(i => [i.id, i]));

  return dados.resultados.map(r => {
    const item = r.importItemId ? porItem.get(r.importItemId) ?? null : null;
    const lote = item ? porLote.get(item.importId) ?? null : null;
    const ponto = porResultado.get(r.id) ?? null;
    const identidade = porIdentidade.get(r.externalAthleteId) ?? null;
    // O eventId do LANÇAMENTO tem precedência; o do LOTE é o reserva.
    const eventId = ponto?.eventId ?? lote?.eventId ?? null;
    const evento = eventId ? porEvento.get(eventId) ?? null : null;

    return {
      resultadoId: r.id,
      source: r.source,
      externalId: r.externalId,
      eventId,
      eventIdOrigem: ponto?.eventId ? 'RankingPoint.eventId' : (lote?.eventId ? 'MuscleWarImport.eventId' : 'ausente'),
      eventoNome: evento?.name ?? null,
      eventoData: evento?.startDate ?? r.eventDate ?? null,
      eventoCidade: evento ? [evento.city, evento.state].filter(Boolean).join('/') : null,
      eventNameNoResultado: r.eventName,
      loteId: lote?.id ?? null,
      loteArquivo: lote?.sourceRef ?? null,
      loteStatus: lote?.status ?? null,
      identidadeId: r.externalAthleteId,
      identityKey: identidade?.identityKey ?? null,
      identidadeNome: identidade?.displayName ?? null,
      identidadeFiliacao: identidade?.affiliationNumber ?? null,
      categoria: r.categoryCode,
      classe: r.className,
      colocacao: r.placing,
      pontosNoResultado: r.points,
      lancamentoId: ponto?.id ?? null,
      pontosDeColocacao: ponto?.placementPoints ?? null,
      pontosDeOverall: ponto?.overallBonus ?? null,
      ajuste: ponto?.adjustmentPoints ?? null,
      pontosTotais: ponto?.points ?? null,
      superOverall: ponto?.superOverallPoints ?? null,
      campeaoOverall: ponto?.isOverallChampion ?? null,
      ledgerId: ponto?.resultId ?? null,
      athleteIdNoResultado: r.athleteId,
      athleteIdNoLancamento: ponto?.athleteId ?? null,
      athleteIdNoItem: item?.athleteId ?? null,
      situacaoDoItem: item?.matchStatus ?? null,
      itemId: item?.id ?? null,
      linhaNoArquivo: item?.rowNumber ?? null,
      nomeNaFonte: item?.athleteName ?? null,
      memberNumberOriginal: item?.memberNumber ?? null,
      correctedMemberNumber: item?.correctedMemberNumber ?? null,
      affiliationOriginal: item?.affiliationCode ?? null,
      correctedAffiliationCode: item?.correctedAffiliationCode ?? null,
      motivoDaCorrecao: item?.correctionReason ?? null,
      correctedAt: item?.correctedAt ?? null,
      correctedById: item?.correctedById ?? null,
      // A assinatura QUE O OUTRO DIAGNÓSTICO USA, reproduzida aqui para que o
      // sinal DUPLICADO possa ser confirmado ou desmentido com o próprio
      // critério dele, em vez de na base da opinião.
      assinaturaDoSinal: [String(r.eventName ?? '').trim().toUpperCase(),
        String(r.className ?? '').trim().toUpperCase(),
        r.placing ?? ''].join('|')
    };
  });
}

function vereditar(linhas) {
  if (linhas.length < 2) {
    return { veredito: 'INCONSISTÊNCIA QUE PRECISA DE INVESTIGAÇÃO',
      porque: `esperava 2 resultados e encontrei ${linhas.length}` };
  }

  const eventIds = linhas.map(l => l.eventId);
  const semEvento = eventIds.filter(e => !e).length;
  const distintos = new Set(eventIds.filter(Boolean));
  const externalIdsDistintos = new Set(linhas.map(l => `${l.source}:${l.externalId}`)).size === linhas.length;
  const lancamentosDistintos = new Set(linhas.map(l => l.lancamentoId).filter(Boolean)).size === linhas.filter(l => l.lancamentoId).length;
  const umDono = new Set(linhas.map(l => l.athleteIdNoLancamento ?? l.athleteIdNoResultado).filter(Boolean)).size === 1;

  if (semEvento) {
    return { veredito: 'INCONSISTÊNCIA QUE PRECISA DE INVESTIGAÇÃO',
      porque: `${semEvento} resultado(s) sem eventId em RankingPoint E sem eventId no lote — sem isso não dá para afirmar de qual etapa cada um veio` };
  }
  if (distintos.size === linhas.length && externalIdsDistintos && lancamentosDistintos && umDono) {
    return { veredito: 'CONSOLIDADO CORRETO',
      porque: 'cada resultado pertence a um evento DIFERENTE, tem (source, externalId) próprio, lançamento próprio, e os dois apontam para o MESMO cadastro' };
  }
  if (distintos.size < linhas.length) {
    return { veredito: 'DUPLICAÇÃO REAL',
      porque: 'há mais de um resultado para o MESMO eventId sob o mesmo atleta' };
  }
  return { veredito: 'INCONSISTÊNCIA QUE PRECISA DE INVESTIGAÇÃO',
    porque: 'eventos distintos, mas alguma das outras invariantes não fecha (externalId, lançamento ou dono)' };
}

function imprimir(dados, linhas) {
  const a = dados.atleta;
  console.log('\n============================================================');
  console.log('  DIAGNÓSTICO — RESULTADOS DO ATLETA (SOMENTE LEITURA)');
  console.log('============================================================\n');
  linha('atleta', `${a.fullName}${a.stageName ? ` (${a.stageName})` : ''}`);
  linha('athleteId', a.id);
  linha('situação', a.status);
  linha('filiação', `${a.affiliation ? a.affiliation.code : '—'} · ${a.affiliationNumber ?? '—'}`);
  linha('identidades externas', dados.identidades.length);
  linha('resultados importados', dados.resultados.length);
  linha('lançamentos de pontos', dados.lancamentos.length);

  linhas.forEach((l, i) => {
    console.log(`\n------------------------------------------------------------`);
    console.log(`  RESULTADO ${i + 1}`);
    console.log(`------------------------------------------------------------`);
    linha('1. ExternalResult.id', l.resultadoId);
    linha('2. eventId', l.eventId);
    linha('   origem do eventId', l.eventIdOrigem);
    linha('3. nome do evento', l.eventoNome);
    linha('4. data do evento', data(l.eventoData));
    linha('   local', l.eventoCidade);
    linha('5. lote / arquivo', `${l.loteId ?? '—'} · ${l.loteArquivo ?? '—'}`);
    linha('   situação do lote', l.loteStatus);
    linha('6. identidade externa', l.identidadeId);
    linha('   identityKey', l.identityKey);
    linha('   nome na identidade', l.identidadeNome);
    linha('   (source, externalId)', `${l.source} · ${l.externalId}`);
    linha('7. categoria', l.categoria);
    linha('8. classe', l.classe);
    linha('9. colocação', l.colocacao);
    linha('10. pontos de colocação', l.pontosDeColocacao);
    linha('11. pontos de Overall', l.pontosDeOverall);
    linha('    ajuste', l.ajuste);
    linha('    TOTAL do lançamento', l.pontosTotais);
    linha('    super overall', l.superOverall);
    linha('    campeão overall', l.campeaoOverall);
    linha('12. RankingPoint.id', l.lancamentoId);
    linha('13. ledger id (resultId)', l.ledgerId);
    linha('14. athleteId (resultado)', l.athleteIdNoResultado);
    linha('    athleteId (lançamento)', l.athleteIdNoLancamento);
    linha('    athleteId (item)', l.athleteIdNoItem);
    linha('15. situação do item', l.situacaoDoItem);
    linha('16. nome na fonte', l.nomeNaFonte);
    linha('17. member number original', l.memberNumberOriginal);
    linha('18. correctedMemberNumber', l.correctedMemberNumber);
    linha('19. affiliation original', l.affiliationOriginal);
    linha('20. correctedAffiliationCode', l.correctedAffiliationCode);
    linha('21. correctedAt', l.correctedAt ? new Date(l.correctedAt).toISOString() : null);
    linha('22. correctedById', l.correctedById);
    linha('    motivo da correção', l.motivoDaCorrecao);
    linha('    eventName no resultado', l.eventNameNoResultado);
    linha('    assinatura do sinal', `"${l.assinaturaDoSinal}"`);
  });

  console.log(`\n------------------------------------------------------------`);
  console.log('  COMPARAÇÃO LADO A LADO');
  console.log(`------------------------------------------------------------`);
  linhas.forEach((l, i) => {
    console.log(`\nRESULTADO ${i + 1}`);
    console.log(`  id:        ${traco(l.resultadoId)}`);
    console.log(`  evento:    ${traco(l.eventoNome)}`);
    console.log(`  eventId:   ${traco(l.eventId)}`);
    console.log(`  pontos:    ${traco(l.pontosTotais)}  (colocação ${traco(l.pontosDeColocacao)} + overall ${traco(l.pontosDeOverall)} + ajuste ${traco(l.ajuste)})`);
    console.log(`  ledger:    ${traco(l.ledgerId)}`);
    console.log(`  athleteId: ${traco(l.athleteIdNoLancamento ?? l.athleteIdNoResultado)}`);
  });

  // O SINAL DUPLICADO, CONFRONTADO COM O PRÓPRIO CRITÉRIO DELE.
  const assinaturas = linhas.map(l => l.assinaturaDoSinal);
  const repetida = new Set(assinaturas).size < assinaturas.length;
  const todasVazias = assinaturas.every(s => s === '||');
  console.log(`\n------------------------------------------------------------`);
  console.log('  O SINAL "DUPLICADO", EXPLICADO');
  console.log(`------------------------------------------------------------`);
  linha('assinaturas repetidas?', repetida ? 'SIM' : 'não');
  linha('assinaturas todas vazias?', todasVazias ? 'SIM' : 'não');
  if (repetida && todasVazias) {
    console.log('\n  A assinatura é "eventName|className|placing" e as duas vieram VAZIAS.');
    console.log('  Duas strings vazias são iguais entre si: a regra de repetição dispara');
    console.log('  sem que haja repetição. O sinal, neste caso, é ARTEFATO — e o veredito');
    console.log('  abaixo foi decidido por eventId, que é a evidência própria.');
  }

  const { veredito, porque } = vereditar(linhas);
  console.log(`\n============================================================`);
  console.log(`  VEREDITO: ${veredito}`);
  console.log(`============================================================`);
  console.log(`  ${porque}\n`);

  if (veredito === 'CONSOLIDADO CORRETO') {
    console.log('  Pontuação por evento, como medida:');
    for (const l of linhas) {
      console.log(`    ${String(l.eventoNome ?? '—').padEnd(34)} = ${traco(l.pontosTotais)}`);
    }
    const total = linhas.reduce((s, l) => s + (l.pontosTotais ?? 0), 0);
    console.log(`    ${'TOTAL'.padEnd(34)} = ${total}\n`);
  }
}

async function principal() {
  const athleteId = arg('atleta');
  const email = arg('email');
  const ator = arg('ator');

  if (!athleteId || (!email && !ator)) {
    console.error('\n  Uso: node scripts/diagnostico-dois-resultados-do-atleta.js \\');
    console.error('         --atleta <athleteId> --email <seu e-mail do MCI> [--json]\n');
    const operadores = await listarOperadores().catch(() => []);
    if (operadores.length) {
      console.error('  Operadores que podem rodar isto:');
      for (const o of operadores.slice(0, 10)) console.error(`    ${o.email}  (${o.role})`);
      console.error('');
    }
    process.exitCode = 2;
    return;
  }

  const atorResolvido = await resolverAtor({ ator, email });
  const dados = await coletar(atorResolvido.id, athleteId);

  if (!dados.atleta) {
    console.error(`\n  Nenhum cadastro visível com o id ${athleteId}.`);
    console.error('  Pode ser que ele não exista OU que a sua organização não o enxergue.');
    console.error('  As duas coisas são diferentes, e este script não as confunde de propósito.\n');
    process.exitCode = 1;
    return;
  }

  const linhas = montar(dados);
  if (temBandeira('json')) {
    console.log(JSON.stringify({ atleta: dados.atleta, resultados: linhas, ...vereditar(linhas) }, null, 2));
    return;
  }
  imprimir(dados, linhas);
}

principal()
  .catch(erro => { console.error('\n  ERRO:', erro.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
