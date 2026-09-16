const { AppError } = require('../errors');
const { somenteDigitos, isValidCpf } = require('../cpf');

// ============================================================================
// MuscleWarAdapter
//
// Camada de tradução entre o formato do MuscleWar e o modelo do MCI. O formato
// definitivo do MuscleWar ainda não foi contratado: nada aqui inventa campos
// obrigatórios do lado deles. O adapter aceita CSV e JSON com um mapa de
// colunas configurável e expõe o mesmo contrato de saída para os três canais
// previstos (CSV, JSON, API), de modo que ligar o formato real depois seja
// registrar um mapa — não reescrever a importação.
//
// Saída canônica por registro:
//   { externalResultId, rowNumber, cpf, athleteName, affiliationCode, memberNumber,
//     categoryCode, divisionName, className, placing, isOverallChampion,
//     teamName, companyName, points, eventName, eventDate, raw }
//
// `className` é o que decide a elegibilidade ao Super Overall: resolvido
// contra o catálogo de classes da organização, nunca comparado ao texto
// "OPEN" dentro do código.
// ============================================================================

// Nomes de coluna reconhecidos por padrão. Um contrato diferente é atendido
// passando `fieldMap` — sem tocar no código.
const MAPA_PADRAO = Object.freeze({
  externalResultId: ['external_result_id', 'externalresultid', 'id', 'result_id', 'resultado_id'],
  cpf: ['cpf', 'documento', 'document'],
  athleteName: ['athlete_name', 'atleta', 'nome', 'name'],
  // O arquivo oficial de uma etapa NPC não traz o nome inteiro: traz `First
  // Name` e `Last Name` em colunas separadas. Sem estas duas o nome chegava
  // nulo, e a sugestão por nome — terceira chave do reconhecimento — ficava
  // cega justamente nas linhas que mais precisam dela.
  firstName: ['first_name', 'firstname', 'primeiro_nome'],
  lastName: ['last_name', 'lastname', 'surname', 'sobrenome'],
  affiliationCode: ['affiliation_code', 'filiacao', 'filiacao_codigo', 'affiliation'],
  // Matrícula do atleta DENTRO da entidade de filiação. É o "Member Number"
  // dos arquivos oficiais, e na maioria deles é a única identificação que
  // existe — CPF frequentemente não vem. Sozinha não identifica ninguém: duas
  // federações emitem o mesmo número, então ela só vale com `affiliationCode`.
  memberNumber: ['member_number', 'membernumber', 'member no', 'matricula', 'matrícula',
    'numero_filiacao', 'affiliation_number', 'registro'],
  categoryCode: ['category_code', 'categoria', 'category'],
  divisionName: ['division', 'divisao', 'division_name'],
  className: ['class', 'classe', 'class_name'],
  placing: ['placing', 'colocacao', 'position', 'place'],
  // Campeão Overall informado pela origem. A pontuação (+10) é regra
  // homologada; QUEM foi o campeão o sistema não deduz — é dado informado.
  isOverallChampion: ['overall', 'is_overall', 'campeao_overall', 'overall_champion', 'super_overall'],
  teamName: ['team', 'equipe', 'team_name', 'nome_equipe'],
  companyName: ['company', 'empresa', 'company_name', 'nome_empresa'],
  points: ['points', 'pontos', 'score'],
  eventName: ['event_name', 'evento', 'event'],
  eventDate: ['event_date', 'data', 'data_evento']
});

// Planilha não tem tipo booleano: o mesmo campo chega como SIM, S, TRUE, 1 ou
// X conforme quem exportou. Ausência e valor não reconhecido são `false` — a
// falta de marcação nunca vira um título de campeão.
function booleanoDeOrigem(valor) {
  if (valor === true) return true;
  if (valor == null || valor === false) return false;

  const texto = String(valor).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  return ['sim', 's', 'true', 't', '1', 'x', 'yes', 'y', 'overall'].includes(texto);
}

const normalizarChave = chave => String(chave || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[\s-]+/g, '_');

// Divide uma linha de CSV respeitando aspas duplas e o escape "" dentro delas.
function dividirLinhaCsv(linha, separador) {
  const campos = [];
  let atual = '';
  let dentroDeAspas = false;

  for (let i = 0; i < linha.length; i += 1) {
    const caractere = linha[i];

    if (dentroDeAspas) {
      if (caractere === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i += 1; } else { dentroDeAspas = false; }
      } else {
        atual += caractere;
      }
      continue;
    }

    if (caractere === '"') { dentroDeAspas = true; continue; }
    if (caractere === separador) { campos.push(atual); atual = ''; continue; }
    atual += caractere;
  }

  campos.push(atual);
  return campos.map(campo => campo.trim());
}

// O separador é detectado pelo cabeçalho: planilha brasileira costuma sair com
// ponto e vírgula, e adivinhar errado transformaria a linha inteira num campo.
const detectarSeparador = cabecalho => {
  const pontoEVirgula = (cabecalho.match(/;/g) || []).length;
  const virgula = (cabecalho.match(/,/g) || []).length;
  return pontoEVirgula > virgula ? ';' : ',';
};

function parseCsv(texto) {
  const linhas = String(texto || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(linha => linha.trim().length);

  if (linhas.length < 2) {
    throw new AppError(422, 'IMPORT_EMPTY', 'O arquivo CSV não contém registros além do cabeçalho');
  }

  const separador = detectarSeparador(linhas[0]);
  const cabecalho = dividirLinhaCsv(linhas[0], separador).map(normalizarChave);

  return linhas.slice(1).map(linha => {
    const valores = dividirLinhaCsv(linha, separador);
    const registro = {};
    cabecalho.forEach((coluna, indice) => { registro[coluna] = valores[indice] ?? null; });
    return registro;
  });
}

function parseJson(conteudo) {
  // Arquivo torto é erro DO ARQUIVO, não do servidor. Sem este try, o
  // `JSON.parse` estourava cru e a importação respondia 500 "Erro interno do
  // servidor" — o operador que colasse um arquivo quebrado não fazia ideia do
  // que fazer, e cada tentativa dele entrava no log como falha da aplicação.
  let dados;
  try {
    dados = typeof conteudo === 'string' ? JSON.parse(conteudo) : conteudo;
  } catch (erro) {
    throw new AppError(422, 'IMPORT_FORMAT', `Conteúdo não é um JSON válido: ${erro.message}`);
  }
  const lista = Array.isArray(dados) ? dados : Array.isArray(dados?.results) ? dados.results : Array.isArray(dados?.data) ? dados.data : null;

  if (!lista) {
    throw new AppError(422, 'IMPORT_FORMAT', 'JSON precisa ser um array de resultados ou conter "results"/"data"');
  }
  if (!lista.length) throw new AppError(422, 'IMPORT_EMPTY', 'Nenhum resultado no JSON enviado');

  return lista.map(item => {
    const registro = {};
    for (const [chave, valor] of Object.entries(item || {})) registro[normalizarChave(chave)] = valor;
    return registro;
  });
}

// Localiza o valor de um campo canônico dentro de um registro já normalizado.
function extrair(registro, campo, fieldMap) {
  const candidatos = [
    ...(fieldMap?.[campo] ? [normalizarChave(fieldMap[campo])] : []),
    ...MAPA_PADRAO[campo]
  ];

  for (const nome of candidatos) {
    const valor = registro[nome];
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') return valor;
  }
  return null;
}

const inteiroOuNulo = valor => {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const numero = Number.parseInt(String(valor).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(numero) ? numero : null;
};

const dataOuNula = valor => {
  if (!valor) return null;
  const texto = String(valor).trim();
  // dd/mm/aaaa é o formato que chega de planilha brasileira; Date() leria
  // como mês/dia e trocaria 03/09 por 09/03.
  const brasileira = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const data = brasileira ? new Date(`${brasileira[3]}-${brasileira[2]}-${brasileira[1]}T00:00:00.000Z`) : new Date(texto);
  return Number.isNaN(data.getTime()) ? null : data;
};

const textoOuNulo = valor => {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor).trim();
  return texto === '' ? null : texto;
};

// Nome de exibição a partir do que o arquivo tiver. A composição só entra
// quando NÃO existe coluna de nome inteiro: um cadastro que exporta o nome
// completo já resolveu a questão, e recompor por cima dele trocaria o nome
// oficial por uma concatenação.
function nomeDeExibicao(registro, fieldMap) {
  const inteiro = textoOuNulo(extrair(registro, 'athleteName', fieldMap));
  if (inteiro) return inteiro;

  const partes = [
    textoOuNulo(extrair(registro, 'firstName', fieldMap)),
    textoOuNulo(extrair(registro, 'lastName', fieldMap))
  ].filter(Boolean);

  // Acentuação e caixa saem como vieram: normalizar é trabalho do
  // reconhecimento, e o que a tela mostra é o nome da pessoa.
  return partes.length ? partes.join(' ') : null;
}

// Pedaço estável de uma chave derivada: mesma classe escrita de três jeitos
// diferentes tem de produzir o mesmo identificador, senão a segunda
// importação do MESMO arquivo reexportado duplicaria os pontos.
const pedacoDeChave = valor => String(valor)
  .trim()
  .toUpperCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

/**
 * Identificador de resultado quando o arquivo não traz nenhum.
 *
 * DERIVAR É OPT-IN, E É DE PROPÓSITO. Um adapter que inventa identificador
 * sempre que não acha um transforma "arquivo sem identidade" em "arquivo
 * importado" — que é exatamente o acidente que a idempotência existe para
 * impedir. Só deriva quando o operador declara o prefixo, e só quando as duas
 * colunas que compõem a chave estão presentes: matrícula diz QUEM, classe diz
 * QUAL participação. Faltando qualquer uma, a linha segue sem identificador e
 * é recusada na validação, com motivo legível.
 *
 * A classe entra na chave porque a regra esportiva manda: cada participação é
 * independente, e o mesmo atleta pontua em quantas classes disputar. Uma chave
 * só de matrícula fundiria essas participações num DUPLICATE e apagaria pontos
 * legítimos do acumulado.
 */
function derivarIdExterno(prefixo, memberNumber, className) {
  if (!prefixo || !memberNumber || !className) return null;

  const partes = [prefixo, memberNumber, className].map(pedacoDeChave);
  return partes.every(Boolean) ? partes.join('-') : null;
}

/**
 * Traduz o conteúdo bruto recebido do MuscleWar para registros canônicos.
 *
 * @param {'CSV'|'JSON'|'API'} sourceType
 * @param {string|object} content
 * @param {{ fieldMap?: object }} options
 */
function parse(sourceType, content, options = {}) {
  const tipo = String(sourceType || '').toUpperCase();

  // API entrega o mesmo corpo do JSON: enquanto o contrato do MuscleWar não
  // existir, os dois caminhos compartilham o tradutor em vez de duplicar
  // suposições sobre a resposta.
  const brutos = tipo === 'CSV' ? parseCsv(content)
    : tipo === 'JSON' || tipo === 'API' ? parseJson(content)
      : (() => { throw new AppError(422, 'IMPORT_FORMAT', `Origem não suportada: ${sourceType}`); })();

  return brutos.map((registro, indice) => {
    const cpfBruto = extrair(registro, 'cpf', options.fieldMap);
    const cpf = cpfBruto ? somenteDigitos(cpfBruto) : null;

    const memberNumber = textoOuNulo(extrair(registro, 'memberNumber', options.fieldMap));
    const className = textoOuNulo(extrair(registro, 'className', options.fieldMap));

    // O identificador do arquivo vem primeiro: quando a origem tem um, ele é a
    // identidade do resultado, e derivar por cima dele criaria duas chaves para
    // a mesma participação.
    const externalResultId = textoOuNulo(extrair(registro, 'externalResultId', options.fieldMap))
      ?? derivarIdExterno(options.externalIdPrefix, memberNumber, className);

    return {
      rowNumber: indice + 1,
      // Sem identificador externo não existe idempotência possível para a
      // linha: ela é aceita na leitura e recusada na validação, com motivo.
      externalResultId,
      cpf: cpf && cpf.length === 11 ? cpf : null,
      cpfInvalido: Boolean(cpfBruto) && !isValidCpf(cpf),
      athleteName: nomeDeExibicao(registro, options.fieldMap),
      // A filiação declarada no lote só preenche o que o arquivo não trouxe.
      // A etapa inteira ser de uma federação só é fato do EVENTO, não de cada
      // linha, e o arquivo oficial não tem essa coluna — sem isto a chave #1
      // do reconhecimento (filiação + matrícula) nunca fecharia e o arquivo
      // inteiro cairia em revisão manual. O que o arquivo afirma continua
      // valendo mais: sobrescrever seria trocar dado de origem por formulário.
      affiliationCode: textoOuNulo(extrair(registro, 'affiliationCode', options.fieldMap))
        ?? textoOuNulo(options.defaultAffiliationCode),
      categoryCode: textoOuNulo(extrair(registro, 'categoryCode', options.fieldMap)),
      divisionName: textoOuNulo(extrair(registro, 'divisionName', options.fieldMap)),
      className,
      placing: inteiroOuNulo(extrair(registro, 'placing', options.fieldMap)),
      memberNumber,
      isOverallChampion: booleanoDeOrigem(extrair(registro, 'isOverallChampion', options.fieldMap)),
      teamName: textoOuNulo(extrair(registro, 'teamName', options.fieldMap)),
      companyName: textoOuNulo(extrair(registro, 'companyName', options.fieldMap)),
      points: inteiroOuNulo(extrair(registro, 'points', options.fieldMap)),
      eventName: textoOuNulo(extrair(registro, 'eventName', options.fieldMap)),
      eventDate: dataOuNula(extrair(registro, 'eventDate', options.fieldMap)),
      raw: registro
    };
  });
}

module.exports = { parse, parseCsv, parseJson, MAPA_PADRAO, normalizarChave };
