import { describe, it, expect } from 'vitest';
import { parse, MAPA_PADRAO, normalizarChave } from '../src/utils/musclewar/adapter.js';

// ============================================================================
// O CABEÇALHO DO ARQUIVO E A LISTA DE APELIDOS, NA MESMA FORMA.
//
// O DEFEITO, medido antes de existir correção
//
// `normalizarChave` passa o cabeçalho do arquivo para minúsculas, remove
// acento e troca espaço e hífen por `_`. A lista de apelidos era comparada
// CRUA. Resultado: todo apelido escrito com espaço, acento ou maiúscula era
// INALCANÇÁVEL — estava na lista e não reconhecia coluna nenhuma.
//
// Dois estavam assim, os dois de `memberNumber`: `'member no'` e
// `'matrícula'`. O primeiro custava caro, porque `Member No` é grafia comum em
// arquivo oficial.
//
// POR QUE PERDER A MATRÍCULA NÃO É PERDER UM CAMPO
//
// Sem matrícula a linha cai na identidade `EXT:{fonte}:{resultado}` — uma
// identidade POR RESULTADO, com filiação e matrícula nulas. A tela mostra "—"
// com fidelidade, e o vínculo tardio, que procura `AFF:{filiação}:{número}`
// por chave exata, não tem como alcançar aquele resultado nunca mais: o atleta
// cadastrado depois não reencontra o próprio histórico. Uma coluna não lida
// apaga a consolidação automática de um campeonato inteiro.
//
// ESTE ARQUIVO NÃO PRECISA DE BANCO. É o adaptador, que é função pura sobre
// texto: a prova roda em qualquer máquina, sem PostgreSQL, sem RLS, sem ator.
// A parte que precisa de banco — identidade, ledger, idempotência — já está
// provada em `identidade-por-matricula`, `matricula-identifica-um`,
// `vinculo-tardio` e `vinculo-resultado-evento-ponto`, e NÃO é duplicada aqui.
// ============================================================================

// Uma linha de CSV com o cabeçalho que se quer testar para a matrícula. As
// outras colunas são as mínimas para a linha ser legível.
const csvComCabecalhoDeMatricula = cabecalho => [
  `external_result_id,atleta,${cabecalho},categoria,classe,colocacao`,
  `r1,Lucas Lima,2932,MENS_BODYBUILDING,OPEN,1`
].join('\n');

const csvComCabecalhoDeFiliacao = cabecalho => [
  `external_result_id,atleta,${cabecalho},matricula,categoria,classe,colocacao`,
  `r1,Lucas Lima,NPC,2932,MENS_BODYBUILDING,OPEN,1`
].join('\n');

const umaLinha = conteudo => {
  const linhas = parse('CSV', conteudo);
  expect(linhas, 'o arquivo de uma linha produz uma linha').toHaveLength(1);
  return linhas[0];
};

// ====================================== A MATRÍCULA, EM TODAS AS GRAFIAS ===
describe('a coluna de matrícula é reconhecida nas grafias reais', () => {
  // Os números são os da lista que a fase nomeou, um teste por grafia. Cada um
  // falha sozinho: saber QUAL grafia quebrou é metade do conserto.
  const GRAFIAS = [
    ['1', 'Member Number'],
    ['2', 'Member No'],
    ['3', 'Member No.'],
    ['4', 'Member #'],
    ['5', 'Affiliation Number'],
    ['6', 'Matrícula'],
    ['7', 'Número de Filiação'],
    ['8', 'numero_de_filiacao'],
    ['9', 'num_filiacao']
  ];

  for (const [numero, cabecalho] of GRAFIAS) {
    it(`${numero}. "${cabecalho}" vira memberNumber "2932"`, () => {
      const linha = umaLinha(csvComCabecalhoDeMatricula(cabecalho));
      expect(linha.memberNumber, `a coluna "${cabecalho}" não foi lida`).toBe('2932');
    });
  }

  // As grafias que já funcionavam continuam funcionando: a correção amplia, não
  // troca.
  it('as grafias antigas não regridem: matricula, numero_filiacao, registro', () => {
    for (const cabecalho of ['matricula', 'numero_filiacao', 'registro', 'MEMBERNUMBER']) {
      expect(umaLinha(csvComCabecalhoDeMatricula(cabecalho)).memberNumber, cabecalho).toBe('2932');
    }
  });
});

// ======================================== A FILIAÇÃO, EM TODAS AS GRAFIAS ===
describe('a coluna de filiação é reconhecida nas grafias reais', () => {
  const GRAFIAS = [
    ['10', 'Affiliation'],
    ['11', 'Affiliation Code'],
    ['12', 'Filiação'],
    ['13', 'Federação'],
    ['14', 'federacao'],
    ['15', 'Entidade'],
    ['16', 'affiliate']
  ];

  for (const [numero, cabecalho] of GRAFIAS) {
    it(`${numero}. "${cabecalho}" vira affiliationCode "NPC"`, () => {
      const linha = umaLinha(csvComCabecalhoDeFiliacao(cabecalho));
      expect(linha.affiliationCode, `a coluna "${cabecalho}" não foi lida`).toBe('NPC');
      // E a matrícula continua vindo junto: as duas formam a identidade.
      expect(linha.memberNumber).toBe('2932');
    });
  }
});

// ============================================== A TRAVA QUE IMPEDE RECAÍDA ==
describe('cabeçalho e apelidos passam pela MESMA normalização', () => {
  it('17. nenhum apelido da lista é inalcançável', () => {
    // Um apelido só reconhece coluna se existir na forma em que as chaves do
    // registro existem — a normalizada. Esta é a trava que impede um apelido
    // novo de nascer morto: quem escrever "Member No" na lista reprova aqui.
    const mortos = [];
    for (const [campo, apelidos] of Object.entries(MAPA_PADRAO)) {
      for (const apelido of apelidos) {
        if (normalizarChave(apelido) !== apelido) mortos.push(`${campo}: ${apelido}`);
      }
    }
    expect(mortos, 'apelidos que nunca casariam com um cabeçalho normalizado').toEqual([]);
  });

  it('18. o apelido que estava morto reconhece a coluna agora', () => {
    // `member no` estava na lista e não lia nada, porque `Member No` normaliza
    // para `member_no`. É o caso que custou a matrícula de arquivos inteiros.
    expect(umaLinha(csvComCabecalhoDeMatricula('Member No')).memberNumber).toBe('2932');
    expect(umaLinha(csvComCabecalhoDeMatricula('MEMBER NO')).memberNumber).toBe('2932');
    expect(umaLinha(csvComCabecalhoDeMatricula('member-no')).memberNumber).toBe('2932');
  });
});

// ================================== O QUE A CORREÇÃO NÃO PODE FAZER ========
describe('o parser continua recusando inventar identidade', () => {
  it('20. arquivo SEM matrícula não ganha matrícula nenhuma', () => {
    const linha = umaLinha([
      'external_result_id,atleta,filiacao,categoria,classe,colocacao',
      'r1,Lucas Lima,NPC,MENS_BODYBUILDING,OPEN,1'
    ].join('\n'));

    expect(linha.memberNumber, 'sem coluna de matrícula, o campo é NULO').toBeNull();
    expect(linha.affiliationCode).toBe('NPC');
  });

  it('21. arquivo SEM filiação não ganha NPC por dedução', () => {
    const linha = umaLinha(csvComCabecalhoDeMatricula('Member No'));

    expect(linha.affiliationCode, 'nada no arquivo diz NPC, então não é NPC').toBeNull();
    expect(linha.memberNumber).toBe('2932');
  });

  it('21b. a filiação do LOTE preenche o que o arquivo não trouxe, e só isso', () => {
    // `defaultAffiliationCode` é fato do EVENTO, declarado pelo operador — não
    // é dedução do parser. E o que o arquivo afirma continua valendo mais.
    const semColuna = parse('CSV', csvComCabecalhoDeMatricula('Member No'),
      { defaultAffiliationCode: 'NPC' })[0];
    expect(semColuna.affiliationCode).toBe('NPC');

    const comColuna = parse('CSV', csvComCabecalhoDeFiliacao('Federação'),
      { defaultAffiliationCode: 'IFBB' })[0];
    expect(comColuna.affiliationCode, 'o arquivo vence o padrão do lote').toBe('NPC');
  });

  it('22. o nome do atleta NÃO vira chave de identidade em lugar nenhum', () => {
    const linha = umaLinha(csvComCabecalhoDeMatricula('Member No'));

    // O nome é lido e preservado — ele é dado da fonte. O que ele não faz é
    // identificar: quem identifica é filiação + matrícula, e o parser não
    // produz identidade a partir de nome.
    expect(linha.athleteName).toBe('Lucas Lima');
    expect(Object.keys(linha)).not.toContain('identityKey');
  });

  it('o número de filiação NUNCA é copiado para número de atleta', () => {
    const linha = umaLinha(csvComCabecalhoDeMatricula('Member No'));
    expect(linha.memberNumber).toBe('2932');
    // `athleteNumber` é identificador operacional do cadastro, com unicidade
    // diferente. O parser não o produz, e nunca deve produzi-lo a partir da
    // matrícula: NPC+2932 e IFBB+2932 são duas pessoas legítimas.
    expect(linha.athleteNumber).toBeUndefined();
    expect(JSON.stringify(linha)).not.toContain('athleteNumber');
  });
});

// ============================== O RESTO DA LINHA NÃO É AFETADO ==============
describe('ler a matrícula não muda mais nada na linha', () => {
  it('24. evento, categoria, classe, colocação e Overall seguem iguais', () => {
    const linha = umaLinha([
      'external_result_id,atleta,Member No,Federação,categoria,classe,colocacao,evento,overall',
      'r-razor,Lucas Lima,2932,NPC,MENS_BODYBUILDING,OPEN,1,Campeonato Razor,sim'
    ].join('\n'));

    expect(linha.externalResultId).toBe('r-razor');
    expect(linha.memberNumber).toBe('2932');
    expect(linha.affiliationCode).toBe('NPC');
    expect(linha.categoryCode).toBe('MENS_BODYBUILDING');
    expect(linha.className).toBe('OPEN');
    expect(linha.placing).toBe(1);
    expect(linha.eventName).toBe('Campeonato Razor');
    expect(linha.isOverallChampion).toBe(true);
    expect(linha.didNotShow).toBe(false);
  });

  it('a linha bruta é preservada inteira, para a conferência contra a súmula', () => {
    const linha = umaLinha(csvComCabecalhoDeMatricula('Member No'));
    // `raw` guarda o registro como o arquivo o trouxe, com as chaves
    // normalizadas. É por ele que se descobre, depois, qual grafia a origem
    // usou — sem o arquivo em mãos.
    expect(linha.raw).toBeTruthy();
    expect(Object.keys(linha.raw)).toContain('member_no');
  });

  it('23. reler o MESMO arquivo produz o MESMO externalResultId', () => {
    // Idempotência começa aqui: a identidade do resultado não pode variar entre
    // duas leituras do mesmo conteúdo, senão a reimportação duplica.
    const conteudo = csvComCabecalhoDeMatricula('Member No');
    const [primeira] = parse('CSV', conteudo);
    const [segunda] = parse('CSV', conteudo);

    expect(segunda.externalResultId).toBe(primeira.externalResultId);
    expect(segunda.memberNumber).toBe(primeira.memberNumber);
    expect(segunda.affiliationCode).toBe(primeira.affiliationCode);
  });
});

// ================================================= O CASO REAL, EM ABERTO ==
describe('o caso do campeonato Razor', () => {
  // ATENÇÃO: a grafia REAL do cabeçalho do arquivo Razor NÃO foi lida — ela
  // está em `MuscleWarImportItem.raw`, no banco de produção, inacessível deste
  // ambiente. Então este teste cobre TODAS as grafias candidatas em vez de
  // afirmar qual foi a usada. Quando a grafia real for conhecida, ela já está
  // aqui — e se não estiver, é só acrescentá-la à lista acima.
  it('NPC + 2932 é lido em qualquer uma das grafias candidatas', () => {
    for (const cabecalho of ['Member Number', 'Member No', 'Member No.', 'Member #',
      'Matrícula', 'Número de Filiação', 'Affiliation Number']) {
      const linha = umaLinha([
        `external_result_id,atleta,${cabecalho},Federação,categoria,classe,colocacao,evento`,
        'r-razor,Lucas Lima,2932,NPC,MENS_BODYBUILDING,OPEN,1,Campeonato Razor'
      ].join('\n'));

      expect(linha.memberNumber, cabecalho).toBe('2932');
      expect(linha.affiliationCode, cabecalho).toBe('NPC');
    }
  });
});
