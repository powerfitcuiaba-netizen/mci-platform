import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });

// Campos que jamais podem aparecer numa resposta pública.
const PROIBIDOS = ['passwordHash', 'userId', 'createdById', 'coachId', 'checkedInById', 'uploadedById', 'operatorName', '@fech.test'];

async function clearDatabase() {
  await prisma.auditLog.deleteMany();
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

// Dois organizadores com operações independentes, para provar isolamento.
async function scenario() {
  const admin = await register('Admin', 'admin@fech.test', 'ADMIN');
  const orgA = await register('Org A', 'orga@fech.test', 'ORGANIZER');
  const orgB = await register('Org B', 'orgb@fech.test', 'ORGANIZER');
  const judge = await register('Juiz', 'juiz@fech.test', 'JUDGE');
  const coach = await register('Tecnico', 'coach@fech.test', 'COACH');
  const athlete = await register('Atleta', 'atleta@fech.test', 'ATHLETE');

  const build = async (org, tag) => {
    const tournament = (await request(app).post(`${api}/campeonatos`).set(auth(org.token))
      .send({ name: `Evento ${tag}`, status: 'ACTIVE' })).body;
    const team = (await request(app).post(`${api}/equipes`).set(auth(org.token))
      .send({ name: `Equipe ${tag}`, identification: `FECH-${tag}`, coachId: coach.user.id })).body;
    const rival = (await request(app).post(`${api}/equipes`).set(auth(org.token))
      .send({ name: `Rival ${tag}`, identification: `FECH-R${tag}` })).body;

    const e1 = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
      .set(auth(org.token)).send({ participantId: team.id })).body;
    await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
      .set(auth(org.token)).send({ participantId: rival.id });

    const match = (await request(app).post(`${api}/partidas`).set(auth(org.token))
      .send({ tournamentId: tournament.id, participantAId: team.id, participantBId: rival.id, status: 'IN_PROGRESS' })).body;

    await request(app).post(`${api}/judge/assignments`).set(auth(admin.token))
      .send({ tournamentId: tournament.id, judgeId: judge.user.id });
    await request(app).post(`${api}/checkin/enrollments/${e1.id}`).set(auth(org.token)).send({ operatorName: `Mesa ${tag}` });

    return { tournament, team, rival, match, enrollment: e1 };
  };

  const A = await build(orgA, 'A');
  const B = await build(orgB, 'B');

  // Um atleta com carreira: vinculado à equipe A e integrante do elenco.
  await prisma.participant.update({ where: { id: A.team.id }, data: { userId: athlete.user.id } });
  const atletaIndividual = await prisma.participant.create({
    data: { name: 'Bruno Publico', identification: 'FECH-P1', type: 'PLAYER', coachId: coach.user.id, teamId: A.team.id, createdById: orgA.user.id }
  });
  await prisma.enrollment.create({ data: { tournamentId: A.tournament.id, participantId: atletaIndividual.id, status: 'CONFIRMED' } });

  await request(app).post(`${api}/partidas/${A.match.id}/resultado`).set(auth(judge.token))
    .send({ winnerParticipantId: A.team.id, scoreA: 3, scoreB: 1 });

  return { admin, orgA, orgB, judge, coach, athlete, A, B, atletaIndividual };
}

describe('Fase 4 — fechamento: páginas públicas, Organizer Center e dashboards', () => {
  beforeEach(clearDatabase);

  describe('Páginas públicas de atleta e equipe', () => {
    it('abre a lista e o detalhe do atleta sem login', async () => {
      const s = await scenario();

      const lista = await request(app).get(`${api}/public/athletes`);
      expect(lista.status).toBe(200);
      expect(lista.body.items.map(item => item.id)).toContain(s.atletaIndividual.id);

      const detalhe = await request(app).get(`${api}/public/athletes/${s.atletaIndividual.id}`);
      expect(detalhe.status).toBe(200);
      expect(detalhe.body.participant.name).toBe('Bruno Publico');
      expect(detalhe.body.team.name).toBe('Equipe A');
      expect(detalhe.body.tournaments.map(item => item.id)).toContain(s.A.tournament.id);
    });

    it('abre a lista e o detalhe da equipe sem login, com elenco e desempenho', async () => {
      const s = await scenario();

      const lista = await request(app).get(`${api}/public/teams`);
      expect(lista.status).toBe(200);
      expect(lista.body.items.map(item => item.id)).toContain(s.A.team.id);

      const detalhe = await request(app).get(`${api}/public/teams/${s.A.team.id}`);
      expect(detalhe.status).toBe(200);
      expect(detalhe.body.participant.name).toBe('Equipe A');
      expect(detalhe.body.members.map(item => item.id)).toContain(s.atletaIndividual.id);
      expect(detalhe.body.standings[0].points).toBe(3);
      expect(detalhe.body.totals.wins).toBe(1);
      expect(detalhe.body.results).toHaveLength(1);
    });

    it('não expõe nenhum dado privado no payload inteiro', async () => {
      const s = await scenario();
      const rotas = [
        '/public/athletes',
        `/public/athletes/${s.atletaIndividual.id}`,
        '/public/teams',
        `/public/teams/${s.A.team.id}`
      ];
      for (const rota of rotas) {
        const resposta = await request(app).get(`${api}${rota}`);
        expect(resposta.status, rota).toBe(200);
        const payload = JSON.stringify(resposta.body);
        for (const proibido of PROIBIDOS) {
          expect(payload, `${rota} vazou ${proibido}`).not.toContain(proibido);
        }
      }
    });

    it('devolve 404 para inexistente e não confunde atleta com equipe', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/public/athletes/nao-existe`)).status).toBe(404);
      expect((await request(app).get(`${api}/public/teams/nao-existe`)).status).toBe(404);
      // Uma equipe não é servida pela rota de atleta, nem o contrário.
      expect((await request(app).get(`${api}/public/athletes/${s.A.team.id}`)).status).toBe(404);
      expect((await request(app).get(`${api}/public/teams/${s.atletaIndividual.id}`)).status).toBe(404);
    });

    it('não lista participante sem inscrição confirmada', async () => {
      const s = await scenario();
      const oculto = await prisma.participant.create({
        data: { name: 'Nunca Competiu', identification: 'FECH-X9', type: 'PLAYER', createdById: s.orgA.user.id }
      });

      const lista = await request(app).get(`${api}/public/athletes`);
      expect(lista.body.items.map(item => item.id)).not.toContain(oculto.id);
      expect((await request(app).get(`${api}/public/athletes/${oculto.id}`)).status).toBe(404);
    });

    it('some da vitrine quando a inscrição é cancelada', async () => {
      const s = await scenario();
      const inscricao = await prisma.enrollment.findFirst({ where: { participantId: s.atletaIndividual.id } });
      await request(app).patch(`${api}/inscricoes/${inscricao.id}/cancel`).set(auth(s.orgA.token));

      const lista = await request(app).get(`${api}/public/athletes`);
      expect(lista.body.items.map(item => item.id)).not.toContain(s.atletaIndividual.id);
    });
  });

  describe('Dashboard por perfil', () => {
    it('entrega ao ADMIN o retrato global', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.admin.token));
      expect(d.status).toBe(200);
      expect(d.body.role).toBe('ADMIN');
      expect(d.body.totals.users).toBeGreaterThanOrEqual(6);
      expect(d.body.totals.tournaments).toBe(2);
      expect(d.body.usersByRole).toBeTruthy();
      expect(Array.isArray(d.body.recentAudit)).toBe(true);
    });

    it('entrega ao ORGANIZER apenas a própria operação', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.orgA.token));
      expect(d.status).toBe(200);
      expect(d.body.role).toBe('ORGANIZER');
      expect(d.body.totals.tournaments).toBe(1);
      expect(d.body.totals.enrollments).toBe(3);
      expect(d.body.totals.checkedIn).toBe(1);
      expect(d.body.totals.judges).toBe(1);
      // Nada do evento do organizador B atravessa.
      expect(JSON.stringify(d.body)).not.toContain(s.B.tournament.id);
      expect(JSON.stringify(d.body)).not.toContain('Evento B');
    });

    it('entrega ao JUDGE a agenda separada por momento', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.judge.token));
      expect(d.status).toBe(200);
      expect(d.body.role).toBe('JUDGE');
      expect(d.body.totals.assignments).toBe(2);
      expect(d.body.totals.finished).toBe(1);
      expect(Array.isArray(d.body.upcomingMatches)).toBe(true);
      expect(Array.isArray(d.body.pendingResults)).toBe(true);
      expect(d.body.tournaments).toHaveLength(2);
    });

    it('entrega ao COACH o elenco e a agenda', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.coach.token));
      expect(d.status).toBe(200);
      expect(d.body.role).toBe('COACH');
      expect(d.body.totals.teams).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(d.body.upcomingMatches)).toBe(true);
      expect(Array.isArray(d.body.standings)).toBe(true);
    });

    it('entrega ao ATHLETE a própria carreira e nada de terceiros', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.athlete.token));
      expect(d.status).toBe(200);
      expect(d.body.role).toBe('ATHLETE');
      expect(d.body.participant.id).toBe(s.A.team.id);
      expect(d.body.totals.wins).toBe(1);
      expect(JSON.stringify(d.body)).not.toContain(s.B.tournament.id);
    });

    it('os cinco perfis recebem conteúdos diferentes na mesma rota', async () => {
      const s = await scenario();
      const perfis = { ADMIN: s.admin, ORGANIZER: s.orgA, JUDGE: s.judge, COACH: s.coach, ATHLETE: s.athlete };
      const formas = {};
      for (const [nome, ator] of Object.entries(perfis)) {
        const d = await request(app).get(`${api}/dashboard/summary`).set(auth(ator.token));
        expect(d.status, nome).toBe(200);
        expect(d.body.role, nome).toBe(nome);
        formas[nome] = Object.keys(d.body).sort().join(',');
      }
      // Nenhum par de perfis recebe exatamente a mesma estrutura.
      const distintas = new Set(Object.values(formas));
      expect(distintas.size).toBe(5);
    });

    it('exige autenticação', async () => {
      expect((await request(app).get(`${api}/dashboard/summary`)).status).toBe(401);
    });
  });

  describe('Organizer Center — isolamento entre organizadores', () => {
    it('cada organizador enxerga apenas a própria operação em todas as fontes', async () => {
      const s = await scenario();

      const fontes = [
        ['/backstage/overview', body => body.tournaments.map(item => item.id)],
        ['/reports/tournaments', body => body.items.map(item => item.id)],
        ['/dashboard/summary', body => body.activeTournaments.map(item => item.id)]
      ];

      for (const [rota, extrair] of fontes) {
        const visaoA = await request(app).get(`${api}${rota}`).set(auth(s.orgA.token));
        const visaoB = await request(app).get(`${api}${rota}`).set(auth(s.orgB.token));
        expect(visaoA.status, rota).toBe(200);
        expect(visaoB.status, rota).toBe(200);
        expect(extrair(visaoA.body), rota).toContain(s.A.tournament.id);
        expect(extrair(visaoA.body), rota).not.toContain(s.B.tournament.id);
        expect(extrair(visaoB.body), rota).toContain(s.B.tournament.id);
        expect(extrair(visaoB.body), rota).not.toContain(s.A.tournament.id);
      }
    });

    it('barra o organizador em recurso alheio mesmo com o id correto em mãos', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/checkin/tournaments/${s.B.tournament.id}`).set(auth(s.orgA.token))).status).toBe(403);
      expect((await request(app).get(`${api}/reports/tournaments/${s.B.tournament.id}`).set(auth(s.orgA.token))).status).toBe(403);
      expect((await request(app).patch(`${api}/campeonatos/${s.B.tournament.id}`).set(auth(s.orgA.token)).send({ name: 'Tomado' })).status).toBe(403);
      expect((await request(app).patch(`${api}/inscricoes/${s.B.enrollment.id}/cancel`).set(auth(s.orgA.token))).status).toBe(403);
    });

    it('mostra ao organizador os juízes designados aos próprios eventos', async () => {
      const s = await scenario();
      const d = await request(app).get(`${api}/dashboard/summary`).set(auth(s.orgA.token));
      expect(d.body.judges).toHaveLength(1);
      expect(d.body.judges[0].judge.name).toBe('Juiz');
      expect(d.body.judges[0].tournament.id).toBe(s.A.tournament.id);
      // O nome do juiz é operacional; o email dele não entra no painel.
      expect(JSON.stringify(d.body.judges)).not.toContain('juiz@fech.test');
    });
  });
});
