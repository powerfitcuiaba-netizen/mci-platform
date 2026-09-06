'use strict';

const crypto = require('node:crypto');
const { AppError } = require('../../utils/errors');

// ============================================================================
// MOTOR DE PONTUAÇÃO — julgamento por colocação de painel.
//
// Fisiculturismo não é confronto direto. Numa bateria, cada juiz ordena TODOS
// os atletas da categoria, do primeiro ao último, e a colocação final sai da
// soma dessas ordens: quem soma menos, vence.
//
// O motor implementa o MECANISMO. Ele não decide quantas notas se descarta nem
// qual desempate se aplica — isso é regra esportiva da organização e chega como
// configuração. Um empate que a regra configurada não resolve NÃO é decidido no
// escuro: volta sinalizado para decisão registrada do juiz principal.
// ============================================================================

const CRITERIOS_DESEMPATE = Object.freeze(['SOMA_COMPLETA', 'CONFRONTO_DIRETO', 'JUIZ_PRINCIPAL']);

const regraPadrao = Object.freeze({
  // Zero descarte é o padrão deliberado: descartar nota é decisão da federação,
  // e assumir um número aqui seria inventar regra esportiva.
  descartarMaiores: 0,
  descartarMenores: 0,
  criteriosDesempate: Object.freeze(['SOMA_COMPLETA', 'CONFRONTO_DIRETO']),
  exigirPainelCompleto: true
});

function normalizarRegra(regra = {}) {
  const criterios = Array.isArray(regra.criteriosDesempate)
    ? regra.criteriosDesempate
    : regraPadrao.criteriosDesempate;

  for (const criterio of criterios) {
    if (!CRITERIOS_DESEMPATE.includes(criterio)) {
      throw new AppError(422, 'REGRA_INVALIDA', `Critério de desempate desconhecido: ${criterio}`);
    }
  }

  const descartarMaiores = Number.isInteger(regra.descartarMaiores)
    ? regra.descartarMaiores
    : regraPadrao.descartarMaiores;
  const descartarMenores = Number.isInteger(regra.descartarMenores)
    ? regra.descartarMenores
    : regraPadrao.descartarMenores;

  if (descartarMaiores < 0 || descartarMenores < 0) {
    throw new AppError(422, 'REGRA_INVALIDA', 'Descarte de notas não pode ser negativo');
  }

  return Object.freeze({
    descartarMaiores,
    descartarMenores,
    criteriosDesempate: Object.freeze([...criterios]),
    exigirPainelCompleto: regra.exigirPainelCompleto !== false
  });
}

// ---------------------------------------------------------------------------
// Validação estrutural. Um resultado só é confiável se a bateria estiver
// íntegra, então tudo o que puder invalidar o cálculo é recusado ANTES de somar
// qualquer coisa — nunca depois, com o pódio já na tela.
// ---------------------------------------------------------------------------
function validarSessao(sessao, regra) {
  const problemas = [];

  const atletas = Array.isArray(sessao?.atletas) ? sessao.atletas : [];
  const juizes = Array.isArray(sessao?.juizes) ? sessao.juizes : [];
  const notas = Array.isArray(sessao?.notas) ? sessao.notas : [];

  if (atletas.length < 1) problemas.push('A bateria não tem atletas');
  if (juizes.length < 1) problemas.push('A bateria não tem juízes');

  const atletasUnicos = new Set(atletas);
  if (atletasUnicos.size !== atletas.length) problemas.push('Há atleta repetido na bateria');

  const juizesUnicos = new Set(juizes);
  if (juizesUnicos.size !== juizes.length) problemas.push('Há juiz repetido no painel');

  // Descartar mais notas do que o painel tem deixaria atleta sem nota alguma.
  const descartadas = regra.descartarMaiores + regra.descartarMenores;
  if (juizes.length > 0 && descartadas >= juizes.length) {
    problemas.push(
      `Descarte inviável: a regra descarta ${descartadas} nota(s) de um painel de ` +
      `${juizes.length} juiz(es), e ao menos uma nota precisa sobrar`
    );
  }

  // Índice das notas por juiz, para checar cobertura e ordenação estrita.
  const porJuiz = new Map(juizes.map(id => [id, new Map()]));

  for (const nota of notas) {
    if (!porJuiz.has(nota.juizId)) {
      problemas.push(`Nota enviada por juiz que não integra o painel: ${nota.juizId}`);
      continue;
    }
    if (!atletasUnicos.has(nota.atletaId)) {
      problemas.push(`Nota atribuída a atleta que não está na bateria: ${nota.atletaId}`);
      continue;
    }
    const doJuiz = porJuiz.get(nota.juizId);
    if (doJuiz.has(nota.atletaId)) {
      problemas.push(`Juiz ${nota.juizId} enviou duas notas para o atleta ${nota.atletaId}`);
      continue;
    }
    if (!Number.isInteger(nota.colocacao) || nota.colocacao < 1 || nota.colocacao > atletas.length) {
      problemas.push(
        `Colocação inválida do juiz ${nota.juizId} para o atleta ${nota.atletaId}: ` +
        `${nota.colocacao} (esperado inteiro de 1 a ${atletas.length})`
      );
      continue;
    }
    doJuiz.set(nota.atletaId, nota.colocacao);
  }

  // Julgamento por colocação exige ordenação estrita: o juiz distribui 1..N sem
  // repetir. Colocação repetida não é empate — é planilha errada.
  for (const juizId of juizes) {
    const doJuiz = porJuiz.get(juizId);

    if (regra.exigirPainelCompleto && doJuiz.size !== atletas.length) {
      const faltantes = atletas.filter(id => !doJuiz.has(id));
      problemas.push(`Juiz ${juizId} não pontuou ${faltantes.length} atleta(s) da bateria`);
      continue;
    }
    if (doJuiz.size === 0) continue;

    const usadas = [...doJuiz.values()];
    if (new Set(usadas).size !== usadas.length) {
      problemas.push(`Juiz ${juizId} repetiu a mesma colocação para atletas diferentes`);
    }
  }

  if (sessao?.juizPrincipalId && !juizesUnicos.has(sessao.juizPrincipalId)) {
    problemas.push('O juiz principal informado não integra o painel');
  }

  return { valida: problemas.length === 0, problemas, porJuiz };
}

// ---------------------------------------------------------------------------
// Soma com descarte. Ordena as colocações recebidas, remove as N melhores e as
// N piores conforme a regra, e soma o que sobra.
// ---------------------------------------------------------------------------
function somarComDescarte(colocacoes, regra) {
  const ordenadas = [...colocacoes].sort((a, b) => a - b);
  const inicio = regra.descartarMenores;
  const fim = ordenadas.length - regra.descartarMaiores;
  const consideradas = ordenadas.slice(inicio, fim);

  return {
    consideradas,
    descartadas: [...ordenadas.slice(0, inicio), ...ordenadas.slice(fim)],
    soma: consideradas.reduce((total, valor) => total + valor, 0),
    somaCompleta: ordenadas.reduce((total, valor) => total + valor, 0)
  };
}

// ---------------------------------------------------------------------------
// Desempates. Cada um recebe o grupo empatado e devolve subgrupos ordenados;
// devolver o grupo inteiro num subgrupo só significa "não separei ninguém".
// ---------------------------------------------------------------------------

// Soma sem descarte: as notas extremas que a regra ignorou voltam a valer.
function desempatarPorSomaCompleta(grupo, ctx) {
  return agruparPorChave(grupo, atletaId => ctx.porAtleta.get(atletaId).somaCompleta);
}

// Confronto direto: para cada par, conta quantos juízes colocaram um à frente
// do outro. Só ordena se a relação for transitiva — havendo ciclo
// (A>B, B>C, C>A), a maioria não decide e o grupo volta inteiro.
function desempatarPorConfrontoDireto(grupo, ctx) {
  if (grupo.length < 2) return [grupo];

  const vitorias = new Map(grupo.map(id => [id, 0]));

  for (let i = 0; i < grupo.length; i += 1) {
    for (let j = i + 1; j < grupo.length; j += 1) {
      const a = grupo[i];
      const b = grupo[j];
      let favoravelA = 0;
      let favoravelB = 0;

      for (const juizId of ctx.juizes) {
        const colocacaoA = ctx.porJuiz.get(juizId).get(a);
        const colocacaoB = ctx.porJuiz.get(juizId).get(b);
        if (colocacaoA === undefined || colocacaoB === undefined) continue;
        if (colocacaoA < colocacaoB) favoravelA += 1;
        else if (colocacaoB < colocacaoA) favoravelB += 1;
      }

      if (favoravelA > favoravelB) vitorias.set(a, vitorias.get(a) + 1);
      else if (favoravelB > favoravelA) vitorias.set(b, vitorias.get(b) + 1);
    }
  }

  const subgrupos = agruparPorChave(grupo, id => -vitorias.get(id));

  // Todos com o mesmo número de vitórias: nada foi separado.
  if (subgrupos.length === 1) return [grupo];
  return subgrupos;
}

// Voto de minerva do juiz principal. Só existe se a bateria declarou um.
function desempatarPorJuizPrincipal(grupo, ctx) {
  if (!ctx.juizPrincipalId) return [grupo];
  const notas = ctx.porJuiz.get(ctx.juizPrincipalId);
  if (!notas) return [grupo];
  return agruparPorChave(grupo, id => notas.get(id) ?? Number.MAX_SAFE_INTEGER);
}

const IMPLEMENTACOES = Object.freeze({
  SOMA_COMPLETA: desempatarPorSomaCompleta,
  CONFRONTO_DIRETO: desempatarPorConfrontoDireto,
  JUIZ_PRINCIPAL: desempatarPorJuizPrincipal
});

// Agrupa por chave numérica e devolve os subgrupos em ordem crescente de chave.
// A ordenação interna por id mantém a saída estável quando a chave empata.
function agruparPorChave(ids, chaveDe) {
  const mapa = new Map();
  for (const id of ids) {
    const chave = chaveDe(id);
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(id);
  }
  return [...mapa.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, grupo]) => [...grupo].sort());
}

// Aplica a cadeia de desempates em profundidade sobre um grupo empatado.
function resolverEmpate(grupo, ctx, criterios) {
  if (grupo.length === 1) return [grupo];
  if (criterios.length === 0) return [grupo];

  const [criterio, ...restantes] = criterios;
  const subgrupos = IMPLEMENTACOES[criterio](grupo, ctx);

  // O critério não separou nada: tenta o próximo sobre o mesmo grupo.
  if (subgrupos.length === 1 && subgrupos[0].length === grupo.length) {
    return resolverEmpate(grupo, ctx, restantes);
  }

  // Separou em parte: cada subgrupo ainda empatado segue na cadeia.
  return subgrupos.flatMap(sub => resolverEmpate(sub, ctx, restantes));
}

// ---------------------------------------------------------------------------
// Assinatura de determinismo. Impressão digital das entradas que produziram o
// resultado. Guardada junto do resultado publicado, é o que permite provar
// depois que um pódio histórico nasceu exatamente daquelas notas e daquela
// regra — e detectar se alguma delas foi mexida.
// ---------------------------------------------------------------------------
function assinaturaDe(sessao, regra) {
  const canonico = JSON.stringify({
    atletas: [...sessao.atletas].sort(),
    juizes: [...sessao.juizes].sort(),
    juizPrincipalId: sessao.juizPrincipalId ?? null,
    notas: [...sessao.notas]
      .map(n => [String(n.juizId), String(n.atletaId), n.colocacao])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    regra: {
      descartarMaiores: regra.descartarMaiores,
      descartarMenores: regra.descartarMenores,
      criteriosDesempate: regra.criteriosDesempate,
      exigirPainelCompleto: regra.exigirPainelCompleto
    }
  });

  return crypto.createHash('sha256').update(canonico).digest('hex');
}

// ---------------------------------------------------------------------------
// Cálculo. Determinístico por construção: mesmas notas e mesma regra produzem
// exatamente a mesma saída, inclusive a ordem dos empatados não resolvidos.
// ---------------------------------------------------------------------------
function calcular(sessao, regraBruta = {}) {
  const regra = normalizarRegra(regraBruta);
  const validacao = validarSessao(sessao, regra);

  if (!validacao.valida) {
    throw new AppError(422, 'BATERIA_INVALIDA', 'A bateria não pode ser apurada', {
      problemas: validacao.problemas
    });
  }

  const { porJuiz } = validacao;
  const porAtleta = new Map();

  for (const atletaId of sessao.atletas) {
    const colocacoes = sessao.juizes
      .map(juizId => porJuiz.get(juizId).get(atletaId))
      .filter(valor => valor !== undefined);

    porAtleta.set(atletaId, { atletaId, ...somarComDescarte(colocacoes, regra), colocacoes });
  }

  const ctx = {
    porAtleta,
    porJuiz,
    juizes: sessao.juizes,
    juizPrincipalId: sessao.juizPrincipalId ?? null
  };

  // Primeiro corte pela soma; depois a cadeia de desempate dentro de cada bloco.
  const blocos = agruparPorChave([...sessao.atletas], id => porAtleta.get(id).soma);
  const ordenado = blocos.flatMap(bloco => resolverEmpate(bloco, ctx, regra.criteriosDesempate));

  const colocacoes = [];
  const empatesNaoResolvidos = [];
  let posicao = 1;

  for (const grupo of ordenado) {
    if (grupo.length > 1) {
      empatesNaoResolvidos.push({ posicao, atletas: [...grupo] });
    }
    for (const atletaId of grupo) {
      const dados = porAtleta.get(atletaId);
      colocacoes.push({
        atletaId,
        posicao,
        soma: dados.soma,
        somaCompleta: dados.somaCompleta,
        notasConsideradas: dados.consideradas,
        notasDescartadas: dados.descartadas,
        // Empatado na mesma posição: o pódio não é oficializável assim.
        empatado: grupo.length > 1
      });
    }
    // Empate ocupa as posições seguintes: dois em 1º, o próximo é 3º.
    posicao += grupo.length;
  }

  return {
    colocacoes,
    empatesNaoResolvidos,
    // O resultado só pode ser aprovado quando não sobra empate. Quem decide o
    // desempate manual é o juiz principal, e a decisão fica registrada.
    apuravel: empatesNaoResolvidos.length === 0,
    regraAplicada: regra,
    assinatura: assinaturaDe(sessao, regra)
  };
}

module.exports = {
  calcular,
  validarSessao,
  normalizarRegra,
  somarComDescarte,
  assinaturaDe,
  regraPadrao,
  CRITERIOS_DESEMPATE
};
