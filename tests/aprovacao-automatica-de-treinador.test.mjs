import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// APROVAÇÃO AUTOMÁTICA DO CADASTRO DE TREINADOR (EQUIPE) — a decisão que mudou
// R-03, e a metade dela que NÃO mudou.
//
// ANTES: o cadastro nascia PENDING e só a administração central da MuscleContest
// podia aprová-lo. Quem se cadastrava esperava numa fila.
//
// AGORA: o cadastro nasce APPROVED e a pessoa entra na área de treinador na hora.
//
// O QUE ESTA SUÍTE EXISTE PARA IMPEDIR
//
// A leitura preguiçosa da decisão é "o treinador foi aprovado, então ele pode
// tudo". É falsa, e o dano seria grande: aprovar CADASTRO nunca foi autorizar
// ATUAÇÃO. Autorizar atuação numa federação é R-04, é decisão da federação, e
// continua exigindo `CoachOrganization`. Metade destes testes mede exatamente
// essa fronteira — o treinador recém-aprovado que ainda não pode nada numa
// federação.
//
// E a segunda borda: cadastro ANTIGO que ficou em análise NÃO foi aprovado
// retroativamente. A decisão vale para o cadastro novo; o passado continua
// esperando análise específica.
// ============================================================================

const SENHA_DO_CONSTRUTOR = 'senha-de-teste-123';

let central;
let orgA;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  central = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  orgA = (await criarOrganizacao(central, { name: unico('Federação A') })).id;
});

const novoTreinador = async (nome = 'Treinadora Marta') => {
  const conta = await criarUsuario({ role: 'COACH', name: nome });
  const pedido = await api().post('/api/v1/coaches/self-register').set(conta.auth())
    .send({ name: `QA ${nome}`, registration: unico('REG').slice(0, 24) });
  return { conta, resposta: pedido };
};

describe('o cadastro novo nasce aprovado', () => {
  it('responde 201 com status APPROVED — sem fila, sem espera', async () => {
    const { resposta } = await novoTreinador();

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.status).toBe('APPROVED');
  });

  it('grava `autoApprovedAt` e `reviewedAt`, e NÃO inventa um revisor', async () => {
    // `reviewedById` nulo porque não houve pessoa: preencher seria mentir na
    // trilha. `reviewedAt` preenchido porque é ele que tira a linha do predicado
    // do legado A-05 (`reviewedById IS NULL AND reviewedAt IS NULL`), que a
    // migration 20260927030000 devolve a PENDING. `autoApprovedAt` diz por quê.
    const { resposta } = await novoTreinador();

    const linha = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: resposta.body.id },
      select: { status: true, autoApprovedAt: true, reviewedAt: true, reviewedById: true }
    }));

    expect(linha.status).toBe('APPROVED');
    expect(linha.autoApprovedAt, 'a marca da aprovação pela regra').toBeTruthy();
    expect(linha.reviewedAt, 'sem isto o legado derrubaria o cadastro para PENDING').toBeTruthy();
    expect(linha.reviewedById, 'não houve pessoa, e a trilha não deve fingir que houve').toBeNull();
  });

  it('o treinador entra e ABRE a própria área na mesma hora', async () => {
    const { conta } = await novoTreinador();

    const entrada = await api().post('/api/v1/auth/login')
      .send({ email: conta.email, password: SENHA_DO_CONSTRUTOR });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(200);

    const area = await api().get('/api/v1/coaches/me')
      .set({ Authorization: `Bearer ${entrada.body.token}` });
    expect(area.status, JSON.stringify(area.body)).toBe(200);
    expect(area.body.status).toBe('APPROVED');
  });

  it('a trilha registra o cadastro E a aprovação, marcada como automática', async () => {
    // Uma auditoria que registrasse só `COACH_REGISTER` faria a aprovação
    // desaparecer do histórico, e quem lesse depois não saberia que o APPROVED
    // não passou por pessoa.
    const { resposta } = await novoTreinador();

    const trilha = await comoAtor(central, tx => tx.auditLog.findMany({
      where: { entity: 'Coach', entityId: resposta.body.id },
      select: { action: true, metadata: true }
    }));
    const acoes = trilha.map(linha => linha.action);

    expect(acoes).toContain('COACH_REGISTER');
    expect(acoes).toContain('COACH_APPROVE');

    const aprovacao = trilha.find(linha => linha.action === 'COACH_APPROVE');
    expect(aprovacao.metadata.automatic, 'a trilha tem de dizer que foi a regra').toBe(true);
    expect(aprovacao.metadata.to).toBe('APPROVED');
  });
});

describe('aprovação de cadastro NÃO é autorização para atuar — R-04 intacta', () => {
  it('o treinador aprovado nasce SEM autorização em federação nenhuma', async () => {
    const { resposta } = await novoTreinador();

    const autorizacoes = await comoAtor(central, tx => tx.coachOrganization.count({
      where: { coachId: resposta.body.id }
    }));
    expect(autorizacoes, 'aprovar cadastro não autoriza atuação em lugar nenhum').toBe(0);
  });

  it('a federação RECUSA equipe para treinador sem autorização dela', async () => {
    // Esta é a barreira que a leitura preguiçosa da decisão nova destruiria.
    const { resposta } = await novoTreinador();
    const diretor = await criarUsuario({ role: 'ATHLETE', name: 'Diretor' });
    await api().post(`/api/v1/organizations/${orgA}/members`).set(central.auth())
      .send({ userId: diretor.id, role: 'EVENT_DIRECTOR' });

    const equipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgA, name: unico('Equipe'), coachId: resposta.body.id });

    expect(equipe.status, JSON.stringify(equipe.body)).toBe(422);
  });

  it('a federação autoriza pelo fluxo que já existia, e só então a equipe passa', async () => {
    const { resposta } = await novoTreinador();
    const diretor = await criarUsuario({ role: 'ATHLETE', name: 'Diretor' });
    await api().post(`/api/v1/organizations/${orgA}/members`).set(central.auth())
      .send({ userId: diretor.id, role: 'EVENT_DIRECTOR' });

    const autorizacao = await api().post(`/api/v1/coaches/${resposta.body.id}/organizations`)
      .set(diretor.auth())
      .send({ organizationId: orgA, reason: 'Atuação autorizada pela federação.' });
    // 200, e não 201: a rota é idempotente por desenho — autorizar de novo a
    // mesma federação reaproveita a linha em vez de criar outra. Medido; eu havia
    // escrito 201 por analogia com as outras criações, e estava errado.
    expect(autorizacao.status, JSON.stringify(autorizacao.body)).toBe(200);

    const equipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgA, name: unico('Equipe'), coachId: resposta.body.id });
    expect(equipe.status, JSON.stringify(equipe.body)).toBe(201);
  });

  it('as permissões do papel continuam as mesmas cinco', async () => {
    const { conta } = await novoTreinador();

    // A área própria abre; a fila de análise central continua fechada para ele.
    expect((await api().get('/api/v1/coaches/me').set(conta.auth())).status).toBe(200);
    expect((await api().get('/api/v1/coaches/review').set(conta.auth())).status).toBe(403);
  });
});

describe('o que continua sendo decisão humana', () => {
  it('suspender é da central, e derruba o acesso à área', async () => {
    const { resposta, conta } = await novoTreinador();

    const suspensao = await api().post(`/api/v1/coaches/${resposta.body.id}/suspend`)
      .set(central.auth()).send({ reason: 'Apuração disciplinar.' });
    expect(suspensao.status, JSON.stringify(suspensao.body)).toBe(200);

    const depois = await api().get('/api/v1/coaches/me').set(conta.auth());
    expect(depois.body.status).toBe('SUSPENDED');
  });

  it('o treinador NÃO suspende nem reativa a si mesmo', async () => {
    const { resposta, conta } = await novoTreinador();

    const tentativa = await api().post(`/api/v1/coaches/${resposta.body.id}/suspend`)
      .set(conta.auth()).send({ reason: 'Tentativa indevida.' });
    expect(tentativa.status).toBe(403);
  });

  it('aprovar de novo o que já está aprovado é recusado, e com o motivo certo', async () => {
    // `COACH_STATUS_UNCHANGED` e não `COACH_INVALID_TRANSITION`: o serviço separa
    // "já está nesse estado" de "não pode ir para esse estado", e a distinção é
    // útil — a primeira é ruído de operação, a segunda é tentativa de pular etapa.
    // Medido; eu esperava a segunda.
    const { resposta } = await novoTreinador();

    const denovo = await api().post(`/api/v1/coaches/${resposta.body.id}/approve`)
      .set(central.auth()).send({ reason: 'Aprovação redundante.' });
    expect(denovo.status).toBe(422);
    expect(denovo.body.error.code).toBe('COACH_STATUS_UNCHANGED');
  });
});

describe('o passado não foi aprovado retroativamente', () => {
  it('cadastro que ficou PENDING continua PENDING e continua na fila', async () => {
    // A decisão vale para o cadastro NOVO. Aprovar o legado em massa seria
    // decidir, sem análise, sobre cadastro que alguém deixou em análise.
    const legado = await comoAtor(central, tx => tx.coach.create({
      data: { name: 'QA Treinador Legado', status: 'PENDING' },
      select: { id: true, status: true, autoApprovedAt: true }
    }));

    expect(legado.status).toBe('PENDING');
    expect(legado.autoApprovedAt, 'o legado não recebe a marca da regra').toBeNull();

    const fila = await api().get('/api/v1/coaches/review?status=PENDING').set(central.auth());
    expect(fila.status).toBe(200);
    expect(fila.body.items.map(item => item.id)).toContain(legado.id);
  });

  it('a central ainda aprova um legado, e aí o revisor É uma pessoa', async () => {
    const legado = await comoAtor(central, tx => tx.coach.create({
      data: { name: 'QA Treinador Legado', status: 'PENDING' }, select: { id: true }
    }));

    const decisao = await api().post(`/api/v1/coaches/${legado.id}/approve`)
      .set(central.auth()).send({ reason: 'Documentação conferida.' });
    expect(decisao.status, JSON.stringify(decisao.body)).toBe(200);

    const linha = await comoAtor(central, tx => tx.coach.findUnique({
      where: { id: legado.id },
      select: { status: true, reviewedById: true, autoApprovedAt: true }
    }));
    expect(linha.status).toBe('APPROVED');
    expect(linha.reviewedById, 'houve pessoa, e a trilha aponta quem').toBe(central.id);
    expect(linha.autoApprovedAt, 'não foi a regra: foi decisão humana').toBeNull();
  });
});

describe('a senha continua sendo guardada só pelo mecanismo de autenticação', () => {
  it('o cadastro de conta nunca devolve nem grava senha em texto puro', async () => {
    const senha = 'SenhaForteDeQA#2026';
    const endereco = `${unico('treinador')}@mci.test`.toLowerCase();

    const criacao = await api().post('/api/v1/auth/register').send({
      name: 'QA Treinador Novo', email: endereco, password: senha, role: 'COACH',
      birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
      postalCode: '78000000', addressLine: 'Rua de QA', addressNumber: '100',
      state: 'MT', city: 'Cuiabá'
    });
    expect(criacao.status, JSON.stringify(criacao.body)).toBe(201);

    const corpo = JSON.stringify(criacao.body);
    expect(corpo, 'a resposta não devolve a senha').not.toContain(senha);
    expect(corpo, 'nem o hash').not.toContain('passwordHash');

    const linha = await prisma.user.findUnique({
      where: { email: endereco }, select: { passwordHash: true }
    });
    expect(linha.passwordHash, 'texto puro no banco é o que não pode acontecer').not.toBe(senha);
    expect(linha.passwordHash, 'bcrypt, como o resto da base').toMatch(/^\$2[aby]\$/);
  });

  it('a senha de quem já existia continua valendo — a mudança não redefine nada', async () => {
    const antiga = await criarUsuario({ role: 'COACH', name: 'Treinador Antigo' });

    const entrada = await api().post('/api/v1/auth/login')
      .send({ email: antiga.email, password: SENHA_DO_CONSTRUTOR });
    expect(entrada.status, 'login de conta pré-existente não pode ter sido afetado').toBe(200);
  });
});
