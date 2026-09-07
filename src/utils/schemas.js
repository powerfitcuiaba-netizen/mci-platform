const { z } = require('zod');
const { USER_ROLES, PAPEIS_DE_CADASTRO_ABERTO } = require('./roles');
const { EVENT_STATES } = require('./eventStates');
const { TIE_BREAKERS, METHODS } = require('./tabulation');

// Validação de entrada. Tudo o que entra na API passa por aqui antes de chegar
// a um service: o service confia no formato e cuida da regra de negócio.

const id = z.string().min(1).max(60);
const texto = (min, max) => z.string().trim().min(min).max(max);
const opcional = schema => schema.optional().nullable();
const dataIso = z.coerce.date();

// Booleano vindo de formulário ou querystring chega como TEXTO, e `z.coerce
// .boolean()` aplica `Boolean(...)`: a string 'false' vira `true`, e com ela um
// documento marcado como privado era gravado como público. Aqui a palavra vale
// o que ela diz — só o texto afirmativo é verdadeiro.
const NEGATIVOS = new Set(['false', '0', 'no', 'nao', 'não', 'off', '']);
const booleano = z.preprocess(valor => {
  if (typeof valor !== 'string') return valor;
  const limpo = valor.trim().toLowerCase();
  if (NEGATIVOS.has(limpo)) return false;
  if (['true', '1', 'yes', 'sim', 'on'].includes(limpo)) return true;
  return valor;
}, z.boolean());

const paginacao = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(60).optional()
});

const paramsWithId = z.object({ id });

// ---------------------------------------------------------------- autenticação
const authRegister = z.object({
  name: texto(2, 120),
  email: z.string().trim().toLowerCase().email().max(180),
  password: z.string().min(8).max(200),
  // O cadastro aberto só cria papéis sem poder operacional. Papel privilegiado
  // é concessão administrativa, nunca autoatribuição.
  role: z.enum(PAPEIS_DE_CADASTRO_ABERTO).optional()
});

const authLogin = z.object({
  email: z.string().trim().toLowerCase().email().max(180),
  password: z.string().min(8).max(200)
});

const profileUpdate = z.object({
  name: texto(2, 120).optional(),
  email: z.string().trim().toLowerCase().email().max(180).optional()
}).refine(data => Object.keys(data).length > 0, { message: 'Informe ao menos um campo' });

const passwordChange = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(8).max(200)
});

// ---------------------------------------------------------------- organizações
const organizationCreate = z.object({
  name: texto(2, 140),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/, 'Slug deve conter apenas letras minúsculas, números e hífen'),
  timezone: texto(3, 60).optional()
});

const organizationMemberCreate = z.object({
  userId: id,
  role: z.enum(USER_ROLES)
});

// ------------------------------------------------------------------ filiação
const affiliationCreate = z.object({
  organizationId: id,
  name: texto(2, 140),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,30}$/),
  kind: z.enum(['FEDERATION', 'ENTITY', 'ASSOCIATION', 'TEAM', 'OTHER']).optional(),
  state: opcional(texto(2, 2))
});

// ------------------------------------------------------------------- atletas
const athleteCreate = z.object({
  organizationId: id,
  fullName: texto(2, 160),
  stageName: opcional(texto(1, 80)),
  cpf: z.string().trim().min(11).max(14),
  birthDate: opcional(dataIso),
  sex: z.enum(['MALE', 'FEMALE']),
  country: texto(2, 3).optional(),
  state: opcional(texto(2, 2)),
  city: opcional(texto(2, 90)),
  phone: opcional(texto(8, 20)),
  email: opcional(z.string().trim().toLowerCase().email().max(180)),
  athleteNumber: opcional(texto(1, 20)),
  affiliationId: opcional(id),
  teamId: opcional(id),
  coachId: opcional(id),
  gymId: opcional(id),
  userId: opcional(id)
});

// `teamId` NÃO entra aqui de propósito. O vínculo com equipe tem trava de
// unicidade e histórico, e é governado por /athletes/:id/team — deixá-lo no
// update genérico seria o contorno mais óbvio da trava.
// `teamId` é recusado com mensagem, não descartado em silêncio: quem tentar
// trocar a equipe por aqui precisa saber que a operação existe noutro lugar e
// exige outra permissão. Omitir o campo faria a requisição responder 200 sem
// ter mudado nada — a pior resposta possível para uma trava.
const athleteUpdate = athleteCreate.partial().omit({ organizationId: true, cpf: true, teamId: true }).extend({
  teamId: z.never({
    error: 'A equipe do atleta não muda por edição de perfil. Use POST /athletes/:id/team para vincular '
      + 'um atleta sem equipe, ou POST /athletes/:id/team/transfer, que exige o operador da Muscle Contest.'
  }).optional()
});

const athleteTeamLink = z.object({ teamId: id, reason: opcional(texto(3, 300)) });
const athleteTeamTransfer = z.object({ teamId: id, reason: texto(3, 300) });
const athleteTeamUnlink = z.object({ reason: texto(3, 300) });

const athleteQuery = paginacao.extend({
  organizationId: id.optional(),
  search: z.string().trim().max(120).optional(),
  proStatus: z.enum(['NONE', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED']).optional(),
  affiliationId: id.optional(),
  teamId: id.optional()
});

const athleteLookup = z.object({
  organizationId: id,
  cpf: z.string().trim().min(11).max(14)
});

const proStatusUpdate = z.object({
  status: z.enum(['NONE', 'ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED']),
  reason: texto(3, 300),
  eventId: opcional(id),
  title: opcional(texto(2, 140))
});

// -------------------------------------------------------------------- eventos
const eventCreate = z.object({
  organizationId: id,
  name: texto(3, 160),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,80}$/),
  description: opcional(texto(1, 4000)),
  timezone: texto(3, 60).optional(),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
  venue: opcional(texto(2, 160)),
  city: opcional(texto(2, 90)),
  state: opcional(texto(2, 2)),
  seasonId: opcional(id),
  scoringRuleSetId: opcional(id)
}).refine(data => !data.startDate || !data.endDate || data.endDate >= data.startDate, {
  message: 'A data final não pode ser anterior à inicial', path: ['endDate']
});

const eventUpdate = z.object({
  name: texto(3, 160).optional(),
  description: opcional(texto(1, 4000)),
  timezone: texto(3, 60).optional(),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
  venue: opcional(texto(2, 160)),
  city: opcional(texto(2, 90)),
  state: opcional(texto(2, 2)),
  seasonId: opcional(id),
  scoringRuleSetId: opcional(id)
});

const eventTransition = z.object({ status: z.enum(EVENT_STATES), reason: opcional(texto(3, 300)) });

const eventQuery = paginacao.extend({
  organizationId: id.optional(),
  status: z.enum(EVENT_STATES).optional(),
  search: z.string().trim().max(120).optional()
});

// --------------------------------------------- categorias, divisões e classes
const categoryCreate = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/),
  name: texto(2, 90),
  sex: z.enum(['MALE', 'FEMALE']),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

const eventCategoryCreate = z.object({ categoryId: id, sortOrder: z.coerce.number().int().min(0).max(999).optional() });

const divisionCreate = z.object({
  name: texto(1, 90),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

const classCreate = z.object({
  name: texto(1, 90),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/),
  minAge: opcional(z.coerce.number().int().min(0).max(120)),
  maxAge: opcional(z.coerce.number().int().min(0).max(120)),
  minWeightGrams: opcional(z.coerce.number().int().min(0).max(500000)),
  maxWeightGrams: opcional(z.coerce.number().int().min(0).max(500000)),
  minHeightCm: opcional(z.coerce.number().int().min(0).max(300)),
  maxHeightCm: opcional(z.coerce.number().int().min(0).max(300)),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
  superOverallEligible: booleano.optional(),
  active: booleano.optional()
}).refine(d => d.minAge == null || d.maxAge == null || d.maxAge >= d.minAge, { message: 'Idade máxima menor que a mínima', path: ['maxAge'] })
  .refine(d => d.minWeightGrams == null || d.maxWeightGrams == null || d.maxWeightGrams >= d.minWeightGrams, { message: 'Peso máximo menor que o mínimo', path: ['maxWeightGrams'] });

// ------------------------------------------------------------------ inscrição
const registrationCreate = z.object({
  cpf: z.string().trim().min(11).max(14),
  // Quando o CPF ainda não existe, estes campos criam o perfil do atleta.
  athlete: athleteCreate.omit({ organizationId: true, cpf: true }).partial().optional(),
  affiliationId: opcional(id),
  classIds: z.array(id).min(1).max(10),
  notes: opcional(texto(1, 500))
});

const registrationCancel = z.object({ reason: texto(3, 300) });

const registrationQuery = paginacao.extend({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REJECTED']).optional(),
  classId: id.optional(),
  search: z.string().trim().max(120).optional()
});

// ---------------------------------------------------------------- check-in
const checkInCreate = z.object({ device: opcional(texto(1, 120)) });

const weighInCreate = z.object({
  weightGrams: z.coerce.number().int().min(20000).max(400000),
  heightCm: opcional(z.coerce.number().int().min(100).max(260)),
  device: opcional(texto(1, 120)),
  notes: opcional(texto(1, 300))
});

const credentialCreate = z.object({
  type: z.enum(['ATHLETE', 'COACH', 'STAFF', 'JUDGE', 'MEDIA', 'PHOTOGRAPHER', 'SPONSOR', 'GUEST']),
  holderName: texto(2, 140),
  registrationId: opcional(id)
});

const credentialScan = z.object({ code: texto(4, 80), gate: opcional(texto(1, 60)) });

// ------------------------------------------------------------------- palco
const batchCreate = z.object({
  classId: id,
  name: texto(1, 90),
  scheduledAt: opcional(dataIso),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional()
});

const batchStatusUpdate = z.object({ status: z.enum(['SCHEDULED', 'CALLED', 'ON_STAGE', 'DONE', 'CANCELLED']) });

const stageOrderSet = z.object({
  items: z.array(z.object({ registrationItemId: id, position: z.coerce.number().int().min(1).max(999) })).min(1).max(200)
});

// -------------------------------------------------------------- julgamento
const panelCreate = z.object({ name: texto(1, 90) });

const panelJudgeAdd = z.object({
  judgeId: id,
  seat: z.coerce.number().int().min(1).max(20),
  role: z.enum(['HEAD', 'JUDGE']).optional()
});

const sessionCreate = z.object({
  classId: id,
  panelId: id,
  batchId: opcional(id),
  round: z.enum(['PREJUDGING', 'COMPARISON', 'FINALS']).optional()
});

const scoreSubmit = z.object({
  placings: z.array(z.object({
    registrationItemId: id,
    placing: z.coerce.number().int().min(1).max(200),
    notes: opcional(texto(1, 300)),
    criteria: z.array(z.object({ criterionId: id, value: z.coerce.number().int().min(0).max(100) })).max(20).optional()
  })).min(1).max(200)
});

// -------------------------------------------------------------- resultados
const resultPublish = z.object({ reason: opcional(texto(3, 300)) });

const resultOverride = z.object({
  reason: texto(5, 400),
  entries: z.array(z.object({
    registrationItemId: id,
    placing: opcional(z.coerce.number().int().min(1).max(200)),
    status: z.enum(['RANKED', 'TIE_UNRESOLVED', 'DISQUALIFIED', 'ABSENT'])
  })).min(1).max(200)
});

const scoringRuleSetCreate = z.object({
  name: texto(2, 90),
  method: z.enum(METHODS).optional(),
  dropHighLow: z.boolean().optional(),
  dropHighLowMinJudges: z.coerce.number().int().min(3).max(20).optional(),
  tieBreakers: z.array(z.enum(TIE_BREAKERS)).max(TIE_BREAKERS.length).optional()
});

// ---------------------------------------------------------------- temporadas
const seasonCreate = z.object({
  organizationId: id,
  name: texto(2, 90),
  year: z.coerce.number().int().min(2000).max(2100),
  startDate: opcional(dataIso),
  endDate: opcional(dataIso),
  scoringRuleSetId: opcional(id)
});

const pointsRuleSet = z.object({
  rules: z.array(z.object({
    placing: z.coerce.number().int().min(1).max(200),
    points: z.coerce.number().int().min(0).max(100000)
  })).min(1).max(200)
});

const classCatalogUpsert = z.object({
  organizationId: id,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,40}$/),
  name: opcional(texto(1, 90)),
  // REGRA HOMOLOGADA: só as classes marcadas alimentam o Super Overall anual.
  superOverallEligible: booleano.optional(),
  active: booleano.optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional()
});

const superOverallQuery = z.object({
  seasonId: id.optional(),
  categoryId: id.optional(),
  organizationId: id.optional()
});

const overallDeclare = z.object({
  athleteId: id,
  categoryId: id.optional(),
  note: opcional(texto(1, 300))
});

const teamRankingQuery = z.object({
  seasonId: id.optional(),
  categoryId: id.optional(),
  organizationId: id.optional()
});

const rankingQuery = paginacao.extend({
  seasonId: id.optional(),
  categoryId: id.optional(),
  state: z.string().trim().length(2).optional(),
  country: z.string().trim().min(2).max(3).optional()
});

// Recortes derivados de RankingPoint: classe, evento e divisão. Exatamente um
// deles por consulta — combinar dois responderia a uma pergunta que ninguém
// fez, e a interseção vazia pareceria "ninguém pontuou".
const rankingCutQuery = z.object({
  seasonId: id,
  categoryId: id.optional(),
  classId: id.optional(),
  eventId: id.optional(),
  divisionId: id.optional()
}).refine(
  d => [d.classId, d.eventId, d.divisionId].filter(Boolean).length === 1,
  { message: 'Informe exatamente um recorte: classId, eventId ou divisionId' }
);

// ----------------------------------------------------------------- MuscleWar
const muscleWarImportCreate = z.object({
  organizationId: id,
  seasonId: opcional(id),
  eventId: opcional(id),
  sourceType: z.enum(['CSV', 'JSON', 'API']),
  sourceRef: texto(1, 200),
  // O conteúdo bruto: texto CSV, JSON serializado ou corpo devolvido pela API.
  content: z.string().min(1).max(5_000_000),
  fieldMap: z.record(z.string(), z.string()).optional()
});

const muscleWarLink = z.object({ athleteId: id });

// -------------------------------------------------------- equipes e parceiros
const teamCreate = z.object({
  organizationId: id, name: texto(2, 120),
  // Empresa que inscreve a equipe. Opcional: equipe sem empresa compete
  // normalmente, apenas não pontua para nenhuma.
  companyId: opcional(id),
  city: opcional(texto(2, 90)), state: opcional(texto(2, 2))
});
const companyCreate = z.object({ organizationId: id, name: texto(2, 120), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });
const coachCreate = z.object({ name: texto(2, 120), userId: opcional(id), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });
const gymCreate = z.object({ organizationId: id, name: texto(2, 120), city: opcional(texto(2, 90)), state: opcional(texto(2, 2)) });

const brandCreate = z.object({
  organizationId: id,
  name: texto(2, 120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,60}$/),
  website: opcional(z.string().trim().url().max(300))
});

const sponsorCreate = z.object({
  organizationId: id,
  name: texto(2, 120),
  brandId: opcional(id),
  contactEmail: opcional(z.string().trim().toLowerCase().email().max(180))
});

const sponsorshipCreate = z.object({
  sponsorId: id,
  eventId: opcional(id),
  teamId: opcional(id),
  athleteId: opcional(id),
  scope: opcional(texto(2, 300)),
  startsAt: opcional(dataIso),
  endsAt: opcional(dataIso)
}).refine(d => Boolean(d.eventId || d.teamId || d.athleteId), { message: 'Informe evento, equipe ou atleta' });

const partnershipCreate = z.object({
  athleteId: id,
  brandId: id,
  scope: opcional(texto(2, 300)),
  startedAt: opcional(dataIso)
});

const partnershipStatus = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'ENDED']) });

// --------------------------------------------------------------------- social
const profileCreate = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, 'Handle inválido'),
  displayName: texto(2, 80),
  kind: z.enum(['ATHLETE', 'COACH', 'GYM', 'TEAM', 'BRAND', 'SPONSOR', 'FAN', 'MEDIA']).optional(),
  bio: opcional(texto(1, 500)),
  isPrivate: z.boolean().optional()
});

const profileUpdateSocial = profileCreate.partial().omit({ handle: true });

const postCreate = z.object({
  content: texto(1, 5000),
  visibility: z.enum(['PUBLIC', 'FOLLOWERS', 'PRIVATE']).optional(),
  eventId: opcional(id),
  communityId: opcional(id)
});

const commentCreate = z.object({ content: texto(1, 2000), parentId: opcional(id) });
const shareCreate = z.object({ comment: opcional(texto(1, 500)) });
const storyCaption = z.object({ caption: opcional(texto(1, 200)) });

const feedQuery = paginacao.extend({
  scope: z.enum(['FOLLOWING', 'DISCOVER', 'EVENT', 'COMMUNITY', 'PROFILE']).default('FOLLOWING'),
  eventId: id.optional(),
  communityId: id.optional(),
  profileId: id.optional()
});

const reportCreate = z.object({
  targetType: z.enum(['POST', 'COMMENT', 'PROFILE', 'MESSAGE']),
  targetId: id,
  reason: texto(3, 500)
});

const reportResolve = z.object({
  status: z.enum(['REVIEWING', 'RESOLVED', 'DISMISSED']),
  resolution: opcional(texto(3, 500)),
  removeContent: z.boolean().optional()
});

// ----------------------------------------------------------------- comunidades
const communityCreate = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,60}$/),
  name: texto(2, 90),
  description: opcional(texto(1, 1000)),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  rules: opcional(texto(1, 4000))
});

// ------------------------------------------------------------------ messenger
const conversationCreate = z.object({
  kind: z.enum(['DIRECT', 'GROUP']).default('DIRECT'),
  title: opcional(texto(1, 90)),
  participantIds: z.array(id).min(1).max(50)
});

const messageCreate = z.object({
  body: opcional(texto(1, 4000)),
  sharedPostId: opcional(id),
  sharedProfileId: opcional(id),
  replyToId: opcional(id)
}).refine(d => Boolean(d.body || d.sharedPostId || d.sharedProfileId), { message: 'Mensagem vazia' });

const reactionCreate = z.object({ emoji: z.string().trim().min(1).max(16) });

const conversationMembers = z.object({ participantIds: z.array(id).min(1).max(50) });

// -------------------------------------------------------------------- busca
const searchQuery = z.object({
  q: z.string().trim().min(2).max(120),
  types: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

// ------------------------------------------------------------- notificações
const notificationQuery = z.object({
  onlyUnread: booleano.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

// ---------------------------------------------------------------- auditoria
const auditQuery = z.object({
  entity: z.string().trim().max(60).optional(),
  entityId: id.optional(),
  userId: id.optional(),
  action: z.string().trim().max(60).optional(),
  organizationId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

// ---------------------------------------------------------------- documentos
const documentUpload = z.object({
  title: z.string().trim().max(160).optional(),
  kind: z.enum(['ID', 'MEDICAL', 'TERM', 'AFFILIATION_PROOF', 'OTHER']).optional()
});

const eventDocumentUpload = z.object({
  title: z.string().trim().max(160).optional(),
  isPublic: booleano.optional()
});

// --------------------------------------------------------------- usuários
const adminUserUpdate = z.object({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional()
}).refine(data => Object.keys(data).length > 0, { message: 'Informe ao menos um campo' });

const adminUserQuery = paginacao.extend({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISABLED']).optional(),
  search: z.string().trim().max(120).optional()
});

// Listagem simples com busca e escopo de organização, usada por filiações,
// equipes, academias, coaches, marcas e patrocinadores.
const scopedListQuery = paginacao.extend({
  organizationId: id.optional(),
  search: z.string().trim().max(120).optional()
});

const checkInQuery = paginacao.extend({
  search: z.string().trim().max(120).optional()
});

const sponsorshipQuery = paginacao.extend({
  organizationId: id.optional(),
  sponsorId: id.optional(),
  eventId: id.optional(),
  teamId: id.optional(),
  athleteId: id.optional()
});

const partnershipQuery = paginacao.extend({
  athleteId: id.optional(),
  brandId: id.optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'ENDED']).optional()
});

const importQuery = paginacao.extend({ organizationId: id.optional() });

const reportQuery = paginacao.extend({ status: z.enum(['OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED']).optional() });

const rankingPointsQuery = z.object({ seasonId: id.optional() });

const communityMemberAdd = z.object({ profileId: id, role: z.enum(['MEMBER', 'ADMIN']).optional() });

const handleUpdate = z.object({ handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_.]{3,30}$/, 'Handle inválido') });

const rejectImport = z.object({ reason: opcional(texto(3, 300)) });

module.exports = {
  paginacao, paramsWithId, scopedListQuery, checkInQuery, sponsorshipQuery, partnershipQuery,
  importQuery, reportQuery, rankingPointsQuery, communityMemberAdd, handleUpdate, rejectImport,
  authRegister, authLogin, profileUpdate, passwordChange,
  organizationCreate, organizationMemberCreate,
  affiliationCreate,
  athleteCreate, athleteUpdate, athleteTeamLink, athleteTeamTransfer, athleteTeamUnlink, athleteQuery, athleteLookup, proStatusUpdate,
  eventCreate, eventUpdate, eventTransition, eventQuery,
  categoryCreate, eventCategoryCreate, divisionCreate, classCreate,
  registrationCreate, registrationCancel, registrationQuery,
  checkInCreate, weighInCreate, credentialCreate, credentialScan,
  batchCreate, batchStatusUpdate, stageOrderSet,
  panelCreate, panelJudgeAdd, sessionCreate, scoreSubmit,
  resultPublish, resultOverride, scoringRuleSetCreate,
  seasonCreate, pointsRuleSet, rankingQuery, rankingCutQuery, overallDeclare, teamRankingQuery,
  classCatalogUpsert, superOverallQuery,
  muscleWarImportCreate, muscleWarLink,
  teamCreate, companyCreate, coachCreate, gymCreate, brandCreate, sponsorCreate, sponsorshipCreate,
  partnershipCreate, partnershipStatus,
  profileCreate, profileUpdateSocial, postCreate, commentCreate, shareCreate, storyCaption, feedQuery,
  reportCreate, reportResolve,
  communityCreate,
  conversationCreate, messageCreate, reactionCreate, conversationMembers,
  searchQuery, notificationQuery, auditQuery,
  documentUpload, eventDocumentUpload,
  adminUserUpdate, adminUserQuery
};
