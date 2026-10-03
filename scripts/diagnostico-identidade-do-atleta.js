#!/usr/bin/env node
/**
 * DIAGNÓSTICO DE IDENTIDADE ESPORTIVA — por MATRÍCULA, nunca por nome.
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * A pergunta "o atleta está partido em vários?" só tem resposta honesta se for
 * feita pelo IDENTIFICADOR. Procurar por nome devolve o que o nome casa, e é
 * justamente o nome que varia entre eventos — acentuação, abreviação, erro de
 * digitação, sobrenome a mais. Procurar por nome para investigar um problema de
 * nome é circular.
 *
 * Então aqui a chave é a matrícula no escopo da filiação, que é a identidade
 * homologada do projeto. O nome aparece apenas como EVIDÊNCIA: a lista de
 * variações encontradas sob o mesmo identificador é exatamente o que prova (ou
 * desmente) que o sistema separou a mesma pessoa.
 *
 * O QUE ELE NÃO FAZ
 *
 * Não escreve. Nenhuma linha, em nenhuma tabela. Não cria, não vincula, não
 * consolida, não recalcula ponto, não apaga nada. É leitura e relatório — a
 * decisão de consolidar é de quem lê, com outro comando.
 *
 * USO
 *
 *   node scripts/diagnostico-identidade-do-atleta.js \
 *     --matricula 2932 --ator <userId> [--filiacao NPC] [--json]
 *
 * POR QUE EXIGE UM ATOR
 *
 * `Athlete`, `ExternalAthlete`, `ExternalResult` e `RankingPoint` têm política
 * de leitura por organização. Um `PrismaClient` cru não passa por
 * `withUserContext` e não tem `mci.user_id`: as consultas voltariam VAZIAS, e o
 * relatório diria "não há registro" quando o que houve foi "não consigo ver".
 * São opostos, e apareciam iguais — foi assim que um diagnóstico anterior deste
 * projeto mentiu. O contexto é o MESMO `set_config('mci.user_id', $1, true)` de
 * toda requisição autenticada: nenhum BYPASSRLS, nenhum SECURITY DEFINER,
 * nenhuma política afrouxada.
 *
 * SOBRE O QUE É IMPRESSO
 *
 * Nomes de atleta saem, porque quem roda isto é o operador da federação que já
 * os vê na tela, e sem eles o relatório não serve para conferir. CPF NÃO sai, e
 * não é consultado: ele mora em tabela própria e não participa desta pergunta.
 * A DATABASE_URL não é impressa, nem parcialmente.
 */
const prisma = require('../src/config/prisma');
const { withUserContext } = require('../src/config/rlsSession');

const argumento = (nome, padrao = null) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : padrao;
};
const temBandeira = nome => process.argv.includes(`--${nome}`);

/**
 * A NORMALIZAÇÃO DA MATRÍCULA, e o que ela deliberadamente NÃO faz.
 *
 * Apara espaço em volta — "2932", " 2932 " e "2932\t" são a mesma digitação do
 * mesmo número, e tratá-los como três identificadores separaria o atleta pelo
 * branco que alguém deixou na planilha.
 *
 * NÃO converte para número, e isto é a parte importante: `Number('02932')` é
 * 2932, e gravar de volta perderia o zero à esquerda. Pior, fundiria "02932" e
 * "2932", que podem ser matrículas LEGÍTIMAS E DIFERENTES. Separar um atleta em
 * dois é um aborrecimento; juntar dois atletas num só apaga a carreira de
 * alguém. Na dúvida, o lado seguro é não fundir.
 *
 * Também não remove zeros, não troca maiúsculas, não tira pontuação: nada que
 * possa transformar dois identificadores diferentes num só.
 */
const normalizarMatricula = valor => {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto.length ? texto : null;
};

/** Só para EXIBIR variações de nome. Nunca para decidir identidade. */
const normalizarNome = nome => String(nome ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const linha = (rotulo, valor) => console.log(`  ${String(rotulo).padEnd(34)} ${valor}`);
const titulo = texto => console.log(`\n${texto}\n${'─'.repeat(texto.length)}`);

async function diagnosticar({ matricula, filiacaoCodigo, actorId }) {
  return withUserContext(actorId, async tx => {
    const ator = await tx.user.findUnique({
      where: { id: actorId },
      select: { id: true, organizationId: true, role: true }
    });
    if (!ator) throw new Error('Ator não encontrado, ou invisível sob a política de leitura.');

    const escopo = { organizationId: ator.organizationId };

    const filiacoes = await tx.affiliation.findMany({
      where: filiacaoCodigo
        ? { ...escopo, code: filiacaoCodigo.toUpperCase() }
        : escopo,
      select: { id: true, name: true, code: true }
    });
    const nomeDaFiliacao = new Map(filiacoes.map(f => [f.id, `${f.code} — ${f.name}`]));

    // ---------------------------------------------------------- cadastros
    // A busca é por matrícula; a filiação entra como RECORTE opcional, não
    // como suposição. Sem ela, o relatório mostra se a mesma matrícula aparece
    // sob filiações diferentes — que é um caso legítimo e que NÃO deve ser
    // consolidado.
    const cadastros = await tx.athlete.findMany({
      where: {
        ...escopo,
        affiliationNumber: matricula,
        ...(filiacaoCodigo ? { affiliationId: { in: filiacoes.map(f => f.id) } } : {})
      },
      select: {
        id: true, fullName: true, stageName: true, status: true,
        affiliationId: true, affiliationNumber: true, createdAt: true
      },
      orderBy: { createdAt: 'asc' }
    });

    // --------------------------------------------- identidades esportivas
    const identidades = await tx.externalAthlete.findMany({
      where: {
        ...escopo,
        affiliationNumber: matricula,
        ...(filiacaoCodigo ? { affiliationId: { in: filiacoes.map(f => f.id) } } : {})
      },
      select: {
        id: true, identityKey: true, displayName: true, source: true,
        affiliationId: true, affiliationNumber: true, athleteId: true, linkedAt: true
      },
      orderBy: { createdAt: 'asc' }
    });

    // ------------------------------------------------------- resultados
    const idsDeIdentidade = identidades.map(i => i.id);
    const idsDeCadastro = cadastros.map(c => c.id);

    const resultados = idsDeIdentidade.length || idsDeCadastro.length
      ? await tx.externalResult.findMany({
        where: {
          ...escopo,
          OR: [
            ...(idsDeIdentidade.length ? [{ externalAthleteId: { in: idsDeIdentidade } }] : []),
            ...(idsDeCadastro.length ? [{ athleteId: { in: idsDeCadastro } }] : [])
          ]
        },
        // `ExternalResult` NÃO tem nome nem marca de Overall: o nome mora na
        // identidade (`ExternalAthlete.displayName`) e o Overall mora no
        // lançamento (`RankingPoint.isOverallChampion` / `overallBonus`).
        // Conferido no schema, não suposto.
        select: {
          id: true, eventName: true, eventDate: true,
          categoryCode: true, className: true, placing: true, points: true,
          athleteId: true, externalAthleteId: true, seasonId: true
        },
        orderBy: [{ eventDate: 'asc' }, { id: 'asc' }]
      })
      : [];

    // ------------------------------------------------------- pontuação
    const lancamentos = idsDeIdentidade.length || idsDeCadastro.length
      ? await tx.rankingPoint.findMany({
        where: {
          ...escopo,
          OR: [
            ...(idsDeIdentidade.length ? [{ externalAthleteId: { in: idsDeIdentidade } }] : []),
            ...(idsDeCadastro.length ? [{ athleteId: { in: idsDeCadastro } }] : [])
          ]
        },
        select: {
          id: true, seasonId: true, athleteId: true, externalAthleteId: true,
          points: true, superOverallPoints: true, placing: true,
          placementPoints: true, overallBonus: true, adjustmentPoints: true,
          isOverallChampion: true, source: true, categoryId: true,
          eventId: true, externalResultId: true
        }
      })
      : [];

    // -------- identidades ÓRFÃS cujo nome coincide: EVIDÊNCIA, não ação
    //
    // Isto é o único lugar do script que olha para nome, e ele serve para
    // MEDIR o tamanho do problema: resultados que vieram sem matrícula e por
    // isso não são alcançáveis por identificador nenhum. A lista é para o
    // operador conferir uma a uma — o script não vincula nada.
    const nomesConhecidos = new Set([
      ...cadastros.map(c => normalizarNome(c.fullName)),
      ...identidades.map(i => normalizarNome(i.displayName))
    ].filter(Boolean));

    const orfas = nomesConhecidos.size
      ? (await tx.externalAthlete.findMany({
        where: { ...escopo, athleteId: null, affiliationNumber: null },
        select: { id: true, identityKey: true, displayName: true, createdAt: true },
        take: 2000
      })).filter(i => nomesConhecidos.has(normalizarNome(i.displayName)))
      : [];

    return { ator, matricula, filiacaoCodigo, nomeDaFiliacao, cadastros, identidades, resultados, lancamentos, orfas };
  });
}

function relatar(d) {
  const porFiliacao = new Map();
  for (const c of d.cadastros) {
    const chave = c.affiliationId ?? 'SEM-FILIAÇÃO';
    if (!porFiliacao.has(chave)) porFiliacao.set(chave, { cadastros: [], identidades: [] });
    porFiliacao.get(chave).cadastros.push(c);
  }
  for (const i of d.identidades) {
    const chave = i.affiliationId ?? 'SEM-FILIAÇÃO';
    if (!porFiliacao.has(chave)) porFiliacao.set(chave, { cadastros: [], identidades: [] });
    porFiliacao.get(chave).identidades.push(i);
  }

  titulo(`MATRÍCULA ${d.matricula}${d.filiacaoCodigo ? ` · filiação ${d.filiacaoCodigo}` : ' · todas as filiações'}`);
  linha('organização do ator', d.ator.organizationId);
  linha('cadastros encontrados', d.cadastros.length);
  linha('identidades esportivas', d.identidades.length);
  linha('resultados importados', d.resultados.length);
  linha('lançamentos de pontos', d.lancamentos.length);

  // ---- a conta que responde a pergunta
  titulo('QUANTOS COMPETIDORES O SISTEMA CONTA HOJE');
  const competidores = new Set([
    ...d.lancamentos.map(p => p.athleteId ? `ATLETA:${p.athleteId}` : `IDENTIDADE:${p.externalAthleteId}`)
  ]);
  linha('competidores distintos na pontuação', competidores.size);
  for (const c of [...competidores].sort()) linha('  ·', c);
  linha('filiações envolvidas', porFiliacao.size);
  console.log(
    porFiliacao.size > 1
      ? '\n  ATENÇÃO: a matrícula aparece sob MAIS DE UMA filiação. Isto pode ser legítimo —\n'
        + '  federações diferentes emitem números iguais — e NÃO deve ser consolidado sem\n'
        + '  conferir com o domínio. Consolidar aqui juntaria duas pessoas.'
      : '\n  Uma única filiação: dentro dela, esta matrícula é um atleta só.'
  );

  // ---- variações de nome: a evidência pedida
  titulo('VARIAÇÕES DE NOME SOB O MESMO IDENTIFICADOR');
  const variacoes = new Map();
  const anotar = (nome, origem) => {
    if (!nome) return;
    const chave = normalizarNome(nome);
    if (!variacoes.has(chave)) variacoes.set(chave, { exemplos: new Set(), origens: new Set() });
    variacoes.get(chave).exemplos.add(nome);
    variacoes.get(chave).origens.add(origem);
  };
  for (const c of d.cadastros) anotar(c.fullName, 'cadastro');
  for (const i of d.identidades) anotar(i.displayName, 'identidade');

  linha('grafias distintas', variacoes.size);
  for (const [, v] of variacoes) {
    linha(`  ${[...v.exemplos].join(' / ')}`, `(${[...v.origens].join(', ')})`);
  }
  if (variacoes.size > 1) {
    console.log('\n  Mais de uma grafia para o MESMO identificador. Pela regra homologada,'
      + '\n  isto é UMA pessoa: a matrícula prevalece sobre o nome.');
  }

  // ---- histórico, evento a evento
  titulo('HISTÓRICO — EVENTO A EVENTO');
  if (!d.resultados.length) console.log('  (nenhum resultado importado alcançável por este identificador)');
  // O Overall de cada resultado vem do LANÇAMENTO correspondente, que é onde
  // ele existe — `ExternalResult` não carrega essa marca.
  const lancamentoDoResultado = new Map(
    d.lancamentos.filter(p => p.externalResultId).map(p => [p.externalResultId, p])
  );
  for (const r of d.resultados) {
    const data = r.eventDate ? new Date(r.eventDate).toISOString().slice(0, 10) : '—';
    const dono = r.athleteId ? `atleta ${r.athleteId}` : `identidade ${r.externalAthleteId ?? '—'}`;
    const ponto = lancamentoDoResultado.get(r.id);
    const overall = ponto?.isOverallChampion ? 'OVERALL  ' : '         ';
    console.log(`  ${data}  ${String(r.eventName ?? '—').padEnd(38).slice(0, 38)}  `
      + `${String(r.categoryCode ?? '—').padEnd(10)} ${String(r.className ?? '—').padEnd(12)} `
      + `${String(r.placing ?? '—').padStart(3)}º  ${String(r.points ?? 0).padStart(4)} pt  `
      + `${overall}${dono}`);
  }

  // ---- pontuação consolidada e por competidor
  titulo('PONTUAÇÃO');
  const soma = (lista, campo) => lista.reduce((t, p) => t + (p[campo] ?? 0), 0);
  linha('pontos de colocação (total)', soma(d.lancamentos, 'points'));
  linha('pontos de Super Overall (total)', soma(d.lancamentos, 'superOverallPoints'));
  console.log('\n  Como ESTÁ hoje, repartido por competidor:');
  for (const chave of [...competidores].sort()) {
    const doCompetidor = d.lancamentos.filter(p =>
      (p.athleteId ? `ATLETA:${p.athleteId}` : `IDENTIDADE:${p.externalAthleteId}`) === chave);
    linha(`  ${chave}`,
      `${soma(doCompetidor, 'points')} pt de colocação · ${soma(doCompetidor, 'superOverallPoints')} pt de Overall · ${doCompetidor.length} lançamento(s)`);
  }

  // ---- o que ficou fora do alcance do identificador
  titulo('RESULTADOS SEM MATRÍCULA COM NOME COINCIDENTE');
  console.log('  Estes NÃO são alcançáveis por identificador: o arquivo veio sem matrícula e');
  console.log('  cada linha virou uma identidade própria. A lista é EVIDÊNCIA para conferência');
  console.log('  humana — o script não vincula nada, e nome sozinho não é prova.\n');
  if (!d.orfas.length) console.log('  (nenhuma)');
  for (const o of d.orfas) linha(`  ${o.displayName}`, o.identityKey);

  titulo('VEREDITO');
  const partido = competidores.size > 1 && porFiliacao.size === 1;
  if (partido) {
    console.log(`  PARTIDO — a matrícula ${d.matricula} está repartida em ${competidores.size} competidores`);
    console.log('  dentro da MESMA filiação. Pela regra homologada deveria ser 1.');
  } else if (competidores.size === 1) {
    console.log(`  CONSOLIDADO — a matrícula ${d.matricula} responde por 1 competidor só.`);
  } else if (competidores.size === 0) {
    console.log(`  SEM PONTUAÇÃO — a matrícula ${d.matricula} não tem lançamento de pontos.`);
  } else {
    console.log(`  AMBÍGUO — ${competidores.size} competidores sob ${porFiliacao.size} filiações.`);
    console.log('  Consolidar sem conferir o domínio juntaria pessoas diferentes.');
  }
  if (d.orfas.length) {
    console.log(`\n  E mais ${d.orfas.length} identidade(s) sem matrícula com nome coincidente, que`);
    console.log('  nenhuma correção automática por identificador alcança.');
  }
  console.log('\n  NADA FOI ALTERADO por este script.');
}

async function principal() {
  const matricula = normalizarMatricula(argumento('matricula'));
  const actorId = argumento('ator');
  const filiacaoCodigo = argumento('filiacao');

  if (!matricula || !actorId) {
    console.error('Uso: node scripts/diagnostico-identidade-do-atleta.js --matricula <nº> --ator <userId> [--filiacao <CÓDIGO>] [--json]');
    process.exitCode = 1;
    return;
  }

  const dados = await diagnosticar({ matricula, filiacaoCodigo, actorId });

  if (temBandeira('json')) {
    console.log(JSON.stringify({
      matricula: dados.matricula,
      filiacao: dados.filiacaoCodigo,
      cadastros: dados.cadastros,
      identidades: dados.identidades,
      resultados: dados.resultados,
      lancamentos: dados.lancamentos,
      orfasComNomeCoincidente: dados.orfas
    }, null, 2));
    return;
  }
  relatar(dados);
}

if (require.main === module) {
  principal()
    .catch(erro => { console.error(`FALHA: ${erro.message}`); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}

module.exports = { normalizarMatricula, normalizarNome };
