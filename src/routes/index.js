const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const validate = require('../middlewares/validate');
const schemas = require('../utils/schemas');
const tournaments = require('../controllers/tournamentController');
const participants = require('../controllers/participantController');
const matches = require('../controllers/matchController');
const enrollments = require('../controllers/enrollmentController');
const results = require('../controllers/resultController');
const standings = require('../controllers/standingController');

const router = express.Router();
const wrap = handler => asyncHandler(handler);

router.route('/campeonatos').get(wrap(tournaments.list)).post(validate(schemas.tournament), wrap(tournaments.create));
router.route('/campeonatos/:id').get(validate(schemas.paramsWithId, 'params'), wrap(tournaments.findById)).patch(validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).put(validate(schemas.paramsWithId, 'params'), validate(schemas.tournamentUpdate), wrap(tournaments.update)).delete(validate(schemas.paramsWithId, 'params'), wrap(tournaments.delete));
router.route('/campeonatos/:id/participantes').get(validate(schemas.paramsWithId, 'params'), wrap(enrollments.list)).post(validate(schemas.paramsWithId, 'params'), validate(schemas.enrollment), wrap(enrollments.create));
router.get('/campeonatos/:id/classificacao', validate(schemas.paramsWithId, 'params'), wrap(standings.list));

router.route('/participantes').get(validate(schemas.query, 'query'), wrap(participants.list)).post(validate(schemas.participant), wrap(participants.create));
router.route('/participantes/:id').get(validate(schemas.paramsWithId, 'params'), wrap(participants.findById)).patch(validate(schemas.paramsWithId, 'params'), validate(schemas.participantUpdate), wrap(participants.update)).put(validate(schemas.paramsWithId, 'params'), validate(schemas.participantUpdate), wrap(participants.update)).delete(validate(schemas.paramsWithId, 'params'), wrap(participants.delete));
router.route('/equipes').get(validate(schemas.query, 'query'), wrap(participants.listTeams)).post(validate(schemas.team), wrap(participants.create));
router.route('/equipes/:id').get(validate(schemas.paramsWithId, 'params'), wrap(participants.findTeamById)).patch(validate(schemas.paramsWithId, 'params'), validate(schemas.teamUpdate), wrap(participants.update)).put(validate(schemas.paramsWithId, 'params'), validate(schemas.teamUpdate), wrap(participants.update)).delete(validate(schemas.paramsWithId, 'params'), wrap(participants.delete));

router.route('/partidas').get(validate(schemas.query, 'query'), wrap(matches.list)).post(validate(schemas.match), wrap(matches.create));
router.route('/partidas/:id').get(validate(schemas.paramsWithId, 'params'), wrap(matches.findById)).patch(validate(schemas.paramsWithId, 'params'), validate(schemas.matchUpdate), wrap(matches.update)).put(validate(schemas.paramsWithId, 'params'), validate(schemas.matchUpdate), wrap(matches.update));
router.route('/partidas/:id/resultado').get(validate(schemas.paramsWithId, 'params'), wrap(results.findByMatchId)).post(validate(schemas.paramsWithId, 'params'), validate(schemas.result), wrap(results.create)).patch(validate(schemas.paramsWithId, 'params'), validate(schemas.result), wrap(results.update));

module.exports = router;