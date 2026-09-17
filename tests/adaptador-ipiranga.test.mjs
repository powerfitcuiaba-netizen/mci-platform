import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const adapter = require('../src/utils/musclewar/adapter');

// ==========================================================================
// O ARQUIVO OFICIAL DE UMA ETAPA NPC NÃO TEM AS COLUNAS QUE O MCI PEDIA.
//
// Duas ausências, medidas contra o cabeçalho real:
//
//   1. o nome vem PARTIDO em `First Name` e `Last Name`, e o adapter só
//      conhecia `athlete_name`/`nome`. Resultado: nome nulo, e a sugestão por
//      nome — a terceira chave do reconhecimento — ficava cega.
//
//   2. não existe identificador de resultado. `Athlete #` é o número do
//      competidor DENTRO do arquivo, e a idempotência da importação exige uma
//      chave que sobreviva a uma reexportação. Sem ela toda linha era
//      IMPORT_REJECTED, e a importação inteira parava em zero.
//
// A segunda ausência não pode ser resolvida em silêncio. Um adapter que
// inventa identificador quando não acha nenhum transforma "arquivo sem
// identidade" em "arquivo importado", que é exatamente o erro que a
// idempotência existe para impedir. Por isso a derivação é OPT-IN: só acontece
// quando o operador declara o prefixo, e só quando as duas colunas que compõem
// a chave estão presentes na linha.
// ==========================================================================

const csv = linhas => linhas.join('\n');

// O cabeçalho real da etapa, na ordem em que sai do sistema de origem.
const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
const linha = (n, classe, primeiro, ultimo, matricula, total, colocacao) =>
  `${n},${classe},${primeiro},${ultimo},${matricula},Brazil,28,1,${total},${colocacao}`;

const ARQUIVO = csv([
  CABECALHO,
  linha(1, 'Bikini Open', 'Yuri', 'Santinelli', '88281', '95.5', '1'),
  linha(2, 'Bikini Novice', 'Kananda', 'Dos Santos Azevedo', '147986', '88.0', '2')
]);

describe('nome partido em duas colunas', () => {
  it('compõe First Name + Last Name quando não existe coluna de nome inteiro', () => {
    const [primeiro] = adapter.parse('CSV', ARQUIVO);
    expect(primeiro.athleteName).toBe('Yuri Santinelli');
  });

  it('compõe sobrenome com mais de uma palavra sem perder nenhuma', () => {
    const [, segundo] = adapter.parse('CSV', ARQUIVO);
    expect(segundo.athleteName).toBe('Kananda Dos Santos Azevedo');
  });

  it('uma coluna de nome inteiro continua tendo precedência sobre as partidas', () => {
    const arquivo = csv([
      'athlete_name,First Name,Last Name,Member Number,Class,Placing',
      'Nome Oficial Do Cadastro,Outro,Nome,88281,Bikini Open,1'
    ]);
    expect(adapter.parse('CSV', arquivo)[0].athleteName).toBe('Nome Oficial Do Cadastro');
  });

  it('só um dos dois campos não produz espaço sobrando', () => {
    const so = campo => adapter.parse('CSV', csv([
      `${campo},Member Number,Class,Placing`, 'Yuri,88281,Bikini Open,1'
    ]))[0].athleteName;

    expect(so('First Name')).toBe('Yuri');
    expect(so('Last Name')).toBe('Yuri');
  });

  it('preserva o nome de origem para exibição, acentos inclusive', () => {
    const arquivo = csv([
      'First Name,Last Name,Member Number,Class,Placing',
      'Fábia,Conceição,46576,Bikini Masters,4'
    ]);
    expect(adapter.parse('CSV', arquivo)[0].athleteName).toBe('Fábia Conceição');
  });
});

describe('identificador derivado — só quando o operador pede', () => {
  it('SEM prefixo declarado, nada é derivado: o arquivo continua sem identidade', () => {
    for (const registro of adapter.parse('CSV', ARQUIVO)) {
      expect(registro.externalResultId).toBeNull();
    }
  });

  it('com prefixo, a chave é prefixo + matrícula + classe', () => {
    const [primeiro] = adapter.parse('CSV', ARQUIVO, { externalIdPrefix: 'IPIRANGA' });
    expect(primeiro.externalResultId).toBe('IPIRANGA-88281-BIKINI_OPEN');
  });

  it('a mesma linha lida duas vezes produz a mesma chave', () => {
    const opcoes = { externalIdPrefix: 'IPIRANGA' };
    const primeira = adapter.parse('CSV', ARQUIVO, opcoes).map(r => r.externalResultId);
    const segunda = adapter.parse('CSV', ARQUIVO, opcoes).map(r => r.externalResultId);
    expect(segunda).toEqual(primeira);
  });

  it('o mesmo atleta em classes diferentes recebe chaves diferentes', () => {
    // É a regra esportiva: cada participação é independente e pontua sozinha.
    // Uma chave que ignorasse a classe fundiria as duas num DUPLICATE e
    // apagaria pontos legítimos do acumulado.
    const arquivo = csv([
      CABECALHO,
      linha(1, 'Bikini Open', 'Yuri', 'Santinelli', '88281', '95.5', '1'),
      linha(2, 'Bikini Novice', 'Yuri', 'Santinelli', '88281', '93.0', '1')
    ]);
    const [a, b] = adapter.parse('CSV', arquivo, { externalIdPrefix: 'IPIRANGA' });
    expect(a.externalResultId).not.toBe(b.externalResultId);
  });

  it('variações de caixa, acento e espaçamento na classe convergem para uma chave', () => {
    const daClasse = classe => adapter.parse('CSV', csv([
      'Member Number,Class,First Name,Last Name,Placing', `88281,${classe},Yuri,Santinelli,1`
    ]), { externalIdPrefix: 'IPIRANGA' })[0].externalResultId;

    const referencia = daClasse('Bikini Open');
    expect(daClasse('BIKINI OPEN')).toBe(referencia);
    expect(daClasse('bikini  open')).toBe(referencia);
    expect(daClasse(' Bikini Open ')).toBe(referencia);
  });

  it('sem matrícula NÃO deriva: chave inventada é pior que linha recusada', () => {
    const arquivo = csv([
      'Member Number,Class,First Name,Last Name,Placing', ',Bikini Open,Yuri,Santinelli,1'
    ]);
    expect(adapter.parse('CSV', arquivo, { externalIdPrefix: 'IPIRANGA' })[0].externalResultId).toBeNull();
  });

  it('sem classe NÃO deriva', () => {
    const arquivo = csv([
      'Member Number,Class,First Name,Last Name,Placing', '88281,,Yuri,Santinelli,1'
    ]);
    expect(adapter.parse('CSV', arquivo, { externalIdPrefix: 'IPIRANGA' })[0].externalResultId).toBeNull();
  });

  it('identificador que o arquivo já traz tem precedência sobre a derivação', () => {
    const arquivo = csv([
      'external_result_id,Member Number,Class,First Name,Last Name,Placing',
      'MW-777,88281,Bikini Open,Yuri,Santinelli,1'
    ]);
    expect(adapter.parse('CSV', arquivo, { externalIdPrefix: 'IPIRANGA' })[0].externalResultId).toBe('MW-777');
  });
});

describe('o que o arquivo NÃO pode provocar', () => {
  it('Total Score não é lido como pontuação de ranking', () => {
    // 95.5 é nota de julgamento externo. Ler isso como ponto de ranking daria
    // 95 pontos a quem a regra homologada dá 5.
    for (const registro of adapter.parse('CSV', ARQUIVO, { externalIdPrefix: 'IPIRANGA' })) {
      expect(registro.points).toBeNull();
    }
  });

  it('arquivo sem coluna de Overall não produz nenhum campeão', () => {
    for (const registro of adapter.parse('CSV', ARQUIVO, { externalIdPrefix: 'IPIRANGA' })) {
      expect(registro.isOverallChampion).toBe(false);
    }
  });

  it('a colocação continua vindo de Placing, e só dela', () => {
    const [primeiro, segundo] = adapter.parse('CSV', ARQUIVO, { externalIdPrefix: 'IPIRANGA' });
    expect(primeiro.placing).toBe(1);
    expect(segundo.placing).toBe(2);
  });

  it('a matrícula não é confundida com o número do competidor no arquivo', () => {
    // `Athlete #` = 1 e `Member Number` = 88281 na mesma linha. Trocar os dois
    // faria o reconhecimento procurar a matrícula 1.
    expect(adapter.parse('CSV', ARQUIVO)[0].memberNumber).toBe('88281');
  });
});

describe('filiação do lote — o arquivo não tem a coluna, e a chave exige as duas', () => {
  // A prioridade #1 do reconhecimento é filiação + matrícula, as duas juntas:
  // duas federações emitem o mesmo número, e matrícula sozinha não identifica
  // ninguém. O arquivo da etapa traz `Member Number` e não traz filiação
  // nenhuma — a etapa inteira é de uma federação só, e isso é fato do EVENTO,
  // não de cada linha. Sem um jeito de declarar isso, a chave #1 nunca fecha e
  // as 191 linhas caem todas em revisão manual.
  const SEM_FILIACAO = csv([
    'Member Number,Class,First Name,Last Name,Placing', '88281,Bikini Open,Yuri,Santinelli,1'
  ]);

  it('sem declaração, a filiação continua nula — nada é presumido', () => {
    expect(adapter.parse('CSV', SEM_FILIACAO)[0].affiliationCode).toBeNull();
  });

  it('a filiação declarada no lote preenche a linha que não tem a coluna', () => {
    const [registro] = adapter.parse('CSV', SEM_FILIACAO, { defaultAffiliationCode: 'NPC' });
    expect(registro.affiliationCode).toBe('NPC');
  });

  it('a filiação do ARQUIVO tem precedência sobre a do lote', () => {
    // Um arquivo que identifica a federação linha a linha sabe mais do que o
    // operador que preencheu um campo na tela. Sobrescrever isso trocaria o
    // dado de origem por um palpite de formulário.
    const comColuna = csv([
      'Member Number,Class,First Name,Last Name,Placing,filiacao',
      '88281,Bikini Open,Yuri,Santinelli,1,FED-MT'
    ]);
    expect(adapter.parse('CSV', comColuna, { defaultAffiliationCode: 'NPC' })[0].affiliationCode).toBe('FED-MT');
  });

  it('declarar filiação não inventa matrícula onde não existe', () => {
    const semMatricula = csv([
      'Member Number,Class,First Name,Last Name,Placing', ',Bikini Open,Yuri,Santinelli,1'
    ]);
    expect(adapter.parse('CSV', semMatricula, { defaultAffiliationCode: 'NPC' })[0].memberNumber).toBeNull();
  });
});

// ==========================================================================
// NS — NÃO COMPARECEU É PARTICIPAÇÃO, NÃO É LINHA QUEBRADA.
//
// A regra homologada diz NS = 0 pontos. Dizer "0 pontos" é dizer que existe
// uma participação a pontuar: o atleta consta na chamada da classe e não subiu.
// Isso é fato esportivo e pertence ao histórico dele.
//
// O motor lia `NS` como colocação ilegível, a linha caía sem colocação NEM
// pontuação, e a importação a recusava. O ranking acabava certo por acidente
// — zero é zero de qualquer jeito —, mas o histórico perdia a participação e
// a tela dizia "linha inválida" sobre uma linha perfeitamente válida.
//
// O que NÃO pode acontecer aqui: `NS` virar 0 no campo de COLOCAÇÃO. Zero não
// é uma colocação, e gravar 0 ali faria a linha disputar a tabela de pontos
// como se fosse um lugar no pódio.
// ==========================================================================

describe('NS é participação válida que vale zero', () => {
  const comPlacing = valor => adapter.parse('CSV', csv([
    'Member Number,Class,First Name,Last Name,Placing', `88281,Bikini Open,Yuri,Santinelli,${valor}`
  ]), { externalIdPrefix: 'IPIRANGA' })[0];

  it('NS não vira colocação nenhuma — nem zero', () => {
    expect(comPlacing('NS').placing).toBeNull();
  });

  it('NS é marcado como não comparecimento', () => {
    expect(comPlacing('NS').didNotShow).toBe(true);
  });

  it('a marca não depende da caixa nem de espaço em volta', () => {
    for (const texto of ['ns', 'Ns', ' NS ', 'nS']) {
      expect(comPlacing(texto).didNotShow, texto).toBe(true);
    }
  });

  it('colocação de verdade NÃO é não comparecimento', () => {
    for (const lugar of ['1', '5', '13']) {
      expect(comPlacing(lugar).didNotShow, lugar).toBe(false);
      expect(comPlacing(lugar).placing, lugar).toBe(Number(lugar));
    }
  });

  it('campo vazio continua sendo ausência, não NS', () => {
    // Célula em branco é informação que faltou. Chamar isso de "não
    // compareceu" inventaria um fato esportivo a partir de um buraco.
    const vazio = comPlacing('');
    expect(vazio.placing).toBeNull();
    expect(vazio.didNotShow).toBe(false);
  });

  it('texto desconhecido não é promovido a NS', () => {
    for (const lixo of ['XX', 'ABC', '--']) {
      expect(comPlacing(lixo).didNotShow, lixo).toBe(false);
    }
  });

  it('NS não produz campeão de Overall', () => {
    expect(comPlacing('NS').isOverallChampion).toBe(false);
  });

  it('NS continua recebendo chave de idempotência', () => {
    // Sem chave a linha seria recusada de novo, agora por outro motivo.
    expect(comPlacing('NS').externalResultId).toBe('IPIRANGA-88281-BIKINI_OPEN');
  });
});

// ==========================================================================
// A COLUNA `Class` CARREGA TRÊS INFORMAÇÕES, E O MCI GUARDA AS TRÊS SEPARADAS.
//
// "Men's Bodybuilding - Masters 35+" é categoria, divisão e classe numa string
// só. Sem decompor, o ponto entrava com categoria NULA e o ranking por
// categoria ficava vazio — o número existia e não tinha onde aparecer.
//
// O TEXTO ORIGINAL CONTINUA SENDO `className`, E ISSO É DELIBERADO. A chave de
// idempotência é montada com ele. Trocar `className` pela classe decomposta
// faria "Men's Bodybuilding - Novice" e "Men's Classic Physique - Novice"
// virarem a MESMA chave `...-NOVICE` — a segunda entraria como DUPLICATE e o
// atleta perderia 5 pontos legítimos do acumulado.
// ==========================================================================

describe('decomposição da classe composta', () => {
  const decompor = classe => adapter.parse('CSV', csv([
    'Member Number,Class,First Name,Last Name,Placing', `88281,${classe},Yuri,Santinelli,1`
  ]))[0];

  // Os dez casos que a homologação mandou cobrir, um a um.
  const CASOS = [
    ["Women's Bikini - Open Class A", 'BIKINI', 'Open', 'A'],
    ["Women's Bikini - Open Class B", 'BIKINI', 'Open', 'B'],
    ["Women's Bikini - Masters 35+", 'BIKINI', 'Masters', '35+'],
    ["Women's Fit Model - True Novice", 'FITMODEL', 'True Novice', null],
    ["Women's Fit Model - Open Class B", 'FITMODEL', 'Open', 'B'],
    ["Women's Wellness - Open Class A", 'WELLNESS', 'Open', 'A'],
    ["Men's Bodybuilding - Masters 35+", 'MENS_BODYBUILDING', 'Masters', '35+'],
    ["Men's Bodybuilding - Open Light Heavyweight", 'MENS_BODYBUILDING', 'Open', 'Light Heavyweight'],
    ["Men's Classic Physique - Open Class B", 'CLASSIC_PHYSIQUE', 'Open', 'B'],
    ["Men's Physique - Masters 45+", 'MENS_PHYSIQUE', 'Masters', '45+']
  ];

  it.each(CASOS)('%s → %s / %s / %s', (classe, categoria, divisao, rotulo) => {
    const r = decompor(classe);
    expect(r.categoryCode).toBe(categoria);
    expect(r.divisionName).toBe(divisao);
    expect(r.classLabel).toBe(rotulo);
  });

  it('o texto original é preservado inteiro', () => {
    expect(decompor("Men's Bodybuilding - Masters 35+").className)
      .toBe("Men's Bodybuilding - Masters 35+");
  });

  it('as divisões sem classe não inventam rótulo', () => {
    for (const d of ['Novice', 'True Novice', 'Junior', 'Teenage', 'Special']) {
      const r = decompor(`Men's Classic Physique - ${d}`);
      expect(r.divisionName, d).toBe(d);
      expect(r.classLabel, d).toBeNull();
    }
  });

  it('a chave de idempotência continua saindo do texto INTEIRO', () => {
    // A prova de que a decomposição não funde participações: mesmo atleta,
    // mesma divisão Novice, categorias diferentes, chaves diferentes.
    const chave = classe => adapter.parse('CSV', csv([
      'Member Number,Class,First Name,Last Name,Placing', `88281,${classe},Yuri,Santinelli,1`
    ]), { externalIdPrefix: 'IPIRANGA' })[0].externalResultId;

    const a = chave("Men's Bodybuilding - Novice");
    const b = chave("Men's Classic Physique - Novice");
    expect(a).not.toBe(b);
    expect(a).toBe('IPIRANGA-88281-MEN_S_BODYBUILDING_NOVICE');
  });

  it('uma categoria informada pelo ARQUIVO tem precedência sobre a derivada', () => {
    const comColuna = adapter.parse('CSV', csv([
      'Member Number,Class,categoria,First Name,Last Name,Placing',
      "88281,Men's Bodybuilding - Novice,WELLNESS,Yuri,Santinelli,1"
    ]))[0];
    expect(comColuna.categoryCode).toBe('WELLNESS');
  });

  it('classe sem o separador não é decomposta, e não inventa categoria', () => {
    const r = decompor('OPEN');
    expect(r.className).toBe('OPEN');
    expect(r.categoryCode).toBeNull();
    expect(r.divisionName).toBeNull();
    expect(r.classLabel).toBeNull();
  });

  it('categoria fora do mapa conhecido fica nula em vez de ser adivinhada', () => {
    const r = decompor('Categoria Que Nao Existe - Open Class A');
    expect(r.categoryCode).toBeNull();
    // A divisão é estrutural e continua legível mesmo sem a categoria.
    expect(r.divisionName).toBe('Open');
  });
});

// ==========================================================================
// AS 57 CLASSES DA ETAPA, UMA A UMA.
//
// Os dez casos acima cobrem as formas. Este cobre o CONJUNTO: nenhuma das 57
// pode sair com categoria nula, porque categoria nula é ponto sem recorte —
// o número existe e não aparece em ranking nenhum.
//
// A lista vive aqui, no teste, e não num arquivo de dados: são 57 strings de
// catálogo esportivo, sem nome de atleta e sem matrícula. O arquivo da etapa
// não é versionado — ele traz dado pessoal de 191 pessoas e o repositório é
// público.
// ==========================================================================

const CATEGORIAS_DA_ETAPA = Object.freeze({
  "Men's Bodybuilding": 'MENS_BODYBUILDING',
  "Men's Classic Physique": 'CLASSIC_PHYSIQUE',
  "Men's Physique": 'MENS_PHYSIQUE',
  "Women's Bikini": 'BIKINI',
  "Women's Figure": 'FIGURE',
  "Women's Fit Model": 'FITMODEL',
  "Women's Physique": 'WOMENS_PHYSIQUE',
  "Women's Wellness": 'WELLNESS'
});

const RECORTES_DA_ETAPA = Object.freeze({
  "Men's Bodybuilding": ['True Novice', 'Novice', 'Junior', 'Masters 35+', 'Masters 40+',
    'Open Middleweight', 'Open Light Heavyweight', 'Open Heavyweight', 'Open Super Heavyweight'],
  "Men's Classic Physique": ['True Novice', 'Novice', 'Junior', 'Teenage', 'Special',
    'Masters 35+', 'Masters 40+', 'Open Class A', 'Open Class B', 'Open Class C', 'Open Class D'],
  "Men's Physique": ['True Novice', 'Novice', 'Junior', 'Teenage', 'Masters 35+', 'Masters 45+',
    'Open Class A', 'Open Class C', 'Open Class D'],
  "Women's Bikini": ['True Novice', 'Novice', 'Junior', 'Teenage', 'Masters 35+', 'Masters 40+',
    'Open Class A', 'Open Class B', 'Open Class C', 'Open Class D'],
  "Women's Figure": ['Masters 40+', 'Open Class A', 'Open Class B'],
  "Women's Fit Model": ['True Novice', 'Novice', 'Junior', 'Open Class B', 'Open Class C', 'Open Class D'],
  "Women's Physique": ['Masters 35+', 'Open Class A'],
  "Women's Wellness": ['True Novice', 'Novice', 'Masters 35+', 'Masters 45+',
    'Open Class A', 'Open Class B', 'Open Class C']
});

const TODAS_AS_CLASSES = Object.entries(RECORTES_DA_ETAPA)
  .flatMap(([categoria, recortes]) => recortes.map(recorte => `${categoria} - ${recorte}`));

describe('as 57 classes da etapa', () => {
  const ler = classe => adapter.parse('CSV', csv([
    'Member Number,Class,First Name,Last Name,Placing', `88281,${classe},Yuri,Santinelli,1`
  ]), { externalIdPrefix: 'IPIRANGA' })[0];

  it('são exatamente 57', () => {
    expect(TODAS_AS_CLASSES).toHaveLength(57);
    expect(new Set(TODAS_AS_CLASSES).size).toBe(57);
  });

  it('nenhuma sai com categoria nula', () => {
    const semCategoria = TODAS_AS_CLASSES.filter(c => ler(c).categoryCode === null);
    expect(semCategoria).toEqual([]);
  });

  it('cada uma cai na categoria do seu próprio prefixo', () => {
    for (const [categoria, recortes] of Object.entries(RECORTES_DA_ETAPA)) {
      for (const recorte of recortes) {
        expect(ler(`${categoria} - ${recorte}`).categoryCode, `${categoria} - ${recorte}`)
          .toBe(CATEGORIAS_DA_ETAPA[categoria]);
      }
    }
  });

  it('nenhuma sai sem divisão', () => {
    const semDivisao = TODAS_AS_CLASSES.filter(c => !ler(c).divisionName);
    expect(semDivisao).toEqual([]);
  });

  it('as 57 produzem 57 chaves de idempotência distintas', () => {
    // A prova de que decompor não funde participações do mesmo atleta.
    const chaves = TODAS_AS_CLASSES.map(c => ler(c).externalResultId);
    expect(new Set(chaves).size).toBe(57);
  });

  it('só as divisões Open e Masters produzem rótulo de classe', () => {
    for (const classe of TODAS_AS_CLASSES) {
      const r = ler(classe);
      const temRotulo = r.classLabel !== null;
      const ehRecortada = ['Open', 'Masters'].includes(r.divisionName);
      expect(temRotulo, classe).toBe(ehRecortada);
    }
  });
});
