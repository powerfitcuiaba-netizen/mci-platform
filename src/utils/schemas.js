const { z } = require('zod');

const id = z.string().trim().min(1, 'ID é obrigatório');
const paramsWithId = z.object({ id }).strict();
const date = z.coerce.date().optional();
const tournamentFields = { name: z.string().trim().min(2), description: z.string().trim().optional(), status: z.enum(['PLANNED', 'ACTIVE', 'FINISHED', 'CANCELLED']).optional(), startDate: date, endDate: date };
const validateDates = (value, context) => {
	if (value.startDate && value.endDate && value.endDate < value.startDate) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'Data de término deve ser posterior à data de início' });
};
const tournament = z.object(tournamentFields).strict().superRefine(validateDates);
const tournamentUpdate = z.object(tournamentFields).strict().partial().superRefine(validateDates).refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const participant = z.object({ name: z.string().trim().min(2), identification: z.string().trim().min(1), type: z.enum(['PLAYER', 'TEAM']).optional() }).strict();
const team = participant.extend({ type: z.literal('TEAM').default('TEAM') });
const participantUpdate = participant.partial().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const teamUpdate = z.object({ name: z.string().trim().min(2).optional(), identification: z.string().trim().min(1).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const enrollment = z.object({ participantId: id }).strict();
const match = z.object({ tournamentId: id, participantAId: id, participantBId: id, scheduledAt: date, status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']).optional(), phase: z.string().trim().min(1).optional(), round: z.number().int().positive().optional() }).strict();
const matchUpdate = z.object({ scheduledAt: date, status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']).optional(), phase: z.string().trim().min(1).optional(), round: z.number().int().positive().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const result = z.object({ winnerParticipantId: id.nullable().optional(), scoreA: z.number().int().nonnegative(), scoreB: z.number().int().nonnegative() }).strict();
const judgeAssignment = z.object({ tournamentId: id, judgeId: id }).strict();
const checkIn = z.object({ operatorName: z.string().trim().min(1).optional(), checkedInById: id.optional() }).strict();
const document = z.object({ tournamentId: id, title: z.string().trim().min(2), fileName: z.string().trim().min(1), mimeType: z.string().trim().min(1).default('application/octet-stream') }).strict();
const query = z.object({ tournamentId: id.optional(), type: z.enum(['PLAYER', 'TEAM']).optional() }).strict();

module.exports = { id, paramsWithId, tournament, tournamentUpdate, participant, participantUpdate, team, teamUpdate, enrollment, match, matchUpdate, result, judgeAssignment, checkIn, document, query };