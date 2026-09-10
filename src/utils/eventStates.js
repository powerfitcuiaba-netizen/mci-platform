const { AppError } = require('./errors');

// Máquina de estados do evento. Toda transição é explícita: o que não está
// declarado aqui não acontece, e a tentativa é recusada com o motivo.
const EVENT_STATES = Object.freeze([
  'DRAFT',
  'PLANNED',
  'REGISTRATIONS_OPEN',
  'REGISTRATIONS_CLOSED',
  'IN_OPERATION',
  'IN_JUDGING',
  'RESULTS_IN_REVIEW',
  'RESULTS_PUBLISHED',
  'CLOSED',
  'CANCELLED'
]);

const TRANSICOES = Object.freeze({
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['REGISTRATIONS_OPEN', 'DRAFT', 'CANCELLED'],
  REGISTRATIONS_OPEN: ['REGISTRATIONS_CLOSED', 'CANCELLED'],
  REGISTRATIONS_CLOSED: ['REGISTRATIONS_OPEN', 'IN_OPERATION', 'CANCELLED'],
  IN_OPERATION: ['IN_JUDGING', 'CANCELLED'],
  IN_JUDGING: ['RESULTS_IN_REVIEW', 'IN_OPERATION', 'CANCELLED'],
  RESULTS_IN_REVIEW: ['RESULTS_PUBLISHED', 'IN_JUDGING', 'CANCELLED'],
  // Depois de publicado não se volta atrás por transição de estado: correção de
  // resultado é nova versão auditada, não retrocesso de evento.
  RESULTS_PUBLISHED: ['CLOSED'],
  CLOSED: [],
  CANCELLED: []
});

// Só nestes estados a inscrição é aceita.
const ESTADOS_QUE_ACEITAM_INSCRICAO = Object.freeze(['REGISTRATIONS_OPEN']);

// Estados em que a operação de piso (check-in, pesagem, credencial, palco)
// pode acontecer.
const ESTADOS_OPERACIONAIS = Object.freeze(['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']);

const canTransition = (de, para) => Boolean(TRANSICOES[de]) && TRANSICOES[de].includes(para);

function assertTransition(de, para) {
  if (!EVENT_STATES.includes(para)) {
    throw new AppError(422, 'INVALID_EVENT_STATE', `Estado desconhecido: ${para}`);
  }
  if (de === para) {
    throw new AppError(422, 'INVALID_STATE_TRANSITION', `O evento já está em ${para}`);
  }
  if (!canTransition(de, para)) {
    throw new AppError(422, 'INVALID_STATE_TRANSITION', `Transição não permitida: ${de} → ${para}`);
  }
  return true;
}

const acceptsRegistration = estado => ESTADOS_QUE_ACEITAM_INSCRICAO.includes(estado);
const isOperational = estado => ESTADOS_OPERACIONAIS.includes(estado);
const allowsJudging = estado => estado === 'IN_JUDGING';

module.exports = {
  EVENT_STATES,
  TRANSICOES,
  ESTADOS_QUE_ACEITAM_INSCRICAO,
  ESTADOS_OPERACIONAIS,
  canTransition,
  assertTransition,
  acceptsRegistration,
  isOperational,
  allowsJudging
};
