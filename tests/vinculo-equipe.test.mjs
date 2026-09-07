import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor, criarEventoCompleto, transicionar
} from './helpers.mjs';

// ============================================================================
// ANTIFRAUDE — vínculo único atleta → equipe/empresa.
//
// REGRA HOMOLOGADA: um atleta tem no máximo UM vínculo ativo. Quem tenta
// reivindicá-lo é recusado e informado de qual é a equipe atual. Trocar de
// equipe passa pelo operador da Muscle Contest, gera auditoria e PRESERVA o
// vínculo anterior — ninguém apaga o passado do atleta.
//
// A trava é do banco. Estes testes cobrem os dois lados: a recusa educada no
// caminho normal e a corrida concorrente, que só o índice único resolve.
// ============================================================================

let admin;
let diretor;          // athletes.transfer — operador da Muscle Contest
let operadorInscricao; // athletes.update, SEM transfer — o "treinador"
let orgId;
let alpha;
let beta;

const cpfSeq = (() => { let n = 700000000; return () => gerarCpf(n += 7717); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Operadora MCI' });
  operadorInscricao = await criarUsuario({ name: 'Treinador' });

  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, operadorInscricao, 'REGISTRATION_OPERATOR');

  alpha = (await api().post('/api/v1/teams').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Team Alpha') })).body;
  beta = (await api().post('/api/v1/teams').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Team Beta') })).body;
});

const criarAtletaLivre = async nome =>
  criarAtleta(diretor, orgId, { fullName: nome, cpf: cpfSeq() });

describe('a trava recusa o segundo vínculo e informa a equipe atual', () => {
  it('atleta livre é vinculado normalmente', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');

    const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(operadorInscricao.auth())
      .send({ teamId: alpha.id });

    expect(vinculo.status, JSON.stringify(vinculo.body)).toBe(201);
    expect(vinculo.body.teamId).toBe(alpha.id);
    expect(vinculo.body.endedAt).toBeNull();
  });

  it('a Team Beta não consegue vincular atleta que já é da Team Alpha', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const tentativa = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(operadorInscricao.auth())
      .send({ teamId: beta.id });

    expect(tentativa.status).toBe(409);
    expect(tentativa.body.error.code).toBe('ATHLETE_ALREADY_LINKED');

    // A mensagem precisa dizer a QUEM recorrer, não só negar.
    expect(tentativa.body.error.message).toContain(alpha.name);
    expect(tentativa.body.error.message).toMatch(/operador da Muscle Contest/i);
  });

  it('nem o operador da Muscle Contest vincula por cima — transferir é outra operação', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const porCima = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: beta.id });

    expect(porCima.status, 'vincular nunca sobrescreve; existe rota própria para transferir').toBe(409);
  });
});

describe('o treinador não transfere sozinho', () => {
  it('quem tem athletes.update mas não athletes.transfer é recusado', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const tentativa = await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(operadorInscricao.auth())
      .send({ teamId: beta.id, reason: 'Atleta pediu para sair' });

    expect([403, 404]).toContain(tentativa.status);

    const ativo = await comoAtor(diretor, tx => tx.athleteTeamMembership.findFirst({ where: { athleteId: atleta.id, endedAt: null } }));
    expect(ativo.teamId, 'o vínculo não pode ter mudado').toBe(alpha.id);
  });

  it('o operador transfere, com motivo obrigatório', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const semMotivo = await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(diretor.auth())
      .send({ teamId: beta.id });
    expect(semMotivo.status, 'transferência sem motivo não entra no histórico').toBe(400);

    const transferencia = await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(diretor.auth())
      .send({ teamId: beta.id, reason: 'Autorizado pela federação' });

    expect(transferencia.status, JSON.stringify(transferencia.body)).toBe(200);
    expect(transferencia.body.teamId).toBe(beta.id);
  });
});

describe('o passado do atleta é preservado', () => {
  it('a transferência encerra o vínculo anterior em vez de apagá-lo', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });
    await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(diretor.auth())
      .send({ teamId: beta.id, reason: 'Autorizado pela federação' });

    const historico = await api().get(`/api/v1/athletes/${atleta.id}/team-history`).set(diretor.auth());
    expect(historico.status).toBe(200);
    expect(historico.body.items).toHaveLength(2);

    const [atual, anterior] = historico.body.items;
    expect(atual.teamId).toBe(beta.id);
    expect(atual.endedAt).toBeNull();

    expect(anterior.teamId, 'a Team Alpha continua no histórico').toBe(alpha.id);
    expect(anterior.endedAt).not.toBeNull();
    expect(anterior.endedById).toBe(diretor.id);
  });

  it('a transferência fica na auditoria, com equipe de origem e destino', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });
    await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(diretor.auth())
      .send({ teamId: beta.id, reason: 'Autorizado pela federação' });

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({ where: { action: 'ATHLETE_TEAM_TRANSFER' } }));
    expect(trilha).toHaveLength(1);
    expect(trilha[0].userEmail).toBe(diretor.email);
    expect(trilha[0].metadata.previousTeamId).toBe(alpha.id);
    expect(trilha[0].metadata.teamId).toBe(beta.id);
  });

  it('depois de encerrado sem substituto, o atleta pode ser vinculado de novo', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const encerrar = await api().post(`/api/v1/athletes/${atleta.id}/team/unlink`).set(diretor.auth())
      .send({ reason: 'Encerrado a pedido' });
    expect(encerrar.status).toBe(200);

    const novo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(operadorInscricao.auth())
      .send({ teamId: beta.id });
    expect(novo.status, 'sem vínculo ativo, a trava não impede').toBe(201);

    const historico = await api().get(`/api/v1/athletes/${atleta.id}/team-history`).set(diretor.auth());
    expect(historico.body.items).toHaveLength(2);
  });
});

describe('a trava é do banco, não da tela', () => {
  it('duas tentativas SIMULTÂNEAS de vincular o mesmo atleta: só uma passa', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');

    // O caso que nenhuma checagem em service resolve: entre o SELECT e o
    // INSERT cabe a transação do outro. Quem garante é o índice único.
    const respostas = await Promise.all([
      api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id }),
      api().post(`/api/v1/athletes/${atleta.id}/team`).set(operadorInscricao.auth()).send({ teamId: beta.id })
    ]);

    const criados = respostas.filter(r => r.status === 201);
    const recusados = respostas.filter(r => r.status === 409);

    expect(criados, 'exatamente um vínculo pode ser criado').toHaveLength(1);
    expect(recusados, `status=${JSON.stringify(respostas.map(r => [r.status, r.body?.error?.code]))}`).toHaveLength(1);
    expect(recusados[0].body.error.code).toBe('ATHLETE_ALREADY_LINKED');

    const ativos = await comoAtor(diretor, tx => tx.athleteTeamMembership.findMany({ where: { athleteId: atleta.id, endedAt: null } }));
    expect(ativos, 'o banco não pode ter dois vínculos ativos').toHaveLength(1);
  });

  it('o banco recusa dois vínculos ativos mesmo por escrita direta', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    // Sem passar pelo service: a garantia precisa estar na tabela.
    await expect(comoAtor(diretor, tx => tx.athleteTeamMembership.create({
      data: { athleteId: atleta.id, teamId: beta.id, activeAthleteId: atleta.id }
    }))).rejects.toThrow();

    const ativos = await comoAtor(diretor, tx => tx.athleteTeamMembership.findMany({ where: { athleteId: atleta.id, endedAt: null } }));
    expect(ativos).toHaveLength(1);
  });
});

describe('não há contorno pela API', () => {
  it('o update genérico do atleta não aceita mais teamId', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const contorno = await api().patch(`/api/v1/athletes/${atleta.id}`).set(diretor.auth())
      .send({ teamId: beta.id, city: 'Cuiabá' });

    // O campo é ignorado ou recusado — o que não pode é trocar a equipe.
    const ativo = await comoAtor(diretor, tx => tx.athleteTeamMembership.findFirst({ where: { athleteId: atleta.id, endedAt: null } }));
    expect(ativo.teamId, `PATCH não pode trocar a equipe (HTTP ${contorno.status})`).toBe(alpha.id);

    // E o espelho não pode divergir do vínculo: se `Athlete.teamId` mudasse
    // sozinho, o ranking atribuiria os pontos à equipe errada mesmo com o
    // histórico intacto.
    const perfil = await comoAtor(diretor, tx => tx.athlete.findUnique({ where: { id: atleta.id }, select: { teamId: true } }));
    expect(perfil.teamId).toBe(alpha.id);
  });

  it('a recusa do PATCH aponta a rota certa, em vez de só negar', async () => {
    // A trava não pode depender de uma única linha de schema: o service
    // recusa por conta própria, e diz por onde a troca se faz.
    const atleta = await criarAtletaLivre('Joao Silva');
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const contorno = await api().patch(`/api/v1/athletes/${atleta.id}`).set(diretor.auth())
      .send({ teamId: beta.id });

    expect([400, 422]).toContain(contorno.status);
    expect(JSON.stringify(contorno.body)).toMatch(/team\/transfer|teamId/);
  });

  it('atleta de outra organização não é vinculado a equipe daqui', async () => {
    const outroDiretor = await criarUsuario({ name: 'Diretor B' });
    const outraOrg = await criarOrganizacao(admin, { name: unico('Federação B') });
    await vincular(outraOrg.id, outroDiretor, 'EVENT_DIRECTOR');

    const deFora = await criarAtleta(outroDiretor, outraOrg.id, { fullName: 'De Fora', cpf: cpfSeq() });

    const tentativa = await api().post(`/api/v1/athletes/${deFora.id}/team`).set(diretor.auth())
      .send({ teamId: alpha.id });

    expect([403, 404, 422]).toContain(tentativa.status);
  });

  it('IDOR: conhecer o id do atleta não basta para vinculá-lo', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');
    const qualquerUm = await criarUsuario({ name: 'Sem Papel' });

    const tentativa = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(qualquerUm.auth())
      .send({ teamId: alpha.id });

    expect([403, 404]).toContain(tentativa.status);
  });
});

describe('vínculo esportivo e relação comercial são coisas diferentes', () => {
  it('patrocínio NÃO cria vínculo de equipe', async () => {
    const atleta = await criarAtletaLivre('Joao Silva');

    const marca = await api().post('/api/v1/brands').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Marca'), slug: unico('marca').toLowerCase() });
    expect(marca.status, JSON.stringify(marca.body)).toBe(201);

    const patrocinio = await api().post('/api/v1/partnerships').set(diretor.auth())
      .send({ brandId: marca.body.id, athleteId: atleta.id, startDate: '2026-01-01' });

    // Independente de a rota aceitar, o que não pode é virar vínculo esportivo.
    const ativo = await comoAtor(diretor, tx => tx.athleteTeamMembership.findFirst({ where: { athleteId: atleta.id, endedAt: null } }));
    expect(ativo, `parceria comercial não é vínculo de equipe (HTTP ${patrocinio.status})`).toBeNull();

    // E o atleta segue livre para ser vinculado a uma equipe.
    const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });
    expect(vinculo.status).toBe(201);
  });

  it('a empresa acompanha a equipe do vínculo', async () => {
    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Empresa') });
    const daEmpresa = (await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe da Empresa'), companyId: empresa.body.id })).body;

    const atleta = await criarAtletaLivre('Joao Silva');
    const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: daEmpresa.id });

    expect(vinculo.body.companyId, 'a empresa da equipe é registrada no vínculo').toBe(empresa.body.id);
  });
});

describe('a inscrição também arma a trava', () => {
  // A inscrição é a porta mais movimentada da plataforma e cria o perfil do
  // atleta quando o CPF é novo. Se ela gravasse só o espelho `Athlete.teamId`
  // sem abrir o vínculo, o atleta nasceria com equipe e SEM trava — e outra
  // equipe o reivindicaria sem receber recusa nenhuma.
  it('atleta criado pela inscrição já nasce com vínculo registrado', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretor, orgId);
    await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const cpf = cpfSeq();
    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth()).send({
      cpf,
      athlete: { fullName: 'Joana Ferreira', sex: 'FEMALE', teamId: alpha.id },
      classIds: [competitionClass.id]
    });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);

    const athleteId = inscricao.body.registration.athlete.id;
    const historico = await api().get(`/api/v1/athletes/${athleteId}/team-history`).set(diretor.auth());
    expect(historico.body.items, 'o vínculo nasce junto com o atleta').toHaveLength(1);
    expect(historico.body.items[0].teamId).toBe(alpha.id);

    // E a trava está de fato armada, não só registrada.
    const tentativa = await api().post(`/api/v1/athletes/${athleteId}/team`).set(operadorInscricao.auth())
      .send({ teamId: beta.id });
    expect(tentativa.status).toBe(409);
    expect(tentativa.body.error.message).toContain(alpha.name);
  });
});

describe('a importação não é a porta dos fundos da trava', () => {
  // O arquivo é redigido fora da plataforma. Se a equipe declarada nele fosse
  // aceita sem conferência, bastaria um CSV para uma equipe acumular pontos de
  // atleta que não é dela — a trava valeria só para quem usa a tela.
  const cabecalho = 'external_result_id,cpf,atleta,filiacao,categoria,classe,colocacao,pontos,evento,equipe,data';

  let seasonId;
  let gerente;

  const importarEAplicar = async linha => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId: orgId, seasonId, sourceType: 'CSV',
      sourceRef: unico('arquivo') + '.csv', content: [cabecalho, linha].join('\n')
    });
    return api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  };

  beforeEach(async () => {
    gerente = await criarUsuario({ name: 'Gerente de Ranking' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');
    await vincular(orgId, gerente, 'REGISTRATION_OPERATOR');

    const temporada = await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
    seasonId = temporada.body.id;
    await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
      .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }] });
  });

  it('arquivo que declara equipe diferente do vínculo não é aplicado', async () => {
    // Inclusive datado no passado: recuar a data da linha não pode virar a
    // brecha que a trava fechou na tela e na API.
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    // O arquivo diz Beta. O vínculo diz Alpha.
    const aplicacao = await importarEAplicar(
      `MWX-1,${cpf},Joana Ferreira,,BIKINI,OPEN,1,5,Etapa,${beta.name},2026-05-10`
    );

    expect(aplicacao.body.teamMismatch, 'a linha divergente é contada').toBe(1);
    expect(aplicacao.body.applied, 'e não entra no ranking').toBe(0);

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(pontos, 'nenhum ponto criado para a equipe que o arquivo reivindicou').toHaveLength(0);
  });

  it('a recusa diz as duas equipes, para o operador saber o que corrigir', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    await importarEAplicar(`MWX-2,${cpf},Joana Ferreira,,BIKINI,OPEN,1,5,Etapa,${beta.name},2026-05-10`);

    const item = await comoAtor(diretor, tx => tx.muscleWarImportItem.findFirst({
      where: { externalResultId: 'MWX-2' }, select: { matchStatus: true, reason: true }
    }));

    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toContain(beta.name);
    expect(item.reason).toContain(alpha.name);
  });

  it('arquivo coerente com o vínculo é aplicado normalmente', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const aplicacao = await importarEAplicar(
      `MWX-3,${cpf},Joana Ferreira,,BIKINI,OPEN,1,5,Etapa,${alpha.name},2026-05-10`
    );

    expect(aplicacao.body.applied).toBe(1);
    expect(aplicacao.body.teamMismatch).toBe(0);

    const [ponto] = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(ponto.teamId).toBe(alpha.id);
  });

  it('resultado ANTIGO pertence à equipe de então, não à de hoje', async () => {
    // Sem isto, transferir de equipe reescreveria o passado: um resultado
    // conquistado na Alpha passaria a contar para a Beta.
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    // O vínculo com a Alpha é recuado no tempo para que o caso seja real: ela
    // esteve na Alpha em maio e só depois foi transferida.
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-01-15T00:00:00Z') }
    }));

    await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(diretor.auth())
      .send({ teamId: beta.id, reason: 'Mudança de equipe homologada' });

    const aplicacao = await importarEAplicar(
      `MWX-4,${cpf},Joana Ferreira,,BIKINI,OPEN,1,5,Etapa antiga,${alpha.name},2026-05-10`
    );

    expect(aplicacao.body.applied, 'a equipe da época é aceita').toBe(1);
    const [ponto] = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(ponto.teamId, 'o ponto fica com a equipe de então').toBe(alpha.id);
  });

  it('atleta sem vínculo nenhum: o arquivo continua sendo a única fonte', async () => {
    const cpf = cpfSeq();
    await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });

    const aplicacao = await importarEAplicar(
      `MWX-5,${cpf},Joana Ferreira,,BIKINI,OPEN,1,5,Etapa,${beta.name},2026-05-10`
    );

    expect(aplicacao.body.applied).toBe(1);
    const [ponto] = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(ponto.teamId).toBe(beta.id);
  });
});

describe('CPF continua protegido', () => {
  it('o histórico de vínculo não expõe CPF', async () => {
    const cpf = gerarCpf(818181818);
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joao Silva', cpf });
    await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth()).send({ teamId: alpha.id });

    const historico = await api().get(`/api/v1/athletes/${atleta.id}/team-history`).set(diretor.auth());
    expect(JSON.stringify(historico.body)).not.toContain(cpf);
  });
});
