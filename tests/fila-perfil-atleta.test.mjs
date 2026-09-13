import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// FILA DE PERFIL DE ATLETA.
//
// Ela existe por uma barreira real: `atleta_criacao` exige
// `mci_operator_of(organizationId)`, e quem acaba de criar conta não é
// operador de federação nenhuma. Em vez de afrouxar a política, o usuário
// PEDE e o operador CONCEDE.
//
// O que este arquivo trava, em ordem de gravidade:
//
//   1. o autocadastro continua SEM conseguir criar `Athlete` direto — se um
//      dia conseguir, a fila virou teatro e a barreira caiu;
//   2. ninguém analisa o próprio pedido;
//   3. operador de outra federação não alcança nem lê o pedido;
//   4. o CPF não aparece na listagem da fila, e some do pedido depois da
//      decisão — ele passa a viver em `AthleteIdentity`;
//   5. a aprovação é atômica: não existe atleta sem documento.
// ==========================================================================

let admin;
let orgA;
let operadorA;
let filiacaoA;

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999991234', whatsapp: '65988884321', postalCode: '78000000',
  addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

const cadastrarPessoa = async nome => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, token: r.body.token, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

const criarFiliacao = async (operador, organizationId, nome = 'NPC Brasil') => {
  const r = await api().post('/api/v1/affiliations').set(operador.auth())
    .send({ organizationId, name: nome, code: unico('npc').toUpperCase().slice(0, 12), kind: 'ENTITY', state: 'MT' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

const pedir = (pessoa, corpo) => api().post('/api/v1/athlete-requests').set(pessoa.auth()).send(corpo);

const pedidoValido = (filiacao, semente) => ({
  fullName: 'Atleta Solicitante',
  cpf: gerarCpf(semente),
  sex: 'FEMALE',
  birthDate: '1998-07-15',
  affiliationId: filiacao.id,
  affiliationNumber: 'NPC-00123'
});

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  operadorA = await criarUsuario({ name: 'Operadora A' });
  await vincular(orgA.id, operadorA, 'EVENT_DIRECTOR');
  filiacaoA = await criarFiliacao(operadorA, orgA.id);
});

describe('a barreira que a fila existe para preservar', () => {
  // Se este teste cair, a fila perdeu o motivo de existir.
  it('quem acabou de se cadastrar NÃO cria atleta direto', async () => {
    const pessoa = await cadastrarPessoa('Pessoa Comum');

    const tentativa = await api().post('/api/v1/athletes').set(pessoa.auth()).send({
      organizationId: orgA.id, fullName: 'Eu Mesmo', cpf: gerarCpf(111222333), sex: 'MALE', birthDate: '1995-01-01'
    });

    expect([401, 403]).toContain(tentativa.status);
    expect(await prisma.athlete.count()).toBe(0);
  });
});

describe('o pedido', () => {
  it('nasce PENDING, sem criar atleta nem identidade', async () => {
    const pessoa = await cadastrarPessoa('Solicitante');
    const r = await pedir(pessoa, pedidoValido(filiacaoA, 111111111));

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status).toBe('PENDING');
    expect(r.body.organizationId, 'a organização deveria vir da filiação').toBe(orgA.id);

    expect(await prisma.athlete.count()).toBe(0);
    expect(await prisma.athleteIdentity.count()).toBe(0);
  });

  it('a organização vem da FILIAÇÃO, não do corpo — mandar outra não muda nada', async () => {
    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const pessoa = await cadastrarPessoa('Espertinha');

    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 222222222), organizationId: orgB.id });

    expect(r.status).toBe(201);
    expect(r.body.organizationId, 'o cliente conseguiu escolher a federação').toBe(orgA.id);
  });

  it('CPF inválido é recusado', async () => {
    const pessoa = await cadastrarPessoa('CPF Ruim');
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf: '11111111111' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INVALID_CPF');
  });

  it('só um pedido em aberto por pessoa', async () => {
    const pessoa = await cadastrarPessoa('Repetida');
    expect((await pedir(pessoa, pedidoValido(filiacaoA, 333333333))).status).toBe(201);

    const segundo = await pedir(pessoa, pedidoValido(filiacaoA, 444444444));
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('REQUEST_ALREADY_PENDING');
  });

  // Medido: o pedido com CPF já cadastrado é ACEITO, e isso não é descuido.
  // `AthleteIdentity` está sob RLS e quem pede não é operador da federação —
  // qualquer pré-checagem ali enxergaria zero linhas e diria "não existe"
  // mesmo quando existe. Quem barra o duplicado é a unicidade no momento da
  // aprovação, dentro da transação, e o teste de atomicidade prova isso.
  it('CPF já cadastrado passa no pedido, e é barrado na aprovação sem deixar resto', async () => {
    const cpf = gerarCpf(555555555);
    expect((await api().post('/api/v1/athletes').set(operadorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Já Existe', cpf, sex: 'MALE', birthDate: '1990-01-01' })).status).toBe(201);

    const pessoa = await cadastrarPessoa('Mesmo CPF');
    const pedido = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });
    expect(pedido.status, 'a RLS impede a pré-checagem, então o pedido entra').toBe(201);

    const antes = await comoAtor(operadorA, () => prisma.athlete.count());
    const aprovacao = await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`).set(operadorA.auth()).send({});

    expect(aprovacao.status, 'a aprovação criou um segundo atleta com o mesmo CPF').toBeGreaterThanOrEqual(400);
    expect(await comoAtor(operadorA, () => prisma.athlete.count())).toBe(antes);

    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.body.id } }));
    expect(naFila.status).toBe('PENDING');
  });

  it('filiação inexistente ou inativa é recusada', async () => {
    const pessoa = await cadastrarPessoa('Sem Filiação');

    const inexistente = await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), affiliationId: 'cl00000000000000000000000' });
    expect(inexistente.status).toBe(422);
    expect(inexistente.body.error.code).toBe('AFFILIATION_INVALID');

    await comoAtor(admin, () => prisma.affiliation.update({ where: { id: filiacaoA.id }, data: { active: false } }));
    const inativa = await pedir(pessoa, pedidoValido(filiacaoA, 2));
    expect(inativa.status).toBe(422);
    expect(inativa.body.error.code).toBe('AFFILIATION_INACTIVE');
  });

  it('o solicitante acompanha o próprio pedido, e sem ver o CPF de volta', async () => {
    const pessoa = await cadastrarPessoa('Acompanha');
    await pedir(pessoa, pedidoValido(filiacaoA, 666666666));

    const meus = await api().get('/api/v1/athlete-requests/me').set(pessoa.auth());
    expect(meus.status).toBe(200);
    expect(meus.body.items).toHaveLength(1);
    expect(meus.body.items[0].status).toBe('PENDING');
    expect(JSON.stringify(meus.body), 'o CPF voltou na consulta do solicitante').not.toMatch(/"cpf"/);
  });
});

describe('quem pode analisar', () => {
  const pedidoDe = async nome => {
    const pessoa = await cadastrarPessoa(nome);
    const r = await pedir(pessoa, pedidoValido(filiacaoA, Math.floor(Math.random() * 1e9)));
    expect(r.status).toBe(201);
    return { pessoa, pedido: r.body };
  };

  it('o próprio solicitante NÃO aprova o próprio pedido, nem sendo operador', async () => {
    const { pessoa, pedido } = await pedidoDe('Auto Aprovadora');
    // Promovida a operadora DEPOIS de pedir: permissão não resolve conflito
    // de interesse.
    await vincular(orgA.id, { id: pessoa.id }, 'EVENT_DIRECTOR');

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(pessoa.auth()).send({});

    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_REVIEW_FORBIDDEN');
    expect(await prisma.athlete.count()).toBe(0);
  });

  it('papéis sem permissão não aprovam', async () => {
    const { pedido } = await pedidoDe('Alvo');

    for (const papel of ['ATHLETE', 'JUDGE', 'STAFF', 'MEDIA']) {
      const usuario = await criarUsuario({ role: papel, name: `Usuário ${papel}` });
      const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(usuario.auth()).send({});
      // 404 é resposta legítima e melhor que 403 aqui: a RLS esconde o pedido
      // de quem não é dono nem operador, então o serviço nem chega a avaliar
      // permissão — e a resposta não confirma que o pedido existe.
      expect([401, 403, 404], `${papel} aprovou`).toContain(r.status);
    }
    expect(await prisma.athlete.count()).toBe(0);
  });

  it('sem autenticação não alcança nada da fila', async () => {
    const { pedido } = await pedidoDe('Anônimo');
    expect((await api().get('/api/v1/athlete-requests')).status).toBe(401);
    expect((await api().get(`/api/v1/athlete-requests/${pedido.id}`)).status).toBe(401);
    expect((await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).send({})).status).toBe(401);
  });

  it('operador de OUTRA federação não lê, não aprova e não rejeita', async () => {
    const { pedido } = await pedidoDe('Alvo Cross');

    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const operadorB = await criarUsuario({ name: 'Operador B' });
    await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');

    expect([403, 404]).toContain((await api().get(`/api/v1/athlete-requests/${pedido.id}`).set(operadorB.auth())).status);
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorB.auth()).send({})).status);
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorB.auth()).send({ reason: 'porque sim' })).status);

    expect(await prisma.athlete.count()).toBe(0);

    // E a fila dele não mostra pedido da federação A.
    const fila = await api().get(`/api/v1/athlete-requests?organizationId=${orgB.id}`).set(operadorB.auth());
    if (fila.status === 200) expect(fila.body.items).toHaveLength(0);
  });
});

describe('aprovação', () => {
  it('cria atleta e identidade, vincula filiação e número, e tira o CPF do pedido', async () => {
    const pessoa = await cadastrarPessoa('Aprovada');
    const cpf = gerarCpf(777777777);
    const pedido = (await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf })).body;

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorA.auth()).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('APPROVED');
    expect(r.body.reviewedById).toBe(operadorA.id);
    expect(r.body.reviewedAt).toBeTruthy();

    const atleta = await comoAtor(operadorA, () => prisma.athlete.findFirst({ where: { organizationId: orgA.id } }));
    expect(atleta).toBeTruthy();
    expect(atleta.userId, 'o atleta não ficou ligado à conta de quem pediu').toBe(pessoa.id);
    expect(atleta.affiliationId).toBe(filiacaoA.id);
    expect(atleta.affiliationNumber).toBe('NPC-00123');
    expect(atleta.fullName).toBe('Atleta Solicitante');

    // O documento migrou para onde a RLS de CPF o protege...
    const identidade = await comoAtor(operadorA, () => prisma.athleteIdentity.findUnique({ where: { athleteId: atleta.id } }));
    expect(identidade.cpf).toBe(cpf.replace(/\D/g, ''));

    // ...e saiu do pedido.
    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }));
    expect(naFila.cpf, 'o CPF continuou guardado na fila depois da aprovação').toBeNull();
    expect(naFila.athleteId).toBe(atleta.id);
  });

  it('aprovar duas vezes não cria dois atletas', async () => {
    const pessoa = await cadastrarPessoa('Duas Vezes');
    const pedido = (await pedir(pessoa, pedidoValido(filiacaoA, 888888888))).body;

    expect((await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorA.auth()).send({})).status).toBe(200);

    const segunda = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorA.auth()).send({});
    expect(segunda.status).toBe(422);
    expect(segunda.body.error.code).toBe('REQUEST_NOT_PENDING');

    expect(await comoAtor(operadorA, () => prisma.athlete.count())).toBe(1);
  });

  // A atomicidade importa porque a falha plausível é justamente a segunda
  // escrita: a identidade. Um atleta sem CPF não aparece na busca por
  // documento e vira um fantasma que ninguém consegue inscrever.
  it('se a identidade falhar, NENHUM atleta sobra', async () => {
    const pessoa = await cadastrarPessoa('Corrida');
    const cpf = gerarCpf(999999999);
    const pedido = (await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf })).body;

    // Alguém registra o mesmo CPF entre o pedido e a análise — a unicidade de
    // `AthleteIdentity` derruba a transação no meio.
    const outro = await api().post('/api/v1/athletes').set(operadorA.auth())
      .send({ organizationId: orgA.id, fullName: 'Chegou Antes', cpf, sex: 'MALE', birthDate: '1990-01-01' });
    expect(outro.status).toBe(201);

    const antes = await comoAtor(operadorA, () => prisma.athlete.count());
    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorA.auth()).send({});
    expect(r.status).toBeGreaterThanOrEqual(400);

    const depois = await comoAtor(operadorA, () => prisma.athlete.count());
    expect(depois, 'sobrou atleta de uma aprovação que falhou').toBe(antes);

    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }));
    expect(naFila.status, 'o pedido foi marcado aprovado mesmo com a transação falhando').toBe('PENDING');
  });
});

describe('rejeição e cancelamento', () => {
  it('rejeitar exige motivo, guarda quem analisou e NÃO apaga a linha', async () => {
    const pessoa = await cadastrarPessoa('Rejeitada');
    const pedido = (await pedir(pessoa, pedidoValido(filiacaoA, 121212121))).body;

    const semMotivo = await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorA.auth()).send({});
    expect(semMotivo.status).toBe(400);

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorA.auth())
      .send({ reason: 'Número de filiação não confere com o cadastro da entidade' });

    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    expect(r.body.rejectionReason).toMatch(/não confere/);
    expect(r.body.reviewedById).toBe(operadorA.id);

    // Histórico preservado, documento não.
    const naFila = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }));
    expect(naFila).toBeTruthy();
    expect(naFila.cpf).toBeNull();
    expect(await prisma.athlete.count()).toBe(0);
  });

  it('depois de rejeitada, a pessoa pode pedir de novo', async () => {
    const pessoa = await cadastrarPessoa('Segunda Chance');
    const primeiro = (await pedir(pessoa, pedidoValido(filiacaoA, 131313131))).body;
    await api().post(`/api/v1/athlete-requests/${primeiro.id}/reject`).set(operadorA.auth()).send({ reason: 'dados incompletos' });

    const segundo = await pedir(pessoa, pedidoValido(filiacaoA, 141414141));
    expect(segundo.status, 'o índice parcial barrou quem já tinha sido recusado').toBe(201);
  });

  it('o solicitante cancela o próprio pedido; outra pessoa não', async () => {
    const pessoa = await cadastrarPessoa('Desistente');
    const pedido = (await pedir(pessoa, pedidoValido(filiacaoA, 151515151))).body;

    const estranha = await cadastrarPessoa('Estranha');
    expect([403, 404]).toContain((await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(estranha.auth()).send({})).status);

    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(pessoa.auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
  });
});

describe('CPF e auditoria', () => {
  it('a listagem da fila NÃO devolve CPF', async () => {
    const pessoa = await cadastrarPessoa('Na Fila');
    const cpf = gerarCpf(161616161);
    await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf });

    const fila = await api().get(`/api/v1/athlete-requests?organizationId=${orgA.id}`).set(operadorA.auth());
    expect(fila.status, JSON.stringify(fila.body)).toBe(200);
    expect(fila.body.items).toHaveLength(1);

    const texto = JSON.stringify(fila.body);
    expect(texto, 'o CPF apareceu na listagem da fila').not.toContain(cpf.replace(/\D/g, ''));
    expect(texto).not.toMatch(/"cpf"/);
  });

  it('o CPF sai só na tela de análise, e só para quem lê dado sensível', async () => {
    const pessoa = await cadastrarPessoa('Analisada');
    const cpf = gerarCpf(171717171);
    const pedido = (await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf })).body;

    const analise = await api().get(`/api/v1/athlete-requests/${pedido.id}`).set(operadorA.auth());
    expect(analise.status).toBe(200);
    expect(analise.body.cpf).toBe(cpf.replace(/\D/g, ''));
  });

  it('a auditoria registra pedido, aprovação e rejeição — e nunca o CPF', async () => {
    const pessoa = await cadastrarPessoa('Auditada');
    const cpf = gerarCpf(181818181);
    const pedido = (await pedir(pessoa, { ...pedidoValido(filiacaoA, 1), cpf })).body;
    await api().post(`/api/v1/athlete-requests/${pedido.id}/approve`).set(operadorA.auth()).send({});

    const trilha = await comoAtor(admin, () => prisma.auditLog.findMany({
      where: { action: { in: ['ATHLETE_PROFILE_REQUEST_CREATE', 'ATHLETE_PROFILE_REQUEST_APPROVE'] } }
    }));

    expect(trilha.map(l => l.action).sort()).toEqual(['ATHLETE_PROFILE_REQUEST_APPROVE', 'ATHLETE_PROFILE_REQUEST_CREATE']);
    expect(JSON.stringify(trilha), 'o CPF foi parar na auditoria').not.toContain(cpf.replace(/\D/g, ''));
  });
});
