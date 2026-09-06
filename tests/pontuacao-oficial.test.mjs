import { describe, it, expect } from 'vitest';
import {
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL,
  pontuarResultado, contadores, compararOficial, classificar
} from '../src/utils/rankingScoring.js';

// ============================================================================
// REGRA OFICIAL DE PONTUAÇÃO E DESEMPATE — fase 11.1
//
// Documentação executável da regra homologada. Cada caso mostra o número, para
// que o comitê técnico confira a aritmética lendo o teste.
// ============================================================================

const TABELA = TABELA_OFICIAL_COLOCACAO;

const competidor = (nome, dados) => ({
  nome, totalPoints: 0,
  overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 0,
  thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0,
  ...dados
});

describe('A) tabela de pontos por colocação', () => {
  it('1º=5 · 2º=4 · 3º=3 · 4º=2 · 5º=1', () => {
    expect(TABELA).toEqual([
      { placing: 1, points: 5 },
      { placing: 2, points: 4 },
      { placing: 3, points: 3 },
      { placing: 4, points: 2 },
      { placing: 5, points: 1 }
    ]);

    for (const { placing, points } of TABELA) {
      expect(pontuarResultado(placing, TABELA).points, `${placing}º`).toBe(points);
    }
  });

  it('do 6º em diante não há pontuação homologada: zero, e não um valor presumido', () => {
    // PENDING HOMOLOGATION — a tabela oficial pode estender a faixa; enquanto
    // não estender, atribuir qualquer valor seria inventar regulamento.
    expect(pontuarResultado(6, TABELA).points).toBe(0);
    expect(pontuarResultado(10, TABELA).points).toBe(0);
    expect(pontuarResultado(null, TABELA).points).toBe(0);
  });
});

describe('B/C) bônus Overall', () => {
  it('o bônus é +10 e SOMA aos pontos da colocação — não os substitui', () => {
    expect(BONUS_OVERALL).toBe(10);

    // Numa classe elegível o bônus também vai para o Super Overall: ele não
    // tem elegibilidade própria, segue a da participação que o originou.
    const comOverall = pontuarResultado(1, TABELA, true, true);
    expect(comOverall).toEqual({ placementPoints: 5, overallBonus: 10, points: 15, superOverallPoints: 15 });
  });

  it('1º sem Overall = 5', () => {
    expect(pontuarResultado(1, TABELA, false, true))
      .toEqual({ placementPoints: 5, overallBonus: 0, points: 5, superOverallPoints: 5 });
  });

  it('o bônus acompanha a colocação de quem o recebeu', () => {
    // Se o campeão Overall tiver vindo de um 2º lugar, o total é 4 + 10 = 14.
    expect(pontuarResultado(2, TABELA, true).points).toBe(14);
    expect(pontuarResultado(5, TABELA, true).points).toBe(11);
  });
});

describe('E–H) desempate, na ordem oficial', () => {
  it('E) mais títulos Overall vence, mesmo com menos primeiros lugares', () => {
    const a = competidor('A', { totalPoints: 15, overallWins: 1, firstPlaceCount: 1 });
    const b = competidor('B', { totalPoints: 15, overallWins: 0, firstPlaceCount: 3 });

    const ordem = classificar([b, a]).map(linha => linha.nome);
    expect(ordem).toEqual(['A', 'B']);
  });

  it('F) empatados no Overall, mais primeiros lugares vence', () => {
    const a = competidor('A', { totalPoints: 20, overallWins: 0, firstPlaceCount: 3 });
    const b = competidor('B', { totalPoints: 20, overallWins: 0, firstPlaceCount: 2, secondPlaceCount: 5 });

    expect(classificar([b, a]).map(l => l.nome)).toEqual(['A', 'B']);
  });

  it('G) empatados até o 1º, mais segundos lugares vence', () => {
    const a = competidor('A', { totalPoints: 12, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 2 });
    const b = competidor('B', { totalPoints: 12, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 9 });

    expect(classificar([b, a]).map(l => l.nome)).toEqual(['A', 'B']);
  });

  it('H) a cadeia PARA no terceiro lugar', () => {
    const base = { totalPoints: 9, overallWins: 1, firstPlaceCount: 1, secondPlaceCount: 1 };

    // Até o terceiro, o critério separa.
    const porTerceiro = classificar([
      competidor('menos', { ...base, thirdPlaceCount: 1 }),
      competidor('mais', { ...base, thirdPlaceCount: 2 })
    ]).map(l => l.nome);
    expect(porTerceiro).toEqual(['mais', 'menos']);
  });

  it('4º e 5º NÃO desempatam — a regra parou no 3º', () => {
    // A fase 11.1 ia até o quinto; a 11.2 encurtou a cadeia. Empatados até o
    // terceiro lugar, o quarto e o quinto não são consultados: o empate fica
    // sem solução, e inventar um critério a mais seria justamente o que a
    // regra proíbe.
    const iguaisAte3 = { totalPoints: 9, overallWins: 1, firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 };

    const classificados = classificar([
      competidor('com_mais_quartos', { ...iguaisAte3, fourthPlaceCount: 5, fifthPlaceCount: 5 }),
      competidor('sem_quartos', { ...iguaisAte3, fourthPlaceCount: 0, fifthPlaceCount: 0 })
    ]);

    expect(classificados.every(l => l.tieUnresolved), 'o 4º lugar não pode ter desempatado').toBe(true);
    expect(classificados.every(l => l.position === null)).toBe(true);
  });

  it('os contadores de 4º e 5º continuam existindo para auditoria', () => {
    // Deixaram de desempatar, mas não deixaram de importar: essas colocações
    // pontuam (2 e 1 ponto) e a conta precisa continuar conferível.
    const contagem = contadores([{ placing: 4 }, { placing: 5 }, { placing: 5 }]);
    expect(contagem.fourthPlaceCount).toBe(1);
    expect(contagem.fifthPlaceCount).toBe(2);
  });

  it('a ORDEM dos critérios é a regra: o primeiro que separar encerra', () => {
    // B tem mais primeiros, segundos e terceiros — e perde mesmo assim, porque
    // o Overall é consultado antes de qualquer um deles.
    const a = competidor('A', { totalPoints: 30, overallWins: 2, firstPlaceCount: 1 });
    const b = competidor('B', { totalPoints: 30, overallWins: 1, firstPlaceCount: 6, secondPlaceCount: 6, thirdPlaceCount: 6 });

    expect(classificar([a, b])[0].nome).toBe('A');
  });

  it('pontuação diferente decide antes de qualquer desempate', () => {
    const a = competidor('A', { totalPoints: 20, overallWins: 0 });
    const b = competidor('B', { totalPoints: 15, overallWins: 5, firstPlaceCount: 9 });

    expect(classificar([b, a]).map(l => l.nome)).toEqual(['A', 'B']);
  });
});

describe('I) empate absoluto', () => {
  const identicos = () => [
    competidor('A', { totalPoints: 15, overallWins: 1, firstPlaceCount: 1, secondPlaceCount: 2, thirdPlaceCount: 3, fourthPlaceCount: 4, fifthPlaceCount: 5 }),
    competidor('B', { totalPoints: 15, overallWins: 1, firstPlaceCount: 1, secondPlaceCount: 2, thirdPlaceCount: 3, fourthPlaceCount: 4, fifthPlaceCount: 5 })
  ];

  it('esgotada a hierarquia (Overall, 1º, 2º, 3º), ninguém recebe colocação', () => {
    const classificados = classificar(identicos());

    expect(classificados.every(linha => linha.tieUnresolved)).toBe(true);
    expect(classificados.every(linha => linha.position === null)).toBe(true);
    expect(classificados).toHaveLength(2);
  });

  it('o empate não é quebrado por id, nome, ordem de inserção nem alfabética', () => {
    const [a, b] = identicos();

    for (const entrada of [[a, b], [b, a]]) {
      const saida = classificar(entrada);
      expect(saida.every(linha => linha.position === null), 'alguém recebeu colocação num empate absoluto').toBe(true);
    }

    // E a comparação em si não separa: é 0, não um número qualquer.
    expect(compararOficial(a, b)).toBe(0);
  });

  it('o empate não promove quem está abaixo', () => {
    const [a, b] = identicos();
    const terceiro = competidor('C', { totalPoints: 5, firstPlaceCount: 1 });

    const classificados = classificar([a, b, terceiro]);
    const c = classificados.find(linha => linha.nome === 'C');

    // Duas empatadas ocupam o 1º e o 2º lugar: C é 3ª, não 2ª.
    expect(c.position).toBe(3);
    expect(c.tieUnresolved).toBe(false);
  });
});

describe('contadores de desempate derivados dos lançamentos', () => {
  it('conta títulos Overall e colocações de 1º a 5º', () => {
    const contagem = contadores([
      { placing: 1, isOverallChampion: true },
      { placing: 1, isOverallChampion: false },
      { placing: 2, isOverallChampion: false },
      { placing: 5, isOverallChampion: false },
      { placing: 8, isOverallChampion: false }
    ]);

    expect(contagem).toEqual({
      overallWins: 1,
      firstPlaceCount: 2, secondPlaceCount: 1, thirdPlaceCount: 0,
      fourthPlaceCount: 0, fifthPlaceCount: 1
    });
  });
});

describe('11) cenário numérico de homologação', () => {
  it('cinco atletas, com a conta aberta', () => {
    const cenario = [
      { nome: 'ATLETA A', placing: 1, overall: true },
      { nome: 'ATLETA B', placing: 1, overall: false },
      { nome: 'ATLETA C', placing: 2, overall: false },
      { nome: 'ATLETA D', placing: 3, overall: false },
      { nome: 'ATLETA E', placing: 5, overall: false }
    ].map(item => {
      const pontos = pontuarResultado(item.placing, TABELA, item.overall);
      return { ...item, ...pontos };
    });

    expect(cenario.map(c => `${c.nome}: ${c.placementPoints}+${c.overallBonus}=${c.points}`)).toEqual([
      'ATLETA A: 5+10=15',
      'ATLETA B: 5+0=5',
      'ATLETA C: 4+0=4',
      'ATLETA D: 3+0=3',
      'ATLETA E: 1+0=1'
    ]);

    const linhas = cenario.map(c => competidor(c.nome, {
      totalPoints: c.points,
      ...contadores([{ placing: c.placing, isOverallChampion: c.overall }])
    }));

    expect(classificar(linhas).map(l => `${l.position}º ${l.nome} (${l.totalPoints})`)).toEqual([
      '1º ATLETA A (15)',
      '2º ATLETA B (5)',
      '3º ATLETA C (4)',
      '4º ATLETA D (3)',
      '5º ATLETA E (1)'
    ]);
  });

  it('duas etapas acumulam, e o desempate decide o título da temporada', () => {
    // Etapa 1: A vence e leva o Overall (15). B é 2ª (4).
    // Etapa 2: B vence (5). A é 2ª (4).
    // Totais: A = 19, B = 9. Sem empate — A é campeã pelos pontos.
    const a = { etapa1: pontuarResultado(1, TABELA, true), etapa2: pontuarResultado(2, TABELA) };
    const b = { etapa1: pontuarResultado(2, TABELA), etapa2: pontuarResultado(1, TABELA) };

    expect(a.etapa1.points + a.etapa2.points).toBe(19);
    expect(b.etapa1.points + b.etapa2.points).toBe(9);

    // Agora um cenário de empate real na temporada: ambas com 10 pontos.
    // C: dois 2º lugares (4+4=8) e um 5º (1) → 9. Não fecha; ajusta-se para
    // igualar em pontos e separar pelo desempate.
    const comEmpate = [
      competidor('C', { totalPoints: 10, overallWins: 0, firstPlaceCount: 2 }),   // 5+5
      competidor('D', { totalPoints: 10, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 })  // 5+4+... 
    ];

    const [primeira, segunda] = classificar(comEmpate);
    expect(primeira.nome, 'mais primeiros lugares vence o empate em pontos').toBe('C');
    expect(segunda.nome).toBe('D');
  });
});
