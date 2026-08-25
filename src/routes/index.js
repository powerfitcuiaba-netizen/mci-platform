const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const { optionalAuth, requireAuth, requireRole } = require('../middlewares/auth');
const { rateLimit } = require('../middlewares/rateLimit');
const authSchemas = require('../utils/authSchemas');
const schemas = require('../utils/schemas');
const auth = require('../controllers/authController');
const tournaments = require('../controllers/tournamentController');
const participants = require('../controllers/participantController');
const matches = require('../controllers/matchController');
const enrollments = require('../controllers/enrollmentController');
const results = require('../controllers/resultController');
const standings = require('../controllers/standingController');
const judge = require('../controllers/judgeController');
const checkin = require('../controllers/checkinController');
const notifications = require('../controllers/notificationController');
const documents = require('../controllers/documentController');
const publicApi = require('../controllers/publicController');
const coach = require('../controllers/coachController');
const backstage = require('../controllers/backstageController');
const reports = require('../controllers/reportController');
const dashboard = require('../controllers/dashboardController');
const profile = require('../controllers/profileController');
const athlete = require('../controllers/athleteController');
const admin = require('../controllers/adminController');
const audit = require('../controllers/auditController');
const { singleFileUpload } = require('../middlewares/upload');
const orders = require('../controllers/orderController');
const payments = require('../controllers/paymentController');
const coupons = require('../controllers/couponController');
const refunds = require('../controllers/refundController');
const sponsors = require('../controllers/sponsorController');

const router = express.Router();
const wrap = handler => asyncHandler(handler);

const limiteAutenticacao = rateLimit({ windowMs: 15 * 60_000, max: 10, nome: 'auth' });

router.post('/auth/register', limiteAutenticacao, validate(authSchemas.authRegister), wrap(auth.register));
router.post('/auth/login', limiteAutenticacao, validate(authSchemas.authLogin), wrap(auth.login));
router.get('/auth/me', requireAuth, wrap(auth.me));

router.get('/profile', requireAuth, wrap(profile.me));
router.patch('/profile', requireAuth, validate(schemas.profileUpdate), wrap(profile.update));
router.post('/profile/password', requireAuth, limiteAutenticacao, validate(schemas.passwordChange), wrap(profile.changePassword));

router.route('/campeonatos').get(optionalAuth, wrap(tournaments.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.tournament), wrap(tournaments.create));
router.route('/campeonatos/:id').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(tournaments.findById)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).put(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), wrap(tournaments.delete));
router.route('/campeonatos/:id/participantes').get(optionalAuth, validate(schemas.paramsWithId, 'params'), validate(schemas.enrollmentQuery, 'query'), wrap(enrollments.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.enrollment), wrap(enrollments.create));
router.patch('/inscricoes/:id/cancel', requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), wrap(enrollments.cancel));
router.get('/campeonatos/:id/classificacao', optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(standings.list));

router.route('/participantes').get(optionalAuth, validate(schemas.query, 'query'), wrap(participants.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.participant), wrap(participants.create));
router.route('/participantes/:id').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(participants.findById)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.participantUpdate), wrap(participants.update)).put(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.participantUpdate), wrap(participants.update)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), wrap(participants.delete));
router.route('/equipes').get(optionalAuth, validate(schemas.query, 'query'), wrap(participants.listTeams)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.team), wrap(participants.create));
router.route('/equipes/:id').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(participants.findTeamById)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.teamUpdate), wrap(participants.update)).put(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.teamUpdate), wrap(participants.update)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), wrap(participants.delete));

router.route('/partidas').get(optionalAuth, validate(schemas.query, 'query'), wrap(matches.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), validate(schemas.match), wrap(matches.create));
router.route('/partidas/:id').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(matches.findById)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), validate(schemas.paramsWithId, 'params'), validate(schemas.matchUpdate), wrap(matches.update)).put(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), validate(schemas.paramsWithId, 'params'), validate(schemas.matchUpdate), wrap(matches.update));
router.route('/partidas/:id/resultado').get(validate(schemas.paramsWithId, 'params'), wrap(results.findByMatchId)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), validate(schemas.paramsWithId, 'params'), validate(schemas.result), wrap(results.create)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), validate(schemas.paramsWithId, 'params'), validate(schemas.result), wrap(results.update));

router.get('/judge/matches', requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), wrap(judge.listMatches));
router.route('/judge/assignments').get(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'JUDGE']), wrap(judge.listAssignments)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.judgeAssignment), wrap(judge.assign));

router.get('/checkin/tournaments/:id', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.searchQuery, 'query'), wrap(checkin.listByTournament));
router.get('/checkin/enrollments/:id', requireAuth, validate(schemas.paramsWithId, 'params'), wrap(checkin.getByEnrollment));
router.post('/checkin/enrollments/:id', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.checkIn, 'body'), wrap(checkin.checkIn));
router.patch('/checkin/enrollments/:id/cancel', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(checkin.cancel));

router.get('/notifications', requireAuth, validate(schemas.notificationQuery, 'query'), wrap(notifications.list));
router.patch('/notifications/:id/read', requireAuth, wrap(notifications.markRead));
router.post('/notifications/read-all', requireAuth, wrap(notifications.markAllRead));

router.route('/documents').get(requireAuth, validate(schemas.documentQuery, 'query'), wrap(documents.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.document), wrap(documents.create));
router.post('/documents/upload', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), rateLimit({ windowMs: 60_000, max: 30, nome: 'upload' }), singleFileUpload('file'), validate(schemas.documentUpload), wrap(documents.upload));
router.get('/documents/:id/download', requireAuth, validate(schemas.paramsWithId, 'params'), wrap(documents.download));
router.route('/documents/:id').get(requireAuth, wrap(documents.findById)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(documents.delete));

// Vale para toda a vitrine, não só para o resumo: é a única superfície
// alcançável sem credencial alguma, então é a que mais precisa de teto.
const limitePublico = rateLimit({ windowMs: 60_000, max: 180, nome: 'public' });

router.get('/public/summary', limitePublico, wrap(publicApi.summary));
router.get('/public/tournaments', limitePublico, wrap(publicApi.listTournaments));
router.get('/public/tournaments/:id', limitePublico, validate(schemas.paramsWithId, 'params'), wrap(publicApi.tournamentDetail));
router.get('/public/live', limitePublico, wrap(publicApi.live));
router.get('/public/athletes', limitePublico, wrap(publicApi.listAthletes));
router.get('/public/athletes/:id', limitePublico, validate(schemas.paramsWithId, 'params'), wrap(publicApi.athleteDetail));
router.get('/public/teams', limitePublico, wrap(publicApi.listTeams));
router.get('/public/teams/:id', limitePublico, validate(schemas.paramsWithId, 'params'), wrap(publicApi.teamDetail));

router.get('/dashboard/summary', requireAuth, wrap(dashboard.summary));

router.get('/coach/overview', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.overview));
router.get('/coach/teams', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.listTeams));
router.get('/coach/athletes', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.listAthletes));
router.patch('/coach/participants/:id/team', requireAuth, requireRole(['ADMIN', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.coachSetTeam), wrap(coach.setTeam));

router.get('/athlete/overview', requireAuth, requireRole(['ADMIN', 'ATHLETE']), wrap(athlete.overview));

router.get('/admin/overview', requireAuth, requireRole(['ADMIN']), wrap(admin.overview));
router.get('/admin/users', requireAuth, requireRole(['ADMIN']), validate(schemas.adminUserQuery, 'query'), wrap(admin.listUsers));
router.get('/admin/users/:id', requireAuth, requireRole(['ADMIN']), validate(schemas.paramsWithId, 'params'), wrap(admin.findUser));
router.patch('/admin/users/:id', requireAuth, requireRole(['ADMIN']), validate(schemas.paramsWithId, 'params'), validate(schemas.adminUserUpdate), wrap(admin.updateUser));

// ---------------------------------------------------------------
// Financeiro. O webhook é público por natureza — quem chama é o
// provedor, não um usuário logado — e se protege por assinatura.
// ---------------------------------------------------------------
router.post('/webhooks/payments/:provider', rateLimit({ windowMs: 60_000, max: 120, nome: 'webhook' }), validate(schemas.webhookParams, 'params'), wrap(payments.webhook));

router.route('/orders')
  .get(requireAuth, validate(schemas.orderQuery, 'query'), wrap(orders.list))
  .post(requireAuth, validate(schemas.orderCreate), wrap(orders.create));
router.get('/orders/:id', requireAuth, validate(schemas.paramsWithId, 'params'), wrap(orders.findById));
router.patch('/orders/:id/cancel', requireAuth, validate(schemas.paramsWithId, 'params'), wrap(orders.cancel));

router.post('/orders/:id/payments', requireAuth, validate(schemas.paramsWithId, 'params'), validate(schemas.paymentStart), wrap(payments.start));
router.get('/orders/:id/payments', requireAuth, validate(schemas.paramsWithId, 'params'), wrap(payments.listByOrder));
router.post('/orders/:id/refunds', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.refundRequest), wrap(refunds.request));

router.get('/refunds', requireAuth, validate(schemas.refundQuery, 'query'), wrap(refunds.list));

router.route('/coupons')
  .get(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(coupons.list))
  .post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.couponCreate), wrap(coupons.create));
router.patch('/coupons/:id/active', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.couponToggle), wrap(coupons.setActive));
router.post('/coupons/preview', requireAuth, validate(schemas.couponPreview), wrap(coupons.preview));

router.route('/sponsors')
  .get(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(sponsors.listSponsors))
  .post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.sponsorCreate), wrap(sponsors.createSponsor));
router.route('/sponsorships')
  .get(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.sponsorshipQuery, 'query'), wrap(sponsors.listSponsorships))
  .post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.sponsorshipCreate), wrap(sponsors.createSponsorship));

router.get('/audit', requireAuth, requireRole(['ADMIN']), validate(schemas.auditQuery, 'query'), wrap(audit.list));

router.get('/backstage/overview', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(backstage.overview));

router.get('/reports/tournaments', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(reports.listAvailable));
router.get('/reports/tournaments/:id', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), wrap(reports.tournamentReport));

module.exports = router;