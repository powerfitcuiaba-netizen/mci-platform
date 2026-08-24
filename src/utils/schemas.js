const { z } = require('zod');

const id = z.string().min(1, 'ID é obrigatório');
const date = z.coerce.date().optional();
const tournament = z.object({ name: z.string().trim().min(2), description: z.string().trim().optional(), status: z.enum(['PLANNED', 'ACTIVE', 'FINISHED', 'CANCELLED']).optional(), startDate: date, endDate: date }).strict();
const participant = z.object({ name: z.string().trim().min(2), identification: z.string().trim().min(1), type: z.enum(['PLAYER', 'TEAM']).optional() }).strict();
const team = participant.extend({ type: z.literal('TEAM').default('TEAM') });
const enrollment = z.object({ participantId: id }).strict();
const match = z.object({ tournamentId: id, participantAId: id, participantBId: id, scheduledAt: date, status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']).optional(), phase: z.string().trim().min(1).optional(), round: z.number().int().positive().optional() }).strict();
const result = z.object({ winnerParticipantId: id.nullable().optional(), scoreA: z.number().int().nonnegative(), scoreB: z.number().int().nonnegative() }).strict();

module.exports = { id, tournament, participant, team, enrollment, match, result };