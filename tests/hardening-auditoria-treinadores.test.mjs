import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

async function habilitarTreinador() {
  expect((await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth())
    .send({ reason: 'Documentação conferida.' })).status).toBe(200);
  expect((await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
    .send({ organizationId: orgA, reason: 'Atuação autorizada.' })).status).toBe(200);
  expect((await api().post(`/api/v1/teams/${equipeA.id}/coach`).set(diretorA.auth())
    .send({ coachId })).status).toBe(200);
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

  it('sem sessão as duas rotas recusam com 401, e não com 404', async () => {
    const seasonId = await criarTemporada();
    for (const rota of ['eligibility', 'projection']) {
      const anonimo = await api().get(`/api/v1/coaches/${coachId}/ranking/${rota}`).query({ seasonId });
      expect(anonimo.status, rota).toBe(401);
    }
  });

  it('a guarda vem ANTES da leitura do cadastro: nem o `status` de um treinador PENDING escapa', async () => {
    // O cadastro é PENDING aqui de propósito — `habilitarTreinador` não roda.
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
