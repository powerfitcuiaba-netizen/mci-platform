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

async function diagnosticar({ matricula, filiacaoCodigo, actorId, organizacaoPedida }) {
  return withUserContext(actorId, async tx => {
    // A ORGANIZAÇÃO NÃO MORA EM `User`. Ela vem dos vínculos
    // (`OrganizationMember`), e um administrador de plataforma pode não ter
    // vínculo nenhum. Por isso `--organizacao` existe: sem ele, o escopo sai
    // do vínculo único do ator; com mais de um, o script PARA e pede, em vez
    // de escolher um por conta própria e relatar a organização errada.
    const ator = await tx.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true, serviceOrganizationId: true,
        memberships: { select: { organizationId: true, role: true } } }
    });
    if (!ator) throw new Error('Ator não encontrado, ou invisível sob a política de leitura.');

    const candidatas = [...new Set([
      ...(organizacaoPedida ? [organizacaoPedida] : []),
      ...(ator.serviceOrganizationId ? [ator.serviceOrganizationId] : []),
      ...ator.memberships.map(m => m.organizationId)
    ])];
    const organizationId = organizacaoPedida ?? candidatas[0] ?? null;
    if (!organizationId) {
      throw new Error('Sem organização: o ator não tem vínculo. Passe --organizacao <id>.');
    }
    if (!organizacaoPedida && candidatas.length > 1) {
      throw new Error(`O ator tem ${candidatas.length} organizações. Passe --organizacao <id> para dizer qual.`);
    }

    const escopo = { organizationId };

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

    // -------------------------------- AS LINHAS DO ARQUIVO, pelo NÚMERO CRU
    //
    // POR QUE ESTA CONSULTA EXISTE, e por que ela não podia faltar
    //
    // Tudo acima procura por `affiliationNumber` em `ExternalAthlete` e em
    // `Athlete`. Isso só encontra quem JÁ TEM identidade formada — e o caso que
    // mais importa é exatamente o contrário: a linha cujo número o sistema
    // leu, mas cuja identidade saiu `EXT:` porque a filiação faltou. Nessa
    // linha, `ExternalAthlete.affiliationNumber` é NULO, e as consultas de cima
    // devolvem vazio.
    //
    // O resultado era um diagnóstico que dizia "nenhum resultado alcançável por
    // este identificador" para um atleta que TEM resultado — só que órfão. Um
    // relatório que não distingue "não existe" de "existe e eu não alcanço"
    // não serve para investigar nada.
    //
    // `MuscleWarImportItem` guarda o que o ARQUIVO disse: `memberNumber`,
    // `affiliationCode`, `matchStatus`, `matchedBy` e `reason` — o motivo
    // escrito pelo próprio sistema no momento em que decidiu vincular ou não.
    // E guarda `raw`, a linha inteira como veio. É aqui que a resposta mora.
    const linhasDoArquivo = await tx.muscleWarImportItem.findMany({
      where: { memberNumber: matricula, import: { organizationId } },
      select: {
        id: true, rowNumber: true, externalResultId: true,
        athleteName: true, affiliationCode: true, memberNumber: true,
        categoryCode: true, className: true, placing: true, isOverallChampion: true,
        matchStatus: true, matchedBy: true, reason: true,
        athleteId: true, suggestedAthleteId: true, linkedAt: true, raw: true,
        import: { select: { id: true, sourceRef: true, status: true, eventId: true, createdAt: true } }
      },
      orderBy: [{ createdAt: 'asc' }, { rowNumber: 'asc' }]
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

    return { ator, organizationId, matricula, filiacaoCodigo, nomeDaFiliacao, cadastros, identidades, resultados, lancamentos, orfas, linhasDoArquivo };
  });
}

// ============================================================================
// AS SEIS GAVETAS DE UM RESULTADO.
//
// A homologação pede que CADA resultado saia classificado, e a classificação
// não pode ser opinião: ela é função dos dados do próprio resultado, da
// identidade esportiva que o carrega e dos cadastros que existem para aquele
// PAR filiação + matrícula. Por isso é uma função PURA, testável sem banco —
// quem quiser conferir a regra não precisa subir PostgreSQL para ler uma
// gaveta.
//
// A ordem das regras importa, e a primeira que casa decide. Duplicata vem
// antes de tudo porque ela invalida qualquer leitura das outras; ausência de
// matrícula vem antes de ambiguidade porque sem identificador não há par a
// disputar.
// ============================================================================
const GAVETAS = Object.freeze({
  CONSOLIDADO: 'CONSOLIDADO',
  VINCULAVEL: 'SEPARADO MAS IDENTIFICÁVEL POR MATRÍCULA',
  SEM_MATRICULA: 'SEM MATRÍCULA',
  AMBIGUO: 'AMBÍGUO',
  DUPLICADO: 'DUPLICADO',
  OUTRO: 'OUTRO'
});

/**
 * A assinatura que delata repetição: o MESMO evento, a MESMA classe e a MESMA
 * colocação aparecendo duas vezes sob a mesma matrícula.
 *
 * NÃO é prova de duplicata — dois resultados legítimos podem coincidir nos três
 * campos se o arquivo trouxer o evento com nomes diferentes, ou se houver duas
 * etapas homônimas. É SINAL, e o relatório diz isso com estas palavras. A
 * unicidade de `(source, externalId)` no banco já impede a duplicata literal.
 */
const assinaturaDoResultado = r =>
  [String(r.eventName ?? '').trim().toUpperCase(),
    String(r.className ?? '').trim().toUpperCase(),
    r.placing ?? ''].join('|');

function classificarResultado(resultado, { identidade, cadastrosDoPar = [], assinaturasRepetidas = new Set() } = {}) {
  if (assinaturasRepetidas.has(assinaturaDoResultado(resultado))) {
    return { gaveta: GAVETAS.DUPLICADO,
      porque: 'mesmo evento, classe e colocação aparecem mais de uma vez sob esta matrícula — SINAL, não prova' };
  }

  if (!identidade) {
    return { gaveta: GAVETAS.OUTRO,
      porque: 'resultado sem identidade esportiva associada' };
  }

  if (!identidade.affiliationNumber) {
    return { gaveta: GAVETAS.SEM_MATRICULA,
      porque: 'o arquivo veio sem matrícula: nenhuma regra automática por identificador alcança esta linha' };
  }

  if (cadastrosDoPar.length > 1) {
    return { gaveta: GAVETAS.AMBIGUO,
      porque: `${cadastrosDoPar.length} cadastros para o mesmo par filiação + matrícula — quem decide é gente` };
  }

  if (resultado.athleteId) {
    if (cadastrosDoPar.length === 1 && resultado.athleteId === cadastrosDoPar[0].id) {
      return { gaveta: GAVETAS.CONSOLIDADO, porque: 'o resultado aponta para o cadastro do par' };
    }
    return { gaveta: GAVETAS.AMBIGUO,
      porque: 'o resultado tem dono, e o dono NÃO é o cadastro deste par — trocar dono é outra operação' };
  }

  if (cadastrosDoPar.length === 1) {
    return { gaveta: GAVETAS.VINCULAVEL,
      porque: 'identidade inequívoca: um cadastro, um par, nenhum conflito — consolidação automática' };
  }

  return { gaveta: GAVETAS.OUTRO,
    porque: 'histórico com matrícula e ainda sem cadastro: vincula sozinho no instante em que ele existir' };
}

/** Monta o contexto de classificação e devolve cada resultado com a sua gaveta. */
function classificarTudo(d) {
  const identidadePorId = new Map(d.identidades.map(i => [i.id, i]));

  const cadastrosPorPar = new Map();
  for (const c of d.cadastros) {
    const par = `${c.affiliationId ?? '—'}|${c.affiliationNumber ?? '—'}`;
    if (!cadastrosPorPar.has(par)) cadastrosPorPar.set(par, []);
    cadastrosPorPar.get(par).push(c);
  }

  const vezes = new Map();
  for (const r of d.resultados) {
    const a = assinaturaDoResultado(r);
    vezes.set(a, (vezes.get(a) ?? 0) + 1);
  }
  const assinaturasRepetidas = new Set([...vezes].filter(([, n]) => n > 1).map(([a]) => a));

  return d.resultados.map(r => {
    const identidade = r.externalAthleteId ? identidadePorId.get(r.externalAthleteId) : null;
    const par = identidade
      ? `${identidade.affiliationId ?? '—'}|${identidade.affiliationNumber ?? '—'}`
      : null;
    const cadastrosDoPar = par ? (cadastrosPorPar.get(par) ?? []) : [];
    return {
      resultado: r,
      identidade,
      ...classificarResultado(r, { identidade, cadastrosDoPar, assinaturasRepetidas })
    };
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
  linha('organização', d.organizationId);
  linha('cadastros encontrados', d.cadastros.length);
  linha('identidades esportivas', d.identidades.length);
  linha('resultados importados', d.resultados.length);
  linha('lançamentos de pontos', d.lancamentos.length);

  // ---- O RELATÓRIO "ANTES" QUE A HOMOLOGAÇÃO PEDE, nos quatro números dela
  titulo('ANTES — o estado atual, sem nenhuma alteração');
  const somar = (lista, campo) => lista.reduce((t, p) => t + (p[campo] ?? 0), 0);
  linha('quantidade de identidades', d.identidades.length);
  linha('quantidade de resultados', d.resultados.length);
  linha('quantidade de lançamentos', d.lancamentos.length);
  linha('pontuação de colocação', somar(d.lancamentos, 'points'));
  linha('pontuação de Super Overall', somar(d.lancamentos, 'superOverallPoints'));
  linha('identidades já com dono', d.identidades.filter(i => i.athleteId).length);
  linha('resultados já com dono', d.resultados.filter(r => r.athleteId).length);
  linha('lançamentos já com dono', d.lancamentos.filter(p => p.athleteId).length);

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

  // ---- histórico, evento a evento, COM TODOS OS CAMPOS PEDIDOS
  // ==========================================================================
  // A LINHA DO ARQUIVO — o que a origem disse, e o que o sistema decidiu.
  //
  // Esta seção vem ANTES do histórico de propósito: ela encontra a linha pelo
  // NÚMERO CRU, sem depender de identidade formada. É a única que enxerga o
  // resultado cuja identidade saiu `EXT:` — e é justamente esse que não
  // aparece no perfil do atleta e que se quer investigar.
  //
  // `motivo` é o texto que o PRÓPRIO sistema escreveu quando analisou a linha.
  // Não é dedução deste relatório: é o registro da decisão.
  // ==========================================================================
  titulo(`A LINHA DO ARQUIVO — ${d.linhasDoArquivo.length} com o número ${d.matricula}`);
  if (!d.linhasDoArquivo.length) {
    console.log('  (nenhuma linha de importação trouxe este número — o arquivo não o informou,');
    console.log('   ou o parser não leu a coluna. Confira `raw` de um lote do mesmo evento.)');
  }
  for (const l of d.linhasDoArquivo) {
    console.log(`\n  lote ${l.import.sourceRef} · linha ${l.rowNumber} · ${l.import.status}`);
    linha('  nome no arquivo', l.athleteName ?? '—');
    linha('  entidade lida', l.affiliationCode ?? '(AUSENTE — é isto que quebra a identidade)');
    linha('  número lido', l.memberNumber ?? '—');
    linha('  categoria / classe', `${l.categoryCode ?? '—'} / ${l.className ?? '—'}`);
    linha('  colocação', l.placing != null ? `${l.placing}º` : '—');
    linha('  Overall no arquivo', l.isOverallChampion ? 'SIM' : 'não');
    linha('  situação', l.matchStatus);
    linha('  reconhecido por', l.matchedBy ?? '(nenhuma chave reconheceu)');
    linha('  MOTIVO REGISTRADO', l.reason ?? '—');
    linha('  atleta vinculado', l.athleteId ?? '(nenhum)');
    linha('  sugestão por nome', l.suggestedAthleteId ?? '(nenhuma)');
    linha('  vinculado em', l.linkedAt ? new Date(l.linkedAt).toISOString() : '(nunca)');
    linha('  id do resultado', l.externalResultId);
    linha('  evento do lote', l.import.eventId ?? '(lote sem evento)');
    // As CHAVES do arquivo original, não os valores: o cabeçalho é o que
    // explica uma coluna não lida, e os valores podem carregar dado pessoal.
    const chaves = l.raw && typeof l.raw === 'object' ? Object.keys(l.raw) : [];
    linha('  colunas do arquivo', chaves.length ? chaves.join(', ') : '—');
  }

  titulo('HISTÓRICO — EVENTO A EVENTO, COM A GAVETA DE CADA RESULTADO');
  if (!d.resultados.length) console.log('  (nenhum resultado importado alcançável por este identificador)');

  // O Overall de cada resultado vem do LANÇAMENTO correspondente, que é onde
  // ele existe — `ExternalResult` não carrega essa marca.
  const lancamentoDoResultado = new Map(
    d.lancamentos.filter(p => p.externalResultId).map(p => [p.externalResultId, p])
  );

  const classificados = classificarTudo(d);
  const porGaveta = new Map();
  for (const item of classificados) {
    if (!porGaveta.has(item.gaveta)) porGaveta.set(item.gaveta, []);
    porGaveta.get(item.gaveta).push(item);
  }

  for (const item of classificados) {
    const r = item.resultado;
    const ponto = lancamentoDoResultado.get(r.id);
    const data = r.eventDate ? new Date(r.eventDate).toISOString().slice(0, 10) : '—';
    console.log(`\n  ${data}  ${r.eventName ?? '—'}`);
    linha('  gaveta', `${item.gaveta} — ${item.porque}`);
    linha('  categoria / classe', `${r.categoryCode ?? '—'} / ${r.className ?? '—'}`);
    linha('  colocação', r.placing != null ? `${r.placing}º` : '—');
    linha('  pontos de colocação', ponto?.placementPoints ?? r.points ?? 0);
    linha('  Overall', ponto?.isOverallChampion
      ? `SIM · bônus ${ponto.overallBonus ?? 0} · Super Overall ${ponto.superOverallPoints ?? 0}`
      : 'não');
    linha('  ajuste', ponto?.adjustmentPoints ?? 0);
    // O nome ORIGINAL da inscrição mora na identidade esportiva; o cadastro tem
    // o nome canônico. Os dois aparecem porque é a divergência entre eles que o
    // operador precisa ver — e que NÃO decide nada.
    linha('  nome na fonte', item.identidade?.displayName ?? '—');
    linha('  matrícula encontrada', item.identidade?.affiliationNumber ?? '(ausente)');
    linha('  filiação encontrada', item.identidade?.affiliationId
      ? (d.nomeDaFiliacao.get(item.identidade.affiliationId) ?? item.identidade.affiliationId)
      : '(ausente)');
    linha('  origem', `${ponto?.source ?? item.identidade?.source ?? '—'} · ${item.identidade?.identityKey ?? '—'}`);
    linha('  identidade associada', item.identidade?.id ?? '—');
    linha('  status do vínculo', r.athleteId
      ? `VINCULADO ao cadastro ${r.athleteId}`
      : 'SEM DONO');
  }

  titulo('CLASSIFICAÇÃO — QUANTOS EM CADA GAVETA');
  for (const gaveta of Object.values(GAVETAS)) {
    linha(gaveta, (porGaveta.get(gaveta) ?? []).length);
  }
  const vinculaveis = porGaveta.get(GAVETAS.VINCULAVEL) ?? [];
  if (vinculaveis.length) {
    console.log(`\n  ${vinculaveis.length} resultado(s) são VINCULÁVEIS por matrícula, de forma inequívoca.`);
    console.log('  Pela regra homologada eles consolidam SOZINHOS — sem clique humano — e o');
    console.log('  caminho que faz isso roda na criação do cadastro, na aprovação do');
    console.log('  autocadastro e na correção da matrícula pelo perfil. Se eles estão aqui,');
    console.log('  algum desses três caminhos não passou por este dado: reexecute a correção');
    console.log('  da matrícula no perfil e rode o diagnóstico de novo.');
  }
  const ambiguos = porGaveta.get(GAVETAS.AMBIGUO) ?? [];
  if (ambiguos.length) {
    console.log(`\n  ${ambiguos.length} resultado(s) AMBÍGUOS. Nenhuma regra automática os toca —`);
    console.log('  e nenhuma deve. Eles vão para conferência humana com as evidências acima.');
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
  const organizacaoPedida = argumento('organizacao');

  if (!matricula || !actorId) {
    console.error('Uso: node scripts/diagnostico-identidade-do-atleta.js --matricula <nº> --ator <userId> [--organizacao <id>] [--filiacao <CÓDIGO>] [--json]');
    process.exitCode = 1;
    return;
  }

  const dados = await diagnosticar({ matricula, filiacaoCodigo, actorId, organizacaoPedida });

  if (temBandeira('json')) {
    console.log(JSON.stringify({
      matricula: dados.matricula,
      filiacao: dados.filiacaoCodigo,
      cadastros: dados.cadastros,
      identidades: dados.identidades,
      resultados: dados.resultados,
      lancamentos: dados.lancamentos,
      orfasComNomeCoincidente: dados.orfas,
      classificacao: classificarTudo(dados).map(item => ({
        resultadoId: item.resultado.id,
        gaveta: item.gaveta,
        porque: item.porque,
        identidadeId: item.identidade?.id ?? null,
        matricula: item.identidade?.affiliationNumber ?? null,
        athleteId: item.resultado.athleteId ?? null
      }))
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

module.exports = {
  normalizarMatricula, normalizarNome,
  GAVETAS, assinaturaDoResultado, classificarResultado, classificarTudo
};
