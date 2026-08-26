import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';

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

// Cenário completo: dois organizadores distintos para provar isolamento, um juiz
// designado, um técnico com elenco próprio e um atleta ligado a um participante.
async function scenario() {
  const admin = await register('Admin', 'admin@mci.test', 'ADMIN');
  const organizer = await register('Organizador', 'org@mci.test', 'ORGANIZER');
  const rival = await register('Organizador Rival', 'rival@mci.test', 'ORGANIZER');
  const judge = await register('Juiz', 'juiz@mci.test', 'JUDGE');
  const coach = await register('Tecnico', 'coach@mci.test', 'COACH');
  const otherCoach = await register('Tecnico Rival', 'coach2@mci.test', 'COACH');
  const athlete = await register('Atleta', 'atleta@mci.test', 'ATHLETE');

  const tournament = (await request(app).post(`${api}/campeonatos`).set(auth(organizer.token))
    .send({ name: 'Copa Operacional', status: 'ACTIVE' })).body;

  const teamA = (await request(app).post(`${api}/equipes`).set(auth(organizer.token))
    .send({ name: 'Equipe A', identification: 'OP-A', coachId: coach.user.id })).body;
  const teamB = (await request(app).post(`${api}/equipes`).set(auth(organizer.token))
    .send({ name: 'Equipe B', identification: 'OP-B' })).body;

  // O vínculo atleta -> participante não passa pela API pública de cadastro.
  await prisma.participant.update({ where: { id: teamA.id }, data: { userId: athlete.user.id } });

  const enrollmentA = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
    .set(auth(organizer.token)).send({ participantId: teamA.id })).body;
  const enrollmentB = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
    .set(auth(organizer.token)).send({ participantId: teamB.id })).body;

  const match = (await request(app).post(`${api}/partidas`).set(auth(organizer.token))
    .send({ tournamentId: tournament.id, participantAId: teamA.id, participantBId: teamB.id, status: 'IN_PROGRESS' })).body;

  await request(app).post(`${api}/judge/assignments`).set(auth(admin.token))
    .send({ tournamentId: tournament.id, judgeId: judge.user.id });

  return { admin, organizer, rival, judge, coach, otherCoach, athlete, tournament, teamA, teamB, enrollmentA, enrollmentB, match };
}

describe('Fase 3 — módulos operacionais', () => {
  beforeEach(clearDatabase);

  describe('Check-in', () => {
    it('lista inscritos com estado derivado e conta os totais', async () => {
      const s = await scenario();
      const listing = await request(app).get(`${api}/checkin/tournaments/${s.tournament.id}`).set(auth(s.organizer.token));
      expect(listing.status).toBe(200);
      expect(listing.body.total).toBe(2);
      expect(listing.body.pending).toBe(2);
      expect(listing.body.items.every(item => item.status === 'PENDING')).toBe(true);
    });

    it('registra, rejeita duplicidade, cancela e permite refazer', async () => {
      const s = await scenario();
      const first = await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({ operatorName: 'Mesa 1' });
      expect(first.status).toBe(201);
      expect(first.body.status).toBe('CHECKED_IN');

      const duplicate = await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});
      expect(duplicate.status).toBe(409);

      const cancelled = await request(app).patch(`${api}/checkin/enrollments/${s.enrollmentA.id}/cancel`).set(auth(s.organizer.token));
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const again = await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});
      expect(again.status).toBe(201);
      expect(again.body.status).toBe('CHECKED_IN');
    });

    it('impede que um organizador opere o campeonato de outro', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/checkin/tournaments/${s.tournament.id}`).set(auth(s.rival.token))).status).toBe(403);
      expect((await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.rival.token)).send({})).status).toBe(403);
    });

    it('deixa o atleta ver a própria situação e barra a de terceiros', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.athlete.token))).status).toBe(200);
      expect((await request(app).get(`${api}/checkin/enrollments/${s.enrollmentB.id}`).set(auth(s.athlete.token))).status).toBe(403);
      expect((await request(app).post(`${api}/checkin/enrollments/${s.enrollmentB.id}`).set(auth(s.athlete.token)).send({})).status).toBe(403);
    });

    it('devolve 404 para inscrição inexistente', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/checkin/enrollments/nao-existe`).set(auth(s.organizer.token))).status).toBe(404);
    });
  });

  describe('Judge Center', () => {
    it('entrega ao juiz apenas as partidas dos campeonatos em que foi designado', async () => {
      const s = await scenario();
      const matches = await request(app).get(`${api}/judge/matches`).set(auth(s.judge.token));
      expect(matches.status).toBe(200);
      expect(matches.body.items).toHaveLength(1);
      expect(matches.body.items[0].id).toBe(s.match.id);
    });

    it('permite ao juiz designado lançar resultado e recalcular a classificação', async () => {
      const s = await scenario();
      const result = await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 3, scoreB: 1 });
      expect(result.status).toBe(201);

      const standings = await request(app).get(`${api}/campeonatos/${s.tournament.id}/classificacao`);
      expect(standings.body[0].participantId).toBe(s.teamA.id);
      expect(standings.body[0].points).toBe(3);
    });

    it('barra juiz sem designação no campeonato', async () => {
      const s = await scenario();
      const outsider = await register('Juiz Externo', 'juiz2@mci.test', 'JUDGE');
      const attempt = await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(outsider.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 1, scoreB: 0 });
      expect(attempt.status).toBe(403);
      expect((await request(app).get(`${api}/judge/matches`).set(auth(outsider.token))).body.items).toHaveLength(0);
    });

    it('recusa designação duplicada e juiz inexistente', async () => {
      const s = await scenario();
      const duplicate = await request(app).post(`${api}/judge/assignments`).set(auth(s.admin.token))
        .send({ tournamentId: s.tournament.id, judgeId: s.judge.user.id });
      expect(duplicate.status).toBe(409);

      const missing = await request(app).post(`${api}/judge/assignments`).set(auth(s.admin.token))
        .send({ tournamentId: s.tournament.id, judgeId: s.athlete.user.id });
      expect(missing.status).toBe(404);
    });
  });

  describe('Notificações', () => {
    it('emite na inscrição para o técnico do participante sem notificar o autor', async () => {
      const s = await scenario();
      const coachInbox = await request(app).get(`${api}/notifications`).set(auth(s.coach.token));
      expect(coachInbox.status).toBe(200);
      expect(coachInbox.body.items.some(item => item.type === 'ENROLLMENT')).toBe(true);

      // O organizador executou a inscrição: não recebe eco da própria ação.
      const ownInbox = await request(app).get(`${api}/notifications`).set(auth(s.organizer.token));
      expect(ownInbox.body.items.some(item => item.type === 'ENROLLMENT')).toBe(false);
    });

    it('emite no check-in e no resultado', async () => {
      const s = await scenario();
      await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});
      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 2, scoreB: 0 });

      const inbox = await request(app).get(`${api}/notifications`).set(auth(s.coach.token));
      const types = inbox.body.items.map(item => item.type);
      expect(types).toContain('CHECKIN');
      expect(types).toContain('RESULT');
    });

    it('marca como lida, marca todas e isola a caixa de cada usuário', async () => {
      const s = await scenario();
      const inbox = await request(app).get(`${api}/notifications`).set(auth(s.coach.token));
      const target = inbox.body.items[0];
      expect(inbox.body.unreadCount).toBeGreaterThan(0);

      const read = await request(app).patch(`${api}/notifications/${target.id}/read`).set(auth(s.coach.token));
      expect(read.status).toBe(200);
      expect(read.body.isRead).toBe(true);

      // A notificação pertence a outro usuário: sequer deve ser localizável.
      expect((await request(app).patch(`${api}/notifications/${target.id}/read`).set(auth(s.rival.token))).status).toBe(404);

      expect((await request(app).post(`${api}/notifications/read-all`).set(auth(s.coach.token))).status).toBe(200);
      expect((await request(app).get(`${api}/notifications`).set(auth(s.coach.token))).body.unreadCount).toBe(0);
    });

    it('exige autenticação', async () => {
      expect((await request(app).get(`${api}/notifications`)).status).toBe(401);
    });
  });

  describe('Documentos', () => {
    it('cria, lista e filtra por campeonato', async () => {
      const s = await scenario();
      const created = await request(app).post(`${api}/documents`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, title: 'Regulamento', fileName: 'regulamento.pdf', mimeType: 'application/pdf' });
      expect(created.status).toBe(201);

      const listing = await request(app).get(`${api}/documents?tournamentId=${s.tournament.id}`).set(auth(s.organizer.token));
      expect(listing.body.items).toHaveLength(1);
    });

    it('rejeita nome de arquivo com travessia de diretório', async () => {
      const s = await scenario();
      for (const fileName of ['../../etc/passwd', 'pasta/arquivo.pdf', '..']) {
        const attempt = await request(app).post(`${api}/documents`).set(auth(s.organizer.token))
          .send({ tournamentId: s.tournament.id, title: 'Malicioso', fileName });
        expect(attempt.status).toBe(422);
      }
    });

    it('dá leitura a quem participa do campeonato e barra estranhos', async () => {
      const s = await scenario();
      const doc = (await request(app).post(`${api}/documents`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, title: 'Ficha', fileName: 'ficha.pdf' })).body;

      // O atleta está ligado ao participante inscrito.
      expect((await request(app).get(`${api}/documents/${doc.id}`).set(auth(s.athlete.token))).status).toBe(200);
      // O técnico do participante inscrito também enxerga.
      expect((await request(app).get(`${api}/documents/${doc.id}`).set(auth(s.coach.token))).status).toBe(200);
      // Um técnico sem vínculo, não.
      expect((await request(app).get(`${api}/documents/${doc.id}`).set(auth(s.otherCoach.token))).status).toBe(403);
    });

    it('só o dono do campeonato ou ADMIN exclui', async () => {
      const s = await scenario();
      const doc = (await request(app).post(`${api}/documents`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, title: 'Ata', fileName: 'ata.pdf' })).body;

      expect((await request(app).delete(`${api}/documents/${doc.id}`).set(auth(s.rival.token))).status).toBe(403);
      expect((await request(app).delete(`${api}/documents/${doc.id}`).set(auth(s.organizer.token))).status).toBe(204);
      expect((await request(app).get(`${api}/documents/${doc.id}`).set(auth(s.organizer.token))).status).toBe(404);
    });
  });

  describe('Coach Center', () => {
    it('mostra ao técnico o próprio elenco, campeonatos e agenda', async () => {
      const s = await scenario();
      const overview = await request(app).get(`${api}/coach/overview`).set(auth(s.coach.token));
      expect(overview.status).toBe(200);
      expect(overview.body.totals.teams).toBe(1);
      expect(overview.body.tournaments).toHaveLength(1);
      expect(overview.body.matches).toHaveLength(1);
    });

    it('isola elencos entre técnicos diferentes', async () => {
      const s = await scenario();
      const rivalView = await request(app).get(`${api}/coach/overview`).set(auth(s.otherCoach.token));
      expect(rivalView.status).toBe(200);
      expect(rivalView.body.totals.teams).toBe(0);
      expect(rivalView.body.tournaments).toHaveLength(0);
    });

    it('impede o técnico de mover atleta que não é seu', async () => {
      const s = await scenario();
      const attempt = await request(app).patch(`${api}/coach/participants/${s.teamB.id}/team`)
        .set(auth(s.coach.token)).send({ teamId: null });
      expect(attempt.status).toBe(403);
    });

    it('força o vínculo do técnico no cadastro, ignorando coachId do corpo', async () => {
      const s = await scenario();
      const created = await request(app).post(`${api}/participantes`).set(auth(s.coach.token))
        .send({ name: 'Atleta Novo', identification: 'COACH-1', type: 'PLAYER', coachId: s.otherCoach.user.id });
      expect(created.status).toBe(201);
      expect(created.body.coachId).toBe(s.coach.user.id);
    });

    it('nega acesso a quem não é técnico nem ADMIN', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/coach/overview`).set(auth(s.athlete.token))).status).toBe(403);
    });
  });

  describe('Backstage', () => {
    it('consolida a operação do organizador com alertas reais', async () => {
      const s = await scenario();
      await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});

      const overview = await request(app).get(`${api}/backstage/overview`).set(auth(s.organizer.token));
      expect(overview.status).toBe(200);
      expect(overview.body.totals.tournaments).toBe(1);
      expect(overview.body.totals.enrollments).toBe(2);
      expect(overview.body.totals.checkedIn).toBe(1);
      expect(overview.body.totals.pendingCheckIn).toBe(1);
      expect(overview.body.totals.liveMatches).toBe(1);
      expect(overview.body.alerts.some(alert => alert.code === 'PENDING_CHECKIN')).toBe(true);
    });

    it('não mostra a um organizador a operação de outro', async () => {
      const s = await scenario();
      const rivalView = await request(app).get(`${api}/backstage/overview`).set(auth(s.rival.token));
      expect(rivalView.status).toBe(200);
      expect(rivalView.body.totals.tournaments).toBe(0);
      expect(rivalView.body.tournaments).toHaveLength(0);
    });

    it('nega acesso a atleta e juiz', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/backstage/overview`).set(auth(s.athlete.token))).status).toBe(403);
      expect((await request(app).get(`${api}/backstage/overview`).set(auth(s.judge.token))).status).toBe(403);
    });
  });

  describe('Relatórios', () => {
    it('gera relatório consolidado do campeonato', async () => {
      const s = await scenario();
      await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});
      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 2, scoreB: 1 });

      const report = await request(app).get(`${api}/reports/tournaments/${s.tournament.id}`).set(auth(s.organizer.token));
      expect(report.status).toBe(200);
      expect(report.body.summary.enrollments).toBe(2);
      expect(report.body.summary.checkedIn).toBe(1);
      expect(report.body.summary.pendingCheckIn).toBe(1);
      expect(report.body.summary.matchesWithResult).toBe(1);
      expect(report.body.standings[0].participant.id).toBe(s.teamA.id);
      expect(report.body.enrollments[0].checkInStatus).toBe('CHECKED_IN');
    });

    it('barra relatório de campeonato alheio e responde 404 para inexistente', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/reports/tournaments/${s.tournament.id}`).set(auth(s.rival.token))).status).toBe(403);
      expect((await request(app).get(`${api}/reports/tournaments/inexistente`).set(auth(s.admin.token))).status).toBe(404);
    });
  });

  describe('Dashboard', () => {
    it('devolve números reais do escopo do organizador', async () => {
      const s = await scenario();
      const summary = await request(app).get(`${api}/dashboard/summary`).set(auth(s.organizer.token));
      expect(summary.status).toBe(200);
      expect(summary.body.totals.activeTournaments).toBe(1);
      expect(summary.body.totals.enrollments).toBe(2);
      expect(summary.body.totals.liveMatches).toBe(1);
      expect(summary.body.totals.teams).toBeGreaterThanOrEqual(2);
      expect(summary.body.liveMatches[0].id).toBe(s.match.id);
    });

    it('exige autenticação', async () => {
      expect((await request(app).get(`${api}/dashboard/summary`)).status).toBe(401);
    });
  });

  describe('MCI TV (público)', () => {
    it('abre campeonatos, detalhe e grade ao vivo sem login', async () => {
      const s = await scenario();
      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 2, scoreB: 1 });

      const listing = await request(app).get(`${api}/public/tournaments`);
      expect(listing.status).toBe(200);
      expect(listing.body.items).toHaveLength(1);

      const detail = await request(app).get(`${api}/public/tournaments/${s.tournament.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.standings[0].participant.name).toBe('Equipe A');
      expect(detail.body.results).toHaveLength(1);

      const live = await request(app).get(`${api}/public/live`);
      expect(live.status).toBe(200);
      expect(Array.isArray(live.body.liveMatches)).toBe(true);
    });

    it('não vaza dado de usuário na superfície pública', async () => {
      const s = await scenario();
      const detail = await request(app).get(`${api}/public/tournaments/${s.tournament.id}`);
      const payload = JSON.stringify(detail.body);
      expect(payload).not.toContain('@mci.test');
      expect(payload).not.toContain('passwordHash');
      expect(payload).not.toContain('createdById');
      expect(detail.body.matches[0].participantA.userId).toBeUndefined();
    });

    it('devolve 404 para campeonato público inexistente', async () => {
      expect((await request(app).get(`${api}/public/tournaments/nao-existe`)).status).toBe(404);
    });
  });
});
