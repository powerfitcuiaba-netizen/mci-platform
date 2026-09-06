'use strict';

const { AppError } = require('../../utils/errors');
const { pode } = require('../acesso/permissoes');

// ============================================================================
// MÁQUINAS DE ESTADO DO CICLO COMPETITIVO.
//
// Mesma ideia já aplicada ao financeiro em utils/financialStates.js, estendida
// com um conceito que o ciclo esportivo exige: a TRANSIÇÃO PRIVILEGIADA.
//
// Resultado publicado é histórico oficial. Ele não volta para revisão porque
// alguém clicou: volta se, e somente se, quem clicou tem `results.override` —
// e a operação exige motivo, que fica na auditoria (seções 39, 80).
// ============================================================================

// Destino simples: string. Destino privilegiado: { para, exige }.
function criarMaquina(nome, rotulo, definicao) {
  const estados = Object.keys(definicao);

  const destinosDe = estado => (definicao[estado] || []).map(d => (typeof d === 'string' ? d : d.para));

  const regraDe = (de, para) =>
    (definicao[de] || []).find(d => (typeof d === 'string' ? d : d.para) === para) || null;

  const ehEstado = estado => Object.prototype.hasOwnProperty.call(definicao, estado);

  const ehTerminal = estado => ehEstado(estado) && definicao[estado].length === 0;

  const permissaoExigida = (de, para) => {
    const regra = regraDe(de, para);
    return regra && typeof regra === 'object' ? regra.exige : null;
  };

  const podeTransitar = (de, para) => de !== para && regraDe(de, para) !== null;

  // `papel` é opcional: sem ele, valida apenas o desenho da transição. Com ele,
  // valida também a autoridade de quem está tentando.
  function assertTransicao(de, para, papel) {
    if (!ehEstado(de)) {
      throw new AppError(422, 'ESTADO_INVALIDO', `Estado atual inválido para ${rotulo}: ${de}`);
    }
    if (!ehEstado(para)) {
      throw new AppError(422, 'ESTADO_INVALIDO', `Estado de destino inválido para ${rotulo}: ${para}`);
    }
    if (de === para) {
      throw new AppError(422, 'TRANSICAO_INVALIDA', `${rotulo} já está em ${de}`);
    }
    if (!podeTransitar(de, para)) {
      throw new AppError(
        422,
        'TRANSICAO_INVALIDA',
        `Transição não permitida para ${rotulo}: ${de} → ${para}`,
        { transicoesPossiveis: destinosDe(de) }
      );
    }

    const exige = permissaoExigida(de, para);
    if (exige) {
      if (!papel) {
        throw new AppError(
          403,
          'TRANSICAO_PRIVILEGIADA',
          `A transição ${de} → ${para} de ${rotulo} exige permissão especial`,
          { permissaoExigida: exige }
        );
      }
      if (!pode(papel, exige)) {
        throw new AppError(
          403,
          'TRANSICAO_PRIVILEGIADA',
          `Seu perfil não pode levar ${rotulo} de ${de} para ${para}`,
          { permissaoExigida: exige }
        );
      }
    }

    return para;
  }

  return Object.freeze({
    nome,
    rotulo,
    estados,
    definicao,
    destinosDe,
    ehEstado,
    ehTerminal,
    podeTransitar,
    permissaoExigida,
    assertTransicao
  });
}

// ---------------------------------------------------------------------------
// EVENTO (seção 25). O ciclo é rígido de propósito: não se abre inscrição de um
// evento em julgamento, e não se volta a operar um evento já encerrado.
// ---------------------------------------------------------------------------
const evento = criarMaquina('evento', 'evento', {
  RASCUNHO: ['PLANEJADO', 'CANCELADO'],
  PLANEJADO: ['INSCRICOES_ABERTAS', 'RASCUNHO', 'CANCELADO'],
  INSCRICOES_ABERTAS: ['INSCRICOES_ENCERRADAS', 'CANCELADO'],
  // Reabrir inscrição depois de encerrada muda a lista de quem compete: é
  // decisão do promotor, não operação de rotina.
  INSCRICOES_ENCERRADAS: [
    { para: 'INSCRICOES_ABERTAS', exige: 'events.update' },
    'EM_OPERACAO',
    'CANCELADO'
  ],
  EM_OPERACAO: ['EM_JULGAMENTO', 'CANCELADO'],
  EM_JULGAMENTO: ['RESULTADOS_EM_REVISAO'],
  RESULTADOS_EM_REVISAO: ['RESULTADOS_PUBLICADOS', 'EM_JULGAMENTO'],
  // Depois de publicar, cancelar o evento apagaria resultado oficial da vista:
  // só sai para encerramento.
  RESULTADOS_PUBLICADOS: ['ENCERRADO'],
  ENCERRADO: [],
  CANCELADO: []
});

// ---------------------------------------------------------------------------
// INSCRIÇÃO (seções 26 e 27).
// ---------------------------------------------------------------------------
const inscricao = criarMaquina('inscricao', 'inscrição', {
  RASCUNHO: ['PENDENTE', 'CANCELADA'],
  PENDENTE: ['AGUARDANDO_PAGAMENTO', 'DOCUMENTACAO_PENDENTE', 'APROVADA', 'REJEITADA', 'CANCELADA'],
  AGUARDANDO_PAGAMENTO: ['PAGA', 'EXPIRADA', 'CANCELADA'],
  PAGA: ['DOCUMENTACAO_PENDENTE', 'APROVADA', 'CANCELADA'],
  DOCUMENTACAO_PENDENTE: ['APROVADA', 'REJEITADA', 'CANCELADA'],
  // Inscrição aprovada volta atrás apenas por quem aprova: desfazer aprovação
  // tira um atleta já contado na ordem de palco.
  APROVADA: [
    { para: 'DOCUMENTACAO_PENDENTE', exige: 'registrations.approve' },
    'CANCELADA'
  ],
  REJEITADA: [{ para: 'PENDENTE', exige: 'registrations.approve' }],
  CANCELADA: [],
  EXPIRADA: [{ para: 'AGUARDANDO_PAGAMENTO', exige: 'registrations.update' }]
});

// ---------------------------------------------------------------------------
// RESULTADO (seção 39). O ponto de não retorno do sistema.
// ---------------------------------------------------------------------------
const resultado = criarMaquina('resultado', 'resultado', {
  RASCUNHO: ['CALCULANDO', 'BLOQUEADO'],
  // Volta a rascunho quando a apuração recusa a bateria (empate não resolvido,
  // painel incompleto): o motor não entrega resultado pela metade.
  CALCULANDO: ['EM_REVISAO', 'RASCUNHO'],
  EM_REVISAO: ['APROVADO', 'CALCULANDO', 'BLOQUEADO'],
  APROVADO: ['PUBLICADO', 'EM_REVISAO'],
  // AQUI está a regra que protege o histórico. Reabrir resultado publicado
  // existe, porque erro acontece e correção precisa ser possível — mas exige
  // `results.override`, que quase nenhum papel tem.
  PUBLICADO: [
    { para: 'EM_REVISAO', exige: 'results.override' },
    { para: 'BLOQUEADO', exige: 'results.override' }
  ],
  BLOQUEADO: [{ para: 'EM_REVISAO', exige: 'results.override' }]
});

module.exports = { criarMaquina, evento, inscricao, resultado };
