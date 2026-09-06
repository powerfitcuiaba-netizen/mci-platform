import { describe, it, expect } from 'vitest';
import { tabulate, REGRA_PADRAO, TIE_BREAKERS, METHODS } from '../src/utils/tabulation.js';

// ============================================================================
// HOMOLOGAÇÃO ESPORTIVA — efeito de cada opção de apuração
//
// Este arquivo é documentação executável para o comitê técnico do Muscle
// Contest. Ele não propõe regulamento nenhum: o código não decide método de
// apuração, tamanho de painel para descarte nem ordem de desempate — tudo isso
// é ScoringRuleSet, configurado por quem tem competência para isso.
//
// O que está aqui é a outra metade da decisão: o que MUDA no pódio quando cada
// opção é ligada. Cada caso usa um painel completo — todo juiz classifica toda
// a classe, como numa prova de verdade — e demonstra a consequência concreta
// da escolha. Ratificar a configuração de produção é ler estes casos e dizer
// qual comportamento é o do regulamento.
//
// Ver docs/HOMOLOGACAO-ESPORTIVA.md.
// ============================================================================

// Cada juiz entrega uma ordenação completa da classe. Construir os votos a
// partir da ordenação garante que nenhum caso deste arquivo use um painel
// impossível — dois atletas no mesmo lugar, ou um lugar vago.
const painel = (ordens, { juizChefe = null } = {}) =>
  ordens.flatMap((ordem, indice) => {
    const judgeId = `juiz-${indice + 1}`;
    return ordem.map((atleta, posicao) => ({
      judgeId,
      registrationItemId: atleta,
      placing: posicao + 1,
      isHeadJudge: judgeId === juizChefe
    }));
  });

const podio = resultado => resultado.entries
  .slice()
  .sort((a, b) => (a.placing ?? 99) - (b.placing ?? 99))
  .map(entry => entry.status === 'RANKED' ? `${entry.placing}º ${entry.registrationItemId}` : `— ${entry.registrationItemId} (${entry.status})`);

describe('homologação: o catálogo do que existe para configurar', () => {
  it('há exatamente um método de apuração implementado', () => {
    // Se o comitê definir outro método, ele precisa ser implementado antes de
    // ser configurável. O motor não aceita nome de método que não existe: cai
    // no padrão em vez de apurar com regra imaginária.
    expect(METHODS).toEqual(['RELATIVE_PLACEMENT_SUM']);
    expect(tabulate([], { method: 'INVENTADO' }).ruleSet.method).toBe('RELATIVE_PLACEMENT_SUM');
  });

  it('há exatamente três critérios de desempate implementados', () => {
    expect(TIE_BREAKERS).toEqual(['HEAD_JUDGE_PLACING', 'COUNT_BACK', 'SUM_WITHOUT_DROP']);
  });

  it('o padrão do código não decide nada por conta própria', () => {
    // Descarte desligado e nenhum desempate: o padrão é o mais conservador
    // possível. Ligar qualquer coisa é ato do organizador, com registro.
    expect(REGRA_PADRAO.dropHighLow).toBe(false);
    expect(REGRA_PADRAO.tieBreakers).toEqual([]);
  });

  it('critério de desempate desconhecido é ignorado, não inventado', () => {
    const regra = tabulate([], { tieBreakers: ['MOEDA', 'COUNT_BACK'] }).ruleSet;
    expect(regra.tieBreakers).toEqual(['COUNT_BACK']);
  });
});

describe('homologação: DECISÃO 1 — descarte da maior e da menor colocação', () => {
  // Classe de 5 atletas, painel de 7 juízes.
  //
  //   ANA  é a atleta consistente: todo juiz a coloca em 2º.
  //   BRUNA é a atleta polarizadora: quatro juízes a colocam em 1º, e os
  //         outros três a colocam em 3º, 3º e 5º.
  //
  // É exatamente o cenário para o qual o descarte foi criado. A pergunta que o
  // comitê precisa responder é qual das duas é a campeã.
  const ORDENS = [
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['CARLA', 'ANA', 'BRUNA', 'DEBORA', 'ELIS'],
    ['CARLA', 'ANA', 'BRUNA', 'DEBORA', 'ELIS'],
    ['DEBORA', 'ANA', 'CARLA', 'ELIS', 'BRUNA']
  ];
  const votos = painel(ORDENS);

  it('SEM descarte (padrão): a consistência vence — ANA é campeã', () => {
    const resultado = tabulate(votos, REGRA_PADRAO);

    // ANA: 2+2+2+2+2+2+2 = 14. BRUNA: 1+1+1+1+3+3+5 = 15.
    expect(podio(resultado)).toEqual([
      '1º ANA', '2º BRUNA', '3º CARLA', '4º DEBORA', '5º ELIS'
    ]);
    expect(resultado.entries.find(e => e.registrationItemId === 'ANA').score).toBe(14);
    expect(resultado.entries.find(e => e.registrationItemId === 'BRUNA').score).toBe(15);
    expect(resultado.hasUnresolvedTie).toBe(false);
  });

  it('COM descarte: o voto extremo sai e o pódio inverte — BRUNA é campeã', () => {
    const resultado = tabulate(votos, { ...REGRA_PADRAO, dropHighLow: true, dropHighLowMinJudges: 7 });

    // Descartada a melhor e a pior colocação de cada uma:
    // ANA: 14 − 2 − 2 = 10. BRUNA: 15 − 1 − 5 = 9.
    expect(podio(resultado)).toEqual([
      '1º BRUNA', '2º ANA', '3º CARLA', '4º DEBORA', '5º ELIS'
    ]);
    expect(resultado.entries.find(e => e.registrationItemId === 'ANA').score).toBe(10);
    expect(resultado.entries.find(e => e.registrationItemId === 'BRUNA').score).toBe(9);
  });

  it('a mesma prova, dois títulos diferentes: a escolha é de regulamento, não de software', () => {
    const campeaSemDescarte = tabulate(votos, REGRA_PADRAO)
      .entries.find(e => e.placing === 1).registrationItemId;
    const campeaComDescarte = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 7 })
      .entries.find(e => e.placing === 1).registrationItemId;

    expect(campeaSemDescarte).not.toBe(campeaComDescarte);
  });

  it('a colocação bruta fica registrada mesmo quando o descarte é aplicado', () => {
    // Sem isto a apuração não seria auditável: o comitê precisa poder refazer
    // a conta pelos dois caminhos a partir do que foi gravado.
    const resultado = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 7 });
    const bruna = resultado.entries.find(e => e.registrationItemId === 'BRUNA');

    expect(bruna.rawScore).toBe(15);
    expect(bruna.score).toBe(9);
    expect(bruna.dropped).toBe(true);
    expect(bruna.placings).toEqual([1, 1, 1, 1, 3, 3, 5]);
  });
});

describe('homologação: DECISÃO 2 — painel mínimo para o descarte valer', () => {
  const votos = painel([
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['BRUNA', 'ANA', 'CARLA', 'DEBORA', 'ELIS'],
    ['CARLA', 'ANA', 'BRUNA', 'DEBORA', 'ELIS'],
    ['CARLA', 'ANA', 'BRUNA', 'DEBORA', 'ELIS'],
    ['DEBORA', 'ANA', 'CARLA', 'ELIS', 'BRUNA']
  ]);

  it('com o mínimo em 7 e painel de 7, o descarte entra', () => {
    const resultado = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 7 });
    expect(resultado.judgeCount).toBe(7);
    expect(resultado.entries.every(e => e.dropped)).toBe(true);
    expect(resultado.entries.find(e => e.placing === 1).registrationItemId).toBe('BRUNA');
  });

  it('com o mínimo em 9 e painel de 7, o descarte NÃO entra — e o título muda', () => {
    // Painel pequeno demais para descartar dois votos sem distorcer. Onde está
    // essa fronteira é decisão do regulamento; o código só a obedece.
    const resultado = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 9 });

    expect(resultado.entries.every(e => e.dropped)).toBe(false);
    expect(resultado.entries.find(e => e.placing === 1).registrationItemId).toBe('ANA');
  });
});

describe('homologação: DECISÃO 3 — empate e ordem dos critérios de desempate', () => {
  // Classe de 3 atletas, 3 juízes. PAULA e QUEZIA empatam em 5 pontos.
  //   PAULA:  1º, 1º, 3º  → duas vitórias e uma queda
  //   QUEZIA: 2º, 2º, 1º  → regularidade e uma vitória
  const ORDENS = [
    ['PAULA', 'QUEZIA', 'RAISSA'],
    ['PAULA', 'QUEZIA', 'RAISSA'],
    ['QUEZIA', 'RAISSA', 'PAULA']
  ];

  it('SEM critério configurado: TIE_UNRESOLVED, e ninguém recebe o título', () => {
    const resultado = tabulate(painel(ORDENS), REGRA_PADRAO);

    expect(resultado.hasUnresolvedTie).toBe(true);
    const empatadas = resultado.entries.filter(e => e.status === 'TIE_UNRESOLVED');
    expect(empatadas.map(e => e.registrationItemId).sort()).toEqual(['PAULA', 'QUEZIA']);
    expect(empatadas.every(e => e.placing === null)).toBe(true);
  });

  it('o empate não vaza para baixo: quem não empatou recebe a colocação correta', () => {
    // Duas atletas ocupam o 1º e o 2º lugar mesmo sem desempate. RAISSA é 3ª,
    // não 2ª: a indefinição lá em cima não a promove.
    const resultado = tabulate(painel(ORDENS), REGRA_PADRAO);
    expect(resultado.entries.find(e => e.registrationItemId === 'RAISSA').placing).toBe(3);
  });

  it('COUNT_BACK: mais primeiros lugares vence — PAULA é campeã', () => {
    const resultado = tabulate(painel(ORDENS), { tieBreakers: ['COUNT_BACK'] });

    expect(resultado.hasUnresolvedTie).toBe(false);
    expect(podio(resultado)).toEqual(['1º PAULA', '2º QUEZIA', '3º RAISSA']);
  });

  it('HEAD_JUDGE_PLACING com o juiz 3 como chefe: QUEZIA é campeã — critério diferente, título diferente', () => {
    const votos = painel(ORDENS, { juizChefe: 'juiz-3' });
    const resultado = tabulate(votos, { tieBreakers: ['HEAD_JUDGE_PLACING'] });

    // O juiz 3 colocou QUEZIA em 1º e PAULA em 3º.
    expect(resultado.hasUnresolvedTie).toBe(false);
    expect(podio(resultado)).toEqual(['1º QUEZIA', '2º PAULA', '3º RAISSA']);
  });

  it('a ORDEM dos critérios decide: o primeiro que resolver encerra a questão', () => {
    const votos = painel(ORDENS, { juizChefe: 'juiz-3' });

    const chefePrimeiro = tabulate(votos, { tieBreakers: ['HEAD_JUDGE_PLACING', 'COUNT_BACK'] });
    const countbackPrimeiro = tabulate(votos, { tieBreakers: ['COUNT_BACK', 'HEAD_JUDGE_PLACING'] });

    expect(chefePrimeiro.entries.find(e => e.placing === 1).registrationItemId).toBe('QUEZIA');
    expect(countbackPrimeiro.entries.find(e => e.placing === 1).registrationItemId).toBe('PAULA');
  });

  it('critério inaplicável não é substituído por outra coisa: o empate permanece', () => {
    // HEAD_JUDGE_PLACING configurado, mas nenhum juiz declarado chefe. O motor
    // não escolhe um chefe, não cai no countback e não sorteia: devolve o
    // empate para a organização resolver com registro.
    const resultado = tabulate(painel(ORDENS), { tieBreakers: ['HEAD_JUDGE_PLACING'] });

    expect(resultado.hasUnresolvedTie).toBe(true);
    expect(resultado.entries.filter(e => e.status === 'TIE_UNRESOLVED')).toHaveLength(2);
  });

  it('empate nunca é resolvido por id, ordem de chegada do voto ou nome', () => {
    const votos = painel(ORDENS);
    const invertidos = [...votos].reverse();

    // Mesmo empate, três apresentações diferentes da mesma entrada.
    for (const entrada of [votos, invertidos, [...votos].sort((a, b) => a.registrationItemId.localeCompare(b.registrationItemId))]) {
      const resultado = tabulate(entrada, REGRA_PADRAO);
      expect(resultado.hasUnresolvedTie).toBe(true);
      expect(resultado.entries.filter(e => e.status === 'TIE_UNRESOLVED')).toHaveLength(2);
    }
  });
});

describe('homologação: DECISÃO 4 — SUM_WITHOUT_DROP como desempate', () => {
  // Painel de 7 juízes, 4 atletas. Depois do descarte, SILVIA e TANIA empatam
  // em 10 pontos. A soma sem descarte separa as duas: TANIA 14, SILVIA 15.
  const ORDENS = [
    ['SILVIA', 'TANIA', 'ULIANA', 'VERA'],
    ['SILVIA', 'TANIA', 'ULIANA', 'VERA'],
    ['SILVIA', 'TANIA', 'ULIANA', 'VERA'],
    ['SILVIA', 'TANIA', 'ULIANA', 'VERA'],
    ['ULIANA', 'TANIA', 'SILVIA', 'VERA'],
    ['ULIANA', 'TANIA', 'VERA', 'SILVIA'],
    ['ULIANA', 'TANIA', 'VERA', 'SILVIA']
  ];
  const votos = painel(ORDENS);
  const COM_DESCARTE = { dropHighLow: true, dropHighLowMinJudges: 7 };

  it('sem o critério, o descarte cria um empate que fica sem solução', () => {
    const resultado = tabulate(votos, COM_DESCARTE);

    expect(resultado.hasUnresolvedTie).toBe(true);
    expect(resultado.entries.filter(e => e.status === 'TIE_UNRESOLVED').map(e => e.registrationItemId).sort())
      .toEqual(['SILVIA', 'TANIA']);
  });

  it('com SUM_WITHOUT_DROP, a soma original resolve — TANIA é campeã', () => {
    const resultado = tabulate(votos, { ...COM_DESCARTE, tieBreakers: ['SUM_WITHOUT_DROP'] });

    expect(resultado.hasUnresolvedTie).toBe(false);
    const tania = resultado.entries.find(e => e.registrationItemId === 'TANIA');
    const silvia = resultado.entries.find(e => e.registrationItemId === 'SILVIA');

    expect([tania.score, tania.rawScore]).toEqual([10, 14]);
    expect([silvia.score, silvia.rawScore]).toEqual([10, 15]);
    expect(tania.placing).toBe(1);
    expect(silvia.placing).toBe(2);
  });
});

describe('homologação: a apuração é auditável e reproduzível', () => {
  const ORDENS = [
    ['BRUNA', 'ANA', 'CARLA'],
    ['ANA', 'BRUNA', 'CARLA'],
    ['ANA', 'CARLA', 'BRUNA']
  ];

  it('mesma entrada e mesma regra produzem o mesmo checksum, venha o voto na ordem que vier', () => {
    const votos = painel(ORDENS);
    const a = tabulate(votos, REGRA_PADRAO);
    const b = tabulate([...votos].reverse(), REGRA_PADRAO);

    expect(a.checksum).toBe(b.checksum);
    expect(a.entries).toEqual(b.entries);
  });

  it('trocar a regra muda o checksum, mesmo sem trocar um voto', () => {
    // É isto que impede que uma apuração seja republicada com outra regra sem
    // deixar rastro: a assinatura cobre a configuração, não só os votos.
    const votos = painel(ORDENS);

    const padrao = tabulate(votos, REGRA_PADRAO).checksum;
    const comDescarte = tabulate(votos, { dropHighLow: true, dropHighLowMinJudges: 3 }).checksum;
    const comDesempate = tabulate(votos, { tieBreakers: ['COUNT_BACK'] }).checksum;

    expect(new Set([padrao, comDescarte, comDesempate]).size).toBe(3);
  });

  it('a regra efetivamente aplicada volta junto com o resultado', () => {
    // O que foi apurado precisa dizer sob qual regra foi apurado. Guardar só a
    // colocação tornaria a conferência impossível meses depois.
    const resultado = tabulate(painel(ORDENS), { dropHighLow: true, dropHighLowMinJudges: 3, tieBreakers: ['COUNT_BACK'] });

    expect(resultado.ruleSet).toEqual({
      method: 'RELATIVE_PLACEMENT_SUM',
      dropHighLow: true,
      dropHighLowMinJudges: 3,
      tieBreakers: ['COUNT_BACK']
    });
  });

  it('o countback de cada atleta é registrado para conferência manual', () => {
    const resultado = tabulate(painel(ORDENS), REGRA_PADRAO);
    const ana = resultado.entries.find(e => e.registrationItemId === 'ANA');

    // ANA: 2º, 1º, 1º → dois primeiros, um segundo, nenhum terceiro.
    expect(ana.countback).toEqual([2, 1, 0]);
    expect(ana.placings).toEqual([1, 1, 2]);
    expect(ana.judgeVotes).toBe(3);
  });
});
