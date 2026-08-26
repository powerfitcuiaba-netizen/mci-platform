import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

async function clearDatabase() {
  await prisma.notification.deleteMany().catch(() => {});
  await prisma.checkIn.deleteMany().catch(() => {});
  await prisma.document.deleteMany().catch(() => {});
  await prisma.judgeAssignment.deleteMany().catch(() => {});
  await prisma.result.deleteMany();
  await prisma.standing.deleteMany();
  await prisma.match.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.participant.deleteMany();
  await prisma.user.deleteMany();
}

describe('Fase 3 operational modules', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('exposes judge, checkin, notification, document and public operational endpoints', async () => {
    const admin = await request(app).post('/api/v1/auth/register').send({ name: 'Admin', email: 'admin@teste.com', password: 'Senha@123', role: 'ADMIN' });
    const judge = await request(app).post('/api/v1/auth/register').send({ name: 'Juiz', email: 'juiz@teste.com', password: 'Senha@123', role: 'JUDGE' });
    const organizer = await request(app).post('/api/v1/auth/register').send({ name: 'Org', email: 'organizer@teste.com', password: 'Senha@123', role: 'ORGANIZER' });

    const tournament = await request(app).post('/api/v1/campeonatos').set('Authorization', `Bearer ${organizer.body.token}`).send({ name: 'Copa Fase 3', status: 'ACTIVE' });
    const teamA = await request(app).post('/api/v1/equipes').set('Authorization', `Bearer ${organizer.body.token}`).send({ name: 'Equipe A', identification: 'FASE-A' });
    const teamB = await request(app).post('/api/v1/equipes').set('Authorization', `Bearer ${organizer.body.token}`).send({ name: 'Equipe B', identification: 'FASE-B' });
    const enrollmentA = await request(app).post(`/api/v1/campeonatos/${tournament.body.id}/participantes`).set('Authorization', `Bearer ${organizer.body.token}`).send({ participantId: teamA.body.id });
    const enrollmentB = await request(app).post(`/api/v1/campeonatos/${tournament.body.id}/participantes`).set('Authorization', `Bearer ${organizer.body.token}`).send({ participantId: teamB.body.id });
    const match = await request(app).post('/api/v1/partidas').set('Authorization', `Bearer ${organizer.body.token}`).send({ tournamentId: tournament.body.id, participantAId: teamA.body.id, participantBId: teamB.body.id, status: 'IN_PROGRESS' });

    await request(app).post('/api/v1/judge/assignments').set('Authorization', `Bearer ${admin.body.token}`).send({ tournamentId: tournament.body.id, judgeId: judge.body.user.id });

    const judgeMatches = await request(app).get('/api/v1/judge/matches').set('Authorization', `Bearer ${judge.body.token}`);
    expect(judgeMatches.status).toBe(200);
    expect(judgeMatches.body.items.length).toBeGreaterThan(0);

    const checkin = await request(app).post(`/api/v1/checkin/enrollments/${enrollmentA.body.id}`).set('Authorization', `Bearer ${organizer.body.token}`).send({ operatorName: 'Operador 1' });
    expect(checkin.status).toBe(201);
    expect(checkin.body.status).toBe('CHECKED_IN');

    const duplicateCheckin = await request(app).post(`/api/v1/checkin/enrollments/${enrollmentA.body.id}`).set('Authorization', `Bearer ${organizer.body.token}`).send({ operatorName: 'Operador 2' });
    expect(duplicateCheckin.status).toBe(409);

    const notifications = await request(app).get('/api/v1/notifications').set('Authorization', `Bearer ${organizer.body.token}`);
    expect(notifications.status).toBe(200);
    expect(Array.isArray(notifications.body.items)).toBe(true);

    const docs = await request(app).post('/api/v1/documents').set('Authorization', `Bearer ${organizer.body.token}`).send({ tournamentId: tournament.body.id, title: 'Regulamento', fileName: 'regulamento.pdf', mimeType: 'application/pdf' });
    expect(docs.status).toBe(201);

    const documentsListing = await request(app).get('/api/v1/documents').set('Authorization', `Bearer ${organizer.body.token}`);
    expect(documentsListing.status).toBe(200);
    expect(documentsListing.body.items.length).toBeGreaterThan(0);

    const publicSummary = await request(app).get('/api/v1/public/summary');
    expect(publicSummary.status).toBe(200);
    expect(publicSummary.body.tournamentCount).toBeGreaterThanOrEqual(1);

    const judgeResult = await request(app).post(`/api/v1/partidas/${match.body.id}/resultado`).set('Authorization', `Bearer ${judge.body.token}`).send({ winnerParticipantId: teamA.body.id, scoreA: 2, scoreB: 1 });
    expect(judgeResult.status).toBe(201);
  });
});
