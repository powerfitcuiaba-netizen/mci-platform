import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

// Matriz de acesso cruzado. Cada caso monta dois atores do mesmo perfil e prova
// que um não alcança o recurso do outro. O que o servidor recusa aqui é a única
// garantia real: a interface apenas acompanha.
const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });

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

// Dois universos paralelos e independentes: A e B.
async function twoWorlds() {
  const admin = await register('Admin', 'admin@sec.test', 'ADMIN');

  const orgA = await register('Org A', 'orga@sec.test', 'ORGANIZER');
  const orgB = await register('Org B', 'orgb@sec.test', 'ORGANIZER');
  const judgeA = await register('Juiz A', 'juiza@sec.test', 'JUDGE');
  const judgeB = await register('Juiz B', 'juizb@sec.test', 'JUDGE');
  const coachA = await register('Coach A', 'coacha@sec.test', 'COACH');
  const coachB = await register('Coach B', 'coachb@sec.test', 'COACH');
  const athleteA = await register('Atleta A', 'atletaa@sec.test', 'ATHLETE');
  const athleteB = await register('Atleta B', 'atletab@sec.test', 'ATHLETE');

  const build = async (org, judge, coach, athlete, tag) => {
    const tournament = (await request(app).post(`${api}/campeonatos`).set(auth(org.token))
      .send({ name: `Evento ${tag}`, status: 'ACTIVE' })).body;
    const team1 = (await request(app).post(`${api}/equipes`).set(auth(org.token))
      .send({ name: `Equipe ${tag}1`, identification: `SEC-${tag}1`, coachId: coach.user.id })).body;
    const team2 = (await request(app).post(`${api}/equipes`).set(auth(org.token))
      .send({ name: `Equipe ${tag}2`, identification: `SEC-${tag}2` })).body;
    await prisma.participant.update({ where: { id: team1.id }, data: { userId: athlete.user.id } });

    const enrollment1 = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
      .set(auth(org.token)).send({ participantId: team1.id })).body;
    const enrollment2 = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
      .set(auth(org.token)).send({ participantId: team2.id })).body;
    const match = (await request(app).post(`${api}/partidas`).set(auth(org.token))
      .send({ tournamentId: tournament.id, participantAId: team1.id, participantBId: team2.id, status: 'IN_PROGRESS' })).body;
    await request(app).post(`${api}/judge/assignments`).set(auth(admin.token))
      .send({ tournamentId: tournament.id, judgeId: judge.user.id });
    const document = (await request(app).post(`${api}/documents`).set(auth(org.token))
      .send({ tournamentId: tournament.id, title: `Doc ${tag}`, fileName: `doc-${tag}.pdf` })).body;

    return { org, judge, coach, athlete, tournament, team1, team2, enrollment1, enrollment2, match, document };
  };

  const A = await build(orgA, judgeA, coachA, athleteA, 'A');
  const B = await build(orgB, judgeB, coachB, athleteB, 'B');
  return { admin, A, B };
}

describe('Segurança — acesso cruzado', () => {
  beforeEach(clearDatabase);

  describe('ORGANIZER', () => {
    it('opera o próprio evento e é barrado no evento alheio', async () => {
      const { A, B } = await twoWorlds();

      expect((await request(app).patch(`${api}/campeonatos/${A.tournament.id}`)
        .set(auth(A.org.token)).send({ name: 'Evento A renomeado' })).status).toBe(200);

      expect((await request(app).patch(`${api}/campeonatos/${B.tournament.id}`)
        .set(auth(A.org.token)).send({ name: 'Sequestro' })).status).toBe(403);
      expect((await request(app).delete(`${api}/campeonatos/${B.tournament.id}`)
        .set(auth(A.org.token))).status).toBe(403);
      expect((await request(app).get(`${api}/checkin/tournaments/${B.tournament.id}`)
        .set(auth(A.org.token))).status).toBe(403);
      expect((await request(app).get(`${api}/reports/tournaments/${B.tournament.id}`)
        .set(auth(A.org.token))).status).toBe(403);
      expect((await request(app).delete(`${api}/documents/${B.document.id}`)
        .set(auth(A.org.token))).status).toBe(403);
    });

    it('não enxerga a operação alheia no Backstage', async () => {
      const { A, B } = await twoWorlds();
      const view = await request(app).get(`${api}/backstage/overview`).set(auth(A.org.token));
      expect(view.status).toBe(200);
      expect(view.body.tournaments.map(item => item.id)).toEqual([A.tournament.id]);
      expect(view.body.tournaments.map(item => item.id)).not.toContain(B.tournament.id);
    });
  });

  describe('JUDGE', () => {
    it('lança resultado só onde está designado', async () => {
      const { A, B } = await twoWorlds();

      expect((await request(app).post(`${api}/partidas/${A.match.id}/resultado`).set(auth(A.judge.token))
        .send({ winnerParticipantId: A.team1.id, scoreA: 2, scoreB: 0 })).status).toBe(201);

      expect((await request(app).post(`${api}/partidas/${B.match.id}/resultado`).set(auth(A.judge.token))
        .send({ winnerParticipantId: B.team1.id, scoreA: 2, scoreB: 0 })).status).toBe(403);
      expect((await request(app).patch(`${api}/partidas/${B.match.id}`).set(auth(A.judge.token))
        .send({ status: 'CANCELLED' })).status).toBe(403);
    });

    it('só vê na sua agenda as partidas dos eventos em que foi designado', async () => {
      const { A, B } = await twoWorlds();
      const agenda = await request(app).get(`${api}/judge/matches`).set(auth(A.judge.token));
      expect(agenda.body.items.map(item => item.id)).toEqual([A.match.id]);
      expect(agenda.body.items.map(item => item.id)).not.toContain(B.match.id);
    });
  });

  describe('COACH', () => {
    it('administra o próprio elenco e é barrado no elenco alheio', async () => {
      const { A, B } = await twoWorlds();

      expect((await request(app).patch(`${api}/participantes/${A.team1.id}`)
        .set(auth(A.coach.token)).send({ name: 'Equipe A1 renomeada' })).status).toBe(200);

      expect((await request(app).patch(`${api}/participantes/${B.team1.id}`)
        .set(auth(A.coach.token)).send({ name: 'Sequestro' })).status).toBe(403);
      expect((await request(app).delete(`${api}/participantes/${B.team1.id}`)
        .set(auth(A.coach.token))).status).toBe(403);
      expect((await request(app).patch(`${api}/coach/participants/${B.team1.id}/team`)
        .set(auth(A.coach.token)).send({ teamId: null })).status).toBe(403);
    });

    it('não vê o elenco alheio na própria visão consolidada', async () => {
      const { A, B } = await twoWorlds();
      const view = await request(app).get(`${api}/coach/overview`).set(auth(A.coach.token));
      const ids = [...view.body.teams, ...view.body.athletes].map(item => item.id);
      expect(ids).toContain(A.team1.id);
      expect(ids).not.toContain(B.team1.id);
    });

    it('não consegue se apossar de participante enviando coachId no corpo', async () => {
      const { A, B } = await twoWorlds();
      const created = await request(app).post(`${api}/participantes`).set(auth(A.coach.token))
        .send({ name: 'Tentativa', identification: 'SEC-IDOR', type: 'PLAYER', coachId: B.coach.user.id });
      expect(created.status).toBe(201);
      expect(created.body.coachId).toBe(A.coach.user.id);

      const moved = await request(app).patch(`${api}/participantes/${A.team1.id}`)
        .set(auth(A.coach.token)).send({ coachId: B.coach.user.id });
      expect(moved.status).toBe(200);
      expect(moved.body.coachId).toBe(A.coach.user.id);
    });
  });

  describe('ATHLETE', () => {
    it('vê a própria inscrição e é barrado na de outro', async () => {
      const { A, B } = await twoWorlds();
      expect((await request(app).get(`${api}/checkin/enrollments/${A.enrollment1.id}`)
        .set(auth(A.athlete.token))).status).toBe(200);
      expect((await request(app).get(`${api}/checkin/enrollments/${A.enrollment2.id}`)
        .set(auth(A.athlete.token))).status).toBe(403);
      expect((await request(app).get(`${api}/checkin/enrollments/${B.enrollment1.id}`)
        .set(auth(A.athlete.token))).status).toBe(403);
    });

    it('não alcança documento de evento em que não participa', async () => {
      const { A, B } = await twoWorlds();
      expect((await request(app).get(`${api}/documents/${A.document.id}`).set(auth(A.athlete.token))).status).toBe(200);
      expect((await request(app).get(`${api}/documents/${B.document.id}`).set(auth(A.athlete.token))).status).toBe(403);
    });

    it('não escala privilégio para escrever no domínio', async () => {
      const { A } = await twoWorlds();
      expect((await request(app).post(`${api}/campeonatos`).set(auth(A.athlete.token))
        .send({ name: 'Evento do atleta' })).status).toBe(403);
      expect((await request(app).post(`${api}/partidas`).set(auth(A.athlete.token))
        .send({ tournamentId: A.tournament.id, participantAId: A.team1.id, participantBId: A.team2.id })).status).toBe(403);
      expect((await request(app).post(`${api}/documents`).set(auth(A.athlete.token))
        .send({ tournamentId: A.tournament.id, title: 'X', fileName: 'x.pdf' })).status).toBe(403);
      expect((await request(app).post(`${api}/judge/assignments`).set(auth(A.athlete.token))
        .send({ tournamentId: A.tournament.id, judgeId: A.judge.user.id })).status).toBe(403);
    });

    it('não lê a caixa de notificações de outro usuário', async () => {
      const { A, B } = await twoWorlds();
      const inbox = await request(app).get(`${api}/notifications`).set(auth(A.coach.token));
      const alheia = await request(app).get(`${api}/notifications`).set(auth(B.coach.token));
      const idsA = inbox.body.items.map(item => item.id);
      for (const item of alheia.body.items) expect(idsA).not.toContain(item.id);
      if (alheia.body.items[0]) {
        expect((await request(app).patch(`${api}/notifications/${alheia.body.items[0].id}/read`)
          .set(auth(A.coach.token))).status).toBe(404);
      }
    });
  });

  describe('Visitante anônimo', () => {
    it('alcança o MCI TV', async () => {
      await twoWorlds();
      expect((await request(app).get(`${api}/public/tournaments`)).status).toBe(200);
      expect((await request(app).get(`${api}/public/live`)).status).toBe(200);
      expect((await request(app).get(`${api}/public/summary`)).status).toBe(200);
    });

    it('recebe 401 em todo endpoint privado', async () => {
      const { A } = await twoWorlds();
      const privados = [
        ['get', '/auth/me'],
        ['get', '/dashboard/summary'],
        ['get', '/notifications'],
        ['get', '/documents'],
        ['get', '/backstage/overview'],
        ['get', '/coach/overview'],
        ['get', '/reports/tournaments'],
        ['get', '/judge/matches'],
        ['get', `/checkin/tournaments/${A.tournament.id}`]
      ];
      for (const [method, path] of privados) {
        const response = await request(app)[method](`${api}${path}`);
        expect(response.status, `${method.toUpperCase()} ${path}`).toBe(401);
      }
    });

    it('não recebe identificadores de posse nas leituras abertas', async () => {
      const { A } = await twoWorlds();
      const alvos = [
        `/campeonatos`,
        `/campeonatos/${A.tournament.id}`,
        `/campeonatos/${A.tournament.id}/participantes`,
        `/campeonatos/${A.tournament.id}/classificacao`,
        `/participantes`,
        `/equipes`,
        `/partidas`
      ];
      for (const path of alvos) {
        const response = await request(app).get(`${api}${path}`);
        expect(response.status, path).toBe(200);
        const payload = JSON.stringify(response.body);
        expect(payload, path).not.toContain('createdById');
        expect(payload, path).not.toContain('coachId');
        expect(payload, path).not.toContain('userId');
      }
    });

    it('mantém os identificadores para quem está autenticado', async () => {
      const { A } = await twoWorlds();
      const response = await request(app).get(`${api}/equipes`).set(auth(A.org.token));
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toContain('coachId');
    });
  });

  describe('Credenciais e token', () => {
    it('nunca devolve passwordHash em nenhuma superfície', async () => {
      const { A } = await twoWorlds();
      const respostas = await Promise.all([
        request(app).get(`${api}/auth/me`).set(auth(A.org.token)),
        request(app).get(`${api}/participantes`).set(auth(A.org.token)),
        request(app).get(`${api}/judge/assignments`).set(auth(A.org.token)),
        request(app).get(`${api}/public/tournaments`),
        request(app).post(`${api}/auth/login`).send({ email: 'orga@sec.test', password: 'Senha@123' })
      ]);
      for (const response of respostas) {
        expect(JSON.stringify(response.body)).not.toContain('passwordHash');
      }
    });

    it('recusa token forjado, malformado ou de assinatura inválida', async () => {
      await twoWorlds();
      const invalidos = [
        'Bearer nao-e-um-token',
        'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWxzbyIsInJvbGUiOiJBRE1JTiJ9.assinatura-invalida',
        'Bearer '
      ];
      for (const header of invalidos) {
        const response = await request(app).get(`${api}/auth/me`).set({ Authorization: header });
        expect(response.status, header).toBe(401);
      }
    });

    it('não aceita perfil inválido no registro', async () => {
      const response = await request(app).post(`${api}/auth/register`)
        .send({ name: 'Fulano', email: 'fulano@sec.test', password: 'Senha@123', role: 'SUPERADMIN' });
      expect(response.status).toBe(400);
    });
  });

  describe('Códigos de erro do domínio', () => {
    it('cobre 400, 401, 403, 404, 409 e 422', async () => {
      const { A } = await twoWorlds();

      // 400 — corpo inválido
      expect((await request(app).post(`${api}/campeonatos`).set(auth(A.org.token)).send({ name: '' })).status).toBe(400);
      // 401 — sem credencial
      expect((await request(app).get(`${api}/notifications`)).status).toBe(401);
      // 403 — sem permissão
      expect((await request(app).get(`${api}/backstage/overview`).set(auth(A.athlete.token))).status).toBe(403);
      // 404 — recurso inexistente
      expect((await request(app).get(`${api}/campeonatos/nao-existe`)).status).toBe(404);
      // 409 — duplicidade
      expect((await request(app).post(`${api}/campeonatos/${A.tournament.id}/participantes`)
        .set(auth(A.org.token)).send({ participantId: A.team1.id })).status).toBe(409);
      // 422 — violação semântica
      expect((await request(app).post(`${api}/documents`).set(auth(A.org.token))
        .send({ tournamentId: A.tournament.id, title: 'Trav', fileName: '../../etc/passwd' })).status).toBe(422);
      expect((await request(app).post(`${api}/partidas`).set(auth(A.org.token))
        .send({ tournamentId: A.tournament.id, participantAId: A.team1.id, participantBId: A.team1.id })).status).toBe(422);
    });

    it('devolve 204 sem corpo na exclusão', async () => {
      const { A } = await twoWorlds();
      const response = await request(app).delete(`${api}/documents/${A.document.id}`).set(auth(A.org.token));
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });
  });
});
