import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// SUSPENDER, REATIVAR E ARQUIVAR — E O QUE NADA DISSO TOCA.
//
// `Athlete` não tinha coluna de estado nenhuma. Um atleta suspenso pela
// organização não tinha onde ser registrado como tal, e a única forma de
// tirar alguém de circulação era APAGAR o cadastro — que leva junto o
// lançamento de ranking, a projeção pública, o resultado da súmula e o título.
//
// O estado existe para separar duas coisas que estavam coladas: o que o atleta
// pode fazer DAQUI PARA FRENTE, e o que já aconteceu no palco. A segunda é
// história da federação, e não se apaga por decisão administrativa.
// ============================================================================

let admin;
let operador;
let gerente;
let organizationId;
let seasonId;
let athleteId;

const cpfSeq = (() => { let n = 771000000; return () => gerarCpf(n += 7717); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  operador = await criarUsuario({ name: 'Operador de cadastro' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, operador, 'REGISTRATION_OPERATOR');
  await vincular(organizationId, gerente, 'RANKING_MANAGER');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: unico('NPC').slice(0, 12).toUpperCase() });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;

  const atleta = await api().post('/api/v1/athletes').set(admin.auth()).send({
    organizationId, fullName: 'QA ATLETA DE ESTADO', sex: 'MALE', cpf: cpfSeq()
  });
  expect(atleta.status, JSON.stringify(atleta.body).slice(0, 300)).toBe(201);
  athleteId = atleta.body.id;
});

const suspender = (ator, reason) => api().post(`/api/v1/athletes/${athleteId}/suspend`).set(ator.auth()).send({ reason });
const arquivar = (ator, reason) => api().post(`/api/v1/athletes/${athleteId}/archive`).set(ator.auth()).send({ reason });
const reativar = (ator, corpo = {}) => api().post(`/api/v1/athletes/${athleteId}/reactivate`).set(ator.auth()).send(corpo);
const excluir = ator => api().delete(`/api/v1/athletes/${athleteId}`).set(ator.auth());

const estadoDoAtleta = () => comoAtor(admin, tx => tx.athlete.findUnique({
  where: { id: athleteId },
  select: { status: true, statusReason: true, statusChangedAt: true, statusChangedById: true }
}));

// Dá ao atleta um lançamento de ranking — o mesmo tipo de linha que os 191 do
// Ipiranga têm. É ela que a guarda de exclusão precisa enxergar.
async function darHistoricoEsportivo() {
  const categoria = await comoAtor(admin, tx => tx.category.findUnique({ where: { code: 'BIKINI' }, select: { id: true } }));
  return comoAtor(gerente, tx => tx.rankingPoint.create({
    data: {
      seasonId, organizationId, athleteId, categoryId: categoria.id,
      source: 'MUSCLEWAR', placing: 1,
      placementPoints: 5, overallBonus: 0, points: 5, superOverallPoints: 5,
      superOverallEligible: true
    },
    select: { id: true, points: true, placing: true, categoryId: true }
  }));
}

describe('o atleta nasce ATIVO', () => {
  it('sem ato nenhum, o estado é ACTIVE e não há motivo', async () => {
    const estado = await estadoDoAtleta();
    expect(estado.status).toBe('ACTIVE');
    expect(estado.statusReason).toBeNull();
    expect(estado.statusChangedAt).toBeNull();
  });
});

describe('suspender exige motivo, e registra quem e quando', () => {
  it('sem motivo é recusado, e o estado não muda', async () => {
    const resposta = await suspender(admin, '');
    expect(resposta.status).toBe(400);
    expect((await estadoDoAtleta()).status).toBe('ACTIVE');
  });

  it('com motivo suspende, guarda o motivo NA LINHA e audita', async () => {
    const motivo = 'Suspensão preventiva por decisão da comissão técnica';
    const resposta = await suspender(admin, motivo);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);

    const estado = await estadoDoAtleta();
    expect(estado.status).toBe('SUSPENDED');
    // O MOTIVO FICA NA LINHA, e não só na auditoria: a trilha guarda o evento,
    // a linha precisa carregar o estado corrente para a tela explicá-lo.
    expect(estado.statusReason).toBe(motivo);
    expect(estado.statusChangedAt).not.toBeNull();
    expect(estado.statusChangedById).toBe(admin.id);

    const registros = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { organizationId, action: 'ATHLETE_SUSPEND' }, select: { entityId: true, metadata: true }
    }));
    expect(registros.length).toBe(1);
    expect(registros[0].entityId).toBe(athleteId);
    expect(registros[0].metadata).toMatchObject({ de: 'ACTIVE', para: 'SUSPENDED' });
  });

  it('suspender duas vezes é idempotente: um estado, uma auditoria', async () => {
    const motivo = 'Suspensão preventiva por decisão da comissão técnica';
    expect((await suspender(admin, motivo)).status).toBe(200);
    expect((await suspender(admin, motivo)).status).toBe(200);

    const registros = await comoAtor(admin, tx => tx.auditLog.count({
      where: { organizationId, action: 'ATHLETE_SUSPEND' }
    }));
    expect(registros, 'o segundo clique não vira segundo ato').toBe(1);
  });
});

describe('reativar devolve o atleta à circulação', () => {
  it('volta a ACTIVE e fica na auditoria', async () => {
    expect((await suspender(admin, 'Suspensão preventiva por decisão da comissão')).status).toBe(200);
    expect((await reativar(admin, { reason: 'Decisão revista em ata pela comissão' })).status).toBe(200);

    expect((await estadoDoAtleta()).status).toBe('ACTIVE');
    const registros = await comoAtor(admin, tx => tx.auditLog.count({
      where: { organizationId, action: 'ATHLETE_REACTIVATE' }
    }));
    expect(registros).toBe(1);
  });

  it('reativar NÃO exige motivo — devolver direito não é restringir', async () => {
    expect((await suspender(admin, 'Suspensão preventiva por decisão da comissão')).status).toBe(200);
    expect((await reativar(admin)).status).toBe(200);
    expect((await estadoDoAtleta()).status).toBe('ACTIVE');
  });
});

describe('NENHUM estado toca o histórico esportivo', () => {
  it('suspender e arquivar preservam o lançamento, os pontos e a categoria', async () => {
    const antes = await darHistoricoEsportivo();

    expect((await suspender(admin, 'Suspensão preventiva por decisão da comissão')).status).toBe(200);
    let ponto = await comoAtor(gerente, tx => tx.rankingPoint.findUnique({
      where: { id: antes.id }, select: { id: true, points: true, placing: true, categoryId: true }
    }));
    expect(ponto, 'a suspensão não moveu nada').toEqual(antes);

    expect((await arquivar(admin, 'Atleta arquivado a pedido, sem histórico a perder')).status).toBe(200);
    ponto = await comoAtor(gerente, tx => tx.rankingPoint.findUnique({
      where: { id: antes.id }, select: { id: true, points: true, placing: true, categoryId: true }
    }));
    expect(ponto, 'o arquivamento também não').toEqual(antes);
    expect((await estadoDoAtleta()).status).toBe('ARCHIVED');
  });
});

describe('apagar atleta com histórico esportivo não é uma opção', () => {
  it('a exclusão é recusada, nomeia o que impede e aponta o arquivamento', async () => {
    const ponto = await darHistoricoEsportivo();

    const resposta = await excluir(admin);
    expect(resposta.status).toBe(409);
    expect(JSON.stringify(resposta.body)).toMatch(/ATHLETE_HAS_HISTORY/);
    // A mensagem diz O QUE impede e QUANTO, e oferece o caminho que existe.
    expect(JSON.stringify(resposta.body)).toMatch(/lançamento de ranking/);
    expect(JSON.stringify(resposta.body)).toMatch(/[Aa]rquive/);

    // E nada foi apagado.
    expect(await comoAtor(admin, tx => tx.athlete.count({ where: { id: athleteId } }))).toBe(1);
    expect(await comoAtor(gerente, tx => tx.rankingPoint.count({ where: { id: ponto.id } }))).toBe(1);
  });

  it('arquivar é o caminho: o atleta sai de circulação e o histórico fica', async () => {
    const ponto = await darHistoricoEsportivo();

    expect((await arquivar(admin, 'Atleta arquivado por decisão da organização')).status).toBe(200);

    expect((await estadoDoAtleta()).status).toBe('ARCHIVED');
    expect(await comoAtor(gerente, tx => tx.rankingPoint.count({ where: { id: ponto.id } }))).toBe(1);
  });

  it('SEM histórico, a exclusão passa e fica na auditoria', async () => {
    const resposta = await excluir(admin);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
    expect(resposta.body.deleted).toBe(true);

    expect(await comoAtor(admin, tx => tx.athlete.count({ where: { id: athleteId } }))).toBe(0);
    const registros = await comoAtor(admin, tx => tx.auditLog.count({
      where: { organizationId, action: 'ATHLETE_DELETE' }
    }));
    expect(registros).toBe(1);
  });
});

describe('a autorização segura as três portas', () => {
  it('quem não tem athletes.manage não suspende, não arquiva e não exclui', async () => {
    // O operador de cadastro cria e edita atleta — mas mudar a SITUAÇÃO dele
    // é outro ato, e pede outra permissão.
    for (const chamada of [
      () => suspender(operador, 'Motivo qualquer suficientemente longo'),
      () => arquivar(operador, 'Motivo qualquer suficientemente longo'),
      () => excluir(operador)
    ]) {
      const resposta = await chamada();
      expect([401, 403]).toContain(resposta.status);
    }

    expect((await estadoDoAtleta()).status).toBe('ACTIVE');
    expect(await comoAtor(admin, tx => tx.athlete.count({ where: { id: athleteId } }))).toBe(1);
  });

  it('o PRÓPRIO atleta não se reativa', async () => {
    // Existe caminho de dono para EDITAR o perfil; não existe para mudar a
    // própria situação administrativa, de propósito.
    const dono = await criarUsuario({ name: 'Atleta dono da conta' });
    await comoAtor(admin, tx => tx.athlete.update({ where: { id: athleteId }, data: { userId: dono.id } }));
    expect((await suspender(admin, 'Suspensão preventiva por decisão da comissão')).status).toBe(200);

    const resposta = await reativar(dono);
    expect([401, 403]).toContain(resposta.status);
    expect((await estadoDoAtleta()).status).toBe('SUSPENDED');
  });

  it('operador de OUTRA organização não alcança este atleta', async () => {
    const vizinha = await criarOrganizacao(admin, { name: 'MCI Vizinha' });
    const deOutra = await criarUsuario({ name: 'Gerente da Vizinha' });
    await vincular(vizinha.id, deOutra, 'RANKING_MANAGER');

    const resposta = await suspender(deOutra, 'Motivo qualquer suficientemente longo');
    expect([401, 403, 404]).toContain(resposta.status);
    expect((await estadoDoAtleta()).status).toBe('ACTIVE');
  });
});
