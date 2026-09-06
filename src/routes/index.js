const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const { optionalAuth, requireAuth, requirePermission } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');
const { singleFileUpload } = require('../middlewares/upload');
const storage = require('../services/storageService');
const s = require('../utils/schemas');
const c = require('../controllers');

const router = express.Router();
const wrap = asyncHandler;

// Autorização por permissão nomeada. O tenant vem de onde a rota o conhece;
// quando o recurso é carregado pelo id, quem confere é o service — a barreira
// de tenant está lá, junto do dado.
const perm = (permission, from = null) => requirePermission(permission, from);
const orgDoCorpo = req => req.body?.organizationId ?? null;
const orgDaQuery = req => req.query?.organizationId ?? null;

const limiteAutenticacao = rateLimit({ windowMs: 15 * 60_000, max: 10, nome: 'auth' });
const limitePublico = rateLimit({ windowMs: 60_000, max: 180, nome: 'public' });
const limiteUpload = rateLimit({ windowMs: 60_000, max: 30, nome: 'upload' });
const limiteBusca = rateLimit({ windowMs: 60_000, max: 120, nome: 'search' });
// A importação lê e valida arquivo inteiro: é a rota mais cara da API.
const limiteImportacao = rateLimit({ windowMs: 60_000, max: 10, nome: 'import' });

const uploadDocumento = singleFileUpload('file');
const uploadMidia = singleFileUpload('file', { maxBytes: storage.MAX_MEDIA_BYTES, tipo: 'midia' });

// ============================================================ AUTENTICAÇÃO
router.post('/auth/register', limiteAutenticacao, validate(s.authRegister), wrap(c.auth.register));
router.post('/auth/login', limiteAutenticacao, validate(s.authLogin), wrap(c.auth.login));
router.get('/auth/me', requireAuth, wrap(c.auth.me));

router.get('/profile', requireAuth, wrap(c.auth.me));
router.patch('/profile', requireAuth, validate(s.profileUpdate), wrap(c.auth.updateProfile));
router.post('/profile/password', requireAuth, limiteAutenticacao, validate(s.passwordChange), wrap(c.auth.changePassword));

// ============================================================= ORGANIZAÇÕES
router.route('/organizations')
  .get(requireAuth, wrap(c.organizations.list))
  .post(requireAuth, perm('organizations.manage'), validate(s.organizationCreate), wrap(c.organizations.create));
router.get('/organizations/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.organizations.findById));
router.post('/organizations/:id/members', requireAuth, validate(s.paramsWithId, 'params'), validate(s.organizationMemberCreate), wrap(c.organizations.addMember));
router.delete('/organizations/:id/members/:membershipId', requireAuth, wrap(c.organizations.removeMember));

// ================================================================= FILIAÇÃO
router.route('/affiliations')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.affiliations.list))
  .post(requireAuth, perm('affiliations.manage', orgDoCorpo), validate(s.affiliationCreate), wrap(c.affiliations.create));
router.post('/affiliations/:id/activate', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.affiliations.activate));
router.post('/affiliations/:id/deactivate', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.affiliations.deactivate));

// =================================================================== ATLETAS
router.route('/athletes')
  .get(requireAuth, validate(s.athleteQuery, 'query'), wrap(c.athletes.list))
  .post(requireAuth, perm('athletes.create', orgDoCorpo), validate(s.athleteCreate), wrap(c.athletes.create));
router.post('/athletes/lookup', requireAuth, perm('athletes.read_sensitive', orgDoCorpo), validate(s.athleteLookup), wrap(c.athletes.lookup));
router.get('/athletes/pro', requireAuth, perm('pro.read'), validate(s.athleteQuery, 'query'), wrap(c.athletes.listPro));
router.route('/athletes/:id')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.athletes.findById))
  .patch(requireAuth, validate(s.paramsWithId, 'params'), validate(s.athleteUpdate), wrap(c.athletes.update));
router.post('/athletes/:id/pro-status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.proStatusUpdate), wrap(c.athletes.setProStatus));

router.route('/athletes/:id/documents')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.listAthlete))
  .post(requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadDocumento, validate(s.documentUpload), wrap(c.documents.uploadAthlete));
router.get('/documents/athlete/:id/download', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.downloadAthlete));
router.delete('/documents/athlete/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.deleteAthlete));

// ==================================================== CATÁLOGO DE CATEGORIAS
router.route('/categories')
  .get(optionalAuth, wrap(c.events.listCategories))
  .post(requireAuth, perm('categories.manage'), validate(s.categoryCreate), wrap(c.events.createCategory));

// =================================================================== EVENTOS
router.route('/events')
  .get(optionalAuth, validate(s.eventQuery, 'query'), wrap(c.events.list))
  .post(requireAuth, perm('events.create', orgDoCorpo), validate(s.eventCreate), wrap(c.events.create));
router.route('/events/:id')
  .get(optionalAuth, wrap(c.events.findOne))
  .patch(requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventUpdate), wrap(c.events.update))
  .delete(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.events.remove));
router.post('/events/:id/transition', requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventTransition), wrap(c.events.transition));
router.post('/events/:id/categories', requireAuth, validate(s.paramsWithId, 'params'), validate(s.eventCategoryCreate), wrap(c.events.addCategory));
router.post('/event-categories/:eventCategoryId/divisions', requireAuth, validate(s.divisionCreate), wrap(c.events.addDivision));
router.post('/divisions/:divisionId/classes', requireAuth, validate(s.classCreate), wrap(c.events.addClass));

router.route('/events/:id/documents')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.listEvent))
  .post(requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadDocumento, validate(s.eventDocumentUpload), wrap(c.documents.uploadEvent));
router.get('/documents/event/:id/download', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.downloadEvent));

// ================================================================ INSCRIÇÕES
router.route('/events/:id/registrations')
  .get(requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationQuery, 'query'), wrap(c.registrations.listByEvent))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationCreate), wrap(c.registrations.create));
router.get('/registrations/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.registrations.findById));
router.post('/registrations/:id/cancel', requireAuth, validate(s.paramsWithId, 'params'), validate(s.registrationCancel), wrap(c.registrations.cancel));

// ============================================================ OPERAÇÃO DE PISO
router.get('/events/:id/checkins', requireAuth, validate(s.paramsWithId, 'params'), validate(s.checkInQuery, 'query'), wrap(c.operations.listCheckIns));
router.post('/registrations/:id/checkin', requireAuth, validate(s.paramsWithId, 'params'), validate(s.checkInCreate), wrap(c.operations.checkIn));
router.post('/registrations/:id/checkin/cancel', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.cancelCheckIn));

router.route('/registrations/:id/weighins')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listWeighIns))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.weighInCreate), wrap(c.operations.weighIn));

router.route('/events/:id/credentials')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listCredentials))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.credentialCreate), wrap(c.operations.issueCredential));
router.post('/events/:id/credentials/scan', requireAuth, validate(s.paramsWithId, 'params'), validate(s.credentialScan), wrap(c.operations.scanCredential));
router.post('/credentials/:id/revoke', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.revokeCredential));

router.route('/events/:id/batches')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listBatches))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.batchCreate), wrap(c.operations.createBatch));
router.route('/batches/:id/order')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.operations.listStageOrder))
  .put(requireAuth, validate(s.paramsWithId, 'params'), validate(s.stageOrderSet), wrap(c.operations.setStageOrder));
router.post('/batches/:id/status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.batchStatusUpdate), wrap(c.operations.updateBatchStatus));

// ================================================================ JULGAMENTO
router.route('/events/:id/panels')
  .get(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.judging.listPanels))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.panelCreate), wrap(c.judging.createPanel));
router.post('/panels/:id/judges', requireAuth, validate(s.paramsWithId, 'params'), validate(s.panelJudgeAdd), wrap(c.judging.addJudge));
router.delete('/panels/:id/judges/:judgeId', requireAuth, wrap(c.judging.removeJudge));

router.get('/events/:id/judging-sessions', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.judging.listSessions));
router.post('/judging-sessions', requireAuth, validate(s.sessionCreate), wrap(c.judging.openSession));
router.get('/judging-sessions/:id/sheet', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.judging.sheet));
router.post('/judging-sessions/:id/scores', requireAuth, perm('judging.score'), validate(s.paramsWithId, 'params'), validate(s.scoreSubmit), wrap(c.judging.submit));
router.post('/judging-sessions/:id/close', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.judging.close));

// ================================================================ RESULTADOS
router.get('/events/:id/results', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.results.listByEvent));
router.get('/classes/:id/result', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.results.findByClass));
router.post('/classes/:id/result/calculate', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.results.calculate));
router.post('/classes/:id/result/publish', requireAuth, validate(s.paramsWithId, 'params'), validate(s.resultPublish), wrap(c.results.publish));
router.post('/classes/:id/result/override', requireAuth, validate(s.paramsWithId, 'params'), validate(s.resultOverride), wrap(c.results.override));
router.get('/classes/:id/result/versions', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.results.versions));

router.route('/scoring-rule-sets')
  .get(requireAuth, wrap(c.scoring.list))
  .post(requireAuth, perm('results.calculate'), validate(s.scoringRuleSetCreate), wrap(c.scoring.create));

// ===================================================== RANKING E TEMPORADAS
router.get('/ranking', optionalAuth, validate(s.rankingQuery, 'query'), wrap(c.ranking.list));
router.route('/seasons')
  .get(optionalAuth, validate(s.scopedListQuery, 'query'), wrap(c.ranking.listSeasons))
  .post(requireAuth, perm('ranking.manage', orgDoCorpo), validate(s.seasonCreate), wrap(c.ranking.createSeason));
router.put('/seasons/:id/points-rules', requireAuth, validate(s.paramsWithId, 'params'), validate(s.pointsRuleSet), wrap(c.ranking.setPointsRules));
router.post('/seasons/:id/recompute', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.recompute));
// Ranking de equipes: mesma tabela de pontos e mesmo desempate do atleta.
router.get('/ranking/teams', optionalAuth, validate(s.teamRankingQuery, 'query'), wrap(c.ranking.teams));

// Título Overall. É declarado pela organização, não calculado: o critério de
// determinação do campeão não foi homologado (ver docs/HOMOLOGACAO-ESPORTIVA.md).
router.route('/events/:id/overall')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.ranking.listOverall))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.overallDeclare), wrap(c.ranking.declareOverall));

router.get('/athletes/:id/ranking-points', requireAuth, validate(s.paramsWithId, 'params'), validate(s.rankingPointsQuery, 'query'), wrap(c.ranking.athletePoints));

// ================================================================= MUSCLEWAR
router.route('/musclewar/imports')
  .get(requireAuth, perm('musclewar.review', orgDaQuery), validate(s.importQuery, 'query'), wrap(c.muscleWar.list))
  .post(requireAuth, limiteImportacao, perm('musclewar.import', orgDoCorpo), validate(s.muscleWarImportCreate), wrap(c.muscleWar.create));
router.get('/musclewar/imports/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.muscleWar.preview));
router.post('/musclewar/items/:itemId/link', requireAuth, validate(s.muscleWarLink), wrap(c.muscleWar.link));
router.post('/musclewar/imports/:id/apply', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.muscleWar.apply));
router.post('/musclewar/imports/:id/reject', requireAuth, validate(s.paramsWithId, 'params'), validate(s.rejectImport), wrap(c.muscleWar.reject));

// ================================== EQUIPES, ACADEMIAS, COACHES, MARCAS, PATROCÍNIO
router.route('/teams')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listTeams))
  .post(requireAuth, perm('teams.manage', orgDoCorpo), validate(s.teamCreate), wrap(c.partners.createTeam));
router.route('/gyms')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listGyms))
  .post(requireAuth, perm('gyms.manage', orgDoCorpo), validate(s.gymCreate), wrap(c.partners.createGym));
router.route('/coaches')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listCoaches))
  .post(requireAuth, perm('coaches.manage'), validate(s.coachCreate), wrap(c.partners.createCoach));
router.route('/brands')
  .get(optionalAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listBrands))
  .post(requireAuth, perm('brands.manage', orgDoCorpo), validate(s.brandCreate), wrap(c.partners.createBrand));
router.route('/sponsors')
  .get(requireAuth, validate(s.scopedListQuery, 'query'), wrap(c.partners.listSponsors))
  .post(requireAuth, perm('sponsors.manage', orgDoCorpo), validate(s.sponsorCreate), wrap(c.partners.createSponsor));
router.route('/sponsorships')
  .get(requireAuth, validate(s.sponsorshipQuery, 'query'), wrap(c.partners.listSponsorships))
  .post(requireAuth, validate(s.sponsorshipCreate), wrap(c.partners.createSponsorship));
router.route('/partnerships')
  .get(optionalAuth, validate(s.partnershipQuery, 'query'), wrap(c.partners.listPartnerships))
  .post(requireAuth, validate(s.partnershipCreate), wrap(c.partners.createPartnership));
router.post('/partnerships/:id/status', requireAuth, validate(s.paramsWithId, 'params'), validate(s.partnershipStatus), wrap(c.partners.setPartnershipStatus));

// ==================================================================== SOCIAL
router.get('/social/me', requireAuth, wrap(c.social.myProfile));
router.patch('/social/me', requireAuth, validate(s.profileUpdateSocial), wrap(c.social.updateProfile));
router.post('/social/me/handle', requireAuth, validate(s.handleUpdate), wrap(c.social.setHandle));

router.get('/social/feed', optionalAuth, validate(s.feedQuery, 'query'), wrap(c.social.feed));
router.get('/social/saved', requireAuth, validate(s.paginacao, 'query'), wrap(c.social.listSaved));

router.route('/social/posts')
  .post(requireAuth, validate(s.postCreate), wrap(c.social.createPost));
router.route('/social/posts/:id')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.social.getPost))
  .delete(requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.deletePost));
router.post('/social/posts/:id/media', requireAuth, limiteUpload, validate(s.paramsWithId, 'params'), uploadMidia, wrap(c.social.attachMedia));
router.post('/social/posts/:id/like', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.like));
router.delete('/social/posts/:id/like', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.unlike));
router.post('/social/posts/:id/save', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.save));
router.delete('/social/posts/:id/save', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.unsave));
router.post('/social/posts/:id/share', requireAuth, validate(s.paramsWithId, 'params'), validate(s.shareCreate), wrap(c.social.share));
router.route('/social/posts/:id/comments')
  .get(optionalAuth, validate(s.paramsWithId, 'params'), validate(s.paginacao, 'query'), wrap(c.social.listComments))
  .post(requireAuth, validate(s.paramsWithId, 'params'), validate(s.commentCreate), wrap(c.social.comment));
router.delete('/social/comments/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.deleteComment));

router.get('/social/profiles/:handle', optionalAuth, wrap(c.social.profile));
router.post('/social/profiles/:handle/follow', requireAuth, wrap(c.social.follow));
router.delete('/social/profiles/:handle/follow', requireAuth, wrap(c.social.unfollow));
router.get('/social/profiles/:handle/followers', optionalAuth, validate(s.paginacao, 'query'), wrap(c.social.followers));
router.get('/social/profiles/:handle/following', optionalAuth, validate(s.paginacao, 'query'), wrap(c.social.following));
router.post('/social/profiles/:handle/block', requireAuth, wrap(c.social.block));
router.delete('/social/profiles/:handle/block', requireAuth, wrap(c.social.unblock));

router.route('/social/stories')
  .get(requireAuth, wrap(c.social.listStories))
  .post(requireAuth, limiteUpload, uploadMidia, validate(s.storyCaption), wrap(c.social.createStory));
router.post('/social/stories/:id/view', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.social.viewStory));

router.get('/media/posts/:id', optionalAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.postMedia));
router.get('/media/stories/:id', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.documents.storyMedia));

router.post('/social/reports', requireAuth, validate(s.reportCreate), wrap(c.social.report));
router.get('/social/reports', requireAuth, perm('social.moderate'), validate(s.reportQuery, 'query'), wrap(c.social.listReports));
router.post('/social/reports/:id/resolve', requireAuth, perm('social.moderate'), validate(s.paramsWithId, 'params'), validate(s.reportResolve), wrap(c.social.resolveReport));

// ================================================================= MESSENGER
router.route('/messenger/conversations')
  .get(requireAuth, perm('messenger.use'), validate(s.paginacao, 'query'), wrap(c.messenger.listConversations))
  .post(requireAuth, perm('messenger.use'), validate(s.conversationCreate), wrap(c.messenger.createConversation));
router.get('/messenger/conversations/:id', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.getConversation));
router.route('/messenger/conversations/:id/messages')
  .get(requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.paginacao, 'query'), wrap(c.messenger.listMessages))
  .post(requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.messageCreate), wrap(c.messenger.sendMessage));
router.post('/messenger/conversations/:id/media', requireAuth, perm('messenger.use'), limiteUpload, validate(s.paramsWithId, 'params'), uploadMidia, wrap(c.messenger.sendMedia));
router.post('/messenger/conversations/:id/read', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.markRead));
router.post('/messenger/conversations/:id/members', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.conversationMembers), wrap(c.messenger.addMembers));
router.post('/messenger/conversations/:id/leave', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.leave));
router.post('/messenger/messages/:id/reactions', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), validate(s.reactionCreate), wrap(c.messenger.react));
router.delete('/messenger/messages/:id', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.deleteMessage));
router.get('/messenger/messages/:id/media', requireAuth, perm('messenger.use'), validate(s.paramsWithId, 'params'), wrap(c.messenger.media));

// =============================================================== COMUNIDADES
router.route('/communities')
  .get(optionalAuth, validate(s.paginacao, 'query'), wrap(c.communities.list))
  .post(requireAuth, perm('communities.manage'), validate(s.communityCreate), wrap(c.communities.create));
router.get('/communities/:slug', optionalAuth, wrap(c.communities.findBySlug));
router.post('/communities/:slug/join', requireAuth, wrap(c.communities.join));
router.post('/communities/:slug/leave', requireAuth, wrap(c.communities.leave));
router.post('/communities/:slug/members', requireAuth, validate(s.communityMemberAdd), wrap(c.communities.addMember));
router.get('/communities/:slug/members', optionalAuth, validate(s.paginacao, 'query'), wrap(c.communities.listMembers));

// ===================================================================== BUSCA
router.get('/search', optionalAuth, limiteBusca, validate(s.searchQuery, 'query'), wrap(c.search.global));

// ================================================================== PAINÉIS
router.get('/dashboard/summary', requireAuth, wrap(c.dashboard.summary));
router.get('/dashboard/admin', requireAuth, perm('analytics.read', orgDaQuery), wrap(c.dashboard.admin));
router.get('/dashboard/athlete', requireAuth, wrap(c.dashboard.athlete));
router.get('/events/:id/operations', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.dashboard.eventOperations));

// ============================================================ NOTIFICAÇÕES
router.get('/notifications', requireAuth, validate(s.notificationQuery, 'query'), wrap(c.notifications.list));
router.post('/notifications/:id/read', requireAuth, validate(s.paramsWithId, 'params'), wrap(c.notifications.markRead));
router.post('/notifications/read-all', requireAuth, wrap(c.notifications.markAllRead));

// ================================================================= AUDITORIA
router.get('/audit', requireAuth, perm('audit.read', orgDaQuery), validate(s.auditQuery, 'query'), wrap(c.audit.list));

// ================================================================== USUÁRIOS
router.get('/admin/users', requireAuth, perm('users.read'), validate(s.adminUserQuery, 'query'), wrap(c.admin.listUsers));
router.get('/admin/users/:id', requireAuth, perm('users.read'), validate(s.paramsWithId, 'params'), wrap(c.admin.findUser));
router.patch('/admin/users/:id', requireAuth, perm('users.manage'), validate(s.paramsWithId, 'params'), validate(s.adminUserUpdate), wrap(c.admin.updateUser));

// =================================================================== VITRINE
router.get('/public/summary', limitePublico, wrap(c.publicApi.summary));
router.get('/public/events', limitePublico, validate(s.paginacao, 'query'), wrap(c.publicApi.listEvents));
router.get('/public/events/:slug', limitePublico, wrap(c.publicApi.eventPage));
router.get('/public/athletes', limitePublico, validate(s.paginacao, 'query'), wrap(c.publicApi.listAthletes));
router.get('/public/athletes/:id', limitePublico, validate(s.paramsWithId, 'params'), wrap(c.publicApi.athletePage));

module.exports = router;
