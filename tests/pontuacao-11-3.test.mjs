import { describe, it, expect } from 'vitest';
import {
  TABELA_OFICIAL_COLOCACAO, CRITERIOS_DESEMPATE,
  pontuarResultado, conferirPontuacaoImportada, classificar
} from '../src/utils/rankingScoring.js';
import organizacoes from '../src/services/organizationService.js';
import seed from '../prisma/seed.js';

// ============================================================================
// FASE 11.3 — as DUAS métricas, lado a lado.
//
// Documentação executável dos 25 casos exigidos pela homologação. Cada um traz
// os dois números que a regra manda não confundir:
//
//   competition_points            → pontuou no Campeonato Brasileiro
//   super_overall_eligible_points → alimenta o Super Overall anual
//
// Toda classe pontua. Só a elegível — pela regra homologada, a OPEN — alimenta
// o ranking anual. São perguntas diferentes, e o motor as responde separado.
//
// A elegibilidade entra como PARÂMETRO, nunca como o código "OPEN" comparado
// dentro do motor: é o que permite ao operador criar e desativar classes sem
// tocar em programa.
// ============================================================================

const TABELA = TABELA_OFICIAL_COLOCACAO;

const OPEN = true;       // classe elegível ao Super Overall
const NAO_OPEN = false;  // Estreante, Novice, Master

// Ajuda a ler o caso: colocação, Overall e elegibilidade entram; os dois
// números saem.
const pontuar = (placing, { overall = false, elegivel = false } = {}) => {
  const r = pontuarResultado(placing, TABELA, overall, elegivel);
  return { campeonato: r.points, superOverall: r.superOverallPoints };
};

describe('1–5) OPEN: pontua no campeonato E alimenta o Super Overall', () => {
  it('TESTE 1 — Open, 1º, sem Overall: 5 e 5', () => {
    expect(pontuar(1, { elegivel: OPEN })).toEqual({ campeonato: 5, superOverall: 5 });
  });

  it('TESTE 2 — Open, 1º, com Overall: 15 e 15', () => {
    // O bônus SOMA (5 + 10) e acompanha a elegibilidade da participação.
    expect(pontuar(1, { overall: true, elegivel: OPEN })).toEqual({ campeonato: 15, superOverall: 15 });
  });

  it('TESTE 3 — Open, 2º: 4 e 4', () => {
    expect(pontuar(2, { elegivel: OPEN })).toEqual({ campeonato: 4, superOverall: 4 });
  });

  it('TESTE 4 — Open, 5º: 1 e 1', () => {
    expect(pontuar(5, { elegivel: OPEN })).toEqual({ campeonato: 1, superOverall: 1 });
  });

  it('TESTE 5 — Open, 6º: 0 e 0', () => {
    // A tabela homologada termina no 5º. Do 6º em diante é ZERO — não um valor
    // extrapolado a partir da progressão.
    expect(pontuar(6, { elegivel: OPEN })).toEqual({ campeonato: 0, superOverall: 0 });
    expect(pontuar(20, { elegivel: OPEN })).toEqual({ campeonato: 0, superOverall: 0 });
  });
});

describe('6–9) demais classes: pontuam no campeonato, NÃO no Super Overall', () => {
  it('TESTE 6 — Novice, 1º: 5 no campeonato, 0 no Super Overall', () => {
    expect(pontuar(1, { elegivel: NAO_OPEN })).toEqual({ campeonato: 5, superOverall: 0 });
  });

  it('TESTE 7 — Estreante, 1º: 5 no campeonato, 0 no Super Overall', () => {
    expect(pontuar(1, { elegivel: NAO_OPEN })).toEqual({ campeonato: 5, superOverall: 0 });
  });

  it('TESTE 8 — Master, 1º: 5 no campeonato, 0 no Super Overall', () => {
    expect(pontuar(1, { elegivel: NAO_OPEN })).toEqual({ campeonato: 5, superOverall: 0 });
  });

  it('TESTE 9 — Novice, 1º, com Overall: 15 no campeonato, e NÃO 15 no Super Overall', () => {
    // O caso que decide a regra: o Overall não carrega elegibilidade própria.
    // Um +10 conquistado fora da OPEN vale no campeonato e não vale no anual.
    // Presumir o contrário seria inventar regulamento.
    const r = pontuar(1, { overall: true, elegivel: NAO_OPEN });

    expect(r.campeonato).toBe(15);
    expect(r.superOverall, 'o bônus segue a elegibilidade da participação').not.toBe(15);
    expect(r.superOverall).toBe(0);
  });

  it('as classes não elegíveis NÃO somem do campeonato — só do Super Overall', () => {
    // A confusão que a regra proíbe: usar a métrica do anual no ranking do
    // campeonato apagaria Estreante, Novice e Master do pódio.
    for (const colocacao of [1, 2, 3, 4, 5]) {
      expect(pontuar(colocacao, { elegivel: NAO_OPEN }).campeonato).toBeGreaterThan(0);
      expect(pontuar(colocacao, { elegivel: NAO_OPEN }).superOverall).toBe(0);
    }
  });
});

describe('10–15) desempate: Overall → 1º → 2º → 3º → TIE_UNRESOLVED', () => {
  const competidor = (nome, dados) => ({
    nome, totalPoints: 15,
    overallWins: 0, firstPlaceCount: 0, secondPlaceCount: 0,
    thirdPlaceCount: 0, fourthPlaceCount: 0, fifthPlaceCount: 0,
    ...dados
  });

  const disputar = (a, b) => classificar([a, b]);

  it('TESTE 10 — um Overall vence três primeiros lugares', () => {
    const [primeiro, segundo] = disputar(
      competidor('A', { overallWins: 1, firstPlaceCount: 1 }),
      competidor('B', { overallWins: 0, firstPlaceCount: 3 })
    );

    expect(primeiro.nome).toBe('A');
    expect(segundo.nome).toBe('B');
    expect(primeiro.position).toBe(1);
  });

  it('TESTE 11 — sem Overall, vence quem tem mais primeiros', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 2 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 3 })
    );
    expect(primeiro.nome).toBe('A');
  });

  it('TESTE 12 — empatados até os primeiros, decide o número de segundos', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 1, secondPlaceCount: 1 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 2 })
    );
    expect(primeiro.nome).toBe('B');
  });

  it('TESTE 13 — empatados até os segundos, decide o número de terceiros', () => {
    const [primeiro] = disputar(
      competidor('A', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 2 })
    );
    expect(primeiro.nome).toBe('B');
  });

  it('TESTE 14 — empatados até os terceiros: TIE_UNRESOLVED', () => {
    const resultado = disputar(
      competidor('A', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 }),
      competidor('B', { firstPlaceCount: 1, secondPlaceCount: 1, thirdPlaceCount: 1 })
    );

    // Ninguém recebe colocação: a decisão volta para quem tem competência.
    for (const linha of resultado) {
      expect(linha.position).toBeNull();
      expect(linha.tieUnresolved).toBe(true);
    }
  });

  it('TESTE 15 — 4º e 5º lugares NÃO desempatam', () => {
    // Eles PONTUAM (2 e 1) e continuam contados para auditoria, mas estão fora
    // da cadeia de desempate. Pontuação e desempate são conceitos diferentes.
    expect(CRITERIOS_DESEMPATE).toEqual(['overallWins', 'firstPlaceCount', 'secondPlaceCount', 'thirdPlaceCount']);
    expect(CRITERIOS_DESEMPATE).not.toContain('fourthPlaceCount');
    expect(CRITERIOS_DESEMPATE).not.toContain('fifthPlaceCount');

    // E na prática: quem tem MUITO mais quartos e quintos não desempata.
    const resultado = disputar(
      competidor('A', { firstPlaceCount: 1, fourthPlaceCount: 9, fifthPlaceCount: 9 }),
      competidor('B', { firstPlaceCount: 1, fourthPlaceCount: 0, fifthPlaceCount: 0 })
    );

    for (const linha of resultado) {
      expect(linha.position, 'quartos e quintos não podem separar').toBeNull();
      expect(linha.tieUnresolved).toBe(true);
    }

    // A tabela de PONTOS, essa, continua valendo para 4º e 5º.
    expect(pontuar(4, { elegivel: OPEN }).campeonato).toBe(2);
    expect(pontuar(5, { elegivel: OPEN }).campeonato).toBe(1);
  });
});

describe('17) pontuação importada é conferida contra a regra oficial', () => {
  it('TESTE 17 — 1º com Overall declarando 14 diverge dos 15 oficiais', () => {
    const divergencia = conferirPontuacaoImportada(1, TABELA, true, 14);

    expect(divergencia).toEqual({ importedPoints: 14, calculatedPoints: 15, difference: -1 });
  });

  it('o número coerente não gera divergência', () => {
    expect(conferirPontuacaoImportada(1, TABELA, true, 15)).toBeNull();
    expect(conferirPontuacaoImportada(1, TABELA, false, 5)).toBeNull();
    expect(conferirPontuacaoImportada(6, TABELA, false, 0)).toBeNull();
  });

  it('sem colocação ou sem número informado não há o que conferir', () => {
    // Linha sem colocação: não há regra a aplicar, o arquivo é a única fonte.
    expect(conferirPontuacaoImportada(null, TABELA, false, 7)).toBeNull();
    // Linha sem coluna de pontos: nada foi afirmado.
    expect(conferirPontuacaoImportada(1, TABELA, false, null)).toBeNull();
  });

  it('a divergência informa os dois números e a diferença, não só que houve erro', () => {
    // O operador precisa saber o que corrigir: o arquivo ou a tabela.
    const divergencia = conferirPontuacaoImportada(3, TABELA, false, 99);

    expect(divergencia.importedPoints).toBe(99);
    expect(divergencia.calculatedPoints).toBe(3);
    expect(divergencia.difference).toBe(96);
  });
});

describe('a configuração homologada das classes é uma só', () => {
  it('ESTREANTE · NOVICE · OPEN · MASTER, e só a OPEN é elegível', () => {
    const catalogo = organizacoes.CLASSES_DO_CAMPEONATO;

    expect(catalogo.map(c => c.code)).toEqual(['ESTREANTE', 'NOVICE', 'OPEN', 'MASTER']);
    expect(catalogo.filter(c => c.superOverallEligible).map(c => c.code)).toEqual(['OPEN']);

    // Ordenáveis pelo operador, sem alteração de programa.
    expect(catalogo.every(c => typeof c.sortOrder === 'number')).toBe(true);
  });

  it('a lista do seed não pode divergir da que é persistida', () => {
    // Até a fase 11.3 o seed dizia JUNIOR, classe que a configuração homologada
    // não tem: quem lesse o log da carga via uma lista inexistente. Duas listas
    // sobre a mesma coisa divergem em silêncio se ninguém as comparar.
    expect(seed.CLASSES_INICIAIS).toEqual(organizacoes.CLASSES_DO_CAMPEONATO.map(c => c.code));
  });
});
