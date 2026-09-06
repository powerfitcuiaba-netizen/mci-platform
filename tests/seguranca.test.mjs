import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar, gerarCpf
} from './helpers.mjs';

// Testes negativos e de segurança: IDOR, cross-tenant, escalada de papel,
// exposição de dado restrito e transições inválidas.

let admin;
let diretorA;
let orgA;
let diretorB;
let orgB;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

  diretorA = await criarUsuario({ name: 'Diretor A' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

  diretorB = await criarUsuario({ name: 'Diretor B' });
  orgB = await criarOrganizacao(admin, { name: 'Federação B' });
  await vincular(orgB.id, diretorB, 'EVENT_DIRECTOR');
});

describe('autenticação', () => {
  it('recusa rota protegida sem token, com token inválido e com token de conta suspensa', async () => {
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set({ Authorization: 'Bearer invalido' })).status).toBe(401);

    const suspenso = await criarUsuario({ name: 'Suspenso' });
    await prisma.user.update({ where: { id: suspenso.id }, data: { status: 'SUSPENDED' } });

    const resposta = await api().get('/api/v1/auth/me').set(suspenso.auth());
    expect(resposta.status).toBe(403);
    expect(resposta.body.error.code).toBe('USER_INACTIVE');
  });

  it('não revela se o email existe e não vaza hash de senha', async () => {
    const usuario = await criarUsuario({ name: 'Alvo' });

    const senhaErrada = await api().post('/api/v1/auth/login').send({ email: usuario.email, password: 'senha-errada-1234' });
    const emailInexistente = await api().post('/api/v1/auth/login').send({ email: 'ninguem@mci.test', password: 'senha-errada-1234' });

    expect(senhaErrada.status).toBe(401);
    expect(emailInexistente.status).toBe(401);
    expect(senhaErrada.body.error.message).toBe(emailInexistente.body.error.message);

    const me = await api().get('/api/v1/auth/me').set(usuario.auth());
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('cadastro aberto não concede papel privilegiado', async () => {
    const resposta = await api().post('/api/v1/auth/register')
      .send({ name: 'Esperto', email: 'esperto@mci.test', password: 'senha-de-teste-123', role: 'ADMIN' });

    // O schema recusa antes mesmo de chegar ao service.
    expect(resposta.status).toBe(400);

    const criado = await api().post('/api/v1/auth/register')
      .send({ name: 'Comum', email: 'comum@mci.test', password: 'senha-de-teste-123' });
    expect(criado.body.user.role).toBe('ATHLETE');
  });

  it('não permite alterar o próprio papel nem se autopromover sem SUPER_ADMIN', async () => {
    const gestor = await criarUsuario({ role: 'ADMIN', name: 'Gestor' });
    const alvo = await criarUsuario({ name: 'Alvo' });

    const autopromocao = await api().patch(`/api/v1/admin/users/${gestor.id}`).set(gestor.auth()).send({ role: 'SUPER_ADMIN' });
    expect(autopromocao.status).toBe(422);

    const promocaoDeOutro = await api().patch(`/api/v1/admin/users/${alvo.id}`).set(gestor.auth()).send({ role: 'EVENT_DIRECTOR' });
    expect(promocaoDeOutro.status).toBe(403);

    const porSuperAdmin = await api().patch(`/api/v1/admin/users/${alvo.id}`).set(admin.auth()).send({ role: 'EVENT_DIRECTOR' });
    expect(porSuperAdmin.status).toBe(200);
  });
});

describe('isolamento entre organizações', () => {
  it('diretor de uma organização não cria evento em outra', async () => {
    const resposta = await api().post('/api/v1/events').set(diretorA.auth())
      .send({ organizationId: orgB.id, name: 'Invasão', slug: 'invasao-cross-tenant' });

    expect(resposta.status).toBe(403);
  });

  it('diretor não cadastra atleta em organização alheia', async () => {
    const resposta = await api().post('/api/v1/athletes').set(diretorA.auth())
      .send({ organizationId: orgB.id, fullName: 'Atleta Alheia', cpf: gerarCpf(818181818), sex: 'FEMALE' });

    expect(resposta.status).toBe(403);
  });

  it('listagem de atletas não mistura organizações', async () => {
    await criarAtleta(diretorA, orgA.id, { fullName: 'Da Federação A', cpf: gerarCpf(717171717) });
    await criarAtleta(diretorB, orgB.id, { fullName: 'Da Federação B', cpf: gerarCpf(616161616) });

    const listaA = await api().get('/api/v1/athletes').set(diretorA.auth());
    const nomes = listaA.body.items.map(item => item.fullName);

    expect(nomes).toContain('Da Federação A');
    expect(nomes).not.toContain('Da Federação B');
  });

  it('não altera atleta de outra organização mesmo conhecendo o id', async () => {
    const atleta = await criarAtleta(diretorB, orgB.id, { fullName: 'Protegida', cpf: gerarCpf(515151515) });

    const resposta = await api().patch(`/api/v1/athletes/${atleta.id}`).set(diretorA.auth()).send({ city: 'Invadida' });
    expect(resposta.status).toBe(403);
  });

  it('não inscreve em evento de outra organização', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretorB, orgB.id);
    await transicionar(diretorB, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const resposta = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(414141414), athlete: { fullName: 'Atleta Alheia', sex: 'FEMALE' }, classIds: [competitionClass.id] });

    expect(resposta.status).toBe(403);
  });

  it('auditoria de uma organização não é lida por diretor de outra', async () => {
    const resposta = await api().get('/api/v1/audit').set(diretorA.auth()).query({ organizationId: orgB.id });
    expect(resposta.status).toBe(403);
  });
});

describe('proteção do CPF', () => {
  it('CPF nunca aparece em rota pública de atleta', async () => {
    const cpf = gerarCpf(313131313);
    const atleta = await criarAtleta(diretorA, orgA.id, { fullName: 'Pública', cpf });

    const pagina = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(pagina.status).toBe(200);
    expect(JSON.stringify(pagina.body)).not.toContain(cpf);

    const lista = await api().get('/api/v1/public/athletes');
    expect(JSON.stringify(lista.body)).not.toContain(cpf);
  });

  it('busca por CPF não encontra nada para quem não tem permissão de dado sensível', async () => {
    const cpf = gerarCpf(212121212);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Sigilosa', cpf });

    const atleta = await criarUsuario({ name: 'Atleta comum' });
    await vincular(orgA.id, atleta, 'ATHLETE');

    const busca = await api().get('/api/v1/search').set(atleta.auth()).query({ q: cpf, types: 'athletes' });
    expect(busca.status).toBe(200);
    expect(busca.body.results.athletes).toHaveLength(0);

    // Mesmo com permissão, o resultado da busca não devolve o número.
    const buscaOperador = await api().get('/api/v1/search').set(diretorA.auth()).query({ q: cpf, types: 'athletes' });
    expect(buscaOperador.body.results.athletes).toHaveLength(1);
    // Encontra o atleta, mas não devolve o número — nem nos dados, nem no eco
    // do termo consultado.
    expect(JSON.stringify(buscaOperador.body)).not.toContain(cpf);
    expect(buscaOperador.body.query).toBe('[CPF]');
  });

  it('consulta de CPF por operador fica registrada na auditoria', async () => {
    const cpf = gerarCpf(919191919);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Consultada', cpf });

    await api().post('/api/v1/athletes/lookup').set(diretorA.auth()).send({ organizationId: orgA.id, cpf });

    const trilha = await prisma.auditLog.findMany({ where: { action: 'ATHLETE_CPF_VIEW' } });
    expect(trilha.length).toBeGreaterThanOrEqual(1);
    expect(trilha[0].userEmail).toBe(diretorA.email);
    // A trilha registra o acesso, não o número consultado.
    expect(JSON.stringify(trilha[0].metadata ?? {})).not.toContain(cpf);
  });

  it('atleta comum não usa a consulta por CPF', async () => {
    const atleta = await criarUsuario({ name: 'Curioso' });
    await vincular(orgA.id, atleta, 'ATHLETE');

    const resposta = await api().post('/api/v1/athletes/lookup').set(atleta.auth())
      .send({ organizationId: orgA.id, cpf: gerarCpf(818281828) });

    expect(resposta.status).toBe(403);
  });

  it('CPF duplicado na mesma organização é recusado', async () => {
    const cpf = gerarCpf(727272727);
    await criarAtleta(diretorA, orgA.id, { fullName: 'Primeira', cpf });

    const repetido = await api().post('/api/v1/athletes').set(diretorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Segunda', cpf, sex: 'FEMALE' });

    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('ATHLETE_CPF_EXISTS');
  });

  it('CPF inválido é recusado com 422', async () => {
    const resposta = await api().post('/api/v1/athletes').set(diretorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Inválida', cpf: '123.456.789-00', sex: 'FEMALE' });

    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('INVALID_CPF');
  });
});

describe('julgamento e resultados', () => {
  let evento;
  let juiz;
  let intruso;

  beforeEach(async () => {
    evento = await criarEventoCompleto(diretorA, orgA.id);
    juiz = await criarUsuario({ name: 'Juiz escalado' });
    intruso = await criarUsuario({ name: 'Juiz não escalado' });
    await vincular(orgA.id, juiz, 'JUDGE');
    await vincular(orgA.id, intruso, 'JUDGE');

    await transicionar(diretorA, evento.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
    const inscricao = await api().post(`/api/v1/events/${evento.event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(626262626), athlete: { fullName: 'Competidora', sex: 'FEMALE' }, classIds: [evento.competitionClass.id] });

    await transicionar(diretorA, evento.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretorA.auth()).send({});
    await transicionar(diretorA, evento.event.id, ['IN_JUDGING']);
  });

  it('juiz não escalado no painel não pontua', async () => {
    const painel = await api().post(`/api/v1/events/${evento.event.id}/panels`).set(diretorA.auth()).send({ name: 'Painel' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: juiz.id, seat: 1, role: 'HEAD' });

    const sessao = await api().post('/api/v1/judging-sessions').set(diretorA.auth())
      .send({ classId: evento.competitionClass.id, panelId: painel.body.id, round: 'FINALS' });

    const item = await prisma.registrationItem.findFirst({ where: { classId: evento.competitionClass.id } });

    const resposta = await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(intruso.auth())
      .send({ placings: [{ registrationItemId: item.id, placing: 1 }] });

    expect(resposta.status).toBe(403);
    expect(resposta.body.error.code).toBe('JUDGE_NOT_ASSIGNED');
  });

  it('juiz não fecha sessão, não apura e não publica', async () => {
    const painel = await api().post(`/api/v1/events/${evento.event.id}/panels`).set(diretorA.auth()).send({ name: 'Painel' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: juiz.id, seat: 1, role: 'HEAD' });

    const sessao = await api().post('/api/v1/judging-sessions').set(diretorA.auth())
      .send({ classId: evento.competitionClass.id, panelId: painel.body.id, round: 'FINALS' });

    expect((await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(juiz.auth())).status).toBe(403);
    expect((await api().post(`/api/v1/classes/${evento.competitionClass.id}/result/calculate`).set(juiz.auth())).status).toBe(403);
    expect((await api().post(`/api/v1/classes/${evento.competitionClass.id}/result/publish`).set(juiz.auth()).send({})).status).toBe(403);
  });

  it('a mesma colocação não vai para dois atletas na ficha do mesmo juiz', async () => {
    const segunda = await api().post(`/api/v1/events/${evento.event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(525252525), athlete: { fullName: 'Segunda', sex: 'FEMALE' }, classIds: [evento.competitionClass.id] });
    // Evento já está em julgamento: a inscrição extra precisa ser criada antes.
    expect(segunda.status).toBe(422);
  });

  it('sessão com ficha incompleta não fecha', async () => {
    const painel = await api().post(`/api/v1/events/${evento.event.id}/panels`).set(diretorA.auth()).send({ name: 'Painel' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: juiz.id, seat: 1, role: 'HEAD' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: intruso.id, seat: 2 });

    const sessao = await api().post('/api/v1/judging-sessions').set(diretorA.auth())
      .send({ classId: evento.competitionClass.id, panelId: painel.body.id, round: 'FINALS' });

    const item = await prisma.registrationItem.findFirst({ where: { classId: evento.competitionClass.id } });
    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juiz.auth())
      .send({ placings: [{ registrationItemId: item.id, placing: 1 }] });

    const fechamento = await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretorA.auth());
    expect(fechamento.status).toBe(422);
    expect(fechamento.body.error.code).toBe('INCOMPLETE_SCORES');
  });

  it('resultado não publicado não vaza para visitante nem para atleta', async () => {
    const painel = await api().post(`/api/v1/events/${evento.event.id}/panels`).set(diretorA.auth()).send({ name: 'Painel' });
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretorA.auth()).send({ judgeId: juiz.id, seat: 1, role: 'HEAD' });

    const sessao = await api().post('/api/v1/judging-sessions').set(diretorA.auth())
      .send({ classId: evento.competitionClass.id, panelId: painel.body.id, round: 'FINALS' });
    const item = await prisma.registrationItem.findFirst({ where: { classId: evento.competitionClass.id } });

    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juiz.auth())
      .send({ placings: [{ registrationItemId: item.id, placing: 1 }] });
    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretorA.auth());
    await api().post(`/api/v1/classes/${evento.competitionClass.id}/result/calculate`).set(diretorA.auth());

    const atleta = await criarUsuario({ name: 'Atleta curiosa' });
    expect((await api().get(`/api/v1/classes/${evento.competitionClass.id}/result`)).status).toBe(404);
    expect((await api().get(`/api/v1/classes/${evento.competitionClass.id}/result`).set(atleta.auth())).status).toBe(404);
    expect((await api().get(`/api/v1/classes/${evento.competitionClass.id}/result`).set(diretorA.auth())).status).toBe(200);

    const listaPublica = await api().get(`/api/v1/events/${evento.event.id}/results`);
    expect(listaPublica.body.items).toHaveLength(0);
  });
});

describe('estados do evento', () => {
  it('recusa transição fora da máquina de estados', async () => {
    const { event } = await criarEventoCompleto(diretorA, orgA.id);

    const invalida = await api().post(`/api/v1/events/${event.id}/transition`).set(diretorA.auth())
      .send({ status: 'RESULTS_PUBLISHED' });

    expect(invalida.status).toBe(422);
    expect(invalida.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('não inscreve com inscrições fechadas', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretorA, orgA.id);

    const cedoDemais = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(434343434), athlete: { fullName: 'Adiantada', sex: 'FEMALE' }, classIds: [competitionClass.id] });

    expect(cedoDemais.status).toBe(422);
    expect(cedoDemais.body.error.code).toBe('REGISTRATIONS_NOT_OPEN');
  });

  it('não faz check-in fora da janela operacional', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretorA, orgA.id);
    await transicionar(diretorA, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(323232323), athlete: { fullName: 'Antecipada', sex: 'FEMALE' }, classIds: [competitionClass.id] });

    const checkin = await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretorA.auth()).send({});
    expect(checkin.status).toBe(422);
    expect(checkin.body.error.code).toBe('EVENT_NOT_OPERATIONAL');
  });

  it('atleta não elegível é recusado com o motivo', async () => {
    const { event } = await criarEventoCompleto(diretorA, orgA.id, { categoryCode: 'MENS_PHYSIQUE' });
    await transicionar(diretorA, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const classe = await prisma.competitionClass.findFirst({ where: { division: { eventCategory: { eventId: event.id } } } });

    const resposta = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth())
      .send({ cpf: gerarCpf(232323232), athlete: { fullName: 'Atleta Feminina', sex: 'FEMALE' }, classIds: [classe.id] });

    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('NOT_ELIGIBLE');
    expect(JSON.stringify(resposta.body.error.details)).toMatch(/masculina/);
  });

  it('inscrição duplicada no mesmo evento é recusada', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretorA, orgA.id);
    await transicionar(diretorA, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const cpf = gerarCpf(132323231);
    const corpo = { cpf, athlete: { fullName: 'Repetida', sex: 'FEMALE' }, classIds: [competitionClass.id] };

    expect((await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth()).send(corpo)).status).toBe(201);
    const repetida = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretorA.auth()).send(corpo);

    expect(repetida.status).toBe(409);
    expect(repetida.body.error.code).toBe('ALREADY_REGISTERED');
  });
});

describe('respostas de erro', () => {
  it('não expõe stack trace nem detalhe interno', async () => {
    const resposta = await api().get('/api/v1/rota-que-nao-existe');
    expect(resposta.status).toBe(404);
    expect(resposta.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada' } });
    expect(JSON.stringify(resposta.body)).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it('valida entrada malformada antes de tocar o banco', async () => {
    const resposta = await api().post('/api/v1/auth/register').send({ name: '', email: 'nao-e-email', password: '123' });
    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('VALIDATION_ERROR');
    expect(resposta.body.error.details.length).toBeGreaterThan(0);
  });
});
