const prisma = require('../config/prisma');
const { AppError, ehViolacaoDeUnicidade } = require('../utils/errors');
const { assertCan } = require('../utils/tenant');
const { isValidCpf } = require('../utils/cpf');
const adapter = require('../utils/musclewar/adapter');
const audit = require('./auditService');
const logger = require('../utils/logger');
const notifications = require('./notificationService');
const ranking = require('./rankingService');
const { pontuarResultado, conferirPontuacaoImportada } = require('../utils/rankingScoring');

const SOURCE = 'MUSCLEWAR';

// Quantas linhas uma importação aceita. O porquê do número está onde ele é
// aplicado, em `createImport`.
const MAXIMO_DE_LINHAS = 20000;

// ============================================================================
// Importação de resultados do MuscleWar.
//
// O MCI não replica o MuscleWar: recebe dele o necessário para reconhecer o
// atleta, identificar o recorte de competição e trazer resultado e pontuação
// para o histórico e o ranking.
//
// Reconhecimento: CPF é a primeira chave; filiação é a segunda, usada para
// confirmar o vínculo quando informada. Atleta não encontrado NUNCA é criado
// em silêncio: vai para MATCH_PENDING e espera vinculação manual.
//
// Idempotência: `ExternalResult(source, externalId)` é único. Reimportar o
// mesmo resultado não gera segunda pontuação.
// ============================================================================

// Resumo de um candidato para a revisão. SÓ o que o operador precisa para
// decidir: quem é, por qual chave apareceu e qual filiação/matrícula tem. Nada
// de telefone, e-mail, endereço ou CPF — a tela de revisão resolve identidade,
// não consulta cadastro.
// Projeção mínima do atleta para o reconhecimento e a revisão. `select` e não
// `include`: sem isto a linha inteira do atleta — telefone, e-mail, endereço —
// era carregada a cada registro do arquivo, para usar três campos.
const RESUMO_DE_ATLETA = Object.freeze({
  id: true, fullName: true, affiliationNumber: true,
  affiliation: { select: { id: true, name: true, code: true, active: true } }
});

function resumoDeCandidato(athlete, matchedBy) {
  return {
    matchedBy,
    athleteId: athlete.id,
    fullName: athlete.fullName,
    affiliationNumber: athlete.affiliationNumber ?? null,
    affiliation: athlete.affiliation
      ? { id: athlete.affiliation.id, code: athlete.affiliation.code }
      : null
  };
}

// Chave 1: o PAR filiação + matrícula. Uma sem a outra não identifica ninguém
// — duas federações emitem o mesmo número, e uma federação tem milhares de
// filiados.
//
// As duas, sempre. Exigir só a matrícula é observável: a entidade seria
// procurada por um código indefinido, e isso não é "não encontrei".
// Devolve SEMPRE uma lista — vazia, com um, ou com vários. Devolver `null`
// num caminho e lista noutro obrigaria cada chamador a lembrar dos dois, e o
// esquecimento não aparece em revisão: aparece como `null.length` em produção.
function atletasPorFiliacao(indice, registro) {
  if (!registro.affiliationCode || !registro.memberNumber) return [];

  const filiacaoId = indice.filiacoesPorCodigo.get(String(registro.affiliationCode).toUpperCase());
  if (!filiacaoId) return [];

  return indice.atletasPorMatricula.get(`${filiacaoId}|${registro.memberNumber}`) ?? [];
}

// Chave 2: a identidade já vinculada. O CPF vive em AthleteIdentity, sob RLS.
function atletaPorCpf(indice, cpf) {
  if (!cpf) return null;
  const athleteId = indice.atletaPorCpf.get(cpf);
  return athleteId ? (indice.atletasPorId.get(athleteId) ?? null) : null;
}

// Acento, caixa e espaço repetido não separam o mesmo nome — e também não
// unem nomes diferentes. A normalização é conservadora de propósito: nada de
// distância de edição, apelido ou abreviação, porque a saída daqui alimenta
// uma SUGESTÃO que um humano confirma, e uma sugestão errada custa a atenção
// de quem revisa.
function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Chave 3: o nome. NUNCA reconhece, NUNCA cria atleta — devolve uma pista.
//
// Duas atletas chamadas "Ana Silva" existem. Reconhecer pela semelhança
// fundiria duas carreiras num cadastro só, e o erro só apareceria quando uma
// delas fosse ver o próprio histórico. Por isso: nome único bate → sugestão;
// mais de um bate → sugestão NENHUMA, porque escolher entre as duas seria
// decidir no lugar de quem tem competência.
async function sugerirPorNome(indice, athleteName) {
  const alvo = normalizarNome(athleteName);
  if (!alvo) {
    return { athleteId: null, reason: 'Sem CPF, sem filiação/matrícula e sem nome: nada a reconhecer' };
  }

  const iguais = await indice.homonimosDe(alvo);

  if (iguais.length === 1) {
    return {
      athleteId: iguais[0].id,
      reason: `Sem CPF nem filiação/matrícula. Nome confere com ${iguais[0].fullName} — `
        + 'confirme o vínculo manualmente: semelhança de nome não reconhece atleta.'
    };
  }
  if (iguais.length > 1) {
    return {
      athleteId: null,
      reason: `Nome "${athleteName}" corresponde a mais de um atleta cadastrado (homônimos). `
        + 'Nenhuma sugestão foi feita: escolher entre eles é decisão do operador.'
    };
  }
  return { athleteId: null, reason: `Atleta não encontrado por CPF, filiação/matrícula ou nome ("${athleteName}")` };
}


// ============================================================================
// ÍNDICE DO LOTE — por que a análise deixou de consultar o banco por linha.
//
// A FASE 13.6 mediu: com 1.000 linhas, a criação da importação devolvia 500.
// O log do servidor dava a causa — P2028, prazo da transação esgotado. A
// requisição inteira roda numa transação (é assim que o ator de RLS é
// definido), com prazo padrão de 5 segundos, e a análise gastava entre cinco e
// sete idas ao banco POR LINHA. Pior: a linha sem chave carregava o cadastro
// INTEIRO de atletas da organização para procurar homônimo — de novo, por
// linha.
//
// Não era lentidão, era recusa: o operador subia o arquivo do campeonato e
// recebia "erro interno", sem nada importado.
//
// Aqui tudo o que a análise precisa é carregado de uma vez, com um número de
// consultas que depende das CHAVES DISTINTAS do arquivo, não da quantidade de
// linhas. A regra de reconhecimento não muda em nada — a mesma cadeia, na
// mesma ordem, com os mesmos conflitos. O que muda é de onde a resposta vem.
//
// O índice de nomes é PREGUIÇOSO: só nasce se alguma linha chegar sem chave
// nenhuma, que é quando o nome entra em cena. Um arquivo bem formado nunca
// paga por ele.
// ============================================================================

// `IN (...)` tem teto: o PostgreSQL aceita no máximo 65.535 parâmetros por
// instrução, e um arquivo grande estoura isso com folga. Partir em lotes é o
// que mantém a consulta legal sem voltar a consultar por linha.
const TAMANHO_DO_LOTE_DE_CHAVES = 5000;

async function emLotes(valores, consultar) {
  const saida = [];
  for (let i = 0; i < valores.length; i += TAMANHO_DO_LOTE_DE_CHAVES) {
    saida.push(...await consultar(valores.slice(i, i + TAMANHO_DO_LOTE_DE_CHAVES)));
  }
  return saida;
}

const distintos = (registros, extrair) => [
  ...new Set(registros.map(extrair).filter(valor => valor != null && valor !== ''))
];

async function montarIndiceDoLote(registros, organizationId, seasonId) {
  const idsExternos = distintos(registros, r => r.externalResultId);
  const cpfs = distintos(registros, r => r.cpf);
  const codigosDeFiliacao = distintos(registros, r => String(r.affiliationCode).toUpperCase());
  const matriculas = distintos(registros, r => r.memberNumber);
  const codigosDeCategoria = distintos(registros, r => String(r.categoryCode).toUpperCase());

  const [jaAplicados, filiacoes, identidades, categorias, tabela] = await Promise.all([
    emLotes(idsExternos, lote => prisma.externalResult.findMany({
      where: { source: SOURCE, externalId: { in: lote } },
      select: { externalId: true, athleteId: true }
    })),
    codigosDeFiliacao.length
      ? emLotes(codigosDeFiliacao, lote => prisma.affiliation.findMany({
        where: { organizationId, code: { in: lote } },
        select: { id: true, code: true }
      }))
      : [],
    emLotes(cpfs, lote => prisma.athleteIdentity.findMany({
      where: { organizationId, cpf: { in: lote } },
      select: { cpf: true, athleteId: true }
    })),
    emLotes(codigosDeCategoria, lote => prisma.category.findMany({
      where: { code: { in: lote } }, select: { code: true }
    })),
    seasonId
      ? prisma.rankingPointsRule.findMany({ where: { seasonId }, select: { placing: true, points: true } })
      : []
  ]);

  const filiacoesPorCodigo = new Map(filiacoes.map(f => [f.code.toUpperCase(), f.id]));

  // Atletas alcançados pelas duas chaves, numa consulta cada.
  //
  // A busca por matrícula é deliberadamente ordenada por id: a versão anterior
  // usava `findFirst` sem ordenação, e "o primeiro" era o que o banco
  // devolvesse. Duas linhas com a mesma matrícula na mesma entidade é defeito
  // de cadastro, mas enquanto existir o reconhecimento tem de ser o MESMO em
  // toda execução — senão o mesmo arquivo importa atletas diferentes em dois
  // dias.
  const [porMatricula, porIdentidade] = await Promise.all([
    (filiacoesPorCodigo.size && matriculas.length)
      ? emLotes(matriculas, lote => prisma.athlete.findMany({
        where: {
          organizationId,
          affiliationId: { in: [...filiacoesPorCodigo.values()] },
          affiliationNumber: { in: lote }
        },
        select: { ...RESUMO_DE_ATLETA, affiliationId: true },
        orderBy: { id: 'asc' }
      }))
      : [],
    emLotes(identidades.map(i => i.athleteId), lote => prisma.athlete.findMany({
      where: { id: { in: lote } }, select: RESUMO_DE_ATLETA
    }))
  ]);

  // TODOS os donos de cada matrícula, não o primeiro.
  //
  // Guardar só o primeiro era escolher entre candidatos em silêncio: duas
  // pessoas com a mesma matrícula na mesma filiação é um fato sobre o
  // CADASTRO, e a linha era creditada a quem o banco devolvesse primeiro —
  // sem nada na tela dizendo que havia outra. A revisão não tinha como
  // desconfiar, porque o resultado saía como reconhecimento normal.
  const atletasPorMatricula = new Map();
  for (const atleta of porMatricula) {
    const chave = `${atleta.affiliationId}|${atleta.affiliationNumber}`;
    if (!atletasPorMatricula.has(chave)) atletasPorMatricula.set(chave, []);
    atletasPorMatricula.get(chave).push(atleta);
  }

  const atletasPorId = new Map(porIdentidade.map(a => [a.id, a]));

  // Índice de nomes: uma consulta, na primeira linha que precisar dele.
  //
  // Carrega o cadastro da organização — é o preço de comparar nome NORMALIZADO
  // (sem acento, sem caixa, sem espaço repetido), que o banco não sabe fazer
  // sem extensão. Antes esse preço era pago UMA VEZ POR LINHA sem chave.
  let porNome = null;
  const homonimosDe = async alvo => {
    if (!porNome) {
      porNome = new Map();
      const todos = await prisma.athlete.findMany({
        where: { organizationId }, select: { id: true, fullName: true }
      });
      for (const atleta of todos) {
        const chave = normalizarNome(atleta.fullName);
        if (!porNome.has(chave)) porNome.set(chave, []);
        porNome.get(chave).push(atleta);
      }
    }
    return porNome.get(alvo) ?? [];
  };

  return {
    aplicadoPorIdExterno: new Map(jaAplicados.map(r => [r.externalId, r.athleteId])),
    filiacoesPorCodigo,
    atletasPorMatricula,
    atletaPorCpf: new Map(identidades.map(i => [i.cpf, i.athleteId])),
    atletasPorId,
    categoriasConhecidas: new Set(categorias.map(c => c.code.toUpperCase())),
    tabelaDaTemporada: tabela,
    homonimosDe,
    // Quantas linhas do cadastro o índice de nomes chegou a carregar. Serve à
    // medição: é o número que dizia "carregou tudo, de novo".
    get cadastroCarregado() { return porNome ? porNome.size : 0; }
  };
}

// `indice` é o do lote. Quando não vem — chamada avulsa, de fora do arreio de
// importação —, um índice de UMA linha é montado na hora: o custo é o mesmo de
// antes, e o contrato da função continua sendo o de sempre.
// ELEGIBILIDADE AO SUPER OVERALL: LIDA NA DIVISÃO, NÃO NO TEXTO INTEIRO.
//
// `className` guarda a classe COMO O ARQUIVO ESCREVEU — "Men's Bodybuilding -
// Open" —, porque é dela que sai a chave de idempotência. O catálogo da
// organização, porém, é indexado por CÓDIGO DE DIVISÃO: ESTREANTE, NOVICE,
// OPEN, MASTER.
//
// Medido: `catalogo.get("MEN'S BODYBUILDING - OPEN")` nunca casa com `OPEN`.
// O efeito não era um erro visível — era um silêncio. Toda linha importada
// saía com `superOverallEligible: false`, e como o bônus é
// `isOverallChampion && superOverallEligible`, NENHUM Overall vindo de
// importação jamais somou +10, e o Super Overall anual não recebeu um ponto
// sequer de resultado importado.
//
// `divisionName` é o campo que o adaptador já decompõe e o item já persiste, e
// é ele que corresponde ao catálogo. A regra homologada não muda em nada: só
// a Open alimenta o Super Overall, e é exatamente o que esta leitura produz —
// "Open" casa com OPEN; "Novice" casa com NOVICE, que está no catálogo como
// não elegível; "Masters", "True Novice", "Teenage", "Junior" e "Special" não
// têm entrada e seguem não elegíveis.
function ehElegivelAoSuperOverall(linha, catalogo) {
  if (!catalogo) return false;
  // AS DUAS FORMAS QUE OS ARQUIVOS REAIS USAM, nesta ordem:
  //
  //   1. classe COMPOSTA — "Men's Bodybuilding - Open". O adaptador decompõe e
  //      `divisionName` vira "Open". É a forma dos arquivos MuscleWar.
  //   2. classe SIMPLES — a coluna já traz "OPEN". Não há o que decompor, e
  //      `divisionName` fica nulo: o próprio texto da classe É a divisão.
  //
  // Tentar só a divisão apagaria o caso 2 — foi exatamente o que a regressão
  // pegou, num teste que importa `classe=OPEN` e espera os 15 pontos. Tentar
  // só o texto inteiro apaga o caso 1, que era o defeito original. Os dois
  // caminhos levam ao mesmo código de catálogo, e nenhum dos dois inventa
  // classe: o que não estiver no catálogo da organização segue não elegível.
  for (const candidato of [linha?.divisionName, linha?.className]) {
    if (!candidato) continue;
    if (catalogo.get(candidato.trim().toUpperCase()) === true) return true;
  }
  return false;
}

async function analisarLinha(registro, organizationId, seasonId, catalogoDeClasses = null, indice = null) {
  const doLote = indice ?? await montarIndiceDoLote([registro], organizationId, seasonId);

  // Sem identificador externo não há como garantir idempotência para a linha.
  if (!registro.externalResultId) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'Registro sem identificador externo (external_result_id)', athleteId: null };
  }
  // Linha sem colocação E sem pontuação não tem o que pontuar — MENOS quando a
  // origem afirma que o atleta não compareceu. NS é resultado: pela regra
  // homologada vale 0, e valer 0 é ter participado. Recusar a linha fazia o
  // ranking sair certo por acidente (zero é zero) enquanto o histórico do
  // atleta perdia a participação e a tela chamava de inválida uma linha que
  // o arquivo preencheu corretamente.
  if (registro.placing == null && registro.points == null && !registro.didNotShow) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'Registro sem colocação nem pontuação', athleteId: null };
  }
  // CPF ausente NÃO encerra mais a análise: os arquivos oficiais identificam
  // por Member Number, e a maioria não traz CPF. Ele continua sendo uma das
  // chaves — deixou de ser a única.
  //
  // CPF PRESENTE e inválido continua sendo recusa: um documento malformado é
  // erro de origem, não ausência de informação.
  if (registro.cpf && !isValidCpf(registro.cpf)) {
    return { matchStatus: 'IMPORT_REJECTED', reason: 'CPF inválido', athleteId: null };
  }

  // Já aplicado antes: duplicado, não erro.
  if (doLote.aplicadoPorIdExterno.has(registro.externalResultId)) {
    return {
      matchStatus: 'DUPLICATE',
      reason: 'Resultado já importado anteriormente',
      athleteId: doLote.aplicadoPorIdExterno.get(registro.externalResultId)
    };
  }

  // ------------------------------------------------- CADEIA DE RECONHECIMENTO
  //
  // Prioridade homologada:
  //   1. filiação + matrícula      (as duas juntas; nenhuma sozinha basta)
  //   2. identidade já vinculada   (CPF em AthleteIdentity)
  //   3. nome normalizado          (NUNCA reconhece — só SUGERE)
  //   4. revisão manual
  //
  // O arquivo oficial do campeonato é redigido com Member Number, e muitas
  // vezes sem CPF nenhum. Reconhecer só por CPF jogava essas linhas inteiras
  // para revisão manual.

  const candidatosDaMatricula = atletasPorFiliacao(doLote, registro);

  // Matrícula com mais de um dono não reconhece ninguém. Não há desempate
  // possível aqui: os dois são igualmente plausíveis pela chave, e o nome não
  // desempata — creditar ao "mais parecido" é exatamente o erro que nenhuma
  // revisão posterior desfaz, porque o ponto já estaria somando para o outro.
  if (candidatosDaMatricula.length > 1) {
    return {
      matchStatus: 'CONFLICT',
      reason: `Matrícula ${registro.memberNumber} pertence a mais de um atleta em ${registro.affiliationCode}: `
        + `${candidatosDaMatricula.map(a => a.fullName).join(' | ')}. Corrija o cadastro antes de aplicar.`,
      athleteId: null,
      matchCandidates: candidatosDaMatricula.map(a => resumoDeCandidato(a, 'AFFILIATION_NUMBER'))
    };
  }

  const porFiliacao = candidatosDaMatricula[0] ?? null;
  const porCpf = atletaPorCpf(doLote, registro.cpf);

  // Duas chaves que apontam para pessoas DIFERENTES é um fato sobre o arquivo
  // ou sobre o cadastro, e quem resolve é gente. Escolher "a que eu achei
  // primeiro" creditaria o resultado ao atleta errado em silêncio.
  if (porFiliacao && porCpf && porFiliacao.id !== porCpf.id) {
    return {
      matchStatus: 'CONFLICT',
      reason: `Chaves divergem: filiação ${registro.affiliationCode}/${registro.memberNumber} indica `
        + `${porFiliacao.fullName}, e o CPF informado indica ${porCpf.fullName}. `
        + 'Corrija a origem ou o cadastro antes de aplicar.',
      athleteId: null,
      // Os dois candidatos, com a chave que apontou cada um. Sem isto na tela,
      // "Conflito de identidade" é uma frase e o botão de vincular é apertado
      // no escuro.
      matchCandidates: [resumoDeCandidato(porFiliacao, 'AFFILIATION_NUMBER'), resumoDeCandidato(porCpf, 'CPF')]
    };
  }

  const athlete = porFiliacao || porCpf;
  // A chave que reconheceu. Vai gravada na linha porque a revisão precisa
  // dizer POR QUE casou, e não só QUE casou.
  const matchedBy = porFiliacao ? 'AFFILIATION_NUMBER' : (porCpf ? 'CPF' : null);

  if (!athlete) {
    // Chave 3: o nome. Não reconhece — prepara a decisão de quem pode tomá-la.
    const sugestao = await sugerirPorNome(doLote, registro.athleteName);
    return {
      matchStatus: 'MATCH_PENDING',
      reason: sugestao.reason,
      athleteId: null,
      suggestedAthleteId: sugestao.athleteId
    };
  }

  // Conferência de filiação para quem foi reconhecido por OUTRA chave. Quando o
  // reconhecimento veio do par filiação/matrícula, a filiação obviamente
  // confere — conferir de novo só produziria ruído.
  if (registro.affiliationCode && !porFiliacao) {
    const codigoAtleta = athlete.affiliation?.code || null;
    if (!codigoAtleta) {
      return { matchStatus: 'CONFLICT', reason: `Atleta sem filiação cadastrada; origem informa ${registro.affiliationCode}`, athleteId: athlete.id };
    }
    if (codigoAtleta.toUpperCase() !== registro.affiliationCode.toUpperCase()) {
      return { matchStatus: 'CONFLICT', reason: `Filiação divergente: cadastro ${codigoAtleta}, origem ${registro.affiliationCode}`, athleteId: athlete.id };
    }
  }

  // Categoria informada precisa existir no catálogo; sem isso o ponto entraria
  // sem recorte e o ranking por categoria ficaria incoerente.
  if (registro.categoryCode) {
    if (!doLote.categoriasConhecidas.has(registro.categoryCode.toUpperCase())) {
      return { matchStatus: 'CONFLICT', reason: `Categoria desconhecida no MCI: ${registro.categoryCode}`, athleteId: athlete.id };
    }
  }

  if (seasonId && registro.placing != null) {
    const tabela = doLote.tabelaDaTemporada;

    // Temporada SEM tabela nenhuma é conflito: não há regra a aplicar, e
    // atribuir zero a todo mundo seria inventar um resultado.
    //
    // Colocação fora de uma tabela que EXISTE não é conflito: pela regra
    // homologada a tabela vai até o 5º, e do 6º em diante vale zero. Tratar
    // isso como conflito obrigaria o operador a cadastrar pontuação para
    // colocações que a regra manda não pontuar.
    if (!tabela.length) {
      return { matchStatus: 'CONFLICT', reason: 'Temporada sem tabela de pontuação definida', athleteId: athlete.id };
    }

    // Pontuação informada no arquivo é AFIRMAÇÃO, não fonte: quando pode ser
    // derivada de colocação + Overall + temporada, é conferida contra a regra
    // oficial. Divergir não se resolve em silêncio — nem sobrescrevendo o
    // arquivo, nem confiando nele.
    // A elegibilidade da CLASSE entra na conferência porque entrou na regra:
    // pela regra vigente o +10 só vale na absoluta, então conferir sem saber a
    // classe calcularia 5 onde o arquivo, corretamente, informa 15 — e a
    // pré-visualização acusaria conflito onde não há.
    const superOverallEligible = ehElegivelAoSuperOverall(registro, catalogoDeClasses);

    const divergencia = conferirPontuacaoImportada(
      registro.placing, tabela, registro.isOverallChampion === true, registro.points, superOverallEligible
    );

    if (divergencia) {
      return {
        matchStatus: 'CONFLICT',
        reason: `Pontuação divergente: o arquivo informa ${divergencia.importedPoints}, `
          + `a regra oficial da temporada calcula ${divergencia.calculatedPoints} `
          + `(colocação ${registro.placing}${registro.isOverallChampion === true && superOverallEligible ? ' + Overall' : ''}), `
          + `diferença de ${divergencia.difference > 0 ? '+' : ''}${divergencia.difference}. `
          + 'Corrija o arquivo ou a tabela da temporada antes de aplicar.',
        athleteId: athlete.id,
        pointsMismatch: divergencia
      };
    }
  }

  return { matchStatus: 'MATCHED', reason: null, athleteId: athlete.id, matchedBy };
}

/**
 * Cria o lote e produz a pré-visualização. Nada é aplicado nesta etapa:
 * o operador revisa totais e pendências antes de confirmar.
 */
async function createImport(data, actor) {
  assertCan(actor, 'musclewar.import', data.organizationId);

  if (data.seasonId) {
    const temporada = await prisma.rankingSeason.findUnique({ where: { id: data.seasonId } });
    if (!temporada || temporada.organizationId !== data.organizationId) throw new AppError(422, 'SEASON_INVALID', 'Temporada inválida para esta organização');
    if (temporada.status !== 'OPEN') throw new AppError(422, 'SEASON_CLOSED', 'Temporada encerrada não recebe importação');
  }
  if (data.eventId) {
    const evento = await prisma.event.findUnique({ where: { id: data.eventId } });
    if (!evento || evento.organizationId !== data.organizationId) throw new AppError(422, 'EVENT_INVALID', 'Evento inválido para esta organização');
  }

  const registros = adapter.parse(data.sourceType, data.content, {
    fieldMap: data.fieldMap,
    externalIdPrefix: data.externalIdPrefix,
    defaultAffiliationCode: data.defaultAffiliationCode
  });
  if (!registros.length) throw new AppError(422, 'IMPORT_EMPTY', 'Nenhum registro encontrado na origem');

  // TETO DE LINHAS — medido, não estimado.
  //
  // O limite de BYTES do corpo (8 MB) não é o limite útil: ele deixa passar um
  // arquivo que a aplicação não termina. Medido na FASE 13.6, contra
  // PostgreSQL na mesma máquina:
  //
  //     10.000 linhas  →  criar 2,0s   aplicar  26s
  //     44.000 linhas  →  criar 8,5s   aplicar 139s
  //
  // A aplicação roda dentro da transação da requisição, cujo prazo é 180s (ver
  // src/routes/index.js). 139s é 77% dele COM o banco ao lado; com o banco
  // gerenciado, a 30ms de latência por ida e volta, o mesmo arquivo não
  // termina — e não terminar significa perder as 139s inteiras, porque a
  // transação desfaz tudo.
  //
  // Recusar na porta é melhor que aceitar e desfazer no fim: o operador divide
  // o arquivo e as partes entram. Dividir é seguro por construção — a
  // idempotência é por `externalResultId`, então reimportar uma parte já
  // aplicada não duplica nada.
  if (registros.length > MAXIMO_DE_LINHAS) {
    throw new AppError(
      422, 'IMPORT_TOO_LARGE',
      `A origem tem ${registros.length} registros e o limite por importação é ${MAXIMO_DE_LINHAS}. `
      + 'Divida o arquivo em partes e envie uma de cada vez — reimportar uma parte já aplicada não duplica resultado.'
    );
  }

  // Catálogo de classes carregado UMA vez para o lote — a regra é a mesma para
  // todas as linhas, e é o mesmo mapa que a aplicação usa depois.
  const catalogoDeClasses = new Map(
    (await prisma.classCatalog.findMany({
      where: { organizationId: data.organizationId },
      select: { code: true, superOverallEligible: true }
    })).map(classe => [classe.code.toUpperCase(), classe.superOverallEligible])
  );

  // Tudo o que a análise consulta, carregado de uma vez para o arquivo inteiro.
  // Ver o cabeçalho de `montarIndiceDoLote`: é o que separa "importa" de
  // "devolve 500 no meio".
  const indice = await montarIndiceDoLote(registros, data.organizationId, data.seasonId ?? null);

  // Duplicidade dentro do próprio arquivo: a segunda ocorrência do mesmo
  // identificador é duplicada, não um segundo resultado.
  const vistos = new Set();

  const analisados = [];
  for (const registro of registros) {
    let analise;
    let repetidoNoArquivo = false;

    if (registro.externalResultId && vistos.has(registro.externalResultId)) {
      repetidoNoArquivo = true;
      analise = { matchStatus: 'DUPLICATE', reason: `Identificador ${registro.externalResultId} repetido no próprio arquivo`, athleteId: null };
    } else {
      analise = await analisarLinha(registro, data.organizationId, data.seasonId ?? null, catalogoDeClasses, indice);
      if (registro.externalResultId) vistos.add(registro.externalResultId);
    }
    analisados.push({ registro, analise, repetidoNoArquivo });
  }

  const totais = contar(analisados.map(item => item.analise.matchStatus));

  const lote = await prisma.$transaction(async tx => {
    const criado = await tx.muscleWarImport.create({
      data: {
        organizationId: data.organizationId,
        seasonId: data.seasonId ?? null,
        eventId: data.eventId ?? null,
        sourceType: data.sourceType,
        sourceRef: data.sourceRef,
        status: 'PREVIEWED',
        totalRecords: registros.length,
        matchedCount: totais.MATCHED,
        pendingCount: totais.MATCH_PENDING,
        conflictCount: totais.CONFLICT,
        duplicateCount: totais.DUPLICATE,
        rejectedCount: totais.IMPORT_REJECTED,
        createdById: actor.id
      }
    });

    // Inserção em LOTE, e não uma instrução por linha.
    //
    // Um `create` por registro é uma ida e volta ao banco por registro — com
    // 1.000 linhas são 1.000, dentro da mesma transação da requisição. Os
    // itens são independentes entre si e não precisam de id devolvido aqui,
    // que é exatamente o caso em que `createMany` se aplica.
    //
    // O corte em blocos existe pelo mesmo motivo do `IN (...)`: uma instrução
    // com dezenas de milhares de VALUES estoura o teto de parâmetros.
    const BLOCO = 1000;
    const paraGravar = analisados.map(({ registro, analise, repetidoNoArquivo }, posicao) => {
      const sequencia = posicao + 1;

      // A chave do item é única dentro do lote. Linha sem identificador e
      // linha repetida ainda precisam existir para poderem ser revisadas —
      // então recebem um sufixo que preserva a origem sem colidir.
      const chaveDoItem = !registro.externalResultId
        ? `__sem-id__:${sequencia}`
        : repetidoNoArquivo
          ? `${registro.externalResultId}__repetida:${sequencia}`
          : registro.externalResultId;

      return {
        importId: criado.id,
        externalResultId: chaveDoItem,
        rowNumber: registro.rowNumber,
        isOverallChampion: registro.isOverallChampion === true,
        teamName: registro.teamName,
        companyName: registro.companyName,
        cpf: registro.cpf,
        athleteName: registro.athleteName,
        affiliationCode: registro.affiliationCode,
        memberNumber: registro.memberNumber ?? null,
        suggestedAthleteId: analise.suggestedAthleteId ?? null,
        matchedBy: analise.matchedBy ?? null,
        matchCandidates: analise.matchCandidates ?? undefined,
        categoryCode: registro.categoryCode,
        divisionName: registro.divisionName,
        className: registro.className,
        classLabel: registro.classLabel ?? null,
        placing: registro.placing,
        didNotShow: registro.didNotShow === true,
        points: registro.points,
        eventName: registro.eventName,
        eventDate: registro.eventDate,
        raw: registro.raw,
        matchStatus: analise.matchStatus,
        reason: analise.reason,
        pointsMismatch: analise.pointsMismatch ?? null,
        athleteId: analise.athleteId
      };
    });

    for (let i = 0; i < paraGravar.length; i += BLOCO) {
      await tx.muscleWarImportItem.createMany({ data: paraGravar.slice(i, i + BLOCO) });
    }

    return criado;
  });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_IMPORT, entity: 'MuscleWarImport', entityId: lote.id,
    organizationId: data.organizationId,
    metadata: { sourceType: data.sourceType, sourceRef: data.sourceRef, total: registros.length, ...totais }
  });

  // Divergência de pontuação é registrada à parte, com os números. Diluída na
  // contagem geral de CONFLICT ela se perderia entre filiação divergente e
  // categoria desconhecida — e é justamente a que indica alguém tentando
  // entrar com uma pontuação que a regra oficial não produz.
  const divergenciasDePontos = analisados
    .filter(item => item.analise.pointsMismatch)
    .map(item => ({
      externalResultId: item.registro.externalResultId,
      placing: item.registro.placing,
      isOverallChampion: item.registro.isOverallChampion === true,
      ...item.analise.pointsMismatch
    }));

  if (divergenciasDePontos.length) {
    await audit.record({
      actor, action: audit.ACTIONS.SCORE_CONFLICT, entity: 'MuscleWarImport', entityId: lote.id,
      organizationId: data.organizationId,
      metadata: { sourceRef: data.sourceRef, seasonId: data.seasonId ?? null, mismatches: divergenciasDePontos }
    });
  }

  return preview(lote.id, actor);
}

function contar(status) {
  const base = { MATCHED: 0, MATCH_PENDING: 0, CONFLICT: 0, DUPLICATE: 0, IMPORT_REJECTED: 0, APPLIED: 0 };
  for (const item of status) base[item] = (base[item] ?? 0) + 1;
  return base;
}

// PÁGINA, E NÃO O LOTE INTEIRO.
//
// Medido na FASE 13.6: uma importação de 10.000 linhas devolvia 12,2 MB —
// três vezes, porque criar, revisar e aplicar terminam todos chamando esta
// função. A memória do processo da API subia de 121 MB para 718 MB no mesmo
// ciclo, e a tela recebia dez mil linhas para mostrar num quadro de 340 pixels
// de altura.
//
// Os TOTAIS continuam sendo do lote inteiro — eles vêm de uma contagem no
// banco, não da soma do que coube na página. Essa distinção é a razão de o
// corte ser seguro: o operador continua vendo quantos reconhecidos, pendentes
// e conflitos existem de fato; o que ele deixa de receber de uma vez é a
// LISTA, que ele lê aos poucos.
//
// O filtro por situação não é enfeite: com dez mil linhas, achar as cem
// pendentes rolando a tabela é inviável, e era a única forma que existia.
const ITENS_POR_PAGINA = 200;
const TETO_DE_ITENS = 1000;

async function preview(importId, actor, { limit, offset = 0, matchStatus = null } = {}) {
  const porPagina = Math.min(Math.max(1, Number(limit) || ITENS_POR_PAGINA), TETO_DE_ITENS);
  const aPartirDe = Math.max(0, Number(offset) || 0);

  const lote = await prisma.muscleWarImport.findUnique({
    where: { id: importId },
    include: {
      season: { select: { id: true, name: true, year: true } },
      // Data e cidade acompanham o nome porque a REVISÃO precisa desambiguar,
      // não só identificar: duas etapas da mesma federação podem ter nomes
      // parecidos, e o operador está prestes a publicar ranking nacional.
      event: { select: { id: true, name: true, slug: true, startDate: true, city: true, state: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      appliedBy: { select: { id: true, name: true, email: true } }
    }
  });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');

  assertCan(actor, 'musclewar.review', lote.organizationId);

  const recorte = { importId, ...(matchStatus ? { matchStatus } : {}) };

  const items = await prisma.muscleWarImportItem.findMany({
    where: recorte,
    skip: aPartirDe,
    take: porPagina,
    include: {
      athlete: { select: { id: true, fullName: true, stageName: true, athleteNumber: true } },
      // O SUGERIDO vem inteiro, e não só o id: a tela precisa mostrar QUEM foi
      // sugerido, com a filiação e a matrícula que sustentam a sugestão. Um id
      // cru obrigaria o operador a abrir outra tela para saber do que se trata.
      //
      // `affiliationNumber` é o Member Number — a matrícula de FILIAÇÃO —, e
      // não `athleteNumber`, que é o número do atleta na federação e é outra
      // coisa no modelo. Confundi-los faria o operador conferir o campo errado.
      suggestedAthlete: {
        select: {
          id: true, fullName: true, stageName: true, affiliationNumber: true,
          affiliation: { select: { id: true, name: true, code: true } }
        }
      }
    },
    orderBy: { rowNumber: 'asc' }
  });

  // Os totais saem de uma contagem AGRUPADA no banco: uma consulta, o lote
  // inteiro. Somar o que veio na página diria "3 pendentes" quando há 300.
  const agrupados = await prisma.muscleWarImportItem.groupBy({
    by: ['matchStatus'],
    where: { importId },
    _count: { _all: true }
  });

  const totais = { MATCHED: 0, MATCH_PENDING: 0, CONFLICT: 0, DUPLICATE: 0, IMPORT_REJECTED: 0, APPLIED: 0 };
  let totalDeItens = 0;
  for (const linha of agrupados) {
    totais[linha.matchStatus] = linha._count._all;
    totalDeItens += linha._count._all;
  }

  const noRecorte = matchStatus ? (totais[matchStatus] ?? 0) : totalDeItens;

  return {
    import: lote,
    summary: {
      totalRecords: totalDeItens,
      recognized: totais.MATCHED,
      pending: totais.MATCH_PENDING,
      conflicts: totais.CONFLICT,
      duplicates: totais.DUPLICATE,
      rejected: totais.IMPORT_REJECTED,
      applied: totais.APPLIED,
      // O que efetivamente entraria se o lote fosse aplicado agora.
      valid: totais.MATCHED
    },
    // O recorte que esta resposta representa. Sem isto a tela não tem como
    // dizer "mostrando 200 de 10.000" — e mostrar 200 calada é pior do que
    // mostrar tudo, porque parece completo.
    page: {
      limit: porPagina,
      offset: aPartirDe,
      matchStatus: matchStatus ?? null,
      returned: items.length,
      total: noRecorte,
      hasMore: aPartirDe + items.length < noRecorte
    },
    items
  };
}

/**
 * Vinculação manual de uma linha pendente a um atleta existente. É a única
 * porta para resolver MATCH_PENDING — nenhum atleta é criado pela importação.
 */
async function linkItem(itemId, { athleteId }, actor) {
  const item = await prisma.muscleWarImportItem.findUnique({ where: { id: itemId }, include: { import: true } });
  if (!item) throw new AppError(404, 'IMPORT_ITEM_NOT_FOUND', 'Registro de importação não encontrado');

  assertCan(actor, 'musclewar.review', item.import.organizationId);

  // Lote REJEITADO não recebe vinculação: ele não vai ser aplicado, e resolver
  // linha nele só produziria trabalho perdido.
  //
  // Lote já APLICADO recebe, sim. É o que o `apply` promete no seu próprio
  // comentário: "pendências e conflitos ficam para revisão e podem ser
  // aplicados depois, no mesmo lote". Barrar aqui prendia a linha para sempre —
  // o operador aplicava o lote para aproveitar as linhas boas, cadastrava
  // depois o atleta que faltava, e não tinha como voltar. O resultado se perdia
  // em silêncio.
  //
  // Não há risco de pontuar duas vezes: a linha aplicada vira `APPLIED`, e o
  // `apply` só recolhe `MATCHED`.
  if (item.import.status === 'REJECTED') {
    throw new AppError(422, 'IMPORT_REJECTED', 'Lote rejeitado não aceita vinculação');
  }
  if (!['MATCH_PENDING', 'CONFLICT'].includes(item.matchStatus)) {
    throw new AppError(422, 'ITEM_NOT_PENDING', `Registro em ${item.matchStatus} não aceita vinculação`);
  }

  const athlete = await prisma.athlete.findUnique({ where: { id: athleteId } });
  if (!athlete) throw new AppError(404, 'ATHLETE_NOT_FOUND', 'Atleta não encontrado');
  if (athlete.organizationId !== item.import.organizationId) throw new AppError(403, 'FORBIDDEN', 'Atleta de outra organização');

  // Vincular a um CPF diferente do que veio da origem é decisão consciente do
  // operador e fica registrada como tal.
  const cadastrado = await prisma.athleteIdentity.findUnique({
    where: { athleteId },
    select: { cpf: true }
  });
  const cpfDivergente = Boolean(item.cpf) && Boolean(cadastrado) && item.cpf !== cadastrado.cpf;

  const atualizado = await prisma.muscleWarImportItem.update({
    where: { id: itemId },
    data: {
      athleteId,
      matchStatus: 'MATCHED',
      reason: cpfDivergente ? `Vinculado manualmente (CPF da origem difere do cadastro)` : 'Vinculado manualmente',
      linkedById: actor.id,
      linkedAt: new Date()
    }
  });

  await recontar(item.importId);

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_REVIEW, entity: 'MuscleWarImportItem', entityId: itemId,
    organizationId: item.import.organizationId,
    metadata: { athleteId, externalResultId: item.externalResultId, cpfDivergente }
  });

  if (athlete.userId) {
    await notifications.notify({
      userIds: [athlete.userId], type: notifications.TYPES.ATHLETE_MATCHED,
      title: 'Resultado externo vinculado',
      message: `Um resultado do MuscleWar foi vinculado ao seu perfil.`,
      entityType: 'MuscleWarImportItem', entityId: itemId, actorId: actor.id
    });
  }

  return atualizado;
}

// ============================================================================
// VÍNCULO TARDIO — o resultado chega antes da pessoa.
//
// A importação não cria atleta, e isso continua valendo. A consequência era que
// o resultado de quem ainda não se cadastrou ficava parado esperando alguém
// reparar nele. Agora ele espera COM a identidade que o arquivo informou —
// organização, filiação e matrícula — e o cadastro aprovado vem buscá-lo.
//
// A chave é a mesma do importador, pela mesma razão: filiação + matrícula
// dentro da organização. Nome não entra. Um vínculo automático por nome
// creditaria pontos de campeonato a um homônimo, e ninguém perceberia — é
// exatamente o erro que nenhuma revisão posterior desfaz, porque o resultado
// já estaria somando no ranking de outra pessoa.
// ============================================================================

const MOTIVO_AUTO = 'AUTO_LINK_AFFILIATION_NUMBER';

// Comparação de nomes só para AVISAR. Acento, caixa e espaço repetido não
// separam o mesmo nome — e nome nenhum decide vínculo aqui.
const mesmoNome = (a, b) => {
  const normal = texto => String(texto || '').trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  return normal(a) === normal(b);
};

/**
 * Procura resultados pendentes que pertençam a este atleta e os vincula.
 *
 * Roda DEPOIS que a aprovação do cadastro foi gravada, e nunca dentro dela: se
 * o vínculo falhar, o atleta continua existindo e a operação pode ser repetida.
 * É idempotente de propósito — rodar de novo não encontra mais nada para fazer.
 *
 * NÃO pontua por conta própria. Vincular é dizer QUEM; quanto vale continua
 * sendo a aplicação do lote. A exceção é o lote que JÁ foi aplicado: ali o
 * operador já fechou a conta, e deixar a linha recém-vinculada de fora faria o
 * atleta ter o resultado reconhecido e nenhum ponto por ele.
 */
async function vincularPendentesDoAtleta(athlete, actor) {
  const vazio = { vinculados: 0, conflitos: 0, lotesAplicados: 0 };

  // Sem matrícula não há chave. Um atleta sem filiação registrada não pode ser
  // alcançado por nenhuma linha, e tentar alcançá-lo pelo nome é justamente o
  // que esta função existe para não fazer.
  if (!athlete?.affiliationId || !athlete?.affiliationNumber) return vazio;

  const filiacao = await prisma.affiliation.findUnique({
    where: { id: athlete.affiliationId },
    select: { id: true, code: true, organizationId: true }
  });
  if (!filiacao || filiacao.organizationId !== athlete.organizationId) return vazio;

  const pendentes = await prisma.muscleWarImportItem.findMany({
    where: {
      matchStatus: 'MATCH_PENDING',
      athleteId: null,
      memberNumber: athlete.affiliationNumber,
      // A fronteira da organização é da CONSULTA, não de uma conferência
      // posterior: uma matrícula igual noutro tenant nem chega a ser candidata.
      import: { organizationId: athlete.organizationId, status: { not: 'REJECTED' } }
    },
    select: {
      id: true, importId: true, athleteName: true, affiliationCode: true,
      externalResultId: true, import: { select: { id: true, status: true, organizationId: true } }
    }
  });

  if (!pendentes.length) return vazio;

  // Matrícula com mais de um dono na organização é fato sobre o CADASTRO, e
  // quem resolve é gente. Vincular "ao que apareceu primeiro" creditaria o
  // resultado ao atleta errado em silêncio.
  const homonimosDeMatricula = await prisma.athlete.count({
    where: {
      organizationId: athlete.organizationId,
      affiliationId: athlete.affiliationId,
      affiliationNumber: athlete.affiliationNumber,
      id: { not: athlete.id }
    }
  });

  const codigoDoAtleta = String(filiacao.code || '').toUpperCase();
  let vinculados = 0;
  let conflitos = 0;
  const lotesTocados = new Map();

  for (const item of pendentes) {
    const codigoDaLinha = String(item.affiliationCode || '').toUpperCase();
    const filiacaoDivergente = Boolean(codigoDaLinha) && codigoDaLinha !== codigoDoAtleta;

    if (homonimosDeMatricula > 0 || filiacaoDivergente) {
      const motivo = homonimosDeMatricula > 0
        ? `Matrícula ${athlete.affiliationNumber} pertence a mais de um atleta nesta filiação; vínculo exige decisão do operador`
        : `Filiação divergente: o arquivo informa ${item.affiliationCode}, o cadastro está em ${filiacao.code}`;

      // CONFLICT não escolhe e não altera o athleteId: só torna o impasse
      // visível na revisão, onde existe quem possa decidir.
      const marcados = await prisma.muscleWarImportItem.updateMany({
        where: { id: item.id, athleteId: null, matchStatus: 'MATCH_PENDING' },
        data: { matchStatus: 'CONFLICT', reason: motivo }
      });
      if (marcados.count) { conflitos += 1; lotesTocados.set(item.importId, item.import); }
      continue;
    }

    const nomeDiverge = Boolean(item.athleteName) && !mesmoNome(item.athleteName, athlete.fullName);

    // A GUARDA DE CORRIDA ESTÁ NO `where`. Duas aprovações simultâneas para a
    // mesma identidade disputam a MESMA linha: a primeira encontra
    // `athleteId: null` e vence; a segunda não encontra linha nenhuma e conta
    // zero. Sem trava, sem segunda tentativa, sem vínculo em dobro.
    const vinculo = await prisma.muscleWarImportItem.updateMany({
      where: { id: item.id, athleteId: null, matchStatus: 'MATCH_PENDING' },
      data: {
        athleteId: athlete.id,
        matchStatus: 'MATCHED',
        matchedBy: 'AFFILIATION_NUMBER',
        linkedById: actor?.id ?? null,
        linkedAt: new Date(),
        reason: nomeDiverge
          ? `Vinculado automaticamente por filiação + matrícula. Nome do arquivo ("${item.athleteName}") difere do cadastro ("${athlete.fullName}") — conferir.`
          : 'Vinculado automaticamente por filiação + matrícula'
      }
    });

    if (!vinculo.count) continue;

    vinculados += 1;
    lotesTocados.set(item.importId, item.import);

    await audit.record({
      actor,
      action: 'RESULTADO_EXTERNAL_LINKED',
      entity: 'MuscleWarImportItem',
      entityId: item.id,
      organizationId: athlete.organizationId,
      // Sem CPF, sem telefone: a auditoria precisa da CHAVE que decidiu, não
      // dos dados pessoais de quem foi identificado por ela.
      metadata: {
        athleteId: athlete.id,
        affiliationId: athlete.affiliationId,
        affiliationNumber: athlete.affiliationNumber,
        importItemId: item.id,
        externalResultId: item.externalResultId,
        motivo: MOTIVO_AUTO,
        nomeDiverge
      }
    });
  }

  for (const importId of lotesTocados.keys()) await recontar(importId);

  // Lote já aplicado: a linha recém-vinculada precisa dos pontos dela, senão o
  // atleta fica com o resultado reconhecido e nada somando. `aplicarLote` só
  // recolhe `MATCHED`, e o que já entrou está `APPLIED` — reaplicar não soma
  // de novo, e a unicidade de (source, externalId) fecha a porta de qualquer
  // jeito.
  let lotesAplicados = 0;
  if (vinculados) {
    for (const lote of lotesTocados.values()) {
      if (lote.status !== 'APPLIED') continue;
      try {
        await aplicarLote(await prisma.muscleWarImport.findUnique({ where: { id: lote.id } }), actor);
        lotesAplicados += 1;
      } catch (erro) {
        // Falhar aqui não pode desfazer o vínculo nem a aprovação do cadastro:
        // o reconhecimento está gravado e correto, e a aplicação pode ser
        // repetida pela tela. Some em silêncio seria pior — vai para o log.
        logger.error({ erro: erro.message, importId: lote.id, athleteId: athlete.id },
          'vínculo tardio: falha ao aplicar o lote já aplicado');
      }
    }
  }

  if (vinculados && athlete.userId) {
    await notifications.notify({
      userIds: [athlete.userId], type: notifications.TYPES.ATHLETE_MATCHED,
      title: 'Resultados anteriores vinculados ao seu perfil',
      message: `${vinculados} resultado(s) de campeonato foram reconhecidos como seus.`,
      entityType: 'Athlete', entityId: athlete.id, actorId: actor?.id ?? null
    });
  }

  return { vinculados, conflitos, lotesAplicados };
}

async function recontar(importId) {
  const items = await prisma.muscleWarImportItem.findMany({ where: { importId }, select: { matchStatus: true } });
  const totais = contar(items.map(item => item.matchStatus));

  return prisma.muscleWarImport.update({
    where: { id: importId },
    data: {
      totalRecords: items.length,
      matchedCount: totais.MATCHED,
      pendingCount: totais.MATCH_PENDING,
      conflictCount: totais.CONFLICT,
      duplicateCount: totais.DUPLICATE,
      rejectedCount: totais.IMPORT_REJECTED,
      appliedCount: totais.APPLIED
    }
  });
}

/**
 * Aplica o lote. Só linhas MATCHED entram; pendências e conflitos ficam para
 * revisão e podem ser aplicados depois, no mesmo lote, sem duplicar o que já
 * entrou.
 */
async function apply(importId, actor) {
  const lote = await prisma.muscleWarImport.findUnique({ where: { id: importId } });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');

  assertCan(actor, 'musclewar.apply', lote.organizationId);

  return aplicarLote(lote, actor);
}

/**
 * O corpo da aplicação, sem a checagem de permissão.
 *
 * Separado porque existe um segundo caminho legítimo até aqui: quando um
 * cadastro é APROVADO e o vínculo tardio encontra linhas de um lote que já
 * havia sido aplicado, quem age é o SISTEMA, em consequência de uma aprovação
 * que já passou pelo seu próprio controle de acesso. Exigir `musclewar.apply`
 * de quem aprovou cadastro faria a operação depender de o mesmo operador
 * acumular dois papéis sem relação entre si — e o resultado do atleta ficaria
 * parado por um detalhe de RBAC que não diz respeito a ele.
 *
 * A porta pública continua sendo `apply`, com a checagem no lugar.
 */
async function aplicarLote(lote, actor) {
  const importId = lote.id;

  if (lote.status === 'REJECTED') throw new AppError(422, 'IMPORT_REJECTED', 'Lote rejeitado não pode ser aplicado');

  // TRAVA DE APLICAÇÃO, POR LOTE.
  //
  // Duplo clique, retry de HTTP, duas abas, dois operadores: medido com 20
  // chamadas simultâneas, o resultado era 1 sucesso, 11 recusas corretas e
  // OITO respostas 500 — e, pior, nenhum ponto gravado. A causa é que a
  // violação de unicidade em `ExternalResult` aborta a transação da
  // REQUISIÇÃO inteira (PostgreSQL 25P02), e o tratamento do duplicado, que
  // tentava escrever logo em seguida, escrevia numa transação já morta.
  //
  // A trava é de transação: solta sozinha no commit ou no rollback, e não
  // deixa cadeado preso se o processo cair. Quem chega depois espera, encontra
  // as linhas já `APPLIED` e recebe a recusa idempotente de sempre — em vez de
  // colidir no banco.
  // `$executeRaw`, e não `$queryRaw`: a função devolve `void`, e o leitor de
  // resultados do Prisma não sabe desserializar isso — o pedido do cadeado
  // virava 500 antes de a aplicação começar.
  await prisma.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`musclewar:apply:${importId}`}))`;

  const aplicaveis = await prisma.muscleWarImportItem.findMany({
    where: { importId, matchStatus: 'MATCHED', athleteId: { not: null } },
    orderBy: { rowNumber: 'asc' }
  });

  if (!aplicaveis.length) throw new AppError(422, 'NOTHING_TO_APPLY', 'Nenhum registro reconhecido para aplicar');

  const seasonId = lote.seasonId;
  let aplicados = 0;
  let ignorados = 0;
  let divergentes = 0;

  // Tabela da temporada e catálogo de classes carregados uma vez: a regra é a
  // mesma para o lote inteiro, e consultá-la por linha só somaria idas ao banco.
  const tabela = seasonId
    ? await prisma.rankingPointsRule.findMany({ where: { seasonId }, select: { placing: true, points: true } })
    : [];

  const catalogo = new Map(
    (await prisma.classCatalog.findMany({
      where: { organizationId: lote.organizationId },
      select: { code: true, superOverallEligible: true }
    })).map(classe => [classe.code.toUpperCase(), classe.superOverallEligible])
  );

  const equipes = new Map(
    (await prisma.team.findMany({
      where: { organizationId: lote.organizationId },
      select: { id: true, name: true, companyId: true }
    })).map(equipe => [equipe.name.trim().toUpperCase(), equipe])
  );

  const empresas = new Map(
    (await prisma.company.findMany({
      where: { organizationId: lote.organizationId },
      select: { id: true, name: true }
    })).map(empresa => [empresa.name.trim().toUpperCase(), empresa.id])
  );

  // Vínculos de equipe dos atletas do lote. A trava de vínculo único não pode
  // parar na tela e na API: sem isto, bastaria um arquivo nomeando outra equipe
  // para que ela acumulasse os pontos de um atleta que não é dela — a regra
  // seria contornada justamente pela porta que o operador usa em massa.
  const vinculos = new Map();
  for (const linha of await prisma.athleteTeamMembership.findMany({
    where: { athleteId: { in: aplicaveis.map(item => item.athleteId) } },
    select: { athleteId: true, teamId: true, startedAt: true, endedAt: true, team: { select: { name: true, companyId: true } } }
  })) {
    if (!vinculos.has(linha.athleteId)) vinculos.set(linha.athleteId, []);
    vinculos.get(linha.athleteId).push(linha);
  }

  // Qual vínculo responde por este resultado.
  //
  // 1. O que valia NA DATA DO EVENTO, se houver: um resultado antigo pertence à
  //    equipe de então, e o histórico guarda exatamente isso.
  // 2. Na falta dele — linha sem data, ou data anterior a qualquer vínculo —, o
  //    vínculo ATIVO. Cair no arquivo aqui seria abrir a porta de volta:
  //    bastaria datar a linha antes do vínculo para atribuí-la a quem quisesse.
  // 3. Atleta que nunca teve vínculo: não há fato registrado a contradizer, e o
  //    arquivo segue sendo a única fonte.
  const vinculoDoResultado = (athleteId, data) => {
    const linhas = vinculos.get(athleteId) || [];
    const daEpoca = data
      ? linhas.find(linha => linha.startedAt <= data && (!linha.endedAt || linha.endedAt >= data))
      : null;
    return daEpoca ?? linhas.find(linha => !linha.endedAt) ?? null;
  };

  for (const item of aplicaveis) {
    // A equipe declarada no arquivo não pode contradizer o vínculo registrado.
    // Divergência não é corrigida em silêncio nem aceita: a linha fica em
    // CONFLICT para o operador resolver — ou o arquivo está errado, ou o
    // atleta mudou de equipe e a transferência não foi feita pela via própria.
    const equipeDeclarada = item.teamName ? equipes.get(item.teamName.trim().toUpperCase()) : null;
    const vinculo = vinculoDoResultado(item.athleteId, item.eventDate);

    if (equipeDeclarada && vinculo && vinculo.teamId !== equipeDeclarada.id) {
      await prisma.muscleWarImportItem.update({
        where: { id: item.id },
        data: {
          matchStatus: 'CONFLICT',
          reason: `Equipe divergente: o arquivo indica ${equipeDeclarada.name}, `
            + `mas o atleta estava vinculado a ${vinculo.team?.name ?? 'outra equipe'}. `
            + 'Corrija o arquivo ou registre a transferência antes de aplicar.'
        }
      });
      divergentes += 1;
      continue;
    }

    // Cada linha em sua própria transação: uma colisão de idempotência no meio
    // do lote não desfaz o que já entrou legitimamente.
    try {
      // CONFERIR ANTES DE INSERIR, em vez de inserir e tratar o erro.
      //
      // Não é preferência de estilo: a violação de unicidade aborta a
      // transação da requisição, e tudo que viesse depois dela — inclusive
      // marcar o item como DUPLICATE — falharia junto. Perguntar primeiro
      // mantém a transação viva e o duplicado vira o que ele é: uma linha
      // ignorada, com motivo, e não um erro de servidor.
      const jaExiste = await prisma.externalResult.findUnique({
        where: { source_externalId: { source: SOURCE, externalId: item.externalResultId } },
        select: { id: true }
      });

      if (jaExiste) {
        await prisma.muscleWarImportItem.update({
          where: { id: item.id },
          data: { matchStatus: 'DUPLICATE', reason: 'Resultado já existente na plataforma' }
        });
        ignorados += 1;
        continue;
      }

      await prisma.$transaction(async tx => {
        const externo = await tx.externalResult.create({
          data: {
            source: SOURCE,
            externalId: item.externalResultId,
            seasonId,
            athleteId: item.athleteId,
            categoryCode: item.categoryCode,
            className: item.className,
            placing: item.placing,
            points: item.points ?? 0,
            eventName: item.eventName,
            eventDate: item.eventDate,
            importItemId: item.id
          }
        });

        if (seasonId) {
          // A COLOCAÇÃO é a fonte primária dos pontos, não um número digitado.
          // O operador informa o resultado oficial; o sistema aplica a regra
          // homologada — inclusive o bônus de Overall, quando a origem o
          // informa. Uma coluna de pontos no arquivo só é usada quando a linha
          // não traz colocação alguma, caso em que não há regra a aplicar.
          // Elegibilidade ao Super Overall: resolvida pela classe declarada,
          // contra o catálogo da organização. O código "OPEN" não aparece aqui.
          // Resolvida ANTES da pontuação porque é ela que decide quanto deste
          // lançamento alimenta o ranking anual.
          const superOverallEligible = ehElegivelAoSuperOverall(item, catalogo);

          const { placementPoints, overallBonus, points, superOverallPoints } = item.placing != null
            ? pontuarResultado(item.placing, tabela, item.isOverallChampion, superOverallEligible)
            : item.didNotShow
              ? {
                // NÃO COMPARECEU VALE ZERO, E O ARQUIVO NÃO OPINA.
                //
                // Medido: um arquivo declarando `Placing: NS` e `pontos: 5`
                // colocava 5 pontos no ledger — a pontuação vinha da planilha
                // porque a linha não tinha colocação para a regra aplicar. É a
                // fraude mais barata que um arquivo pode tentar, e a regra
                // homologada é explícita: NS = 0.
                placementPoints: 0, overallBonus: 0, points: 0, superOverallPoints: 0
              }
              : {
                // Linha sem colocação e sem ausência declarada: não há regra a
                // aplicar, e o número do arquivo é o único dado disponível.
                placementPoints: item.points ?? 0,
                overallBonus: 0,
                points: item.points ?? 0,
                superOverallPoints: superOverallEligible ? (item.points ?? 0) : 0
              };

          const categoria = item.categoryCode
            ? await tx.category.findUnique({ where: { code: item.categoryCode.toUpperCase() } })
            : null;

          // Na ausência de equipe no arquivo, o vínculo registrado responde —
          // é o mesmo fato, vindo da fonte que a plataforma controla.
          const equipeDoItem = equipeDeclarada
            ?? (vinculo ? { id: vinculo.teamId, companyId: vinculo.team?.companyId ?? null } : null);

          await tx.rankingPoint.create({
            data: {
              seasonId,
              athleteId: item.athleteId,
              categoryId: categoria?.id ?? null,
              source: 'MUSCLEWAR',
              // O EVENTO ACOMPANHA O PONTO.
              //
              // O caminho interno (`source: 'EVENT'`) sempre gravou
              // `eventId`. O da importação não gravava nada: o evento
              // sobrevivia só como TEXTO livre em `ExternalResult.eventName`,
              // digitado no arquivo de origem.
              //
              // Sem o vínculo, a pergunta "de qual evento veio este ponto?"
              // dependia de conferir um nome digitado — e a regra homologada
              // do Overall, que vale +10 uma vez POR EVENTO, não tinha como
              // ser verificada nos próprios dados do ledger. Com o Ipiranga
              // seguido de um segundo e de um terceiro campeonato, essa trilha
              // deixa de ser conveniência e vira a única forma de auditar.
              //
              // Nulo quando o lote não declara evento — caso legítimo e
              // preservado: `MuscleWarImport.eventId` é opcional, e existe
              // resultado histórico cujo evento nunca foi cadastrado aqui.
              eventId: lote.eventId ?? null,
              externalResultId: externo.id,
              placing: item.placing,
              // A ausência acompanha o lançamento: sem ela o histórico mostra
              // uma participação de zero ponto sem colocação e não sabe dizer
              // se o atleta não subiu ou se a origem não informou o lugar.
              didNotShow: item.didNotShow === true,
              placementPoints, overallBonus,
              isOverallChampion: item.isOverallChampion === true,
              superOverallEligible,
              superOverallPoints,
              teamId: equipeDoItem?.id ?? null,
              // A empresa vem da declarada na origem; na falta dela, da equipe
              // reconhecida — que é a cadeia natural: atleta → equipe → empresa.
              companyId: (item.companyName ? empresas.get(item.companyName.trim().toUpperCase()) : null)
                ?? equipeDoItem?.companyId ?? null,
              awardedById: actor?.id ?? null,
              points
            }
          });
        }

        await tx.muscleWarImportItem.update({ where: { id: item.id }, data: { matchStatus: 'APPLIED' } });
      });
      aplicados += 1;
    } catch (error) {
      // A conferência acima resolve o duplicado sem provocar a violação. Se
      // ela ainda assim escapar — corrida que passou entre o SELECT e o
      // INSERT —, a transação da requisição já está abortada e NÃO dá para
      // escrever mais nada nela: tentar era exatamente o que produzia 500.
      // Vira conflito explícito, que o operador entende e pode repetir.
      if (ehViolacaoDeUnicidade(error)) {
        throw new AppError(409, 'IMPORT_CONCURRENT',
          'Outra aplicação deste lote aconteceu ao mesmo tempo. Confira o resultado e repita se necessário.');
      }
      throw error;
    }
  }

  if (seasonId) await ranking.recompute_(seasonId);

  await recontar(importId);

  const atualizado = await prisma.muscleWarImport.update({
    where: { id: importId },
    data: {
      status: 'APPLIED',
      appliedById: actor.id,
      appliedAt: new Date(),
      // Reaplicar o mesmo lote depois de resolver pendências cria uma nova
      // versão da importação; o histórico anterior não é apagado.
      version: lote.status === 'APPLIED' ? lote.version + 1 : lote.version
    }
  });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_APPLY, entity: 'MuscleWarImport', entityId: importId,
    organizationId: lote.organizationId,
    metadata: {
      applied: aplicados, skippedAsDuplicate: ignorados, teamMismatch: divergentes,
      seasonId, version: atualizado.version, sourceRef: lote.sourceRef
    }
  });

  const atletas = await prisma.athlete.findMany({
    where: { id: { in: aplicaveis.map(item => item.athleteId) } },
    select: { userId: true }
  });

  await notifications.notify({
    userIds: atletas.map(atleta => atleta.userId).filter(Boolean),
    type: notifications.TYPES.IMPORT_APPLIED,
    title: 'Resultado importado',
    message: 'Um resultado do MuscleWar foi somado ao seu histórico.',
    entityType: 'MuscleWarImport', entityId: importId, actorId: actor.id
  });

  return {
    applied: aplicados, skippedAsDuplicate: ignorados, teamMismatch: divergentes,
    preview: await preview(importId, actor)
  };
}

async function reject(importId, { reason }, actor) {
  const lote = await prisma.muscleWarImport.findUnique({ where: { id: importId } });
  if (!lote) throw new AppError(404, 'IMPORT_NOT_FOUND', 'Importação não encontrada');
  assertCan(actor, 'musclewar.apply', lote.organizationId);

  if (lote.status === 'APPLIED') throw new AppError(422, 'IMPORT_ALREADY_APPLIED', 'Lote já aplicado não pode ser rejeitado');

  const atualizado = await prisma.muscleWarImport.update({ where: { id: importId }, data: { status: 'REJECTED' } });

  await audit.record({
    actor, action: audit.ACTIONS.MUSCLEWAR_REVIEW, entity: 'MuscleWarImport', entityId: importId,
    organizationId: lote.organizationId, metadata: { rejected: true, reason: reason ?? null }
  });

  return atualizado;
}

async function listImports(filtros, actor) {
  const { organizationFilter } = require('../utils/tenant');
  const escopo = organizationFilter(actor, filtros.organizationId);

  return prisma.muscleWarImport.findMany({
    where: escopo,
    include: {
      createdBy: { select: { id: true, name: true } },
      appliedBy: { select: { id: true, name: true } },
      season: { select: { id: true, name: true, year: true } },
      event: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: filtros.limit || 50
  });
}

module.exports = {
  vincularPendentesDoAtleta, createImport, preview, linkItem, apply, reject, listImports, analisarLinha, SOURCE, MAXIMO_DE_LINHAS };
