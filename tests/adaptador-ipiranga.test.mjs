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
