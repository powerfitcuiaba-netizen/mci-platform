import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('Auth API', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  it('registers, logs in and returns current user', async () => {
    const register = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Ana', email: 'ana@example.com', password: 'Senha@123', role: 'ORGANIZER' });

    expect(register.status).toBe(201);
    expect(register.body.user).toMatchObject({ name: 'Ana', email: 'ana@example.com', role: 'ORGANIZER' });
    expect(register.body.user.passwordHash).toBeUndefined();

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ana@example.com', password: 'Senha@123' });

    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe('ana@example.com');
    expect(login.body.token).toBeTruthy();

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ana@example.com');
  });

  it('rejects duplicate email and invalid credentials', async () => {
    await request(app).post('/api/v1/auth/register').send({ name: 'Ana', email: 'ana@example.com', password: 'Senha@123' });
    const duplicate = await request(app).post('/api/v1/auth/register').send({ name: 'Ana', email: 'ana@example.com', password: 'Outra@456' });
    expect(duplicate.status).toBe(409);

    const wrongPassword = await request(app).post('/api/v1/auth/login').send({ email: 'ana@example.com', password: 'SenhaErrada@123' });
    expect(wrongPassword.status).toBe(401);

    const invalidEmail = await request(app).post('/api/v1/auth/register').send({ name: 'Ana', email: 'nao-e-email', password: 'Senha@123' });
    expect(invalidEmail.status).toBe(400);
  });

  it('enforces access control for protected routes', async () => {
    const organizer = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Org', email: 'org@example.com', password: 'Senha@123', role: 'ORGANIZER' });

    const athlete = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Atl', email: 'atl@example.com', password: 'Senha@123', role: 'ATHLETE' });

    const organizerToken = organizer.body.token;
    const athleteToken = athlete.body.token;

    const createTournamentAsOrganizer = await request(app)
      .post('/api/v1/campeonatos')
      .set('Authorization', `Bearer ${organizerToken}`)
      .send({ name: 'Campeonato Protegido' });
    expect(createTournamentAsOrganizer.status).toBe(201);

    const athleteTryToCreateTournament = await request(app)
      .post('/api/v1/campeonatos')
      .set('Authorization', `Bearer ${athleteToken}`)
      .send({ name: 'Sem permissão' });
    expect(athleteTryToCreateTournament.status).toBe(403);
  });
});
