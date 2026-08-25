const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const { optionalAuth, requireAuth, requireRole } = require('../middlewares/auth');
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

const router = express.Router();
const wrap = handler => asyncHandler(handler);

router.post('/auth/register', validate(authSchemas.authRegister), wrap(auth.register));
router.post('/auth/login', validate(authSchemas.authLogin), wrap(auth.login));
router.get('/auth/me', requireAuth, wrap(auth.me));

router.route('/campeonatos').get(optionalAuth, wrap(tournaments.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.tournament), wrap(tournaments.create));
router.route('/campeonatos/:id').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(tournaments.findById)).patch(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).put(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), wrap(tournaments.delete));
router.route('/campeonatos/:id/participantes').get(optionalAuth, validate(schemas.paramsWithId, 'params'), wrap(enrollments.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.enrollment), wrap(enrollments.create));
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

router.get('/notifications', requireAuth, wrap(notifications.list));
router.patch('/notifications/:id/read', requireAuth, wrap(notifications.markRead));
router.post('/notifications/read-all', requireAuth, wrap(notifications.markAllRead));

router.route('/documents').get(requireAuth, validate(schemas.documentQuery, 'query'), wrap(documents.list)).post(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.document), wrap(documents.create));
router.route('/documents/:id').get(requireAuth, wrap(documents.findById)).delete(requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(documents.delete));

router.get('/public/summary', wrap(publicApi.summary));
router.get('/public/tournaments', wrap(publicApi.listTournaments));
router.get('/public/tournaments/:id', validate(schemas.paramsWithId, 'params'), wrap(publicApi.tournamentDetail));
router.get('/public/live', wrap(publicApi.live));

router.get('/dashboard/summary', requireAuth, wrap(dashboard.summary));

router.get('/coach/overview', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.overview));
router.get('/coach/teams', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.listTeams));
router.get('/coach/athletes', requireAuth, requireRole(['ADMIN', 'COACH']), wrap(coach.listAthletes));
router.patch('/coach/participants/:id/team', requireAuth, requireRole(['ADMIN', 'COACH']), validate(schemas.paramsWithId, 'params'), validate(schemas.coachSetTeam), wrap(coach.setTeam));

router.get('/backstage/overview', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(backstage.overview));

router.get('/reports/tournaments', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), wrap(reports.listAvailable));
router.get('/reports/tournaments/:id', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), validate(schemas.paramsWithId, 'params'), wrap(reports.tournamentReport));

module.exports = router;