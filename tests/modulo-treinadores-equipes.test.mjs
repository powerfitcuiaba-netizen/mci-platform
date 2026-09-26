import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// MÓDULO TREINADORES & EQUIPES — as cinco decisões aprovadas, medidas.
//
// R-01  O ponto pertence ao vínculo que existia NA DATA OFICIAL do evento. Sem
//       retroatividade automática.
// R-02  Transferência, desvínculo e correção que afetem atribuição de pontos só
//       por SUPER_ADMIN ou administrador central FORMALMENTE autorizado.
// R-03  Quem aprova ou rejeita treinador é a administração CENTRAL.
// R-04  O cadastro do treinador é GLOBAL e não se duplica por federação;
//       cadastro global NÃO concede atuação.
// R-05  O treinador vê dado esportivo, de filiação e de resultado dos atletas
//       vinculados a ele. Nunca documento, CPF, financeiro, credencial ou médico.
//
// §8.3 A FÓRMULA DO RANKING DE TREINADORES NÃO ESTÁ HOMOLOGADA. Há teste para a
//       ausência dela: a rota de classificação RECUSA, e a recusa diz que o
//       bloqueio é de homologação, não de implementação.
// ============================================================================

let admin;
let orgA;
let orgB;
let diretorA;      // opera a federação A
let diretorB;      // opera a federação B
let contaTreinador; // a conta que vai se cadastrar como treinadora
let coachId;
let equipeA;
let contaAtleta;   // a conta DONA de um atleta — quem confirma o vínculo
let atletaComConta;
let atletaSemConta;

const cpfSeq = (() => { let n = 880000000; return () => gerarCpf(n += 3331); })();

const semCpf = corpo => {
  const texto = JSON.stringify(corpo);
  return /"cpf"|"cpfMasked"|"documents"|"storageKey"/.test(texto) === false;
};

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
    fullName: 'Joana Ferreira', cpf: cpfSeq(), affiliationNumber: '5001'
  });
  atletaSemConta = await criarAtleta(diretorA, orgA, {
    fullName: 'Carla Souza', cpf: cpfSeq(), affiliationNumber: '5002'
  });
  await api().patch(`/api/v1/athletes/${atletaComConta.id}`).set(diretorA.auth())
    .send({ userId: contaAtleta.id });

  // O autocadastro do treinador, pela rota real.
  const cadastro = await api().post('/api/v1/coaches/self-register').set(contaTreinador.auth())
    .send({ name: 'Marta Treinadora', registration: 'CREF-99999', phone: '65999887766' });
  expect(cadastro.status, JSON.stringify(cadastro.body)).toBe(201);
  coachId = cadastro.body.id;

  equipeA = (await api().post('/api/v1/teams').set(diretorA.auth())
    .send({ organizationId: orgA, name: unico('Equipe Marta') })).body;
});

/** Aprova o cadastro e autoriza a atuação na federação A. É o caminho feliz. */
async function habilitarTreinador() {
  const aprovacao = await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth())
    .send({ reason: 'Documentação conferida.' });
  expect(aprovacao.status, JSON.stringify(aprovacao.body)).toBe(200);

  const autorizacao = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
    .send({ organizationId: orgA, reason: 'Atuação autorizada na federação A.' });
  expect(autorizacao.status, JSON.stringify(autorizacao.body)).toBe(200);

  const responsavel = await api().post(`/api/v1/teams/${equipeA.id}/coach`).set(diretorA.auth())
    .send({ coachId });
  expect(responsavel.status, JSON.stringify(responsavel.body)).toBe(200);
}

// ---------------------------------------------------------------------- R-03
describe('R-03: quem aprova treinador é a administração central', () => {
  it('o cadastro nasce PENDING, e o treinador não muda o próprio estado', async () => {
    const meu = await api().get('/api/v1/coaches/me').set(contaTreinador.auth());
    expect(meu.status).toBe(200);
    expect(meu.body.status).toBe('PENDING');

    // O corpo tenta levar `status`; o schema não o aceita e o serviço nunca o lê.
    const tentativa = await api().patch('/api/v1/coaches/me').set(contaTreinador.auth())
      .send({ bio: 'Atualizando a apresentação', status: 'APPROVED' });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(200);
    expect(tentativa.body.status, 'o estado não mudou pela mão do interessado').toBe('PENDING');
    expect(tentativa.body.bio).toBe('Atualizando a apresentação');
  });

  it('o DIRETOR da federação não aprova treinador, ainda que opere tudo o mais', async () => {
    const tentativa = await api().post(`/api/v1/coaches/${coachId}/approve`).set(diretorA.auth())
      .send({ reason: 'Tentativa da federação.' });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(403);

    const depois = await comoAtor(admin, tx => tx.coach.findUnique({ where: { id: coachId }, select: { status: true } }));
    expect(depois.status, 'o cadastro continua pendente').toBe('PENDING');
  });

  it('a administração central aprova, rejeita com motivo e suspende com motivo', async () => {
    const semMotivo = await api().post(`/api/v1/coaches/${coachId}/reject`).set(admin.auth()).send({});
    expect(semMotivo.status, 'rejeitar sem motivo não entra na trilha').toBe(400);

    const rejeicao = await api().post(`/api/v1/coaches/${coachId}/reject`).set(admin.auth())
      .send({ reason: 'Falta comprovante de registro profissional.' });
    expect(rejeicao.status, JSON.stringify(rejeicao.body)).toBe(200);
    expect(rejeicao.body.status).toBe('REJECTED');
    expect(rejeicao.body.rejectionReason).toContain('comprovante');

    // REJEITADO volta para análise: o treinador corrige e pede de novo.
    const reanalise = await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth()).send({});
    expect(reanalise.status, 'de REJECTED não se vai direto a APPROVED').toBe(422);
    expect(reanalise.body.error.code).toBe('COACH_INVALID_TRANSITION');
  });

  it('a máquina de estados recusa transição não prevista, e CANCELLED é terminal', async () => {
    await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth()).send({});
    const encerramento = await api().post(`/api/v1/coaches/${coachId}/cancel`).set(admin.auth())
      .send({ reason: 'Encerrado a pedido do treinador.' });
    expect(encerramento.status).toBe(200);

    const ressurreicao = await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth()).send({});
    expect(ressurreicao.status, 'cadastro encerrado não ressuscita').toBe(422);
    expect(ressurreicao.body.error.code).toBe('COACH_INVALID_TRANSITION');
  });

  it('a decisão central fica na auditoria e chega ao treinador como notificação', async () => {
    await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth())
      .send({ reason: 'Documentação conferida.' });

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({ where: { action: 'COACH_APPROVE' } }));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].metadata.de).toBe('PENDING');
    expect(trilha[0].metadata.para).toBe('APPROVED');

    const avisos = await api().get('/api/v1/notifications').set(contaTreinador.auth());
    expect(avisos.body.items.some(item => item.type === 'COACH_APPROVED')).toBe(true);
  });
});

// ---------------------------------------------------------------------- R-04
describe('R-04: identidade global, atuação por federação', () => {
  it('o cadastro aprovado NÃO basta: sem autorização da federação não há atuação', async () => {
    await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth()).send({});

    const tentativa = await api().post(`/api/v1/teams/${equipeA.id}/coach`).set(diretorA.auth())
      .send({ coachId });
    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(422);
    expect(tentativa.body.error.code).toBe('COACH_ORG_NOT_AUTHORIZED');
  });

  it('a federação B não autoriza atuação na federação A', async () => {
    await api().post(`/api/v1/coaches/${coachId}/approve`).set(admin.auth()).send({});

    const tentativa = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorB.auth())
      .send({ organizationId: orgA, reason: 'Autorização de fora.' });
    expect([403, 404]).toContain(tentativa.status);
  });

  it('a autorização é uma linha por par treinador/federação — reautorizar atualiza, não empilha', async () => {
    await habilitarTreinador();

    const revogacao = await api().post(`/api/v1/coaches/${coachId}/organizations/revoke`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Revogada para reteste.' });
    expect(revogacao.status).toBe(200);
    expect(revogacao.body.status).toBe('REVOKED');

    const denovo = await api().post(`/api/v1/coaches/${coachId}/organizations`).set(diretorA.auth())
      .send({ organizationId: orgA, reason: 'Reautorizada.' });
    expect(denovo.status).toBe(200);

    const linhas = await comoAtor(admin, tx => tx.coachOrganization.findMany({ where: { coachId } }));
    expect(linhas, 'uma linha por par, não uma pilha').toHaveLength(1);
    expect(linhas[0].status).toBe('APPROVED');
    expect(linhas[0].revokedAt, 'a revogação anterior foi limpa ao reautorizar').toBeNull();
  });

  it('não existe cadastro duplicado por federação: a mesma conta não se cadastra duas vezes', async () => {
    const segundo = await api().post('/api/v1/coaches/self-register').set(contaTreinador.auth())
      .send({ name: 'Marta Treinadora (outra federação)' });
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(409);
    expect(segundo.body.error.code).toBe('COACH_ALREADY_EXISTS');
  });
});

// ---------------------------------------------------------------------- R-05
describe('R-05: o treinador vê esporte, nunca documento nem CPF', () => {
  it('a lista de atletas da equipe não traz CPF, documento nem chave de arquivo', async () => {
    await habilitarTreinador();
    await api().post(`/api/v1/athletes/${atletaComConta.id}/team`).set(diretorA.auth())
      .send({ teamId: equipeA.id });

    const meus = await api().get('/api/v1/coaches/me/athletes').set(contaTreinador.auth());
    expect(meus.status, JSON.stringify(meus.body)).toBe(200);
    expect(meus.body.items).toHaveLength(1);
    expect(meus.body.items[0].athlete.fullName).toBe('Joana Ferreira');
    expect(meus.body.items[0].athlete.affiliationNumber).toBe('5001');
    expect(semCpf(meus.body), 'nenhum campo de documento na resposta').toBe(true);

    // ------------------------------------------------------------------
    // A PROVA É A FORMA EXATA DA PROJEÇÃO, e não a ausência de `cpf`.
    //
    // MEDIDO por mutação (TE-M4): trocar `select: SELECT_ATLETA_ESPORTIVO` por
    // `athlete: true` SOBREVIVIA à asserção anterior — porque o CPF não mora em
    // `Athlete`, mora em `AthleteIdentity`. O include genérico não traria CPF,
    // mas traria `birthDate`, `phone`, `email`, `photoKey`, `statusReason` e
    // todo campo que a tabela ganhasse depois. É exatamente assim que um dado
    // pessoal aparece num painel meses depois de ter sido proibido.
    //
    // Por isso o conjunto de chaves é FIXADO. Acrescentar campo à projeção
    // passa a exigir mexer aqui, e mexer aqui é a conversa sobre R-05.
    // ------------------------------------------------------------------
    expect(Object.keys(meus.body.items[0].athlete).sort()).toEqual([
      'affiliation', 'affiliationNumber', 'fullName', 'id', 'organization',
      'proStatus', 'sex', 'stageName', 'status', 'team'
    ]);
    expect(Object.keys(meus.body.items[0]).sort()).toEqual(['athlete', 'membershipId', 'since', 'teamId']);
  });

  it('o documento da análise NÃO aparece para o treinador, nem para quem o enviou', async () => {
    const enviado = await api().post(`/api/v1/coaches/${coachId}/documents`).set(contaTreinador.auth())
      .attach('file', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g2pFAAAAAElFTkSuQmCC', 'base64'), 'doc.png');
    expect(enviado.status, JSON.stringify(enviado.body)).toBe(201);
    expect(enviado.body.storageKey, 'a chave de armazenamento não volta ao cliente').toBeUndefined();

    const listagem = await api().get(`/api/v1/coaches/${coachId}/documents`).set(contaTreinador.auth());
    expect(listagem.status, 'o próprio autor do envio não lista de volta — R-05').toBe(403);

    const download = await api().get(`/api/v1/documents/coach/${enviado.body.id}/download`).set(contaTreinador.auth());
    expect(download.status).toBe(403);

    // A mesa central, sim.
    const daMesa = await api().get(`/api/v1/coaches/${coachId}/documents`).set(admin.auth());
    expect(daMesa.status).toBe(200);
    expect(daMesa.body.items).toHaveLength(1);

    const meuCadastro = await api().get('/api/v1/coaches/me').set(contaTreinador.auth());
    expect(Object.keys(meuCadastro.body)).not.toContain('documents');
  });

  it('o treinador não alcança a equipe de outro treinador', async () => {
    await habilitarTreinador();

    const outraConta = await criarUsuario({ role: 'COACH', name: 'Outro Treinador' });
    const outroCadastro = await api().post('/api/v1/coaches/self-register').set(outraConta.auth())
      .send({ name: 'Outro Treinador' });
    expect(outroCadastro.status).toBe(201);

    const minhas = await api().get('/api/v1/coaches/me/teams').set(outraConta.auth());
    expect(minhas.status).toBe(200);
    expect(minhas.body.items, 'quem não responde por equipe nenhuma vê lista vazia').toHaveLength(0);

    const espiando = await api().get('/api/v1/coaches/me/athletes').set(outraConta.auth())
      .query({ teamId: equipeA.id });
    expect(espiando.status, 'pedir a equipe de outro pelo id é recusado').toBe(403);
  });
});

// ------------------------------------------------- solicitação e confirmação
describe('o treinador pede, o ATLETA decide', () => {
  it('o pedido não vincula ninguém: o vínculo só nasce na confirmação', async () => {
    await habilitarTreinador();

    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id, reason: 'Convite para a equipe.' });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body.status).toBe('PENDING');

    const semVinculo = await comoAtor(admin, tx => tx.athleteTeamMembership.count({
      where: { athleteId: atletaComConta.id, endedAt: null }
    }));
    expect(semVinculo, 'enviar pedido NÃO vincula').toBe(0);

    const confirmacao = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/confirm`)
      .set(contaAtleta.auth()).send({});
    expect(confirmacao.status, JSON.stringify(confirmacao.body)).toBe(200);
    expect(confirmacao.body.membership.teamId).toBe(equipeA.id);

    const comVinculo = await comoAtor(admin, tx => tx.athleteTeamMembership.findFirst({
      where: { athleteId: atletaComConta.id, endedAt: null }
    }));
    expect(comVinculo.teamId).toBe(equipeA.id);
    expect(comVinculo.activeAthleteId, 'a trava do banco está armada').toBe(atletaComConta.id);
  });

  it('o TREINADOR não confirma no lugar do atleta, nem com o id do pedido na mão', async () => {
    await habilitarTreinador();
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });

    const tentativa = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/confirm`)
      .set(contaTreinador.auth()).send({});
    expect([403, 404]).toContain(tentativa.status);

    const vinculos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({ where: { athleteId: atletaComConta.id } }));
    expect(vinculos, 'nenhum vínculo criado').toBe(0);
  });

  it('a titularidade é conferida DENTRO da função que grava, e não só na rota', async () => {
    // MEDIDO por mutação (TE-M6): remover a conferência de titularidade de
    // `vincularPorConfirmacao` SOBREVIVIA a toda a suíte, porque
    // `carregarPedidoDoAtleta` já recusa antes, na rota. Defesa em profundidade
    // é boa — mas uma barreira que nenhum teste alcança é uma barreira que a
    // próxima refatoração remove sem reprovar nada.
    //
    // `vincularPorConfirmacao` é EXPORTADA: outro serviço pode chamá-la amanhã
    // sem passar pela rota. É por isso que ela confere por conta própria, e é
    // por isso que este teste a chama direto.
    await habilitarTreinador();

    const memberships = (await import('../src/services/membershipService.js')).default;

    // O ATOR ESCOLHIDO É O DIRETOR DA FEDERAÇÃO, e a escolha importa: ele VÊ o
    // atleta (é operador, a RLS o reconhece), então a função chega até a
    // conferência de titularidade em vez de parar num 404 de visibilidade. Com
    // uma conta sem relação nenhuma o teste mediria a RLS, não a titularidade —
    // e um mutante na titularidade sobreviveria.
    await comoAtor(diretorA, async () => {
      await expect(
        memberships.vincularPorConfirmacao(atletaComConta.id, { teamId: equipeA.id }, diretorA)
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    });

    // E o TREINADOR também não: ter pedido não é ter titularidade. Ele também vê
    // o atleta, pela cláusula de treinador autorizado.
    await comoAtor(contaTreinador, async () => {
      await expect(
        memberships.vincularPorConfirmacao(atletaComConta.id, { teamId: equipeA.id }, contaTreinador)
      ).rejects.toMatchObject({ status: 403 });
    });

    const vinculos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({ where: { athleteId: atletaComConta.id } }));
    expect(vinculos, 'nenhum vínculo criado por quem não é o dono').toBe(0);
  });

  it('a recusa do atleta fica registrada, e libera a vaga para um pedido futuro', async () => {
    await habilitarTreinador();
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });

    const recusa = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/reject`)
      .set(contaAtleta.auth()).send({ reason: 'Prefiro continuar sem equipe.' });
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    expect(recusa.body.status).toBe('REJECTED');

    const linha = await comoAtor(admin, tx => tx.teamMembershipRequest.findUnique({ where: { id: pedido.body.id } }));
    expect(linha.decidedById).toBe(contaAtleta.id);
    expect(linha.decidedAt).not.toBeNull();
    expect(linha.pendingAthleteId, 'decidido deixa de ser pendente').toBeNull();

    const novo = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });
    expect(novo.status, 'a vaga da trava reabriu').toBe(201);
  });

  it('DOIS pedidos simultâneos para o mesmo atleta: só um fica pendente — a trava é do banco', async () => {
    await habilitarTreinador();

    // A segunda equipe tem o MESMO treinador: o que se mede aqui é a trava de
    // pedido por atleta, não a de equipe.
    const equipeDois = (await api().post('/api/v1/teams').set(diretorA.auth())
      .send({ organizationId: orgA, name: unico('Equipe Dois'), coachId })).body;

    const respostas = await Promise.all([
      api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
        .send({ athleteId: atletaComConta.id, teamId: equipeA.id }),
      api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
        .send({ athleteId: atletaComConta.id, teamId: equipeDois.id })
    ]);

    const criados = respostas.filter(r => r.status === 201);
    const recusados = respostas.filter(r => r.status === 409);
    expect(criados, 'exatamente um pedido passa').toHaveLength(1);
    expect(recusados, 'o outro é recusado com 409').toHaveLength(1);

    const pendentes = await comoAtor(admin, tx => tx.teamMembershipRequest.count({
      where: { athleteId: atletaComConta.id, status: 'PENDING' }
    }));
    expect(pendentes).toBe(1);
  });

  it('atleta já vinculado: o pedido é recusado com o nome da equipe atual', async () => {
    await habilitarTreinador();
    await api().post(`/api/v1/athletes/${atletaComConta.id}/team`).set(diretorA.auth())
      .send({ teamId: equipeA.id });

    const equipeDois = (await api().post('/api/v1/teams').set(diretorA.auth())
      .send({ organizationId: orgA, name: unico('Equipe Dois'), coachId })).body;

    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeDois.id });
    expect(pedido.status).toBe(409);
    expect(pedido.body.error.code).toBe('ATHLETE_ALREADY_LINKED');
    expect(pedido.body.error.message).toContain(equipeA.name);
  });

  it('o treinador suspenso deixa de pedir vínculo na mesma hora', async () => {
    await habilitarTreinador();
    const suspensao = await api().post(`/api/v1/coaches/${coachId}/suspend`).set(admin.auth())
      .send({ reason: 'Suspensão administrativa.' });
    expect(suspensao.status).toBe(200);

    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaComConta.id, teamId: equipeA.id });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(403);
    expect(pedido.body.error.code).toBe('COACH_NOT_APPROVED');
  });

  it('a atleta sem conta na plataforma só é vinculada por DECISÃO ADMINISTRATIVA (R-02)', async () => {
    await habilitarTreinador();
    const pedido = await api().post('/api/v1/team-membership-requests').set(contaTreinador.auth())
      .send({ athleteId: atletaSemConta.id, teamId: equipeA.id });
    expect(pedido.status).toBe(201);

    // O diretor da federação NÃO tem `athletes.transfer` desde R-02.
    const tentativa = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/admin-approve`)
      .set(diretorA.auth()).send({ reason: 'Tentativa da federação.' });
    expect([403, 404]).toContain(tentativa.status);

    const semMotivo = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/admin-approve`)
      .set(admin.auth()).send({});
    expect(semMotivo.status, 'decisão administrativa sem justificativa não entra').toBe(400);

    const decisao = await api().post(`/api/v1/team-membership-requests/${pedido.body.id}/admin-approve`)
      .set(admin.auth()).send({ reason: 'Atleta sem conta; vínculo comprovado por ofício da federação.' });
    expect(decisao.status, JSON.stringify(decisao.body)).toBe(200);

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'MEMBERSHIP_REQUEST_ADMIN_APPROVE' }
    }));
    expect(trilha, 'a decisão administrativa tem ação PRÓPRIA na trilha').toHaveLength(1);
    expect(trilha[0].metadata.reason).toContain('ofício');
  });
});

// ------------------------------------------------------- busca por matrícula
describe('a busca por matrícula identifica sem revelar dado pessoal', () => {
  it('devolve nome e filiação, nunca CPF — e registra quem procurou', async () => {
    await habilitarTreinador();

    const achou = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '5001' });
    expect(achou.status, JSON.stringify(achou.body)).toBe(200);
    expect(achou.body.found).toBe(true);
    expect(achou.body.athlete.fullName).toBe('Joana Ferreira');
    expect(semCpf(achou.body), 'a busca não devolve CPF nem documento').toBe(true);
    expect(achou.body.athlete.birthDate).toBeUndefined();

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'ATHLETE_LOOKUP_AFFILIATION' }
    }));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].metadata.found).toBe(true);
    expect(trilha[0].metadata.affiliationNumber).toBe('5001');
  });

  it('matrícula inexistente e matrícula de OUTRA federação respondem igual', async () => {
    await habilitarTreinador();

    const inexistente = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '999999' });
    expect(inexistente.status).toBe(200);
    expect(inexistente.body).toEqual({ found: false, athlete: null });

    // Uma atleta que existe, mas na federação B.
    await criarAtleta(diretorB, orgB, { fullName: 'Atleta De Fora', cpf: cpfSeq(), affiliationNumber: '7777' });
    const deOutra = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '7777' });
    expect(deOutra.status).toBe(200);
    expect(deOutra.body, 'as duas respostas são indistinguíveis').toEqual({ found: false, athlete: null });

    // E procurar DENTRO da federação B é recusado pelo tenant, não respondido.
    const cruzando = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgB, affiliationNumber: '7777' });
    expect(cruzando.status).toBe(403);
  });

  it('a busca exige a matrícula completa: não há consulta por prefixo nem por nome', async () => {
    await habilitarTreinador();

    const prefixo = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, affiliationNumber: '500' });
    expect(prefixo.body, 'prefixo não casa').toEqual({ found: false, athlete: null });

    const porNome = await api().post('/api/v1/athletes/lookup-affiliation').set(contaTreinador.auth())
      .send({ organizationId: orgA, search: 'Joana' });
    expect(porNome.status, 'não existe campo de busca por nome no schema').toBe(400);
  });
});

// ---------------------------------------------------------------------- §8.3
describe('§8.3: a fórmula do ranking de treinadores NÃO está homologada', () => {
  it('a rota de classificação recusa, e diz que o bloqueio é de homologação', async () => {
    const publica = await api().get('/api/v1/ranking/coaches');
    expect(publica.status).toBe(409);
    expect(publica.body.error.code).toBe('COACH_RANKING_NOT_HOMOLOGATED');
    expect(publica.body.error.message).toContain('não foi homologada');

    // E não existe apelido em `/coaches/ranking`: o ranking público mora em
    // `/ranking/*`, e uma rota a menos é uma exceção a menos na auditoria de
    // superfície.
    const apelido = await api().get('/api/v1/coaches/ranking');
    expect(apelido.status, 'o apelido não existe').toBe(404);
  });

  it('a projeção existe, avisa que está em homologação e NÃO inventa total nem posição', async () => {
    await habilitarTreinador();
    const temporada = await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId: orgA, name: unico('Temporada'), year: 2031 });
    expect(temporada.status).toBeLessThan(300);

    const projecao = await api().get(`/api/v1/coaches/${coachId}/ranking/projection`).set(contaTreinador.auth())
      .query({ seasonId: temporada.body.id });
    expect(projecao.status, JSON.stringify(projecao.body)).toBe(200);
    expect(projecao.body.homologado).toBe(false);
    expect(projecao.body.aviso).toContain('Ranking em homologação');
    expect(projecao.body.totalDoTreinador, 'não há total de treinador').toBeNull();
    expect(projecao.body.posicao, 'não há posição de treinador').toBeNull();

    const elegibilidade = await api().get(`/api/v1/coaches/${coachId}/ranking/eligibility`).set(contaTreinador.auth())
      .query({ seasonId: temporada.body.id });
    expect(elegibilidade.status).toBe(200);
    expect(elegibilidade.body.homologado).toBe(false);
    expect(elegibilidade.body.teams[0].lancamentosElegiveis, 'contagem de lançamentos, não pontuação').toBe(0);
    expect(Object.keys(elegibilidade.body.teams[0])).not.toContain('points');
  });
});
