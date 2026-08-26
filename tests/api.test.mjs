import request from 'supertest';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

async function clearDatabase() {
  await prisma.result.deleteMany();
  await prisma.standing.deleteMany();
  await prisma.match.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.user.deleteMany();
}

describe('API MCI Campeonatos', () => {
  beforeAll(() => clearDatabase());
  beforeEach(() => clearDatabase());
  afterAll(() => prisma.$disconnect());

  async function registerOrganizer() {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Organizador', email: 'organizador@teste.com', password: 'Senha@123', role: 'ORGANIZER' });
    return response.body.token;
  }

  it('mantém a rota inicial e responde 404 em JSON', async () => {
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.text).toBe('MCI Campeonatos API funcionando!');
    const missing = await request(app).get('/nao-existe');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('executa o fluxo de campeonato, inscrição, partida, resultado e classificação', async () => {
    const token = await registerOrganizer();
    const tournament = await request(app)
      .post('/api/v1/campeonatos')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Copa MCI', status: 'ACTIVE' });
    expect(tournament.status).toBe(201);
    const teamA = await request(app).post('/api/v1/equipes').set('Authorization', `Bearer ${token}`).send({ name: 'Equipe A', identification: 'A' });
    const teamB = await request(app).post('/api/v1/equipes').set('Authorization', `Bearer ${token}`).send({ name: 'Equipe B', identification: 'B' });
    expect(teamA.status).toBe(201);
    expect(teamB.status).toBe(201);

    const enrollA = await request(app).post(`/api/v1/campeonatos/${tournament.body.id}/participantes`).set('Authorization', `Bearer ${token}`).send({ participantId: teamA.body.id });
    const enrollB = await request(app).post(`/api/v1/campeonatos/${tournament.body.id}/participantes`).set('Authorization', `Bearer ${token}`).send({ participantId: teamB.body.id });
    expect(enrollA.status).toBe(201);
    expect(enrollB.status).toBe(201);
    const duplicate = await request(app).post(`/api/v1/campeonatos/${tournament.body.id}/participantes`).set('Authorization', `Bearer ${token}`).send({ participantId: teamA.body.id });
    expect(duplicate.status).toBe(409);

    const match = await request(app).post('/api/v1/partidas').set('Authorization', `Bearer ${token}`).send({ tournamentId: tournament.body.id, participantAId: teamA.body.id, participantBId: teamB.body.id });
    expect(match.status).toBe(201);
    const result = await request(app).post(`/api/v1/partidas/${match.body.id}/resultado`).set('Authorization', `Bearer ${token}`).send({ winnerParticipantId: teamA.body.id, scoreA: 2, scoreB: 1 });
    expect(result.status).toBe(201);
    const resultLookup = await request(app).get(`/api/v1/partidas/${match.body.id}/resultado`);
    expect(resultLookup.status).toBe(200);
    const resultUpdate = await request(app).patch(`/api/v1/partidas/${match.body.id}/resultado`).set('Authorization', `Bearer ${token}`).send({ winnerParticipantId: teamA.body.id, scoreA: 3, scoreB: 1 });
    expect(resultUpdate.status).toBe(200);
    const duplicateResult = await request(app).post(`/api/v1/partidas/${match.body.id}/resultado`).set('Authorization', `Bearer ${token}`).send({ winnerParticipantId: teamA.body.id, scoreA: 2, scoreB: 1 });
    expect(duplicateResult.status).toBe(409);

    const standing = await request(app).get(`/api/v1/campeonatos/${tournament.body.id}/classificacao`);
    expect(standing.status).toBe(200);
    expect(standing.body[0].participantId).toBe(teamA.body.id);
    expect(standing.body[0].points).toBe(3);
  });

  it('valida dados e permite atualizar e excluir campeonatos', async () => {
    const token = await registerOrganizer();
    const invalid = await request(app).post('/api/v1/campeonatos').set('Authorization', `Bearer ${token}`).send({ name: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details).toBeInstanceOf(Array);
    expect((await request(app).get('/api/v1/campeonatos/%20')).status).toBe(400);
    const invalidDates = await request(app).post('/api/v1/campeonatos').set('Authorization', `Bearer ${token}`).send({ name: 'Datas inválidas', startDate: '2026-05-02', endDate: '2026-05-01' });
    expect(invalidDates.status).toBe(400);
    const created = await request(app).post('/api/v1/campeonatos').set('Authorization', `Bearer ${token}`).send({ name: 'Temporada 1' });
    const updated = await request(app).patch(`/api/v1/campeonatos/${created.body.id}`).set('Authorization', `Bearer ${token}`).send({ status: 'FINISHED' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('FINISHED');
    expect((await request(app).get(`/api/v1/campeonatos/${created.body.id}`)).status).toBe(200);
    expect((await request(app).delete(`/api/v1/campeonatos/${created.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(204);
    expect((await request(app).get(`/api/v1/campeonatos/${created.body.id}`)).status).toBe(404);
  });

  it('impede que um organizador altere recursos pertencentes a outro organizador', async () => {
    const firstResponse = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Organizador A', email: 'organizador-a@teste.com', password: 'Senha@123', role: 'ORGANIZER' });
    const secondResponse = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Organizador B', email: 'organizador-b@teste.com', password: 'Senha@123', role: 'ORGANIZER' });

    const tournament = await request(app)
      .post('/api/v1/campeonatos')
      .set('Authorization', `Bearer ${firstResponse.body.token}`)
      .send({ name: 'Campeonato do A', status: 'ACTIVE' });

    const participant = await request(app)
      .post('/api/v1/participantes')
      .set('Authorization', `Bearer ${firstResponse.body.token}`)
      .send({ name: 'Atleta do A', identification: 'A-OWNED', type: 'PLAYER' });

    const forbiddenTournamentUpdate = await request(app)
      .patch(`/api/v1/campeonatos/${tournament.body.id}`)
      .set('Authorization', `Bearer ${secondResponse.body.token}`)
      .send({ status: 'FINISHED' });

    const forbiddenParticipantDelete = await request(app)
      .delete(`/api/v1/participantes/${participant.body.id}`)
      .set('Authorization', `Bearer ${secondResponse.body.token}`);

    expect(forbiddenTournamentUpdate.status).toBe(403);
    expect(forbiddenParticipantDelete.status).toBe(403);
  });

  it('cobre CRUD de participantes e rejeita relações inválidas', async () => {
    const token = await registerOrganizer();
    const participant = await request(app).post('/api/v1/participantes').set('Authorization', `Bearer ${token}`).send({ name: 'Pessoa MCI', identification: 'P1', type: 'PLAYER' });
    expect(participant.status).toBe(201);
    const team = await request(app).post('/api/v1/equipes').set('Authorization', `Bearer ${token}`).send({ name: 'Equipe MCI', identification: 'T1' });
    expect(team.status).toBe(201);
    expect((await request(app).get('/api/v1/equipes')).body).toHaveLength(1);
    expect((await request(app).patch(`/api/v1/equipes/${team.body.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'Equipe Atualizada' })).status).toBe(200);
    expect((await request(app).get('/api/v1/participantes/sem-id-valido')).status).toBe(404);
    const tournament = await request(app).post('/api/v1/campeonatos').set('Authorization', `Bearer ${token}`).send({ name: 'Relações' });
    const invalidMatch = await request(app).post('/api/v1/partidas').set('Authorization', `Bearer ${token}`).send({ tournamentId: tournament.body.id, participantAId: participant.body.id, participantBId: team.body.id });
    expect(invalidMatch.status).toBe(422);
    expect((await request(app).delete(`/api/v1/participantes/${participant.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(204);
  });
});