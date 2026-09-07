import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar, gerarCpf, comoAtor
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
    // 404, não 403: com FORCE ligado, o atleta da outra federação não existe
    // para este diretor nem no banco. Conhecer o id deixou de ser suficiente
    // até para confirmar que o registro existe.
    expect(resposta.status).toBe(404);
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

    // A auditoria só é legível por administrador da plataforma ou operador da
    // organização — inclusive para o dono do schema, desde que o RLS ganhou FORCE.
    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({ where: { action: 'ATHLETE_CPF_VIEW' } }));
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

  it('quem não tem permissão não lança o resultado oficial nem publica', async () => {
    const item = await prisma.registrationItem.findFirst({ where: { classId: evento.competitionClass.id } });
    const inscrita = await prisma.registration.findUnique({ where: { id: item.registrationId } });

    const lancamento = await api().post(`/api/v1/classes/${evento.competitionClass.id}/result`).set(juiz.auth())
      .send({ entries: [{ athleteId: inscrita.athleteId, placing: 1 }] });
    expect(lancamento.status).toBe(403);

    const publicacao = await api().post(`/api/v1/classes/${evento.competitionClass.id}/result/publish`).set(juiz.auth()).send({});
    expect(publicacao.status).toBe(403);
  });

  it('duas colocações iguais no resultado recebido são recusadas', async () => {
    // Evento próprio: a classe do cenário tem uma inscrita só, e sem duas
    // atletas não existe colocação repetida para recusar.
    const outro = await criarEventoCompleto(diretorA, orgA.id);
    await transicionar(diretorA, outro.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const atletas = [];
    for (const semente of [717171717, 727272727]) {
      const inscricao = await api().post(`/api/v1/events/${outro.event.id}/registrations`).set(diretorA.auth())
        .send({ cpf: gerarCpf(semente), athlete: { fullName: `Dupla ${semente}`, sex: 'FEMALE' }, classIds: [outro.competitionClass.id] });
      expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
      atletas.push(inscricao.body.registration.athlete.id);
    }

    const resposta = await api().post(`/api/v1/classes/${outro.competitionClass.id}/result`).set(diretorA.auth())
      .send({ entries: atletas.map(athleteId => ({ athleteId, placing: 1 })) });

    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('DUPLICATE_PLACING');
  });

  it('atleta de fora da classe não entra no resultado recebido', async () => {
    const estranha = await criarAtleta(diretorA, orgA.id, { cpf: gerarCpf(818181818) });

    const resposta = await api().post(`/api/v1/classes/${evento.competitionClass.id}/result`).set(diretorA.auth())
      .send({ entries: [{ athleteId: estranha.id, placing: 1 }] });

    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('ATHLETE_NOT_IN_CLASS');
  });

  it('resultado não publicado não vaza para visitante nem para atleta', async () => {
    const item = await prisma.registrationItem.findFirst({ where: { classId: evento.competitionClass.id } });
    const inscrita = await prisma.registration.findUnique({ where: { id: item.registrationId } });

    const recebido = await api().post(`/api/v1/classes/${evento.competitionClass.id}/result`).set(diretorA.auth())
      .send({ entries: [{ athleteId: inscrita.athleteId, placing: 1 }] });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

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

describe('cross-tenant no detalhamento de pontos', () => {
  // Achado de auditoria: `athletePoints` checava a PERMISSÃO e não o TENANT.
  // O gerente de ranking de uma organização recebia 200 consultando atleta de
  // outra — a permissão existia, e ninguém perguntava de quem era o atleta.
  // Todo o resto do service usa `assertCan`, que exige as duas condições.
  it('gerente de ranking de outra organização não lê os pontos do atleta', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });

    const orgA = await criarOrganizacao(admin, { name: `Federação A ${Date.now()}` });
    const orgB = await criarOrganizacao(admin, { name: `Federação B ${Date.now()}` });

    const diretorA = await criarUsuario({ name: 'Diretora A' });
    await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

    const intruso = await criarUsuario({ name: 'Gerente B' });
    await vincular(orgB.id, intruso, 'RANKING_MANAGER');

    const atletaDaA = await criarAtleta(diretorA, orgA.id, {
      fullName: 'ATLETA DA ORG A', cpf: gerarCpf(818282828)
    });

    const tentativa = await api().get(`/api/v1/athletes/${atletaDaA.id}/ranking-points`)
      .set(intruso.auth());

    expect([403, 404], `vazou com HTTP ${tentativa.status}`).toContain(tentativa.status);
  });

  it('quem é da organização do atleta continua lendo normalmente', async () => {
    // A correção não pode fechar a porta para quem tem o direito de passar.
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
    const org = await criarOrganizacao(admin, { name: `Federação ${Date.now()}` });

    const diretor = await criarUsuario({ name: 'Diretora' });
    await vincular(org.id, diretor, 'EVENT_DIRECTOR');
    await vincular(org.id, diretor, 'RANKING_MANAGER');

    const atleta = await criarAtleta(diretor, org.id, {
      fullName: 'ATLETA DA CASA', cpf: gerarCpf(838383838)
    });

    const leitura = await api().get(`/api/v1/athletes/${atleta.id}/ranking-points`).set(diretor.auth());

    expect(leitura.status).toBe(200);
    expect(leitura.body.items).toEqual([]);
  });

  it('atleta inexistente responde 404, não lista vazia', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
    const resposta = await api().get('/api/v1/athletes/clnaoexiste000000000000/ranking-points')
      .set(admin.auth());

    expect(resposta.status).toBe(404);
  });
});

describe('cross-tenant na administração de contas', () => {
  // Segundo achado da mesma auditoria: `users.read` é permissão de
  // EVENT_DIRECTOR, e a listagem não tinha escopo. O diretor de uma federação
  // enumerava TODOS os usuários da plataforma, e-mail incluído.
  //
  // Usuário não tem organizationId — participa de várias —, então o escopo é
  // por membresia compartilhada, como manda a convenção de tenant.js.
  const cenario = async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
    const orgA = await criarOrganizacao(admin, { name: `Federação A ${Date.now()}` });
    const orgB = await criarOrganizacao(admin, { name: `Federação B ${Date.now()}` });

    const diretorA = await criarUsuario({ name: 'Diretora A' });
    await vincular(orgA.id, diretorA, 'EVENT_DIRECTOR');

    const soDaB = await criarUsuario({ name: 'Somente da B' });
    await vincular(orgB.id, soDaB, 'REGISTRATION_OPERATOR');

    return { admin, orgA, diretorA, soDaB };
  };

  it('diretor de uma federação não enumera usuários da outra', async () => {
    const { diretorA, soDaB } = await cenario();

    const lista = await api().get('/api/v1/admin/users').set(diretorA.auth());
    expect(lista.status).toBe(200);

    const emails = lista.body.items.map(item => item.email);
    expect(emails, 'usuário exclusivo da outra federação não pode aparecer').not.toContain(soDaB.email);
    expect(emails, 'e ele continua se vendo').toContain(diretorA.email);
  });

  it('nem alcança o usuário da outra federação pelo id', async () => {
    const { diretorA, soDaB } = await cenario();

    const resposta = await api().get(`/api/v1/admin/users/${soDaB.id}`).set(diretorA.auth());

    // 404, e não 403: distinguir "não existe" de "existe noutra federação"
    // transformaria a rota numa sonda de ids válidos.
    expect(resposta.status).toBe(404);
  });

  it('SUPER_ADMIN continua vendo a plataforma inteira', async () => {
    const { admin, soDaB } = await cenario();

    const lista = await api().get('/api/v1/admin/users').set(admin.auth());

    expect(lista.body.items.map(item => item.email)).toContain(soDaB.email);
  });
});

// ===========================================================================
// Documento de evento marcado como privado.
//
// Achado por sondagem (fase 11.5): `isPublic` usava `z.coerce.boolean()`, que
// aplica `Boolean(...)`. Campo de multipart chega SEMPRE como texto, e a string
// 'false' vira `true` — todo documento enviado como privado era gravado como
// público e ficava baixável por qualquer um, sem autenticação.
// ===========================================================================
describe('documento privado de evento', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  async function documentos() {
    const montagem = await criarEventoCompleto(diretorA, orgA.id);

    const privado = await api().post(`/api/v1/events/${montagem.event.id}/documents`)
      .set(diretorA.auth())
      .field('title', 'Ata interna')
      .field('isPublic', 'false')
      .attach('file', PNG, 'ata.png');

    const publico = await api().post(`/api/v1/events/${montagem.event.id}/documents`)
      .set(diretorA.auth())
      .field('title', 'Regulamento')
      .field('isPublic', 'true')
      .attach('file', PNG, 'regulamento.png');

    expect(privado.status).toBe(201);
    expect(publico.status).toBe(201);
    return { montagem, privado: privado.body, publico: publico.body };
  }

  it("'false' no formulário grava privado de verdade, e não o contrário", async () => {
    const { privado } = await documentos();

    const gravado = await prisma.eventDocument.findUnique({ where: { id: privado.id } });
    expect(gravado.isPublic).toBe(false);
  });

  it('não aparece na listagem anônima nem na de outra federação', async () => {
    const { montagem } = await documentos();

    const anonima = await api().get(`/api/v1/events/${montagem.event.id}/documents`);
    const deB = await api().get(`/api/v1/events/${montagem.event.id}/documents`).set(diretorB.auth());

    const titulos = resposta => (resposta.body.items ?? resposta.body).map(item => item.title);
    expect(titulos(anonima)).toEqual(['Regulamento']);
    expect(titulos(deB)).toEqual(['Regulamento']);
  });

  it('não é baixável por anônimo nem por outra federação, mas o dono baixa', async () => {
    const { privado } = await documentos();
    const url = `/api/v1/documents/event/${privado.id}/download`;

    expect((await api().get(url)).status).toBe(401);
    expect((await api().get(url).set(diretorB.auth())).status).toBe(403);
    expect((await api().get(url).set(diretorA.auth())).status).toBe(200);
  });

  it('o documento público continua público: regulamento abre sem login', async () => {
    const { publico } = await documentos();

    const resposta = await api().get(`/api/v1/documents/event/${publico.id}/download`);
    expect(resposta.status).toBe(200);
  });
});

// ===========================================================================
// Parceria atleta ↔ marca, mudança de status por outra federação.
//
// Achado por sondagem (fase 11.5): devolvia 500. A parceria é vitrine pública
// e não tem RLS; o atleta tem. Pedir o atleta por `include` obrigatório de
// dentro de outra federação fazia o Prisma estourar em cima de uma negativa
// que já estava correta — a escrita nunca chegou a acontecer, mas um 500
// esconde a resposta certa e entrega ruído a quem sonda.
// ===========================================================================
describe('status de parceria entre federações', () => {
  async function parceria() {
    const marca = await api().post('/api/v1/brands').set(diretorA.auth())
      .send({ organizationId: orgA.id, name: 'Marca A', slug: 'marca-a' });
    const atleta = await criarAtleta(diretorA, orgA.id, { cpf: gerarCpf() });

    const criada = await api().post('/api/v1/partnerships').set(diretorA.auth())
      .send({ athleteId: atleta.id, brandId: marca.body.id });

    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    return criada.body;
  }

  it('responde 404, e não 500, para quem é de outra federação', async () => {
    const criada = await parceria();

    const resposta = await api().post(`/api/v1/partnerships/${criada.id}/status`)
      .set(diretorB.auth()).send({ status: 'ACTIVE' });

    expect(resposta.status).toBe(404);
    expect(resposta.body.error.code).toBe('PARTNERSHIP_NOT_FOUND');
  });

  it('e o status continua o que era: a recusa não escreve nada', async () => {
    const criada = await parceria();

    await api().post(`/api/v1/partnerships/${criada.id}/status`)
      .set(diretorB.auth()).send({ status: 'ENDED' });

    const depois = await prisma.athleteBrandPartnership.findUnique({ where: { id: criada.id } });
    expect(depois.status).toBe('PENDING');
    expect(depois.endedAt).toBeNull();
  });

  it('a federação dona muda o status normalmente', async () => {
    const criada = await parceria();

    const resposta = await api().post(`/api/v1/partnerships/${criada.id}/status`)
      .set(diretorA.auth()).send({ status: 'ACTIVE' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.status).toBe('ACTIVE');
  });
});
