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
router.route('/campeonatos/:id').get(wrap(tournaments.findById)).patch(validate(schemas.tournament.partial()), wrap(tournaments.update)).put(validate(schemas.tournament.partial()), wrap(tournaments.update)).delete(wrap(tournaments.delete));
router.route('/campeonatos/:id/participantes').get(wrap(enrollments.list)).post(validate(schemas.enrollment), wrap(enrollments.create));
router.get('/campeonatos/:id/classificacao', wrap(standings.list));

router.route('/participantes').get(wrap(participants.list)).post(validate(schemas.participant), wrap(participants.create));
router.route('/participantes/:id').get(wrap(participants.findById)).patch(validate(schemas.participant.partial()), wrap(participants.update)).put(validate(schemas.participant.partial()), wrap(participants.update)).delete(wrap(participants.delete));
router.route('/equipes').get((req, res, next) => { req.query.type = 'TEAM'; next(); }, wrap(participants.list)).post(validate(schemas.team), wrap(participants.create));

router.route('/partidas').get(wrap(matches.list)).post(validate(schemas.match), wrap(matches.create));
router.route('/partidas/:id').get(wrap(matches.findById)).patch(validate(schemas.match.partial()), wrap(matches.update)).put(validate(schemas.match.partial()), wrap(matches.update));
router.post('/partidas/:id/resultado', validate(schemas.result), wrap(results.create));

module.exports = router;