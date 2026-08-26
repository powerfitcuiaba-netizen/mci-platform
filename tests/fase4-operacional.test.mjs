import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/app.js';
import prisma from '../src/config/prisma.js';
import storage from '../src/services/storageService.js';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';

const api = '/api/v1';
const auth = token => ({ Authorization: `Bearer ${token}` });

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

const PDF = Buffer.from('%PDF-1.4\nconteudo de teste do MCI\n%%EOF');

async function scenario() {
  const admin = await register('Admin', 'admin@f4.test', 'ADMIN');
  const organizer = await register('Organizador', 'org@f4.test', 'ORGANIZER');
  const rival = await register('Organizador Rival', 'rival@f4.test', 'ORGANIZER');
  const judge = await register('Juiz', 'juiz@f4.test', 'JUDGE');
  const coach = await register('Tecnico', 'coach@f4.test', 'COACH');
  const athlete = await register('Atleta', 'atleta@f4.test', 'ATHLETE');
  const outsider = await register('Atleta Externo', 'externo@f4.test', 'ATHLETE');

  const tournament = (await request(app).post(`${api}/campeonatos`).set(auth(organizer.token))
    .send({ name: 'Copa Fase 4', status: 'ACTIVE' })).body;

  const teamA = (await request(app).post(`${api}/equipes`).set(auth(organizer.token))
    .send({ name: 'Equipe F4A', identification: 'F4-A', coachId: coach.user.id })).body;
  const teamB = (await request(app).post(`${api}/equipes`).set(auth(organizer.token))
    .send({ name: 'Equipe F4B', identification: 'F4-B' })).body;

  await prisma.participant.update({ where: { id: teamA.id }, data: { userId: athlete.user.id } });

  const enrollmentA = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
    .set(auth(organizer.token)).send({ participantId: teamA.id })).body;
  const enrollmentB = (await request(app).post(`${api}/campeonatos/${tournament.id}/participantes`)
    .set(auth(organizer.token)).send({ participantId: teamB.id })).body;

  const match = (await request(app).post(`${api}/partidas`).set(auth(organizer.token))
    .send({ tournamentId: tournament.id, participantAId: teamA.id, participantBId: teamB.id, status: 'IN_PROGRESS' })).body;

  await request(app).post(`${api}/judge/assignments`).set(auth(admin.token))
    .send({ tournamentId: tournament.id, judgeId: judge.user.id });

  return { admin, organizer, rival, judge, coach, athlete, outsider, tournament, teamA, teamB, enrollmentA, enrollmentB, match };
}

describe('Fase 4 — experiência por perfil, documentos e auditoria', () => {
  beforeEach(clearDatabase);
  // A suíte grava arquivos de verdade; o diretório de teste é descartado ao fim.
  afterAll(async () => { await rm(storage.ROOT, { recursive: true, force: true }); });

  describe('Documentos com arquivo real', () => {
    it('envia, lista, baixa e devolve exatamente o conteúdo gravado', async () => {
      const s = await scenario();

      const envio = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .field('title', 'Regulamento Oficial')
        .attach('file', PDF, { filename: 'regulamento.pdf', contentType: 'application/pdf' });

      expect(envio.status).toBe(201);
      expect(envio.body.sizeBytes).toBe(PDF.length);
      expect(envio.body.title).toBe('Regulamento Oficial');
      // A chave de armazenamento nunca sai na resposta.
      expect(JSON.stringify(envio.body)).not.toContain('storageKey');

      const download = await request(app).get(`${api}/documents/${envio.body.id}/download`).set(auth(s.organizer.token));
      expect(download.status).toBe(200);
      expect(download.headers['content-type']).toContain('application/pdf');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(download.body).equals(PDF)).toBe(true);
    });

    it('grava o arquivo fora do repositório e o remove junto com o registro', async () => {
      const s = await scenario();
      const envio = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'ata.pdf', contentType: 'application/pdf' });
      expect(envio.status).toBe(201);

      const registro = await prisma.document.findUnique({ where: { id: envio.body.id } });
      expect(registro.storageKey).toBeTruthy();
      expect(await storage.exists(registro.storageKey)).toBe(true);
      // A raiz fica num diretorio de uploads ignorado pelo git — uploads/ na
      // aplicacao, uploads-test/ na suite — e nunca dentro de src/ ou frontend/.
      // basename resolve os dois separadores; no Windows o caminho usa barra invertida.
      expect(basename(storage.ROOT)).toMatch(/^uploads(-test)?$/);

      expect((await request(app).delete(`${api}/documents/${envio.body.id}`).set(auth(s.organizer.token))).status).toBe(204);
      expect(await storage.exists(registro.storageKey)).toBe(false);
    });

    it('recusa tipo não permitido e envio sem arquivo', async () => {
      const s = await scenario();

      const executavel = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', Buffer.from('MZ binario'), { filename: 'virus.exe', contentType: 'application/x-msdownload' });
      expect(executavel.status).toBe(415);

      const semArquivo = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id);
      expect(semArquivo.status).toBe(422);

      const semMultipart = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id });
      expect(semMultipart.status).toBe(415);
    });

    it('não deixa resíduo em disco quando o envio não é autorizado', async () => {
      const s = await scenario();
      const antes = await prisma.document.count();

      const alheio = await request(app).post(`${api}/documents/upload`).set(auth(s.rival.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'invasao.pdf', contentType: 'application/pdf' });
      expect(alheio.status).toBe(403);

      const atleta = await request(app).post(`${api}/documents/upload`).set(auth(s.athlete.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'atleta.pdf', contentType: 'application/pdf' });
      expect(atleta.status).toBe(403);

      expect(await prisma.document.count()).toBe(antes);
    });

    it('rejeita travessia de diretório no nome enviado', async () => {
      const s = await scenario();
      const ataque = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .field('fileName', '../../../etc/passwd')
        .attach('file', PDF, { filename: 'ok.pdf', contentType: 'application/pdf' });
      expect(ataque.status).toBe(422);
    });

    it('libera download a quem participa e barra quem não participa', async () => {
      const s = await scenario();
      const envio = await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'ficha.pdf', contentType: 'application/pdf' });

      expect((await request(app).get(`${api}/documents/${envio.body.id}/download`).set(auth(s.athlete.token))).status).toBe(200);
      expect((await request(app).get(`${api}/documents/${envio.body.id}/download`).set(auth(s.coach.token))).status).toBe(200);
      expect((await request(app).get(`${api}/documents/${envio.body.id}/download`).set(auth(s.outsider.token))).status).toBe(403);
      expect((await request(app).get(`${api}/documents/${envio.body.id}/download`)).status).toBe(401);
    });

    it('devolve 409 ao baixar documento que é apenas registro de metadados', async () => {
      const s = await scenario();
      const registro = await request(app).post(`${api}/documents`).set(auth(s.organizer.token))
        .send({ tournamentId: s.tournament.id, title: 'Sem arquivo', fileName: 'referencia.pdf' });
      expect(registro.status).toBe(201);

      const download = await request(app).get(`${api}/documents/${registro.body.id}/download`).set(auth(s.organizer.token));
      expect(download.status).toBe(409);
    });
  });

  describe('Perfil', () => {
    it('permite editar nome e email do próprio usuário', async () => {
      const s = await scenario();
      const resposta = await request(app).patch(`${api}/profile`).set(auth(s.athlete.token))
        .send({ name: 'Atleta Renomeado', email: 'novo@f4.test' });
      expect(resposta.status).toBe(200);
      expect(resposta.body.user.name).toBe('Atleta Renomeado');
      expect(resposta.body.user.email).toBe('novo@f4.test');
      expect(JSON.stringify(resposta.body)).not.toContain('passwordHash');
    });

    it('ignora tentativa de escalar privilégio pelo corpo da requisição', async () => {
      const s = await scenario();
      const ataque = await request(app).patch(`${api}/profile`).set(auth(s.athlete.token))
        .send({ name: 'Atleta', role: 'ADMIN' });
      // O schema é estrito: campo desconhecido é rejeitado antes do service.
      expect(ataque.status).toBe(400);

      const depois = await prisma.user.findUnique({ where: { id: s.athlete.user.id } });
      expect(depois.role).toBe('ATHLETE');
    });

    it('recusa email já usado por outro usuário', async () => {
      const s = await scenario();
      const conflito = await request(app).patch(`${api}/profile`).set(auth(s.athlete.token))
        .send({ email: 'org@f4.test' });
      expect(conflito.status).toBe(409);
    });

    it('troca a senha exigindo a atual e invalida a antiga', async () => {
      const s = await scenario();

      const semAtual = await request(app).post(`${api}/profile/password`).set(auth(s.athlete.token))
        .send({ currentPassword: 'ErradaTotal1', newPassword: 'NovaSenha@456' });
      expect(semAtual.status).toBe(401);

      const troca = await request(app).post(`${api}/profile/password`).set(auth(s.athlete.token))
        .send({ currentPassword: 'Senha@123', newPassword: 'NovaSenha@456' });
      expect(troca.status).toBe(200);

      const antiga = await request(app).post(`${api}/auth/login`).send({ email: 'atleta@f4.test', password: 'Senha@123' });
      expect(antiga.status).toBe(401);

      const nova = await request(app).post(`${api}/auth/login`).send({ email: 'atleta@f4.test', password: 'NovaSenha@456' });
      expect(nova.status).toBe(200);
    });

    it('recusa nova senha curta ou igual à atual', async () => {
      const s = await scenario();
      expect((await request(app).post(`${api}/profile/password`).set(auth(s.athlete.token))
        .send({ currentPassword: 'Senha@123', newPassword: 'curta' })).status).toBe(400);
      expect((await request(app).post(`${api}/profile/password`).set(auth(s.athlete.token))
        .send({ currentPassword: 'Senha@123', newPassword: 'Senha@123' })).status).toBe(422);
    });
  });

  describe('Cancelamento de inscrição', () => {
    it('cancela por transição de estado, preservando a linha', async () => {
      const s = await scenario();
      const cancelamento = await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token));
      expect(cancelamento.status).toBe(200);
      expect(cancelamento.body.status).toBe('CANCELLED');

      const linha = await prisma.enrollment.findUnique({ where: { id: s.enrollmentB.id } });
      expect(linha).not.toBeNull();
      expect(linha.cancelledById).toBe(s.organizer.user.id);
      expect(linha.cancelledAt).toBeTruthy();
    });

    it('tira o cancelado da listagem, do check-in e das contagens', async () => {
      const s = await scenario();
      await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token));

      const listagem = await request(app).get(`${api}/campeonatos/${s.tournament.id}/participantes`).set(auth(s.organizer.token));
      expect(listagem.body.map(item => item.id)).not.toContain(s.enrollmentB.id);

      const comCanceladas = await request(app).get(`${api}/campeonatos/${s.tournament.id}/participantes?incluirCanceladas=true`).set(auth(s.organizer.token));
      expect(comCanceladas.body.map(item => item.id)).toContain(s.enrollmentB.id);

      const checkin = await request(app).get(`${api}/checkin/tournaments/${s.tournament.id}`).set(auth(s.organizer.token));
      expect(checkin.body.total).toBe(1);

      const backstage = await request(app).get(`${api}/backstage/overview`).set(auth(s.organizer.token));
      expect(backstage.body.totals.enrollments).toBe(1);

      const relatorio = await request(app).get(`${api}/reports/tournaments/${s.tournament.id}`).set(auth(s.organizer.token));
      expect(relatorio.body.summary.enrollments).toBe(1);
      expect(relatorio.body.summary.cancelledEnrollments).toBe(1);
    });

    it('permite reinscrever quem foi cancelado', async () => {
      const s = await scenario();
      await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token));

      const reinscricao = await request(app).post(`${api}/campeonatos/${s.tournament.id}/participantes`)
        .set(auth(s.organizer.token)).send({ participantId: s.teamB.id });
      expect(reinscricao.status).toBe(201);
      expect(reinscricao.body.status).toBe('CONFIRMED');
      expect(reinscricao.body.id).toBe(s.enrollmentB.id);
    });

    it('recusa cancelar duas vezes e cancelar quem já tem resultado', async () => {
      const s = await scenario();

      await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token));
      expect((await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token))).status).toBe(409);

      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 2, scoreB: 0 });
      const comResultado = await request(app).patch(`${api}/inscricoes/${s.enrollmentA.id}/cancel`).set(auth(s.organizer.token));
      expect(comResultado.status).toBe(422);
    });

    it('barra organizador alheio e avisa o técnico com prioridade alta', async () => {
      const s = await scenario();
      expect((await request(app).patch(`${api}/inscricoes/${s.enrollmentA.id}/cancel`).set(auth(s.rival.token))).status).toBe(403);

      await request(app).patch(`${api}/inscricoes/${s.enrollmentA.id}/cancel`).set(auth(s.organizer.token));
      const inbox = await request(app).get(`${api}/notifications`).set(auth(s.coach.token));
      const aviso = inbox.body.items.find(item => item.type === 'ENROLLMENT_CANCELLED');
      expect(aviso).toBeTruthy();
      expect(aviso.priority).toBe('HIGH');
      expect(aviso.link).toBe(`#tournaments/${s.tournament.id}`);
    });
  });

  describe('Athlete Center', () => {
    it('mostra ao atleta a própria vida esportiva', async () => {
      const s = await scenario();
      await request(app).post(`${api}/checkin/enrollments/${s.enrollmentA.id}`).set(auth(s.organizer.token)).send({});
      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 3, scoreB: 1 });

      const visao = await request(app).get(`${api}/athlete/overview`).set(auth(s.athlete.token));
      expect(visao.status).toBe(200);
      expect(visao.body.participant.id).toBe(s.teamA.id);
      expect(visao.body.coach.id).toBe(s.coach.user.id);
      expect(visao.body.enrollments[0].checkInStatus).toBe('CHECKED_IN');
      expect(visao.body.totals.matches).toBe(1);
      expect(visao.body.totals.wins).toBe(1);
      expect(visao.body.standings[0].points).toBe(3);
    });

    it('isola atletas entre si', async () => {
      const s = await scenario();
      const externo = await request(app).get(`${api}/athlete/overview`).set(auth(s.outsider.token));
      expect(externo.status).toBe(200);
      // Sem vínculo o estado é explícito, não um zero disfarçado.
      expect(externo.body.semVinculo).toBe(true);
      expect(externo.body.participant).toBeNull();
      expect(externo.body.enrollments).toHaveLength(0);
      expect(JSON.stringify(externo.body)).not.toContain(s.teamA.id);
    });

    it('exige autenticação e perfil adequado', async () => {
      const s = await scenario();
      expect((await request(app).get(`${api}/athlete/overview`)).status).toBe(401);
      expect((await request(app).get(`${api}/athlete/overview`).set(auth(s.organizer.token))).status).toBe(403);
    });
  });

  describe('Admin Center', () => {
    it('lista usuários sem jamais expor passwordHash', async () => {
      const s = await scenario();
      const usuarios = await request(app).get(`${api}/admin/users`).set(auth(s.admin.token));
      expect(usuarios.status).toBe(200);
      expect(usuarios.body.items.length).toBeGreaterThanOrEqual(7);
      expect(JSON.stringify(usuarios.body)).not.toContain('passwordHash');

      const filtrado = await request(app).get(`${api}/admin/users?role=JUDGE`).set(auth(s.admin.token));
      expect(filtrado.body.items.every(item => item.role === 'JUDGE')).toBe(true);
    });

    it('altera perfil de outro usuário e registra na auditoria', async () => {
      const s = await scenario();
      const alteracao = await request(app).patch(`${api}/admin/users/${s.athlete.user.id}`).set(auth(s.admin.token))
        .send({ role: 'JUDGE' });
      expect(alteracao.status).toBe(200);
      expect(alteracao.body.role).toBe('JUDGE');

      const trilha = await request(app).get(`${api}/audit?entity=User`).set(auth(s.admin.token));
      const registro = trilha.body.items.find(item => item.action === 'USER_UPDATE');
      expect(registro).toBeTruthy();
      expect(registro.entityId).toBe(s.athlete.user.id);
    });

    it('impede o administrador de se rebaixar ou se suspender', async () => {
      const s = await scenario();
      expect((await request(app).patch(`${api}/admin/users/${s.admin.user.id}`).set(auth(s.admin.token))
        .send({ role: 'ATHLETE' })).status).toBe(422);
      expect((await request(app).patch(`${api}/admin/users/${s.admin.user.id}`).set(auth(s.admin.token))
        .send({ status: 'SUSPENDED' })).status).toBe(422);
    });

    it('consolida o retrato global da plataforma', async () => {
      const s = await scenario();
      const visao = await request(app).get(`${api}/admin/overview`).set(auth(s.admin.token));
      expect(visao.status).toBe(200);
      expect(visao.body.users.total).toBeGreaterThanOrEqual(7);
      expect(visao.body.tournaments.porStatus.ACTIVE).toBe(1);
      expect(visao.body.enrollments.porStatus.CONFIRMED).toBe(2);
    });

    it('é inacessível a qualquer perfil que não seja ADMIN', async () => {
      const s = await scenario();
      for (const ator of [s.organizer, s.judge, s.coach, s.athlete]) {
        expect((await request(app).get(`${api}/admin/users`).set(auth(ator.token))).status).toBe(403);
        expect((await request(app).get(`${api}/admin/overview`).set(auth(ator.token))).status).toBe(403);
        expect((await request(app).get(`${api}/audit`).set(auth(ator.token))).status).toBe(403);
      }
      expect((await request(app).get(`${api}/admin/users`)).status).toBe(401);
    });
  });

  describe('Auditoria', () => {
    it('registra as ações e nunca guarda senha ou token', async () => {
      const s = await scenario();

      await request(app).post(`${api}/profile/password`).set(auth(s.athlete.token))
        .send({ currentPassword: 'Senha@123', newPassword: 'OutraSenha@789' });
      await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'doc.pdf', contentType: 'application/pdf' });
      await request(app).patch(`${api}/inscricoes/${s.enrollmentB.id}/cancel`).set(auth(s.organizer.token));

      const trilha = await request(app).get(`${api}/audit`).set(auth(s.admin.token));
      expect(trilha.status).toBe(200);
      const acoes = trilha.body.items.map(item => item.action);
      expect(acoes).toContain('PASSWORD_CHANGE');
      expect(acoes).toContain('DOCUMENT_UPLOAD');
      expect(acoes).toContain('ENROLLMENT_CANCEL');

      const payload = JSON.stringify(trilha.body);
      expect(payload).not.toContain('Senha@123');
      expect(payload).not.toContain('OutraSenha@789');
      expect(payload).not.toContain('passwordHash');
      expect(payload.toLowerCase()).not.toContain('bearer ');
    });

    it('filtra por entidade e registra quem executou', async () => {
      const s = await scenario();
      await request(app).post(`${api}/documents/upload`).set(auth(s.organizer.token))
        .field('tournamentId', s.tournament.id)
        .attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' });

      const trilha = await request(app).get(`${api}/audit?entity=Document`).set(auth(s.admin.token));
      expect(trilha.body.items.every(item => item.entity === 'Document')).toBe(true);
      expect(trilha.body.items[0].user.id).toBe(s.organizer.user.id);
      expect(trilha.body.items[0].userEmail).toBe('org@f4.test');
    });
  });

  describe('Notificações aprofundadas', () => {
    it('carrega prioridade, referência e destino de navegação', async () => {
      const s = await scenario();
      await request(app).post(`${api}/partidas/${s.match.id}/resultado`).set(auth(s.judge.token))
        .send({ winnerParticipantId: s.teamA.id, scoreA: 2, scoreB: 1 });

      const inbox = await request(app).get(`${api}/notifications`).set(auth(s.coach.token));
      const resultado = inbox.body.items.find(item => item.type === 'RESULT');
      expect(resultado.priority).toBe('HIGH');
      expect(resultado.entityType).toBe('Match');
      expect(resultado.entityId).toBe(s.match.id);
      expect(resultado.link).toContain('#tournaments/');
      expect(inbox.body.highPriorityUnread).toBeGreaterThan(0);
    });

    it('filtra apenas não lidas e marca com carimbo de leitura', async () => {
      const s = await scenario();
      const inbox = await request(app).get(`${api}/notifications?onlyUnread=true`).set(auth(s.coach.token));
      expect(inbox.body.items.every(item => item.isRead === false)).toBe(true);

      const alvo = inbox.body.items[0];
      const lida = await request(app).patch(`${api}/notifications/${alvo.id}/read`).set(auth(s.coach.token));
      expect(lida.body.isRead).toBe(true);
      expect(lida.body.readAt).toBeTruthy();
    });
  });
});
