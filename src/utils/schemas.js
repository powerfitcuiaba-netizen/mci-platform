const { z } = require('zod');

const id = z.string().trim().min(1, 'ID é obrigatório');
const paramsWithId = z.object({ id }).strict();
const date = z.coerce.date().optional();
const cents = z.number().int().nonnegative().max(100000000);
const tournamentFields = { name: z.string().trim().min(2), description: z.string().trim().optional(), status: z.enum(['PLANNED', 'ACTIVE', 'FINISHED', 'CANCELLED']).optional(), startDate: date, endDate: date, entryFeeCents: cents.optional() };
const validateDates = (value, context) => {
	if (value.startDate && value.endDate && value.endDate < value.startDate) context.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'Data de término deve ser posterior à data de início' });
};
const tournament = z.object(tournamentFields).strict().superRefine(validateDates);
const tournamentUpdate = z.object(tournamentFields).strict().partial().superRefine(validateDates).refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const participant = z.object({ name: z.string().trim().min(2), identification: z.string().trim().min(1), type: z.enum(['PLAYER', 'TEAM']).optional(), coachId: id.nullable().optional(), teamId: id.nullable().optional() }).strict();
const team = participant.extend({ type: z.literal('TEAM').default('TEAM') });
const participantUpdate = participant.partial().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const teamUpdate = z.object({ name: z.string().trim().min(2).optional(), identification: z.string().trim().min(1).optional(), coachId: id.nullable().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const enrollment = z.object({ participantId: id }).strict();
const match = z.object({ tournamentId: id, participantAId: id, participantBId: id, scheduledAt: date, status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']).optional(), phase: z.string().trim().min(1).optional(), round: z.number().int().positive().optional() }).strict();
const matchUpdate = z.object({ scheduledAt: date, status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED']).optional(), phase: z.string().trim().min(1).optional(), round: z.number().int().positive().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const result = z.object({ winnerParticipantId: id.nullable().optional(), scoreA: z.number().int().nonnegative(), scoreB: z.number().int().nonnegative() }).strict();
const judgeAssignment = z.object({ tournamentId: id, judgeId: id }).strict();
const checkIn = z.object({ operatorName: z.string().trim().min(1).optional(), checkedInById: id.optional() }).strict();
const document = z.object({ tournamentId: id, title: z.string().trim().min(2).max(180), fileName: z.string().trim().min(1).max(255), mimeType: z.string().trim().min(1).max(120).default('application/octet-stream') }).strict();
const query = z.object({ tournamentId: id.optional(), type: z.enum(['PLAYER', 'TEAM']).optional() }).strict();
const searchQuery = z.object({ search: z.string().trim().max(120).optional() }).strict();
const documentQuery = z.object({ tournamentId: id.optional() }).strict();
const coachSetTeam = z.object({ teamId: id.nullable() }).strict();
const profileUpdate = z.object({ name: z.string().trim().min(2).max(120).optional(), email: z.string().trim().email().max(180).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe ao menos um campo para atualizar');
const passwordChange = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'A nova senha deve ter pelo menos 8 caracteres').max(200) }).strict();
const adminUserUpdate = z.object({ role: z.enum(['ADMIN', 'ORGANIZER', 'JUDGE', 'COACH', 'ATHLETE', 'PUBLIC']).optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Informe perfil ou situação para atualizar');
const adminUserQuery = z.object({ role: z.string().trim().optional(), status: z.string().trim().optional(), search: z.string().trim().max(120).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).strict();
const auditQuery = z.object({ entity: z.string().trim().max(60).optional(), entityId: z.string().trim().max(60).optional(), userId: z.string().trim().max(60).optional(), action: z.string().trim().max(60).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).strict();
const notificationQuery = z.object({ onlyUnread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().positive().max(200).optional() }).strict();
const enrollmentQuery = z.object({ incluirCanceladas: z.enum(['true', 'false']).optional() }).strict();
// O corpo do pedido diz o QUE se quer comprar. Preço, desconto e total são
// calculados no servidor e por isso não têm campo aqui: schema estrito rejeita
// qualquer tentativa de enviá-los.
const orderCreate = z.object({ tournamentId: id, participantId: id, couponCode: z.string().trim().min(1).max(60).optional(), idempotencyKey: z.string().trim().min(8).max(120).optional() }).strict();
const orderQuery = z.object({ status: z.enum(['PENDING', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED']).optional(), tournamentId: id.optional() }).strict();
const paymentStart = z.object({ provider: z.string().trim().min(1).max(40).optional(), idempotencyKey: z.string().trim().min(8).max(120).optional() }).strict();
const couponCreate = z.object({ code: z.string().trim().min(3).max(60), description: z.string().trim().max(180).optional(), percentOff: z.number().int().min(1).max(100).optional(), amountOffCents: cents.optional(), tournamentId: id.optional(), active: z.boolean().optional(), startsAt: date, endsAt: date, maxRedemptions: z.number().int().positive().max(1000000).optional(), maxPerUser: z.number().int().positive().max(100).optional() }).strict();
const couponToggle = z.object({ active: z.boolean() }).strict();
const couponPreview = z.object({ code: z.string().trim().min(1).max(60), tournamentId: id }).strict();
const refundRequest = z.object({ amountCents: cents.optional(), reason: z.string().trim().max(300).optional() }).strict();
const refundQuery = z.object({ orderId: id.optional() }).strict();
const sponsorCreate = z.object({ name: z.string().trim().min(2).max(160), document: z.string().trim().max(40).optional(), contactEmail: z.string().trim().email().max(180).optional(), active: z.boolean().optional() }).strict();
const sponsorshipCreate = z.object({ sponsorId: id, tournamentId: id, status: z.enum(['ACTIVE', 'ENDED', 'CANCELLED']).optional(), amountCents: cents.optional(), startsAt: date, endsAt: date, notes: z.string().trim().max(500).optional() }).strict();
const sponsorshipQuery = z.object({ tournamentId: id.optional() }).strict();
const webhookParams = z.object({ provider: z.string().trim().min(1).max(40) }).strict();

const documentUpload = z.object({ tournamentId: id, title: z.string().trim().min(2).max(180).optional(), fileName: z.string().trim().min(1).max(255).optional() }).strict();

module.exports = { id, paramsWithId, tournament, tournamentUpdate, participant, participantUpdate, team, teamUpdate, enrollment, match, matchUpdate, result, judgeAssignment, checkIn, document, query, searchQuery, documentQuery, coachSetTeam, profileUpdate, passwordChange, adminUserUpdate, adminUserQuery, auditQuery, notificationQuery, enrollmentQuery, documentUpload, orderCreate, orderQuery, paymentStart, couponCreate, couponToggle, couponPreview, refundRequest, refundQuery, sponsorCreate, sponsorshipCreate, sponsorshipQuery, webhookParams };