import { describe, expect, it } from 'vitest';
import motor from '../src/domain/julgamento/motorPontuacao.js';

// Suíte do motor de apuração. Não toca no banco de propósito: a regra de
// pontuação é lógica pura, e lógica pura se prova com entrada e saída.
//
// O que estes testes protegem, acima de tudo, é o determinismo (seção 38) e a
// recusa de apurar bateria inconsistente (seção 64). Um pódio de fisiculturismo
// é resultado oficial: se o motor decidir empate no escuro ou aceitar planilha
// furada, o dano não é um bug de tela — é um título entregue errado.

const { calcular, somarComDescarte, normalizarRegra, assinaturaDe } = motor;

// Monta a bateria a partir das ordens de cada juiz, no formato em que a súmula
// é preenchida: { juiz: { atleta: colocação } }.
function bateria(ordens, extras = {}) {
  const juizes = Object.keys(ordens);
  const atletas = [...new Set(juizes.flatMap(j => Object.keys(ordens[j])))].sort();
  const notas = juizes.flatMap(juizId =>
    Object.entries(ordens[juizId]).map(([atletaId, colocacao]) => ({ juizId, atletaId, colocacao }))
  );
  return { atletas, juizes, notas, ...extras };
}

const posicaoDe = (resultado, atletaId) =>
  resultado.colocacoes.find(c => c.atletaId === atletaId).posicao;

const ordemFinal = resultado => resultado.colocacoes.map(c => c.atletaId);

describe('soma com descarte', () => {
  it('soma todas as notas quando a regra não descarta nada', () => {
    const regra = normalizarRegra({});
    expect(somarComDescarte([1, 2, 3], regra).soma).toBe(6);
  });

  it('remove as notas extremas conforme a regra e preserva a soma completa', () => {
    const regra = normalizarRegra({ descartarMaiores: 1, descartarMenores: 1 });
    const resultado = somarComDescarte([1, 1, 2, 2, 5], regra);

    expect(resultado.consideradas).toEqual([1, 2, 2]);
    expect(resultado.descartadas).toEqual([1, 5]);
    expect(resultado.soma).toBe(5);
    // A soma completa continua disponível: é o primeiro critério de desempate.
    expect(resultado.somaCompleta).toBe(11);
  });
});

describe('apuração de bateria', () => {
  it('ordena pela menor soma de colocações', () => {
    const resultado = calcular(bateria({
      j1: { ana: 1, bruna: 2, carla: 3 },
      j2: { ana: 1, bruna: 2, carla: 3 },
      j3: { ana: 2, bruna: 1, carla: 3 }
    }));

    expect(ordemFinal(resultado)).toEqual(['ana', 'bruna', 'carla']);
    expect(resultado.colocacoes[0].soma).toBe(4);
    expect(resultado.apuravel).toBe(true);
    expect(resultado.empatesNaoResolvidos).toEqual([]);
  });

  it('aplica o descarte configurado antes de ordenar', () => {
    // Sem descarte as duas somam igual; com descarte da maior nota, a atleta
    // que levou uma colocação isolada ruim passa à frente.
    const ordens = {
      j1: { ana: 1, bruna: 2, carla: 3 },
      j2: { ana: 3, bruna: 2, carla: 1 },
      j3: { ana: 2, bruna: 1, carla: 3 }
    };

    const semDescarte = calcular(bateria(ordens));
    expect(semDescarte.colocacoes.find(c => c.atletaId === 'ana').soma).toBe(6);

    const comDescarte = calcular(bateria(ordens), { descartarMaiores: 1 });
    const ana = comDescarte.colocacoes.find(c => c.atletaId === 'ana');

    expect(ana.notasConsideradas).toEqual([1, 2]);
    expect(ana.notasDescartadas).toEqual([3]);
    expect(ana.soma).toBe(3);
    expect(ana.somaCompleta).toBe(6);
  });
});

describe('desempate', () => {
  it('resolve pela soma completa quando o descarte igualou as somas', () => {
    // ana e bruna empatam em 3 após descartar a maior nota, mas bruna soma
    // menos considerando todas as notas.
    const resultado = calcular(bateria({
      j1: { ana: 1, bruna: 2, carla: 3 },
      j2: { ana: 3, bruna: 2, carla: 1 },
      j3: { ana: 2, bruna: 1, carla: 3 }
    }), { descartarMaiores: 1, criteriosDesempate: ['SOMA_COMPLETA'] });

    expect(resultado.colocacoes.find(c => c.atletaId === 'ana').soma).toBe(3);
    expect(resultado.colocacoes.find(c => c.atletaId === 'bruna').soma).toBe(3);
    expect(posicaoDe(resultado, 'bruna')).toBe(1);
    expect(posicaoDe(resultado, 'ana')).toBe(2);
    expect(resultado.apuravel).toBe(true);
  });

  it('resolve por confronto direto quando as somas são idênticas', () => {
    // ana e bruna somam 5 e têm a mesma soma completa. Dois dos três juízes
    // colocaram ana à frente de bruna: a maioria decide.
    const resultado = calcular(bateria({
      j1: { ana: 1, bruna: 2, carla: 3 },
      j2: { ana: 1, bruna: 2, carla: 3 },
      j3: { ana: 3, bruna: 1, carla: 2 }
    }));

    expect(resultado.colocacoes.find(c => c.atletaId === 'ana').soma).toBe(5);
    expect(resultado.colocacoes.find(c => c.atletaId === 'bruna').soma).toBe(5);
    expect(posicaoDe(resultado, 'ana')).toBe(1);
    expect(posicaoDe(resultado, 'bruna')).toBe(2);
    expect(resultado.apuravel).toBe(true);
  });

  it('usa o juiz principal como último critério', () => {
    // Painel par, empate perfeito: confronto direto termina 2 a 2 e só a nota
    // do juiz principal separa.
    const sessao = bateria({
      j1: { ana: 1, bruna: 2 },
      j2: { ana: 1, bruna: 2 },
      j3: { ana: 2, bruna: 1 },
      j4: { ana: 2, bruna: 1 }
    }, { juizPrincipalId: 'j3' });

    const resultado = calcular(sessao, {
      criteriosDesempate: ['SOMA_COMPLETA', 'CONFRONTO_DIRETO', 'JUIZ_PRINCIPAL']
    });

    // j3 colocou bruna em primeiro.
    expect(posicaoDe(resultado, 'bruna')).toBe(1);
    expect(posicaoDe(resultado, 'ana')).toBe(2);
    expect(resultado.apuravel).toBe(true);
  });

  it('NÃO decide empate que a regra configurada não resolve', () => {
    // Este é o teste mais importante da suíte. Empate perfeito, sem juiz
    // principal: o motor precisa devolver o empate sinalizado em vez de
    // escolher alguém por ordem de id, data de inscrição ou acaso.
    const resultado = calcular(bateria({
      j1: { ana: 1, bruna: 2 },
      j2: { ana: 1, bruna: 2 },
      j3: { ana: 2, bruna: 1 },
      j4: { ana: 2, bruna: 1 }
    }));

    expect(resultado.apuravel).toBe(false);
    expect(resultado.empatesNaoResolvidos).toEqual([{ posicao: 1, atletas: ['ana', 'bruna'] }]);
    expect(resultado.colocacoes.every(c => c.empatado)).toBe(true);
    expect(resultado.colocacoes.every(c => c.posicao === 1)).toBe(true);
  });

  it('empate ocupa as posições seguintes: dois em primeiro, o próximo é terceiro', () => {
    const resultado = calcular(bateria({
      j1: { ana: 1, bruna: 2, carla: 3 },
      j2: { ana: 2, bruna: 1, carla: 3 },
      j3: { ana: 1, bruna: 2, carla: 3 },
      j4: { ana: 2, bruna: 1, carla: 3 }
    }));

    expect(posicaoDe(resultado, 'ana')).toBe(1);
    expect(posicaoDe(resultado, 'bruna')).toBe(1);
    expect(posicaoDe(resultado, 'carla')).toBe(3);
    expect(resultado.apuravel).toBe(false);
  });
});

describe('determinismo', () => {
  const ordens = {
    j1: { ana: 1, bruna: 2, carla: 3, duda: 4 },
    j2: { ana: 2, bruna: 1, carla: 4, duda: 3 },
    j3: { ana: 1, bruna: 3, carla: 2, duda: 4 },
    j4: { ana: 3, bruna: 1, carla: 2, duda: 4 },
    j5: { ana: 1, bruna: 2, carla: 4, duda: 3 }
  };
  const regra = { descartarMaiores: 1, descartarMenores: 1 };

  it('produz saída idêntica em execuções repetidas', () => {
    const primeira = calcular(bateria(ordens), regra);
    const segunda = calcular(bateria(ordens), regra);

    expect(segunda.colocacoes).toEqual(primeira.colocacoes);
    expect(segunda.assinatura).toBe(primeira.assinatura);
  });

  it('independe da ordem em que as notas chegam', () => {
    const referencia = calcular(bateria(ordens), regra);

    const embaralhada = bateria(ordens);
    embaralhada.notas = [...embaralhada.notas].reverse();
    embaralhada.atletas = [...embaralhada.atletas].reverse();
    embaralhada.juizes = [...embaralhada.juizes].reverse();

    const resultado = calcular(embaralhada, regra);

    expect(ordemFinal(resultado)).toEqual(ordemFinal(referencia));
    // A assinatura é canônica: a mesma bateria descrita em outra ordem é a
    // mesma bateria, e precisa gerar a mesma impressão digital.
    expect(resultado.assinatura).toBe(referencia.assinatura);
  });

  it('muda a assinatura quando qualquer nota muda', () => {
    const original = calcular(bateria(ordens), regra);
    const alterada = calcular(bateria({ ...ordens, j1: { ana: 2, bruna: 1, carla: 3, duda: 4 } }), regra);

    expect(alterada.assinatura).not.toBe(original.assinatura);
  });

  it('muda a assinatura quando a regra muda, mesmo com as mesmas notas', () => {
    const sessao = bateria(ordens);
    const comUmDescarte = assinaturaDe(sessao, normalizarRegra({ descartarMaiores: 1 }));
    const comDoisDescartes = assinaturaDe(sessao, normalizarRegra({ descartarMaiores: 2 }));

    expect(comUmDescarte).not.toBe(comDoisDescartes);
  });
});

describe('recusa de bateria inconsistente', () => {
  const esperarRecusa = (sessao, regra, trecho) => {
    try {
      calcular(sessao, regra);
      throw new Error('a apuração deveria ter sido recusada');
    } catch (erro) {
      expect(erro.status).toBe(422);
      expect(erro.code).toBe('BATERIA_INVALIDA');
      expect(erro.details.problemas.join(' | ')).toContain(trecho);
    }
  };

  it('recusa juiz que não integra o painel', () => {
    const sessao = bateria({ j1: { ana: 1, bruna: 2 } });
    sessao.notas.push({ juizId: 'intruso', atletaId: 'ana', colocacao: 1 });
    esperarRecusa(sessao, {}, 'não integra o painel');
  });

  it('recusa nota para atleta que não está na bateria', () => {
    const sessao = bateria({ j1: { ana: 1, bruna: 2 } });
    sessao.notas.push({ juizId: 'j1', atletaId: 'fantasma', colocacao: 1 });
    esperarRecusa(sessao, {}, 'não está na bateria');
  });

  it('recusa colocação repetida pelo mesmo juiz', () => {
    // Julgamento por colocação exige ordenação estrita: dois primeiros lugares
    // na mesma súmula é erro de preenchimento, não empate.
    const sessao = bateria({ j1: { ana: 1, bruna: 1 } });
    esperarRecusa(sessao, {}, 'repetiu a mesma colocação');
  });

  it('recusa painel incompleto', () => {
    const sessao = {
      atletas: ['ana', 'bruna'],
      juizes: ['j1', 'j2'],
      notas: [
        { juizId: 'j1', atletaId: 'ana', colocacao: 1 },
        { juizId: 'j1', atletaId: 'bruna', colocacao: 2 },
        { juizId: 'j2', atletaId: 'ana', colocacao: 1 }
      ]
    };
    esperarRecusa(sessao, {}, 'não pontuou');
  });

  it('recusa colocação fora do intervalo válido', () => {
    const sessao = bateria({ j1: { ana: 1, bruna: 9 } });
    esperarRecusa(sessao, {}, 'Colocação inválida');
  });

  it('recusa colocação zero ou negativa', () => {
    const sessao = bateria({ j1: { ana: 0, bruna: 1 } });
    esperarRecusa(sessao, {}, 'Colocação inválida');
  });

  it('recusa descarte que não deixaria nota alguma', () => {
    const sessao = bateria({
      j1: { ana: 1, bruna: 2 },
      j2: { ana: 1, bruna: 2 }
    });
    esperarRecusa(sessao, { descartarMaiores: 1, descartarMenores: 1 }, 'Descarte inviável');
  });

  it('recusa bateria sem atletas', () => {
    esperarRecusa({ atletas: [], juizes: ['j1'], notas: [] }, {}, 'não tem atletas');
  });

  it('recusa bateria sem juízes', () => {
    esperarRecusa({ atletas: ['ana'], juizes: [], notas: [] }, {}, 'não tem juízes');
  });

  it('recusa juiz principal que não está no painel', () => {
    const sessao = bateria({ j1: { ana: 1, bruna: 2 } }, { juizPrincipalId: 'j9' });
    esperarRecusa(sessao, {}, 'juiz principal informado não integra o painel');
  });

  it('recusa critério de desempate desconhecido', () => {
    const sessao = bateria({ j1: { ana: 1, bruna: 2 } });
    expect(() => calcular(sessao, { criteriosDesempate: ['MOEDA'] })).toThrow(/desconhecido/);
  });

  it('recusa descarte negativo', () => {
    expect(() => normalizarRegra({ descartarMaiores: -1 })).toThrow(/negativo/);
  });
});
