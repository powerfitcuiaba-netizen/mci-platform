import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

// Fluxo ponta a ponta contra o banco de teste real: nenhuma etapa é simulada.
// Cada passo depende do estado deixado pelo anterior, então a ordem importa e o
// estado é montado uma única vez.
const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });

const state = {};

async function clearDatabase() {
  await prisma.notification.deleteMany();
  await prisma.checkIn.deleteMany();
  await prisma.document.deleteMany();
  await prisma.judgeAssignment.deleteMany();
  await prisma.result.deleteMany();
  await prisma.standing.deleteMany();
  await prisma.match.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.participant.updateMany({ data: { teamId: null } });
  await prisma.tournament.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.user.deleteMany();
}

const register = async (name, email, role) => {
  const response = await request(app).post(`${api}/auth/register`).send({ name, email, password: 'Senha@123', role });
  expect(response.status).toBe(201);
  return { token: response.body.token, user: response.body.user };
};

describe('E2E — ciclo operacional completo', () => {
  beforeAll(async () => {
    await clearDatabase();
    state.admin = await register('Admin E2E', 'admin@e2e.test', 'ADMIN');
    state.organizer = await register('Organizador E2E', 'org@e2e.test', 'ORGANIZER');
    state.judge = await register('Juiz E2E', 'juiz@e2e.test', 'JUDGE');
    state.coach = await register('Tecnico E2E', 'coach@e2e.test', 'COACH');
  });

  it('1. ADMIN cria o evento', async () => {
    const response = await request(app).post(`${api}/campeonatos`).set(auth(state.admin.token))
      .send({ name: 'Campeonato E2E', description: 'Ciclo completo', status: 'ACTIVE' });
    expect(response.status).toBe(201);
    state.tournament = response.body;
  });

  it('2. ADMIN designa o juiz e o ORGANIZER passa a operar', async () => {
    const assignment = await request(app).post(`${api}/judge/assignments`).set(auth(state.admin.token))
      .send({ tournamentId: state.tournament.id, judgeId: state.judge.user.id });
    expect(assignment.status).toBe(201);

    // O evento foi criado pelo ADMIN; o organizador administra sob override
    // administrativo apenas quando o ADMIN transfere o evento para ele.
    const transfer = await prisma.tournament.update({
      where: { id: state.tournament.id },
      data: { createdById: state.organizer.user.id }
    });
    expect(transfer.createdById).toBe(state.organizer.user.id);
  });

  it('3. ORGANIZER cadastra equipes e inscreve o elenco do técnico', async () => {
    state.teamA = (await request(app).post(`${api}/equipes`).set(auth(state.organizer.token))
      .send({ name: 'Equipe E2E A', identification: 'E2E-A', coachId: state.coach.user.id })).body;
    state.teamB = (await request(app).post(`${api}/equipes`).set(auth(state.organizer.token))
      .send({ name: 'Equipe E2E B', identification: 'E2E-B' })).body;
    expect(state.teamA.coachId).toBe(state.coach.user.id);

    state.enrollmentA = (await request(app).post(`${api}/campeonatos/${state.tournament.id}/participantes`)
      .set(auth(state.organizer.token)).send({ participantId: state.teamA.id })).body;
    state.enrollmentB = (await request(app).post(`${api}/campeonatos/${state.tournament.id}/participantes`)
      .set(auth(state.organizer.token)).send({ participantId: state.teamB.id })).body;
    expect(state.enrollmentA.id).toBeTruthy();
    expect(state.enrollmentB.id).toBeTruthy();
  });

  it('4. CHECK-IN confirma a presença dos inscritos', async () => {
    const checkA = await request(app).post(`${api}/checkin/enrollments/${state.enrollmentA.id}`)
      .set(auth(state.organizer.token)).send({ operatorName: 'Mesa E2E' });
    expect(checkA.status).toBe(201);

    const listing = await request(app).get(`${api}/checkin/tournaments/${state.tournament.id}`).set(auth(state.organizer.token));
    expect(listing.status).toBe(200);
    expect(listing.body.checkedIn).toBe(1);
    expect(listing.body.pending).toBe(1);
  });

  it('5. ORGANIZER agenda a partida', async () => {
    const response = await request(app).post(`${api}/partidas`).set(auth(state.organizer.token))
      .send({ tournamentId: state.tournament.id, participantAId: state.teamA.id, participantBId: state.teamB.id, status: 'IN_PROGRESS' });
    expect(response.status).toBe(201);
    state.match = response.body;
  });

  it('6. JUDGE enxerga a partida designada e registra o resultado', async () => {
    const matches = await request(app).get(`${api}/judge/matches`).set(auth(state.judge.token));
    expect(matches.status).toBe(200);
    expect(matches.body.items.map(item => item.id)).toContain(state.match.id);

    const result = await request(app).post(`${api}/partidas/${state.match.id}/resultado`).set(auth(state.judge.token))
      .send({ winnerParticipantId: state.teamA.id, scoreA: 3, scoreB: 1 });
    expect(result.status).toBe(201);
  });

  it('7. Classificação é recalculada a partir do resultado real', async () => {
    const standings = await request(app).get(`${api}/campeonatos/${state.tournament.id}/classificacao`);
    expect(standings.status).toBe(200);
    expect(standings.body[0].participantId).toBe(state.teamA.id);
    expect(standings.body[0].points).toBe(3);
    expect(standings.body[1].points).toBe(0);
  });

  it('8. NOTIFICAÇÃO chega ao técnico pelas ações do ciclo', async () => {
    const inbox = await request(app).get(`${api}/notifications`).set(auth(state.coach.token));
    expect(inbox.status).toBe(200);
    const types = inbox.body.items.map(item => item.type);
    expect(types).toContain('ENROLLMENT');
    expect(types).toContain('CHECKIN');
    expect(types).toContain('RESULT');
    expect(inbox.body.unreadCount).toBeGreaterThan(0);
  });

  it('9. COACH vê a própria equipe, competição e agenda', async () => {
    const overview = await request(app).get(`${api}/coach/overview`).set(auth(state.coach.token));
    expect(overview.status).toBe(200);
    expect(overview.body.totals.teams).toBe(1);
    expect(overview.body.tournaments[0].id).toBe(state.tournament.id);
    expect(overview.body.tournaments[0].checkedIn).toBe(1);
    expect(overview.body.matches.map(item => item.id)).toContain(state.match.id);
  });

  it('10. BACKSTAGE consolida a operação do organizador', async () => {
    const overview = await request(app).get(`${api}/backstage/overview`).set(auth(state.organizer.token));
    expect(overview.status).toBe(200);
    expect(overview.body.totals.tournaments).toBe(1);
    expect(overview.body.totals.enrollments).toBe(2);
    expect(overview.body.totals.checkedIn).toBe(1);
    expect(overview.body.totals.missingResults).toBe(0);
  });

  it('11. MCI TV publica o resultado sem exigir login', async () => {
    const detail = await request(app).get(`${api}/public/tournaments/${state.tournament.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.results).toHaveLength(1);
    expect(detail.body.standings[0].participant.name).toBe('Equipe E2E A');
    expect(JSON.stringify(detail.body)).not.toContain('@e2e.test');
  });

  it('12. RELATÓRIO fecha o ciclo com os números reais', async () => {
    const report = await request(app).get(`${api}/reports/tournaments/${state.tournament.id}`).set(auth(state.organizer.token));
    expect(report.status).toBe(200);
    expect(report.body.summary.enrollments).toBe(2);
    expect(report.body.summary.checkedIn).toBe(1);
    expect(report.body.summary.pendingCheckIn).toBe(1);
    expect(report.body.summary.matches).toBe(1);
    expect(report.body.summary.matchesWithResult).toBe(1);
    expect(report.body.summary.matchesPending).toBe(0);
    expect(report.body.standings[0].participant.name).toBe('Equipe E2E A');
  });
});
