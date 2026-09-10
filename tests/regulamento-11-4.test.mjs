import { describe, it, expect } from 'vitest';
import {
  TABELA_OFICIAL_COLOCACAO, BONUS_OVERALL, CRITERIOS_DESEMPATE,
  pontuarResultado, contadores, classificar
} from '../src/utils/rankingScoring.js';
import organizacoes from '../src/services/organizationService.js';

// ============================================================================
// REGULAMENTO OFICIAL DO RANKING — fase 11.4
//
// A matriz completa da regra homologada, caso a caso, com os números abertos.
// Nada aqui é provisório: é o regulamento, e este arquivo existe para que
// alterá-lo sem decisão do organizador quebre a suíte.
//
//   Classes:    ESTREANTE · NOVICE · OPEN · MASTER
//   Pontuação:  1º=5 · 2º=4 · 3º=3 · 4º=2 · 5º=1 · 6º+=0
//   Overall:    +10, somados
//   Elegível:   somente OPEN alimenta o Super Overall anual
//   Desempate:  Overall → 1º → 2º → 3º → TIE_UNRESOLVED
// ============================================================================

const TABELA = TABELA_OFICIAL_COLOCACAO;

// A elegibilidade entra como PARÂMETRO — jamais o código "OPEN" comparado
// dentro do motor. É o que permite criar e desativar classes sem tocar em
// programa, e é por isso que as classes abaixo são apenas rótulos do teste.
const CLASSES = [
  { nome: 'ESTREANTE', elegivel: false },
  { nome: 'NOVICE', elegivel: false },
  { nome: 'OPEN', elegivel: true },
  { nome: 'MASTER', elegivel: false }
];

const pontuar = (placing, { overall = false, elegivel = false } = {}) => {
  const r = pontuarResultado(placing, TABELA, overall, elegivel);
  return { campeonato: r.points, superOverall: r.superOverallPoints };
};

describe('classes homologadas', () => {
  it('ESTREANTE · NOVICE · OPEN · MASTER — e JUNIOR não é classe oficial', () => {
    const catalogo = organizacoes.CLASSES_DO_CAMPEONATO;

    expect(catalogo.map(c => c.code)).toEqual(['ESTREANTE', 'NOVICE', 'OPEN', 'MASTER']);
    expect(catalogo.map(c => c.code)).not.toContain('JUNIOR');
  });

  it('somente OPEN é elegível ao Super Overall', () => {
    const catalogo = organizacoes.CLASSES_DO_CAMPEONATO;
    expect(catalogo.filter(c => c.superOverallEligible).map(c => c.code)).toEqual(['OPEN']);
  });
});

describe('1–11) tabela de pontos: 5/4/3/2/1 e zero do 6º em diante', () => {
  it('TESTES 1–4 — 1º lugar vale 5 em TODAS as classes', () => {
    // Toda classe pontua no campeonato. A elegibilidade muda o Super Overall,
    // nunca a pontuação do campeonato.
    for (const classe of CLASSES) {
      expect(pontuar(1, { elegivel: classe.elegivel }).campeonato, classe.nome).toBe(5);
    }
  });

  it('TESTES 5–8 — 2º=4 · 3º=3 · 4º=2 · 5º=1', () => {
    expect(pontuar(2, { elegivel: true }).campeonato).toBe(4);
    expect(pontuar(3, { elegivel: true }).campeonato).toBe(3);
    expect(pontuar(4, { elegivel: true }).campeonato).toBe(2);
    expect(pontuar(5, { elegivel: true }).campeonato).toBe(1);
  });

  it('TESTES 9–11 — 6º, 7º e 10º valem ZERO', () => {
    // Valor DEFINIDO, não lacuna: extrapolar a progressão seria inventar
    // regulamento tanto quanto deixar em aberto.
    for (const colocacao of [6, 7, 10, 50]) {
      expect(pontuar(colocacao, { elegivel: true }).campeonato, `${colocacao}º`).toBe(0);
      expect(pontuar(colocacao, { elegivel: true }).superOverall, `${colocacao}º`).toBe(0);
    }
  });

  it('TESTE 12 — 1º + Overall = 15, e o bônus é +10', () => {
    expect(BONUS_OVERALL).toBe(10);
    expect(pontuar(1, { overall: true, elegivel: true }).campeonato).toBe(15);

    // O bônus acompanha a colocação de quem o recebeu, não a substitui.
    expect(pontuar(2, { overall: true, elegivel: true }).campeonato).toBe(14);
    expect(pontuar(5, { overall: true, elegivel: true }).campeonato).toBe(11);
  });
});

describe('13–20) elegibilidade ao Super Overall: somente OPEN', () => {
  it('TESTES 13–16 — 1º lugar: 5 no campeonato em todas; 5 no anual só na OPEN', () => {
    for (const classe of CLASSES) {
      const r = pontuar(1, { elegivel: classe.elegivel });

      expect(r.campeonato, `${classe.nome} pontua no campeonato`).toBe(5);
      expect(r.superOverall, `${classe.nome} no anual`).toBe(classe.elegivel ? 5 : 0);
    }
  });

  it('TESTES 17–20 — 1º + Overall: 15 no campeonato em todas; 15 no anual só na OPEN', () => {
    // O caso que decide a regra: o bônus NÃO carrega elegibilidade própria.
    for (const classe of CLASSES) {
      const r = pontuar(1, { overall: true, elegivel: classe.elegivel });

      expect(r.campeonato, `${classe.nome} com Overall`).toBe(15);
      expect(r.superOverall, `${classe.nome} com Overall, no anual`).toBe(classe.elegivel ? 15 : 0);
    }
  });

  it('nenhuma classe não elegível some do campeonato', () => {
    // O erro que a regra proíbe: usar a métrica do anual no ranking do
    // campeonato apagaria Estreante, Novice e Master do pódio.
    for (const classe of CLASSES.filter(c => !c.elegivel)) {
      for (const colocacao of [1, 2, 3, 4, 5]) {
        expect(pontuar(colocacao, { elegivel: false }).campeonato, `${classe.nome} ${colocacao}º`).toBeGreaterThan(0);
      }
    }
  });
});

describe('21–27) desempate: Overall → 1º → 2º → 3º → TIE_UNRESOLVED', () => {
  const competidor = (nome, dados) => ({
    nome, totalPoints: 20,
    overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 0,
    thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0,
    ...dados
  });
  const disputar = (a, b) => classificar([a, b]);

  it('TESTE 21 — Overall vence', () => {
    const [primeiro] = disputar(
      competidor('A', { overallWins: 1 }),
      competidor('B', { overallWins: 0, firstPlaceCount: 5 })
    );
    expect(primeiro.nome).toBe('A');
  });

  it('TESTE 22 — mais primeiros vence', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 2 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 9 })
    );
    expect(primeiro.nome).toBe('A');
  });

  it('TESTE 23 — mais segundos vence', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 1, secondPlaceCount: 1 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 2 })
    );
    expect(primeiro.nome).toBe('B');
  });

  it('TESTE 24 — mais terceiros vence', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 2 })
    );
    expect(primeiro.nome).toBe('B');
  });

  it('TESTES 25/26 — 4º e 5º NÃO desempatam', () => {
    expect(CRITERIOS_DESEMPATE).toEqual(['overallWins', 'firstPlaceCount', 'secondPlaceCount', 'thirdPlaceCount']);
    expect(CRITERIOS_DESEMPATE).not.toContain('fourthPlaceCount');
    expect(CRITERIOS_DESEMPATE).not.toContain('fifthPlaceCount');

    // Na prática: montanhas de quartos e quintos não separam ninguém.
    for (const campo of ['fourthPlaceCount', 'fifthPlaceCount']) {
      const resultado = disputar(
        competidor('A', { firstPlaceCount: 1, [campo]: 99 }),
        competidor('B', { firstPlaceCount: 1, [campo]: 0 })
      );
      for (const linha of resultado) {
        expect(linha.position, `${campo} não pode separar`).toBeNull();
        expect(linha.tieUnresolved).toBe(true);
      }
    }

    // E continuam PONTUANDO — são conceitos diferentes.
    expect(pontuar(4, { elegivel: true }).campeonato).toBe(2);
    expect(pontuar(5, { elegivel: true }).campeonato).toBe(1);
  });

  it('TESTE 27 — empate que sobrevive à hierarquia é TIE_UNRESOLVED', () => {
    const resultado = disputar(
      competidor('A', { overallWins: 1, firstPlaceCount: 2, secondPlaceCount: 1, thirdPlaceCount: 3 }),
      competidor('B', { overallWins: 1, firstPlaceCount: 2, secondPlaceCount: 1, thirdPlaceCount: 3 })
    );

    for (const linha of resultado) {
      expect(linha.position).toBeNull();
      expect(linha.tieUnresolved).toBe(true);
    }
  });
});

describe('equipes e empresas: a MESMA regra, sem exceção', () => {
  // A pontuação de equipe/empresa é a soma dos pontos dos seus atletas, e o
  // motor é literalmente o mesmo — mesma tabela, mesmos contadores, mesmo
  // `classificar`. Estes casos existem para que uma fórmula própria de equipe
  // introduzida por engano quebre a suíte.
  const pontosDe = colocacoes => colocacoes.map(([placing, overall = false]) => ({
    placing, isOverallChampion: overall,
    ...pontuarResultado(placing, TABELA, overall, true)
  }));

  const agregar = (nome, colocacoes) => {
    const pontos = pontosDe(colocacoes);
    return {
      nome,
      totalPoints: pontos.reduce((soma, p) => soma + p.points, 0),
      superOverallTotal: pontos.reduce((soma, p) => soma + p.superOverallPoints, 0),
      ...contadores(pontos)
    };
  };

  it('a equipe soma pela mesma tabela: 1º+Overall e 3º = 15 + 3 = 18', () => {
    const alfa = agregar('Alfa', [[1, true], [3]]);
    expect(alfa.totalPoints).toBe(18);
  });

  it('a equipe usa o MESMO desempate — Overall antes de mais primeiros', () => {
    const alfa = agregar('Alfa', [[1, true]]);            // 15 pontos, 1 Overall
    const beta = agregar('Beta', [[1], [1], [1]]);        // 15 pontos, 3 primeiros

    expect(alfa.totalPoints).toBe(beta.totalPoints);

    const [primeiro] = classificar([alfa, beta]);
    expect(primeiro.nome, 'o Overall decide também para equipes').toBe('Alfa');
  });

  it('o acumulado de Super Overall de equipe/empresa recebe SÓ a OPEN', () => {
    // A estrutura já suporta a regra sem tabela nova: cada lançamento carrega
    // superOverallPoints ao lado da equipe e da empresa. Somar por equipe
    // exclui Estreante, Novice e Master POR CONSTRUÇÃO.
    const daOpen = pontuarResultado(1, TABELA, true, true);      // OPEN
    const daNovice = pontuarResultado(1, TABELA, true, false);   // NOVICE

    const equipe = [daOpen, daNovice];

    const campeonato = equipe.reduce((soma, p) => soma + p.points, 0);
    const anual = equipe.reduce((soma, p) => soma + p.superOverallPoints, 0);

    expect(campeonato, 'as duas participações pontuam no campeonato').toBe(30);
    expect(anual, 'só a OPEN alimenta o anual').toBe(15);
  });
});
