// Determinismo da classificação.
//
// Descoberto na FASE 12.3 (recuperação de desastre): o mesmo banco, restaurado
// a partir de um backup, devolvia o Super Overall com DOIS atletas empatados
// em ordem trocada. Nenhum número mudou — ambos continuavam com
// `position: null` e `tieUnresolved: true` —, mas a SEQUÊNCIA de saída era a
// ordem física das linhas no PostgreSQL, e o `pg_restore` a reescreve.
//
// Isso não é cosmético:
//   1. um relatório emitido antes e depois do restore não bate byte a byte,
//      o que derruba qualquer conferência de integridade;
//   2. a paginação corta a lista JÁ classificada — se a ordem muda entre duas
//      requisições, um competidor pode aparecer em duas páginas ou em nenhuma.
//
// A correção NÃO desempata: quem está no bloco empatado continua sem posição.
// Só fixa a sequência de leitura, para que a mesma entrada produza sempre a
// mesma saída.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classificar } = require('../src/utils/rankingScoring.js');

// Três atletas com números IDÊNTICOS: a hierarquia oficial não os separa.
const empatados = [
  { athleteId: 'c_zzz', totalPoints: 5, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 0, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 },
  { athleteId: 'c_aaa', totalPoints: 5, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 0, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 },
  { athleteId: 'c_mmm', totalPoints: 5, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 0, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 }
];

describe('classificação determinística', () => {
  it('devolve a mesma sequência qualquer que seja a ordem de entrada', () => {
    // Simula o que o restore faz: entrega as mesmas linhas embaralhadas.
    const permutacoes = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
    ];
    const saidas = permutacoes.map(p => classificar(p.map(i => empatados[i])).map(l => l.athleteId));
    for (const saida of saidas) expect(saida).toEqual(saidas[0]);
  });

  it('não desempata: todos continuam sem posição e marcados como empate', () => {
    const saida = classificar(empatados);
    expect(saida).toHaveLength(3);
    for (const linha of saida) {
      expect(linha.position).toBeNull();
      expect(linha.tieUnresolved).toBe(true);
    }
  });

  it('a sequência estável não altera as colocações de quem a regra separa', () => {
    const linhas = [
      { athleteId: 'z', totalPoints: 3, overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 0, thirdPlaceCount: 1, fourthPlaceCount: 0, fifthPlaceCount: 0 },
      { athleteId: 'a', totalPoints: 9, overallWins: 1, firstPlaceCount: 0, secondPlaceCount: 0, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 },
      { athleteId: 'm', totalPoints: 5, overallWins: 0, firstPlaceCount: 1, secondPlaceCount: 0, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 }
    ];
    expect(classificar(linhas).map(l => [l.athleteId, l.position]))
      .toEqual([['a', 1], ['m', 2], ['z', 3]]);
  });

  it('vale para equipes e empresas, que não têm athleteId', () => {
    const equipes = [
      { teamId: 't_zzz', totalPoints: 4, overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 1, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 },
      { teamId: 't_aaa', totalPoints: 4, overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 1, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 }
    ];
    const direta = classificar(equipes).map(l => l.teamId);
    const invertida = classificar([...equipes].reverse()).map(l => l.teamId);
    expect(invertida).toEqual(direta);

    const empresas = [
      { companyId: 'e_zzz', totalPoints: 4, overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 1, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 },
      { companyId: 'e_aaa', totalPoints: 4, overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 1, thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0 }
    ];
    expect(classificar([...empresas].reverse()).map(l => l.companyId))
      .toEqual(classificar(empresas).map(l => l.companyId));
  });

  it('a paginação de um bloco empatado não repete nem perde competidor', () => {
    const todos = classificar(empatados).map(l => l.athleteId);
    const embaralhado = classificar([empatados[2], empatados[0], empatados[1]]).map(l => l.athleteId);
    // Página 1 de uma ordem + página 2 da outra tem de cobrir todo mundo, sem repetir.
    const juntas = [...todos.slice(0, 2), ...embaralhado.slice(2)];
    expect(new Set(juntas).size).toBe(3);
  });
});
