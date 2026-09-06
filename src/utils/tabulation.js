const crypto = require('crypto');

// ============================================================================
// Motor de apuração — determinístico, reproduzível e auditável.
//
// Entrada: as colocações que cada juiz deu a cada atleta de uma classe.
// Saída: colocação final, pontuação considerada, colocação bruta e o
// countback completo de cada atleta.
//
// O método e os desempates são CONFIGURAÇÃO do organizador (ScoringRuleSet),
// nunca regra embutida. Nenhum critério de desempate arbitrário é aplicado:
// não se desempata por id, ordem de cadastro, timestamp nem nome. Se os
// desempates configurados não resolverem, os atletas empatados saem como
// TIE_UNRESOLVED e a apuração informa isso explicitamente.
// ============================================================================

const TIE_BREAKERS = Object.freeze(['HEAD_JUDGE_PLACING', 'COUNT_BACK', 'SUM_WITHOUT_DROP']);
const METHODS = Object.freeze(['RELATIVE_PLACEMENT_SUM']);

const REGRA_PADRAO = Object.freeze({
  method: 'RELATIVE_PLACEMENT_SUM',
  // Descarte da maior e da menor colocação. Desligado por padrão: aplicar
  // descarte é decisão de regulamento, e assumi-lo por conta própria alteraria
  // o resultado de uma competição real.
  dropHighLow: false,
  dropHighLowMinJudges: 7,
  tieBreakers: []
});

// Countback: quantas vezes o atleta recebeu cada colocação. Índice 0 conta os
// primeiros lugares, índice 1 os segundos, e assim por diante.
function countback(placings, maiorColocacao) {
  const contagem = new Array(maiorColocacao).fill(0);
  for (const placing of placings) {
    if (placing >= 1 && placing <= maiorColocacao) contagem[placing - 1] += 1;
  }
  return contagem;
}

// Descarta uma ocorrência da maior e uma da menor colocação. O tamanho mínimo
// de painel para o descarte é configuração do regulamento
// (`dropHighLowMinJudges`), não decisão do código; a única guarda estrutural é
// que precisa sobrar pelo menos um voto.
function aplicarDescarte(placings, regra) {
  if (!regra.dropHighLow) return { considerados: [...placings], descartou: false };
  if (placings.length < regra.dropHighLowMinJudges) return { considerados: [...placings], descartou: false };
  if (placings.length - 2 < 1) return { considerados: [...placings], descartou: false };

  const ordenados = [...placings].sort((a, b) => a - b);
  return { considerados: ordenados.slice(1, -1), descartou: true };
}

const soma = valores => valores.reduce((total, valor) => total + valor, 0);

// Comparação lexicográfica de countback: quem tem mais colocações melhores
// vence. Devolve <0 se `a` vem antes.
function compararCountback(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diferenca = (b[i] || 0) - (a[i] || 0);
    if (diferenca !== 0) return diferenca;
  }
  return 0;
}

// Aplica os desempates configurados, na ordem, a um grupo empatado.
// Devolve subgrupos: cada subgrupo é um conjunto que continuou empatado.
function desempatar(grupo, regra) {
  let grupos = [grupo];

  for (const criterio of regra.tieBreakers) {
    const proximos = [];

    for (const atual of grupos) {
      if (atual.length === 1) {
        proximos.push(atual);
        continue;
      }

      const chave = competidor => {
        if (criterio === 'HEAD_JUDGE_PLACING') {
          // Sem juiz-chefe declarado o critério não se aplica: devolver null
          // mantém o grupo empatado em vez de inventar uma ordem.
          return competidor.headJudgePlacing ?? null;
        }
        if (criterio === 'SUM_WITHOUT_DROP') return competidor.rawScore;
        return null;
      };

      if (criterio === 'COUNT_BACK') {
        const ordenado = [...atual].sort((a, b) => compararCountback(a.countback, b.countback));
        proximos.push(...agruparPorEmpate(ordenado, (a, b) => compararCountback(a.countback, b.countback) === 0));
        continue;
      }

      const chaves = atual.map(chave);
      if (chaves.some(valor => valor === null || valor === undefined)) {
        // Critério inaplicável a algum integrante: o grupo segue empatado.
        proximos.push(atual);
        continue;
      }

      const ordenado = [...atual].sort((a, b) => chave(a) - chave(b));
      proximos.push(...agruparPorEmpate(ordenado, (a, b) => chave(a) === chave(b)));
    }

    grupos = proximos;
    if (grupos.every(item => item.length === 1)) break;
  }

  return grupos;
}

// Quebra uma lista já ordenada em blocos de elementos equivalentes.
function agruparPorEmpate(ordenado, saoIguais) {
  const blocos = [];
  let atual = [];

  for (const item of ordenado) {
    if (!atual.length || saoIguais(atual[0], item)) {
      atual.push(item);
    } else {
      blocos.push(atual);
      atual = [item];
    }
  }
  if (atual.length) blocos.push(atual);
  return blocos;
}

/**
 * Apura uma classe.
 *
 * @param {Array} scores  Lista de votos: { judgeId, registrationItemId, placing, isHeadJudge }
 * @param {Object} ruleSet Configuração de apuração (ScoringRuleSet).
 * @returns {{ entries: Array, hasUnresolvedTie: boolean, judgeCount: number, checksum: string, ruleSet: Object }}
 */
function tabulate(scores, ruleSet = {}) {
  const regra = {
    method: METHODS.includes(ruleSet.method) ? ruleSet.method : REGRA_PADRAO.method,
    dropHighLow: Boolean(ruleSet.dropHighLow),
    dropHighLowMinJudges: Number.isInteger(ruleSet.dropHighLowMinJudges) ? ruleSet.dropHighLowMinJudges : REGRA_PADRAO.dropHighLowMinJudges,
    tieBreakers: (ruleSet.tieBreakers || []).filter(item => TIE_BREAKERS.includes(item))
  };

  const votos = (scores || []).filter(voto => Number.isInteger(voto.placing) && voto.placing > 0);

  const porAtleta = new Map();
  const juizes = new Set();

  for (const voto of votos) {
    juizes.add(voto.judgeId);
    if (!porAtleta.has(voto.registrationItemId)) {
      porAtleta.set(voto.registrationItemId, { registrationItemId: voto.registrationItemId, placings: [], headJudgePlacing: null });
    }
    const atleta = porAtleta.get(voto.registrationItemId);
    atleta.placings.push(voto.placing);
    if (voto.isHeadJudge) atleta.headJudgePlacing = voto.placing;
  }

  if (!porAtleta.size) {
    return { entries: [], hasUnresolvedTie: false, judgeCount: 0, checksum: checksumOf([], regra), ruleSet: regra };
  }

  const maiorColocacao = Math.max(...votos.map(voto => voto.placing));

  const competidores = [...porAtleta.values()].map(atleta => {
    const { considerados, descartou } = aplicarDescarte(atleta.placings, regra);
    return {
      registrationItemId: atleta.registrationItemId,
      headJudgePlacing: atleta.headJudgePlacing,
      placings: [...atleta.placings].sort((a, b) => a - b),
      score: soma(considerados),
      rawScore: soma(atleta.placings),
      dropped: descartou,
      judgeVotes: atleta.placings.length,
      countback: countback(atleta.placings, maiorColocacao)
    };
  });

  // Ordenação primária: menor soma de colocações vence.
  const ordenados = [...competidores].sort((a, b) => a.score - b.score);
  const blocos = agruparPorEmpate(ordenados, (a, b) => a.score === b.score);

  const entries = [];
  let hasUnresolvedTie = false;
  let posicao = 1;

  for (const bloco of blocos) {
    if (bloco.length === 1) {
      entries.push({ ...bloco[0], placing: posicao, status: 'RANKED' });
      posicao += 1;
      continue;
    }

    const subgrupos = desempatar(bloco, regra);

    for (const subgrupo of subgrupos) {
      if (subgrupo.length === 1) {
        entries.push({ ...subgrupo[0], placing: posicao, status: 'RANKED' });
        posicao += 1;
        continue;
      }

      // Empate que os critérios configurados não resolveram. Ninguém recebe
      // colocação: a decisão volta para a organização, com registro.
      hasUnresolvedTie = true;
      for (const competidor of subgrupo) {
        entries.push({ ...competidor, placing: null, status: 'TIE_UNRESOLVED' });
      }
      posicao += subgrupo.length;
    }
  }

  return {
    entries,
    hasUnresolvedTie,
    judgeCount: juizes.size,
    checksum: checksumOf(votos, regra),
    ruleSet: regra
  };
}

// Assinatura da entrada da apuração. Os votos são ordenados antes do hash para
// que a ordem em que vieram do banco não mude o checksum: mesma entrada, mesmo
// checksum, sempre.
function checksumOf(votos, regra) {
  const normalizados = [...(votos || [])]
    .map(voto => `${voto.judgeId}:${voto.registrationItemId}:${voto.placing}`)
    .sort();

  const material = JSON.stringify({
    method: regra.method,
    dropHighLow: regra.dropHighLow,
    dropHighLowMinJudges: regra.dropHighLowMinJudges,
    tieBreakers: [...regra.tieBreakers].sort(),
    votos: normalizados
  });

  return crypto.createHash('sha256').update(material).digest('hex');
}

module.exports = { tabulate, checksumOf, countback, TIE_BREAKERS, METHODS, REGRA_PADRAO };
