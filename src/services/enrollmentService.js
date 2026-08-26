const enrollmentRepository = require('../repositories/enrollmentRepository');
const tournamentRepository = require('../repositories/tournamentRepository');
const participantRepository = require('../repositories/participantRepository');
const prisma = require('../config/prisma');
const notificationService = require('./notificationService');
const auditService = require('./auditService');
const { AppError } = require('../utils/errors');

const CONFIRMADA = 'CONFIRMED';
const CANCELADA = 'CANCELLED';

// A rota admite ADMIN, ORGANIZER e COACH. Cada um por um motivo diferente:
// o organizador por ser dono do campeonato, o técnico por ser dono do atleta.
async function assertCanEnroll(tournament, participant, actor) {
  if (!actor) throw new AppError(401, 'UNAUTHORIZED', 'Autenticação obrigatória');
  if (actor.role === 'ADMIN') return;
  if (tournament.createdById === actor.id) return;
  if (actor.role === 'COACH' && participant.coachId === actor.id) return;
  throw new AppError(403, 'FORBIDDEN', 'Você não pode alterar inscrições deste campeonato');
}

async function enroll(tournamentId, participantId, actor) {
  const tournament = await tournamentRepository.findById(tournamentId);
  if (!tournament) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', 'Campeonato não encontrado');

  const participant = await participantRepository.findById(participantId);
  if (!participant) throw new AppError(404, 'PARTICIPANT_NOT_FOUND', 'Participante não encontrado');

  await assertCanEnroll(tournament, participant, actor);

  const existente = await enrollmentRepository.exists(tournamentId, participantId);
  if (existente && existente.status !== CANCELADA) {
    throw new AppError(409, 'ENROLLMENT_ALREADY_EXISTS', 'Participante já inscrito neste campeonato');
  }

  // Uma inscrição cancelada pode ser refeita. O par (campeonato, participante) é
  // único, então reativamos a linha em vez de criar outra — o histórico de
  // cancelamento é limpo para não confundir a leitura do estado atual.
  const enrollment = existente
    ? await prisma.enrollment.update({
        where: { id: existente.id },
        data: { status: CONFIRMADA, cancelledAt: null, cancelledById: null },
        include: { participant: true }
      })
    : await enrollmentRepository.create({ tournamentId, participantId });

  await notificationService.notifyEnrollment(tournamentId, participantId, actor?.id);
  await auditService.record({
    actor, action: existente ? 'ENROLLMENT_REACTIVATE' : 'ENROLLMENT_CREATE',
    entity: 'Enrollment', entityId: enrollment.id,
    metadata: { tournamentId, participantId }
  });

  return enrollment;
}

// Cancelamento é transição de estado, nunca exclusão física: o histórico da
// competição precisa continuar auditável depois da baixa.
async function cancel(enrollmentId, actor) {
  const enrollment = await prisma.enrollment.findUnique({
    where: { id: enrollmentId },
    include: { tournament: true, participant: true }
  });
  if (!enrollment) throw new AppError(404, 'ENROLLMENT_NOT_FOUND', 'Inscrição não encontrada');

  await assertCanEnroll(enrollment.tournament, enrollment.participant, actor);

  if (enrollment.status === CANCELADA) {
    throw new AppError(409, 'ENROLLMENT_ALREADY_CANCELLED', 'Esta inscrição já está cancelada');
  }

  // Quem já entrou em quadra não sai da tabela por uma baixa administrativa.
  const partidas = await prisma.match.count({
    where: {
      tournamentId: enrollment.tournamentId,
      OR: [{ participantAId: enrollment.participantId }, { participantBId: enrollment.participantId }],
      result: { isNot: null }
    }
  });
  if (partidas > 0) {
    throw new AppError(422, 'ENROLLMENT_HAS_RESULTS', 'Não é possível cancelar: o participante já possui resultado registrado');
  }

  const atualizada = await prisma.enrollment.update({
    where: { id: enrollmentId },
    data: { status: CANCELADA, cancelledAt: new Date(), cancelledById: actor.id },
    include: { participant: true, tournament: { select: { id: true, name: true } } }
  });

  await notificationService.notifyEnrollmentCancelled(enrollmentId, actor.id);
  await auditService.record({
    actor, action: 'ENROLLMENT_CANCEL', entity: 'Enrollment', entityId: enrollmentId,
    metadata: { tournamentId: enrollment.tournamentId, participantId: enrollment.participantId }
  });

  return atualizada;
}

// Por padrão a listagem devolve apenas quem está de fato na competição.
// A visão administrativa pede o histórico completo com `incluirCanceladas`.
async function list(tournamentId, { incluirCanceladas = false } = {}) {
  return prisma.enrollment.findMany({
    where: { tournamentId, ...(incluirCanceladas ? {} : { status: CONFIRMADA }) },
    include: { participant: true },
    orderBy: { createdAt: 'asc' }
  });
}

module.exports = { enroll, cancel, list, CONFIRMADA, CANCELADA };
