import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// ENDURECIMENTO APÓS A AUDITORIA INDEPENDENTE — os achados A-01 a A-04.
//
// Cada bloco abaixo é a PROVA NEGATIVA de um achado: o teste falha se a
// correção for desfeita. Não há teste de caminho feliz aqui que já exista em
// `modulo-treinadores-equipes.test.mjs` — o caminho feliz continua sendo medido
// lá, e duplicá-lo só tornaria a suíte mais lenta sem medir nada novo.
//
// A-01  as rotas de ranking do treinador exigiam apenas sessão: qualquer conta
//       autenticada lia `status` e as equipes de qualquer treinador, com os ids
//       enumeráveis pelo catálogo público `GET /coaches`.
// A-02  a concessão central aceitava escopo nulo (valia em TODA federação) e
//       validade nula (valia para sempre).
// A-03  a leitura de atleta pelo treinador é de FEDERAÇÃO, não de equipe — o
//       limite real está aqui medido, inclusive o que ele NÃO cobre.
// A-04  `vinculo_criacao` deixava o atleta gravar vínculo para si em QUALQUER
//       equipe, sem exigir pedido pendente daquela equipe.
// ============================================================================

let admin;
let orgA;
let orgB;
let diretorA;
let diretorB;
let contaTreinador;
let coachId;
let equipeA;
let contaAtleta;
let atletaComConta;

const cpfSeq = (() => { let n = 770000000; return () => gerarCpf(n += 4441); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  orgA = (await criarOrganizacao(admin, { name: unico('Federação A') })).id;
  orgB = (await criarOrganizacao(admin, { name: unico('Federação B') })).id;

  diretorA = await criarUsuario({ name: 'Diretor A' });
  diretorB = await criarUsuario({ name: 'Diretor B' });
  await vincular(orgA, diretorA, 'EVENT_DIRECTOR');
  await vincular(orgB, diretorB, 'EVENT_DIRECTOR');

  contaTreinador = await criarUsuario({ role: 'COACH', name: 'Treinadora Marta' });
  contaAtleta = await criarUsuario({ name: 'Atleta Com Conta' });

  atletaComConta = await criarAtleta(diretorA, orgA, {
    fullName: 'Joana Ferreira', cpf: cpfSeq(), affiliationNumber: '7001'
  });
  await api().patch(`/api/v1/athletes/${atletaComConta.id}`).set(diretorA.auth())
    .send({ userId: contaAtleta.id });

  const cadastro = await api().post('/api/v1/coaches/self-register').set(contaTreinador.auth())
    .send({ name: 'Marta Treinadora', registration: 'CREF-77777', phone: '65999887766' });
  expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(201);
  coachId = cadastro.body.id;

  equipeA = (await api().post('/api/v1/teams').set(diretorA.auth())
    .send({ organizationId: orgA, name: unico('Equipe Marta') })).body;
});

// A APROVAÇÃO DO CADASTRO SAIU DAS FIXTURES DESTE ARQUIVO.
//
// Ela passou a acontecer no próprio autocadastro — decisão que substituiu a
// análise central. Chamar `POST /coaches/:id/approve` depois do autocadastro
// agora devolve 422 `COACH_STATUS_UNCHANGED`, porque o cadastro JÁ está aprovado.
//
// O que continua medido aqui, e não mudou: a federação NÃO aprova cadastro
// (403), autorizar atuação continua sendo ato dela, e suspender/reativar
// continuam sendo da central. A aprovação automática e a fronteira que ela não
// atravessa estão em `tests/aprovacao-automatica-de-treinador.test.mjs`.
async function habilitarTreinador() {
  expect((await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
    .send({ organizationId: orgA, reason: 'Atuação autorizada.' })).status).toBe(200);
  expect((await api().post(`/api/v1/teams/${equipeA.id}/coach`).set(diretorA.auth())
    .send({ coachId })).status).toBe(200);
}

// O CADASTRO EM ANÁLISE VIROU ESTADO LEGADO — e escrevê-lo é a única forma honesta.
//
// Vários testes deste arquivo medem o que acontece com um cadastro PENDING: a
// guarda de A-01 que não deixa o `status` escapar, o predicado da correção de
// A-05, o catálogo de A-13 com um cadastro rejeitado, e a lista da federação de
// F-04. O produto não produz mais esse estado — o autocadastro nasce APPROVED —
// e nenhuma rota devolve um cadastro aprovado para análise.
//
// Então ele é ESCRITO, dizendo que é isso que se está fazendo. O que se monta é
// o cadastro feito ANTES da mudança, que ficou em análise e não foi aprovado
// retroativamente. `autoApprovedAt` e `reviewedAt` voltam a nulo junto com o
// status: um PENDING com marca de aprovação seria um estado que nunca existiu.
async function voltarParaAnalise(id = coachId) {
  await comoAtor(admin, tx => tx.coach.update({
    where: { id },
    data: { status: 'PENDING', autoApprovedAt: null, reviewedAt: null, reviewedById: null }
  }));
}

// Aprovação POR PESSOA, pela rota real — o caminho que grava revisor e data. Ela
// só existe para o cadastro legado, e por isso passa pela análise primeiro.
async function aprovarPorPessoa(id = coachId) {
  await voltarParaAnalise(id);
  const r = await api().post(`/api/v1/coaches/${id}/approve`).set(admin.auth())
    .send({ reason: 'Documentação conferida pela mesa central.' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function criarTemporada() {
  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: orgA, name: unico('Temporada'), year: 2032 });
  expect(temporada.status, JSON.stringify(temporada.body)).toBeLessThan(300);
  return temporada.body.id;
}

// ---------------------------------------------------------------------- A-01
describe('A-01: as rotas de ranking do treinador exigem mais que uma sessão', () => {
  it('conta autenticada ALHEIA recebe 404 nas duas rotas — e o 404 não é oráculo', async () => {
    await habilitarTreinador();
    const seasonId = await criarTemporada();

    // O intruso é uma conta comum, do tipo que qualquer pessoa cria sozinha.
    const intruso = await criarUsuario({ name: 'Conta Qualquer' });

    // O id do treinador não é segredo: o catálogo o entrega.
    const catalogo = await api().get('/api/v1/coaches').set(intruso.auth());
    expect(catalogo.status, 'o catálogo de treinadores continua respondendo').toBe(200);

    for (const rota of ['eligibility', 'projection']) {
      const tentativa = await api().get(`/api/v1/coaches/${coachId}/ranking/${rota}`)
        .set(intruso.auth()).query({ seasonId });
      expect(tentativa.status, `${rota}: ${JSON.stringify(tentativa.body)}`).toBe(404);
      expect(tentativa.body.error.code).toBe('COACH_NOT_FOUND');

      // ANTIENUMERAÇÃO: id inexistente produz a MESMA resposta. Se um dia a
      // recusa do treinador alheio virar 403, esta comparação falha.
      const inexistente = await api().get(`/api/v1/coaches/nao-existe-id/ranking/${rota}`)
        .set(intruso.auth()).query({ seasonId });
      expect(inexistente.status).toBe(tentativa.status);
      expect(inexistente.body.error.code).toBe(tentativa.body.error.code);
    }
  });

  it('o corpo da recusa não vaza status nem nome de equipe do treinador', async () => {
    await habilitarTreinador();
    const seasonId = await criarTemporada();
    const intruso = await criarUsuario({ name: 'Conta Qualquer' });

    const tentativa = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(intruso.auth()).query({ seasonId });
    const texto = JSON.stringify(tentativa.body);
    expect(texto).not.toContain('APPROVED');
    expect(texto).not.toContain(equipeA.name);
    expect(texto).not.toContain('Marta');
  });

  it('o DONO do cadastro continua lendo as duas rotas', async () => {
    await habilitarTreinador();
    const seasonId = await criarTemporada();

    const elegibilidade = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(contaTreinador.auth()).query({ seasonId });
    expect(elegibilidade.status, JSON.stringify(elegibilidade.body)).toBe(200);
    expect(elegibilidade.body.teams.map(e => e.id)).toContain(equipeA.id);

    const projecao = await api().get(`/api/v1/coaches/${coachId}/ranking/projection`)
      .set(contaTreinador.auth()).query({ seasonId });
    expect(projecao.status, JSON.stringify(projecao.body)).toBe(200);
    expect(projecao.body.homologado).toBe(false);
  });

  it('a mesa central lê qualquer treinador — é o trabalho dela (R-03)', async () => {
    await habilitarTreinador();
    const seasonId = await criarTemporada();

    const pelaMesa = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(admin.auth()).query({ seasonId });
    expect(pelaMesa.status, JSON.stringify(pelaMesa.body)).toBe(200);
    expect(pelaMesa.body.coach.id).toBe(coachId);
  });

  it('o gestor de ranking de OUTRA federação NÃO lê o cadastro — nem com a permissão dele', async () => {
    // A PRIMEIRA VERSÃO DESTA GUARDA ADMITIA `ranking.manage`, e estava larga por
    // uma razão que não é óbvia: numa pergunta SEM organização,
    // `effectivePermissions` soma as permissões de TODAS as filiações do ator.
    // Então o gestor de ranking de qualquer federação lia o `status` da análise
    // cadastral de treinador de outra — vazamento cross-tenant de dado de R-03,
    // criado pela guarda que fecha A-01.
    await habilitarTreinador();
    const seasonId = await criarTemporada();

    const gestorDeB = await criarUsuario({ name: 'Gestora de Ranking da B' });
    await vincular(orgB, gestorDeB, 'RANKING_MANAGER');

    for (const rota of ['eligibility', 'projection']) {
      const tentativa = await api().get(`/api/v1/coaches/${coachId}/ranking/${rota}`)
        .set(gestorDeB.auth()).query({ seasonId });
      expect(tentativa.status, `${rota}: ${JSON.stringify(tentativa.body)}`).toBe(404);
      expect(JSON.stringify(tentativa.body)).not.toContain('APPROVED');
    }

    // E a conferência de R-01, que é sobre PONTO e não sobre cadastro, continua
    // sendo dele: a guarda estreitou o que precisava, não o que funcionava.
    const divergencias = await api().get('/api/v1/coaches/ranking/divergences')
      .set(gestorDeB.auth()).query({ seasonId });
    expect(divergencias.status, JSON.stringify(divergencias.body)).toBe(200);
  });

  it('sem sessão as duas rotas recusam com 401, e não com 404', async () => {
    const seasonId = await criarTemporada();
    for (const rota of ['eligibility', 'projection']) {
      const anonimo = await api().get(`/api/v1/coaches/${coachId}/ranking/${rota}`).query({ seasonId });
      expect(anonimo.status, rota).toBe(401);
    }
  });

  it('a guarda vem ANTES da leitura do cadastro: nem o `status` de um treinador PENDING escapa', async () => {
    // O cadastro é devolvido à análise de propósito (ver `voltarParaAnalise`), e
    // `habilitarTreinador` não roda: é o cadastro legado em análise que se mede.
    await voltarParaAnalise();
    const seasonId = await criarTemporada();
    const intruso = await criarUsuario({ name: 'Conta Qualquer' });

    const tentativa = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`)
      .set(intruso.auth()).query({ seasonId });
    expect(tentativa.status).toBe(404);
    expect(JSON.stringify(tentativa.body)).not.toContain('PENDING');

    const registro = await comoAtor(admin, tx => tx.coach.findUnique({
      where: { id: coachId }, select: { status: true }
    }));
    expect(registro.status, 'a consulta recusada não mexeu no cadastro').toBe('PENDING');
  });
});

// ---------------------------------------------------------------------- A-02
//
// A CONCESSÃO GRAVADA POR FORA DA ROTA É O CASO QUE IMPORTA.
//
// O schema Zod e o serviço recusam conceder sem escopo ou sem prazo, e isso está
// medido em `permissoes-delegacao.test.mjs`. Mas a política `central_concessao`
// autoriza o administrador de plataforma a INSERIR qualquer linha, e script,
// migration e mão humana no banco não passam pelo serviço. Se a linha plantada
// virasse poder, as duas recusas de escrita seriam decoração — então o que os
// testes abaixo medem é a LEITURA: a linha existe no banco e não concede nada.
//
// O caminho medido é o real: `POST /athletes/:id/team/transfer`, que é a
// operação de R-02 que a delegação existe para autorizar.
describe('A-02: delegação central sem escopo ou sem prazo não concede nada', () => {
  let delegado;
  let equipeB;
  let atleta;

  const PRAZO_VALIDO = new Date('2099-12-31T00:00:00.000Z');

  /** Grava a concessão DIRETO na tabela, como um script faria. */
  const plantarConcessao = ({ organizationId, expiresAt }) => comoAtor(admin, tx =>
    tx.centralAuthorization.create({
      data: {
        userId: delegado.id, permission: 'athletes.transfer',
        organizationId, expiresAt,
        reason: 'Linha gravada fora da rota, como um script faria.',
        grantedById: admin.id,
        activeKey: `${delegado.id}:athletes.transfer:${organizationId ?? 'ALL'}`
      },
      select: { id: true }
    }));

  const revogar = id => comoAtor(admin, tx => tx.centralAuthorization.update({
    where: { id }, data: { revokedAt: new Date(), revokedById: admin.id, activeKey: null }
  }));

  const transferir = () => api().post(`/api/v1/athletes/${atleta.id}/team/transfer`)
    .set(delegado.auth()).send({ teamId: equipeB.id, reason: 'Transferência autorizada pela federação.' });

  const equipeAtual = () => comoAtor(admin, tx => tx.athleteTeamMembership.findFirst({
    where: { athleteId: atleta.id, endedAt: null }, select: { teamId: true }
  }));

  beforeEach(async () => {
    // ADMIN de plataforma: a delegação pressupõe quem já é administrador
    // central, porque RLS não reconhece `CentralAuthorization` como
    // visibilidade. Ver `tests/vinculo-equipe.test.mjs`.
    delegado = await criarUsuario({ role: 'ADMIN', name: 'Administradora Delegada' });

    equipeB = (await api().post('/api/v1/teams').set(diretorA.auth())
      .send({ organizationId: orgA, name: unico('Equipe Beta') })).body;

    atleta = await criarAtleta(diretorA, orgA, { fullName: 'Atleta Da Delegação', cpf: cpfSeq() });
    const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretorA.auth())
      .send({ teamId: equipeA.id });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(201);
  });

  it('concessão SEM ESCOPO, gravada no banco, não autoriza a transferência', async () => {
    const { id } = await plantarConcessao({ organizationId: null, expiresAt: PRAZO_VALIDO });

    const tentativa = await transferir();
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);

    expect((await equipeAtual()).teamId, 'o vínculo não mudou').toBe(equipeA.id);

    // A LINHA CONTINUA LÁ: a correção é de leitura, não apaga registro real.
    const viva = await comoAtor(admin, tx => tx.centralAuthorization.findUnique({
      where: { id }, select: { id: true, revokedAt: true, organizationId: true }
    }));
    expect(viva.revokedAt, 'a concessão não foi revogada por baixo dos panos').toBeNull();
    expect(viva.organizationId).toBeNull();
  });

  it('concessão SEM PRAZO, gravada no banco, não autoriza a transferência', async () => {
    await plantarConcessao({ organizationId: orgA, expiresAt: null });

    const tentativa = await transferir();
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
    expect((await equipeAtual()).teamId).toBe(equipeA.id);
  });

  it('concessão VENCIDA não autoriza, e o vencimento vale sem job nenhum', async () => {
    await plantarConcessao({ organizationId: orgA, expiresAt: new Date('2020-01-01T00:00:00.000Z') });

    const tentativa = await transferir();
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
    expect((await equipeAtual()).teamId).toBe(equipeA.id);
  });

  it('concessão de OUTRA federação não autoriza a operação nesta', async () => {
    await plantarConcessao({ organizationId: orgB, expiresAt: PRAZO_VALIDO });

    const tentativa = await transferir();
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
    expect((await equipeAtual()).teamId).toBe(equipeA.id);
  });

  it('concessão COM escopo E prazo autoriza — a correção não quebrou o caminho legítimo', async () => {
    await plantarConcessao({ organizationId: orgA, expiresAt: PRAZO_VALIDO });

    const transferencia = await transferir();
    expect(transferencia.status, JSON.stringify(transferencia.body)).toBe(200);
    expect((await equipeAtual()).teamId).toBe(equipeB.id);
  });

  it('a REVOGAÇÃO tira o poder na requisição seguinte, sem esperar nada', async () => {
    const { id } = await plantarConcessao({ organizationId: orgA, expiresAt: PRAZO_VALIDO });
    await revogar(id);

    const tentativa = await transferir();
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);
    expect((await equipeAtual()).teamId).toBe(equipeA.id);
  });

  it('o serviço recusa conceder sem escopo e sem prazo, mesmo chamado por dentro', async () => {
    // A recusa do schema Zod já está medida pela rota. Esta mede a do SERVIÇO,
    // que é a que resta quando a chamada não vem de uma requisição HTTP.
    const central = await import('../src/services/centralAuthorizationService.js');
    const ator = { id: admin.id, role: 'SUPER_ADMIN', memberships: [], centralGrantsReceived: [] };

    const semEscopo = await comoAtor(admin, () => central.default.conceder(
      { userId: delegado.id, permission: 'athletes.transfer', reason: 'Sem escopo.', expiresAt: PRAZO_VALIDO },
      ator
    )).catch(erro => erro);
    expect(semEscopo.status).toBe(422);
    expect(semEscopo.code).toBe('ORGANIZATION_REQUIRED');

    const semPrazo = await comoAtor(admin, () => central.default.conceder(
      { userId: delegado.id, permission: 'athletes.transfer', organizationId: orgA, reason: 'Sem prazo.' },
      ator
    )).catch(erro => erro);
    expect(semPrazo.status).toBe(422);
    expect(semPrazo.code).toBe('EXPIRES_AT_REQUIRED');

    // E nada foi gravado pelas duas tentativas.
    const gravadas = await comoAtor(admin, tx => tx.centralAuthorization.findMany({ where: { userId: delegado.id } }));
    expect(gravadas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- A-04
//
// A POLÍTICA TEM DE SER TÃO ESTREITA QUANTO O SERVIÇO, E NÃO MAIS LARGA.
//
// `vinculo_criacao` autorizava `mci_atleta_do_usuario("athleteId")` sem dizer
// nada sobre `teamId`: o atleta gravava vínculo com QUALQUER equipe. Nenhuma
// rota fazia isso — `confirmar` usa `pedido.teamId` —, e é justamente por isso
// que o teste da folga não podia passar pela rota: ele grava DIRETO na tabela,
// no contexto de RLS do atleta, que é o único lugar onde a política é o que
// decide.
describe('A-04: o vínculo por confirmação exige convite pendente daquela equipe', () => {
  let equipeOutroTreinador;

  beforeEach(async () => {
    await habilitarTreinador();
    // Uma equipe da MESMA federação, de outro responsável. É o alvo plausível:
    // mesma organização, então a conferência de federação não salva ninguém.
    equipeOutroTreinador = (await api().post('/api/v1/teams').set(diretorA.auth())
      .send({ organizationId: orgA, name: unico('Equipe Alheia') })).body;
  });

  /** O INSERT cru, no contexto de RLS da conta do atleta. */
  const gravarVinculoDireto = teamId => comoAtor(contaAtleta, tx =>
    tx.athleteTeamMembership.create({
      data: {
        athleteId: atletaComConta.id, teamId,
        createdById: contaAtleta.id, activeAthleteId: atletaComConta.id
      },
      select: { id: true }
    }));

  it('a RLS recusa o INSERT do atleta em equipe que NÃO o convidou', async () => {
    const erro = await gravarVinculoDireto(equipeOutroTreinador.id).catch(e => e);
    expect(erro, 'o INSERT tinha de falhar').toBeInstanceOf(Error);
    // 42501 é a recusa de política do PostgreSQL; o Prisma a traz como P2010 ou
    // como erro de política. O que importa é que NADA foi gravado.
    expect(String(erro.message)).toMatch(/row-level security|42501/i);

    const vinculos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({
      where: { athleteId: atletaComConta.id }
    }));
    expect(vinculos, 'nenhum vínculo nasceu sem convite').toBe(0);
  });

  it('a RLS recusa até na equipe do treinador certo, se não houver convite pendente', async () => {
    // A equipe é a do treinador que existe e está habilitado — só não convidou
    // ninguém. Sem esta medição, a correção poderia estar só comparando
    // organizações.
    const erro = await gravarVinculoDireto(equipeA.id).catch(e => e);
    expect(erro).toBeInstanceOf(Error);

    const vinculos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({
      where: { athleteId: atletaComConta.id }
    }));
    expect(vinculos).toBe(0);
  });

  it('COM convite pendente daquela equipe, o INSERT do atleta é aceito', async () => {
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);

    // O convite é da equipe A; a gravação na equipe ALHEIA continua recusada.
    const naAlheia = await gravarVinculoDireto(equipeOutroTreinador.id).catch(e => e);
    expect(naAlheia, 'convite de uma equipe não abre a porta da outra').toBeInstanceOf(Error);

    const criado = await gravarVinculoDireto(equipeA.id);
    expect(criado.id).toBeTruthy();
  });

  it('o SERVIÇO recusa o vínculo sem convite, com motivo — e não depende da RLS', async () => {
    // Defesa em profundidade, e medida por conta própria: a RLS dá um erro de
    // banco, que não é mensagem para pessoa. O serviço dá 409 com o motivo.
    const memberships = (await import('../src/services/membershipService.js')).default;

    const erro = await comoAtor(contaAtleta, () =>
      memberships.vincularPorConfirmacao(atletaComConta.id, { teamId: equipeA.id }, contaAtleta)
    ).catch(e => e);

    expect(erro.status).toBe(409);
    expect(erro.code).toBe('MEMBERSHIP_REQUEST_REQUIRED');

    const vinculos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({
      where: { athleteId: atletaComConta.id }
    }));
    expect(vinculos).toBe(0);
  });

  it('o caminho legítimo continua inteiro: convite, confirmação, vínculo', async () => {
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });
    expect(pedido.status).toBe(201);

    const confirmacao = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/confirm`)
      .set(contaAtleta.auth()).send({});
    expect(confirmacao.status, JSON.stringify(confirmacao.body)).toBe(200);
    expect(confirmacao.body.membership.teamId).toBe(equipeA.id);
    expect(confirmacao.body.request.status).toBe('CONFIRMED');
  });

  it('o operador da federação continua gravando vínculo sem convite — a cláusula dele não mudou', async () => {
    const vinculo = await api().post(`/api/v1/athletes/${atletaComConta.id}/team`).set(diretorA.auth())
      .send({ teamId: equipeOutroTreinador.id });
    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(201);
    expect(vinculo.body.teamId).toBe(equipeOutroTreinador.id);
  });
});

// ---------------------------------------------------------------------- A-03
//
// A LEITURA DE ATLETA PELO TREINADOR, MEDIDA NO QUE ELA É E NO QUE NÃO É.
//
// A correção estreitou a cláusula: além de cadastro aprovado e autorização viva
// na federação, o treinador precisa ser RESPONSÁVEL POR ALGUMA EQUIPE dela. Os
// testes abaixo medem os dois lados — o que passou a ser recusado, e o que
// continua funcionando — e, além deles, medem o LIMITE REAL da política, que é o
// que a auditoria pediu para ficar explícito: o conjunto que o treinador lê é
// subconjunto do que uma requisição SEM SESSÃO já lê, e o que R-05 protege
// (CPF, documento) está em outra tabela, fora do alcance dele.
describe('A-03: a leitura de atleta pelo treinador é estreitada e o limite fica medido', () => {
  /** Ids de `Athlete` visíveis dentro do contexto de RLS de quem se pedir. */
  const atletasVisiveis = ator => comoAtor(ator, tx =>
    tx.athlete.findMany({ select: { id: true, organizationId: true } }));

  it('treinador aprovado e autorizado mas SEM EQUIPE na federação não lê atleta nenhum dela', async () => {
    // Aprovado (R-03) e autorizado na federação A (R-04) — e nada mais. A equipe
    // NÃO é atribuída de propósito: é o estado do treinador recém-autorizado.
    expect((await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Atuação autorizada.' })).status).toBe(200);

    const visiveis = await atletasVisiveis(contaTreinador);
    expect(visiveis.filter(a => a.organizationId === orgA),
      'sem equipe na federação não há a quem listar nem para onde convidar').toHaveLength(0);

    // E a busca por matrícula, que é o caminho real, não encontra.
    const busca = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '7001' });
    expect(busca.status, JSON.stringify(busca.body)).toBe(200);
    expect(busca.body.found).toBe(false);
  });

  it('com equipe na federação, a leitura e a busca voltam — a correção não quebrou o convite', async () => {
    await habilitarTreinador();

    const visiveis = await atletasVisiveis(contaTreinador);
    expect(visiveis.map(a => a.id)).toContain(atletaComConta.id);

    const busca = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '7001' });
    expect(busca.status, JSON.stringify(busca.body)).toBe(200);
    expect(busca.body.found, 'sem esta leitura não há como convidar ninguém').toBe(true);
    expect(busca.body.athlete.id).toBe(atletaComConta.id);
  });

  it('treinador da federação A não lê atleta da federação B', async () => {
    await habilitarTreinador();
    const atletaDeB = await criarAtleta(diretorB, orgB, { fullName: 'Atleta De B', cpf: cpfSeq() });

    const visiveis = await atletasVisiveis(contaTreinador);
    expect(visiveis.map(a => a.id)).not.toContain(atletaDeB.id);
    expect(visiveis.filter(a => a.organizationId === orgB)).toHaveLength(0);

    // Nem com o id na mão, e nem pela rota.
    const direto = await comoAtor(contaTreinador, tx => tx.athlete.findUnique({ where: { id: atletaDeB.id } }));
    expect(direto, 'o id conhecido não abre a linha de outra federação').toBeNull();
  });

  it('REVOGAR a autorização da federação apaga a leitura na requisição seguinte', async () => {
    await habilitarTreinador();
    expect((await atletasVisiveis(contaTreinador)).map(a => a.id)).toContain(atletaComConta.id);

    const revogacao = await api().post(`/api/v1/coaches/${coachId}/organizations/revoke`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Atuação encerrada.' });
    expect(revogacao.status, JSON.stringify(revogacao.body)).toBe(200);

    expect(await atletasVisiveis(contaTreinador),
      'a revogação vale já, sem job e sem cache').toHaveLength(0);
  });

  it('SUSPENDER o cadastro apaga a leitura, mesmo com autorização e equipe intactas', async () => {
    await habilitarTreinador();
    const suspensao = await api().post(`/api/v1/coaches/${coachId}/suspend`).set(admin.auth())
      .send({ reason: 'Suspensão cautelar na análise.' });
    expect(suspensao.status, JSON.stringify(suspensao.body)).toBe(200);

    expect(await atletasVisiveis(contaTreinador)).toHaveLength(0);
  });

  it('perder a equipe para outro responsável apaga a leitura', async () => {
    await habilitarTreinador();
    const outroCadastro = await criarUsuario({ role: 'COACH', name: 'Outro Treinador' });
    const outro = await api().post('/api/v1/coaches/self-register').set(outroCadastro.auth())
      .send({ name: 'Outro Treinador', registration: 'CREF-11111' });
    expect(outro.status).toBe(201);
    // Responder por equipe exige cadastro aprovado (R-03) — o substituto passa
    // pela mesa central como qualquer outro.
    expect((await api().post(`/api/v1/coaches/${outro.body.id}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Atuação autorizada.' })).status).toBe(200);

    const troca = await api().post(`/api/v1/teams/${equipeA.id}/coach`).set(diretorA.auth())
      .send({ coachId: outro.body.id });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);

    expect(await atletasVisiveis(contaTreinador),
      'sem equipe na federação, a leitura larga não sobrevive').toHaveLength(0);
  });

  it('o que o treinador lê é SUBCONJUNTO do que uma requisição sem sessão já lê', async () => {
    // Esta é a medição que dimensiona o achado. `atleta_leitura` libera
    // `mci_current_user_id() IS NULL`, e é disso que vivem a vitrine pública e o
    // ranking. Se algum dia o treinador passar a ler algo que o anônimo não lê,
    // este teste reprova — e aí a conversa é outra.
    await habilitarTreinador();
    await criarAtleta(diretorB, orgB, { fullName: 'Atleta De B', cpf: cpfSeq() });

    const doTreinador = (await atletasVisiveis(contaTreinador)).map(a => a.id).sort();
    const doAnonimo = (await atletasVisiveis(null)).map(a => a.id).sort();

    expect(doAnonimo.length, 'o anônimo lê a superfície pública inteira').toBeGreaterThan(0);
    for (const id of doTreinador) expect(doAnonimo).toContain(id);
    expect(doTreinador.length).toBeLessThan(doAnonimo.length);
  });

  it('o que R-05 protege está FORA do alcance do treinador: CPF e documento', async () => {
    await habilitarTreinador();

    // CPF vive em `AthleteIdentity`, tabela própria com RLS própria.
    const identidades = await comoAtor(contaTreinador, tx => tx.athleteIdentity.findMany());
    expect(identidades, 'o CPF não é alcançável pelo treinador').toHaveLength(0);

    // E a projeção do painel não tem por onde vazar: a lista é explícita.
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });
    expect(pedido.status).toBe(201);
    const confirmacao = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/confirm`)
      .set(contaAtleta.auth()).send({});
    expect(confirmacao.status, JSON.stringify(confirmacao.body)).toBe(200);

    const painel = await api().get('/api/v1/coaches/me/athletes').set(contaTreinador.auth());
    expect(painel.status, JSON.stringify(painel.body)).toBe(200);
    expect(painel.body.items).toHaveLength(1);

    const texto = JSON.stringify(painel.body);
    for (const proibido of ['cpf', 'Cpf', 'CPF', 'documents', 'storageKey', 'birthDate', 'phone', 'email', 'passwordHash']) {
      expect(texto, `a projeção do painel não carrega ${proibido}`).not.toContain(proibido);
    }
  });

  it('o treinador não lê o vínculo de atleta de OUTRA equipe', async () => {
    // `vinculo_leitura` continua sendo por EQUIPE, e não por federação: o
    // histórico de vínculo de quem está em outra equipe segue invisível.
    await habilitarTreinador();
    const equipeAlheia = (await api().post('/api/v1/teams').set(diretorA.auth())
      .send({ organizationId: orgA, name: unico('Equipe Alheia') })).body;
    const atletaAlheio = await criarAtleta(diretorA, orgA, { fullName: 'Atleta Alheio', cpf: cpfSeq() });
    expect((await api().post(`/api/v1/athletes/${atletaAlheio.id}/team`).set(diretorA.auth())
      .send({ teamId: equipeAlheia.id })).status).toBe(201);

    const vinculos = await comoAtor(contaTreinador, tx => tx.athleteTeamMembership.findMany({
      select: { id: true, teamId: true }
    }));
    expect(vinculos.filter(v => v.teamId === equipeAlheia.id),
      'vínculo de equipe alheia não é do treinador').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- A-05
//
// A MIGRATION 20260926020000 EXECUTA `UPDATE "Coach" SET status='APPROVED'` SEM
// `WHERE`, e R-03 diz que quem aprova cadastro de treinador é a administração
// central. A correção (migration 20260927030000) devolve a `PENDING` só as linhas
// aprovadas SEM revisor e SEM data de revisão.
//
// O teste do predicado roda o SQL DO ARQUIVO, e não uma cópia dele: um predicado
// que divergisse do que vai subir não estaria sendo medido.
describe('A-05: o cadastro legado de treinador não fica aprovado por migration', () => {
  const SQL_DA_CORRECAO = readFileSync(
    new URL('../prisma/migrations/20260927030000_status_legado_de_treinador/migration.sql', import.meta.url),
    'utf8'
  );

  it('aprovar pela rota grava REVISOR e DATA — é o que protege o cadastro real', async () => {
    // A rota de aprovação só alcança cadastro em análise, que hoje é estado
    // legado — daí o cadastro voltar para lá antes.
    await aprovarPorPessoa();

    const cadastro = await comoAtor(admin, tx => tx.coach.findUnique({
      where: { id: coachId }, select: { status: true, reviewedById: true, reviewedAt: true }
    }));
    expect(cadastro.status).toBe('APPROVED');
    expect(cadastro.reviewedById, 'sem revisor o predicado da migration não distinguiria nada').toBe(admin.id);
    expect(cadastro.reviewedAt).toBeTruthy();
  });

  // ESTE TESTE MUDOU DE LADO quando a aprovação automática entrou, e é o encontro
  // das duas decisões: o autocadastro nasce APPROVED e SEM revisor — ninguém
  // julgou —, que é exatamente a forma do cadastro que a correção de A-05
  // devolve para análise. O que os separa é `reviewedAt`: o predicado exige
  // `reviewedById IS NULL AND reviewedAt IS NULL`, e a aprovação automática grava
  // a data. Se um dia ela parar de gravá-la, a correção passa a devolver para
  // análise todo treinador que se cadastrou depois da mudança — e este teste cai.
  it('o autocadastro nasce APPROVED sem revisor, e a correção de A-05 não o alcança', async () => {
    const cadastro = await comoAtor(admin, tx => tx.coach.findUnique({
      where: { id: coachId },
      select: { status: true, reviewedById: true, reviewedAt: true, autoApprovedAt: true }
    }));
    expect(cadastro.status).toBe('APPROVED');
    expect(cadastro.reviewedById, 'aprovação automática não tem revisor: ninguém julgou').toBeNull();
    expect(cadastro.autoApprovedAt, 'e ela se identifica como automática').toBeTruthy();
    expect(cadastro.reviewedAt, 'a data existe, e é ela que o predicado da correção enxerga').toBeTruthy();

    await comoAtor(admin, tx => tx.$executeRawUnsafe(SQL_DA_CORRECAO));

    const depois = await comoAtor(admin, tx => tx.coach.findUnique({
      where: { id: coachId }, select: { status: true }
    }));
    expect(depois.status, 'o cadastro aprovado automaticamente NÃO volta para análise').toBe('APPROVED');
  });

  it('o SQL da correção atinge o aprovado SEM revisor e NÃO toca o aprovado por pessoa', async () => {
    // Um cadastro aprovado por pessoa, pela rota real.
    await aprovarPorPessoa();

    // E um cadastro no estado que a migration anterior produz: aprovado, sem
    // revisor, sem data — exatamente o `UPDATE` sem `WHERE`.
    const legado = await comoAtor(admin, tx => tx.coach.create({
      data: { name: 'Treinador Legado', status: 'APPROVED' },
      select: { id: true }
    }));

    await comoAtor(admin, tx => tx.$executeRawUnsafe(SQL_DA_CORRECAO));

    const depois = await comoAtor(admin, tx => tx.coach.findMany({
      where: { id: { in: [coachId, legado.id] } },
      select: { id: true, status: true, reviewedById: true }
    }));
    const porId = new Map(depois.map(c => [c.id, c]));

    expect(porId.get(legado.id).status, 'o legado volta ao estado que R-03 manda').toBe('PENDING');
    expect(porId.get(coachId).status, 'o aprovado por pessoa não é tocado').toBe('APPROVED');
    expect(porId.get(coachId).reviewedById).toBe(admin.id);
  });

  it('o SQL da correção é idempotente: a segunda execução não muda nada', async () => {
    await comoAtor(admin, tx => tx.coach.create({
      data: { name: 'Treinador Legado', status: 'APPROVED' }, select: { id: true }
    }));

    await comoAtor(admin, tx => tx.$executeRawUnsafe(SQL_DA_CORRECAO));
    const primeira = await comoAtor(admin, tx => tx.coach.findMany({ select: { id: true, status: true } }));

    await comoAtor(admin, tx => tx.$executeRawUnsafe(SQL_DA_CORRECAO));
    const segunda = await comoAtor(admin, tx => tx.coach.findMany({ select: { id: true, status: true } }));

    expect(segunda).toEqual(primeira);
  });

  it('e o efeito é o que importa: cadastro pendente não é ator, nem para a RLS', async () => {
    // Autorizado na federação e responsável pela equipe, mas com o cadastro
    // devolvido a PENDING pela correção — não lê atleta nenhum.
    await habilitarTreinador();
    await comoAtor(admin, tx => tx.coach.update({
      where: { id: coachId }, data: { status: 'APPROVED', reviewedById: null, reviewedAt: null }
    }));
    await comoAtor(admin, tx => tx.$executeRawUnsafe(SQL_DA_CORRECAO));

    const visiveis = await comoAtor(contaTreinador, tx => tx.athlete.findMany({ select: { id: true } }));
    expect(visiveis, 'pendente não é ator reconhecido pelo banco').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------- A-13
//
// ACHADO NOVO, ENCONTRADO NESTA ETAPA — e a razão de ele existir é instrutiva.
//
// `GET /coaches` é o catálogo de técnicos, criado antes deste módulo, e a consulta
// não tinha `select`: devolvia a linha INTEIRA de `Coach`. Quando a migration do
// módulo acrescentou colunas à tabela, elas entraram na resposta por acidente —
// `findMany` sem projeção carrega tudo o que a tabela ganhar depois.
//
// O que passou a sair para QUALQUER conta autenticada: o `status` da análise
// cadastral, o MOTIVO de uma rejeição, o MOTIVO de uma suspensão, quem julgou e
// quando, telefone, e-mail, e o `userId` que liga o cadastro a uma conta.
//
// Motivo de recusa é informação sobre uma pessoa, e a análise cadastral é de R-03.
// A correção é a projeção explícita — que também impede a repetição: a próxima
// coluna de `Coach` não entra sozinha.
describe('A-13: o catálogo de técnicos não publica a análise cadastral', () => {
  it('a listagem não traz status, motivo de recusa, contato nem o elo com a conta', async () => {
    // Um cadastro REJEITADO, com motivo — é o pior caso, e é o que a listagem
    // entregava por extenso. Recusar exige cadastro em análise: APPROVED →
    // REJECTED não é transição permitida (devolve 422 `COACH_INVALID_TRANSITION`).
    await voltarParaAnalise();
    expect((await api().post(`/api/v1/coaches/${coachId}/reject`).set(admin.auth())
      .send({ reason: 'Documentação profissional não confere com o registro informado.' })).status).toBe(200);

    // A conta mais barata de produzir: autocadastro aberto, papel comum.
    const intruso = await criarUsuario({ name: 'Conta Qualquer' });
    const lista = await api().get('/api/v1/coaches').set(intruso.auth());
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);

    const texto = JSON.stringify(lista.body);
    for (const proibido of ['status', 'rejectionReason', 'suspendedReason', 'reviewedById',
      'reviewedAt', 'registration', 'phone', 'email', 'userId', 'bio']) {
      expect(texto, `o catálogo não publica ${proibido}`).not.toContain(proibido);
    }
    // E o motivo, que é o texto sobre a pessoa, não aparece de jeito nenhum.
    expect(texto).not.toContain('Documentação profissional');
  });

  it('o catálogo continua servindo para o que existe: escolher um técnico', async () => {
    const operador = await criarUsuario({ name: 'Operadora' });
    await vincular(orgA, operador, 'EVENT_DIRECTOR');

    const lista = await api().get('/api/v1/coaches').set(operador.auth());
    expect(lista.status).toBe(200);

    const linha = lista.body.items.find(item => item.id === coachId);
    expect(linha, 'o técnico cadastrado aparece no catálogo').toBeTruthy();
    expect(linha.name).toBe('Marta Treinadora');
    expect(Object.keys(linha).sort(), 'a projeção é exatamente esta')
      .toEqual(['_count', 'city', 'id', 'name', 'state']);
    expect(linha._count.athletes, 'a contagem de atletas é o que a escolha usa').toBe(0);
  });
});

// ---------------------------------------------------------------------- F-04
//
// A FEDERAÇÃO PRECISA DE UMA LISTA PARA EXERCER R-04.
//
// Achado da homologação manual, passo F4: o servidor já aceitava a autorização
// do diretor de federação — `POST /coaches/:id/organizations` respondia 200 —
// mas o único botão de autorizar da interface vivia dentro da fila de análise
// central, que exige `coaches.approve`. Quem tem `coaches.authorize_org` e não
// tem `coaches.approve` ficava sem lista, e sem lista não havia como chamar a
// rota. A correção é `GET /coaches/authorizable`, e este bloco é a prova de que
// ela abriu exatamente o que faltava, e nada além.
//
// O risco de uma lista nova é sempre o mesmo: virar porta larga. Por isso os
// testes abaixo insistem em três limites — cadastro APROVADO, escopo da PRÓPRIA
// federação e conjunto EXATO de campos.
describe('F-04: a federação lista treinadores aprovados e autoriza a atuação', () => {
  const listar = (ator, organizationId) =>
    api().get(`/api/v1/coaches/authorizable?organizationId=${organizationId}`).set(ator.auth());

  it('o diretor lista o treinador APROVADO e autoriza a atuação na própria federação', async () => {

    const lista = await listar(diretorA, orgA);
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);

    const linha = lista.body.items.find(item => item.id === coachId);
    expect(linha, 'o treinador aprovado aparece para a federação').toBeTruthy();
    expect(linha.authorization, 'ainda não autorizado nesta federação').toBeNull();

    const autorizacao = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Atuação autorizada na homologação.' });
    expect(autorizacao.status, JSON.stringify(autorizacao.body)).toBe(200);

    const depois = await listar(diretorA, orgA);
    const atualizada = depois.body.items.find(item => item.id === coachId);
    expect(atualizada.authorization.status, 'a lista reflete a autorização na requisição seguinte').toBe('APPROVED');
  });

  it('a projeção é exatamente a necessária para decidir — e nada da análise cadastral', async () => {

    const lista = await listar(diretorA, orgA);
    const linha = lista.body.items.find(item => item.id === coachId);

    expect(Object.keys(linha).sort(), 'o conjunto de campos é este, e mudá-lo é decisão')
      .toEqual(['authorization', 'city', 'id', 'name', 'registration', 'state']);

    // O motivo escrito pela mesa central é texto SOBRE a pessoa: ele não
    // atravessa para a federação de jeito nenhum.
    const texto = JSON.stringify(lista.body);
    for (const proibido of ['rejectionReason', 'suspendedReason', 'reviewedById', 'reviewedAt',
      'bio', 'phone', 'email', 'userId', 'passwordHash', 'cpf']) {
      expect(texto, `a lista da federação não publica ${proibido}`).not.toContain(proibido);
    }
    expect(texto).not.toContain('Documentação profissional');
  });

  it('o treinador PENDENTE não aparece na lista nem pode ser autorizado', async () => {
    await voltarParaAnalise();
    const semAprovacao = await listar(diretorA, orgA);
    expect(semAprovacao.status).toBe(200);
    expect(semAprovacao.body.items.some(item => item.id === coachId),
      'cadastro em análise é assunto da mesa central, não da federação').toBe(false);

    const tentativa = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Tentativa antes da aprovação.' });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(422);
    expect(tentativa.body.error.code).toBe('COACH_NOT_APPROVED');
  });

  it('a lista NÃO dá à federação o poder de aprovar cadastro nacional (R-03)', async () => {
    expect((await api().get('/api/v1/coaches/review?status=PENDING').set(diretorA.auth())).status).toBe(403);
    expect((await api().get(`/api/v1/coaches/${coachId}/review`).set(diretorA.auth())).status).toBe(403);
    expect((await api().post(`/api/v1/coaches/${coachId}/approve`).set(diretorA.auth())
      .send({ reason: 'Tentando aprovar pela federação.' })).status).toBe(403);
    expect((await api().post(`/api/v1/coaches/${coachId}/reject`).set(diretorA.auth())
      .send({ reason: 'Tentando recusar pela federação.' })).status).toBe(403);
  });

  it('o diretor da federação A não lista nem autoriza na federação B (R-04)', async () => {

    expect((await listar(diretorA, orgB)).status, 'a lista de outra federação é recusada').toBe(403);

    const alheia = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgB, reason: 'Autorizando na federação alheia.' });
    expect(alheia.status, JSON.stringify(alheia.body)).toBe(403);

    // E o diretor de B continua com o poder dele, intacto — a correção não
    // trocou uma federação pela outra.
    expect((await listar(diretorB, orgB)).status).toBe(200);
  });

  it('sem escopo a rota nem chega ao serviço — o escopo é obrigatório no schema', async () => {
    const semEscopo = await api().get('/api/v1/coaches/authorizable').set(diretorA.auth());
    expect([400, 403, 422], JSON.stringify(semEscopo.body)).toContain(semEscopo.status);
    expect(semEscopo.status, 'e nunca 200: escopo nulo somaria permissões de todas as federações')
      .not.toBe(200);
  });

  it('quem não tem a permissão não lê a lista, nem treinador, nem atleta, nem conta comum', async () => {
    const comum = await criarUsuario({ name: 'Conta Qualquer' });
    for (const ator of [comum, contaTreinador, contaAtleta]) {
      const r = await listar(ator, orgA);
      expect([403, 404], `${JSON.stringify(r.body)}`).toContain(r.status);
    }
    expect((await api().get(`/api/v1/coaches/authorizable?organizationId=${orgA}`)).status,
      'sem sessão é 401, e não 403').toBe(401);
  });

  it('o SERVIÇO recusa a lista sem a permissão, mesmo chamado por dentro', async () => {
    // A recusa da ROTA já está medida acima, e foi ela que matou a tentativa por
    // HTTP. Esta mede a do SERVIÇO — a que resta quando a chamada não vem de uma
    // requisição. A distinção não é teórica: a mutação apontou que, sem este
    // teste, apagar `assertCan` de `listarParaAutorizacao` não quebrava nada, e
    // barreira sem teste é barreira que alguém remove sem ver vermelho.
    const coaches = await import('../src/services/coachService.js');
    const semPermissao = { id: contaAtleta.id, role: 'ATHLETE', memberships: [], centralGrantsReceived: [] };

    const recusa = await comoAtor(contaAtleta, () => coaches.default.listarParaAutorizacao(
      { organizationId: orgA, limit: 50 }, semPermissao
    )).catch(erro => erro);
    expect(recusa, 'chamar o serviço direto não é atalho').toBeInstanceOf(Error);
    expect(recusa.status).toBe(403);

    // E o diretor de OUTRA federação também não passa por dentro.
    const atorDeB = { id: diretorB.id, role: 'ATHLETE', memberships: [{ organizationId: orgB, role: 'EVENT_DIRECTOR' }], centralGrantsReceived: [] };
    const alheia = await comoAtor(diretorB, () => coaches.default.listarParaAutorizacao(
      { organizationId: orgA, limit: 50 }, atorDeB
    )).catch(erro => erro);
    expect(alheia, 'o escopo vale também para a chamada interna').toBeInstanceOf(Error);
    expect(alheia.status).toBe(403);
  });

  it('a mesa central mantém todos os poderes — a correção não tirou nada dela', async () => {
    expect((await api().get('/api/v1/coaches/review?status=PENDING').set(admin.auth())).status).toBe(200);
    expect((await listar(admin, orgA)).status, 'a central também lê a lista da federação').toBe(200);
    expect((await api().post(`/api/v1/coaches/${coachId}/organizations`).set(admin.auth())
      .send({ organizationId: orgA, reason: 'Autorização pela central.' })).status).toBe(200);
    expect((await api().get('/api/v1/central-authorizations').set(admin.auth())).status).toBe(200);
  });

  it('revogar pela federação exige motivo, tem efeito imediato e deixa trilha', async () => {
    await habilitarTreinador();

    const semMotivo = await api().post(`/api/v1/coaches/${coachId}/organizations/revoke`).set(diretorA.auth())
      .send({ organizationId: orgA });
    expect([400, 422], JSON.stringify(semMotivo.body)).toContain(semMotivo.status);

    const revogada = await api().post(`/api/v1/coaches/${coachId}/organizations/revoke`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Revogação da homologação manual.' });
    expect(revogada.status, JSON.stringify(revogada.body)).toBe(200);

    const depois = await listar(diretorA, orgA);
    const linha = depois.body.items.find(item => item.id === coachId);
    expect(linha.authorization.status, 'a lista mostra a revogação na requisição seguinte').toBe('REVOKED');

    const trilha = await api().get('/api/v1/audit?action=COACH_ORG_REVOKE').set(admin.auth());
    expect(trilha.status, JSON.stringify(trilha.body)).toBe(200);
    expect(JSON.stringify(trilha.body), 'a revogação fica na trilha com o motivo')
      .toContain('Revogação da homologação manual.');
  });
});
