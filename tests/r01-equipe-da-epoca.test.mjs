import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular,
  criarAtleta, criarEventoCompleto, inscrever, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// R-01 — O PONTO PERTENCE AO VÍNCULO QUE EXISTIA NA DATA OFICIAL DO EVENTO.
//
// A decisão aprovada diz: sem retroatividade automática. Entrar numa equipe hoje
// não traz para ela o que o atleta pontuou antes; sair dela não leva embora o
// que já pontuou por ela.
//
// O QUE ESTA SUÍTE MEDE, E POR QUE ELA PRECISOU EXISTIR
//
// O caminho da IMPORTAÇÃO já cumpria R-01 desde antes do módulo Treinadores &
// Equipes: `vinculoDoResultado`, em `muscleWarService`, resolve o vínculo pela
// data do resultado. O caminho INTERNO — resultado julgado fora e publicado no
// MCI — não cumpria: ele lia `Athlete.teamId`, o vínculo CORRENTE no instante da
// projeção.
//
// Enquanto o resultado é publicado no mesmo dia, os dois coincidem e ninguém
// nota. Eles divergem no caso normal: o resultado é publicado dias depois e o
// atleta é transferido nesse intervalo. O ponto ia para a equipe NOVA, que não
// competiu — o oposto de R-01.
//
// O CENÁRIO É MONTADO NA ORDEM DA REALIDADE: o atleta compete pela equipe A na
// data do evento, depois é transferido para a B, e só então o resultado é
// publicado. O que se mede é para qual equipe o lançamento aponta.
// ============================================================================

let admin;
let diretor;
let centralAutorizado;
let orgId;
let seasonId;
let equipeA;
let equipeB;

const cpfSeq = (() => { let n = 660000000; return () => gerarCpf(n += 4337); })();

// A data OFICIAL do evento, e a data em que o vínculo muda. A transferência
// acontece DEPOIS do evento — é a sequência que produz a divergência.
const DATA_DO_EVENTO = '2026-05-10T12:00:00.000Z';

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administração Central' });
  diretor = await criarUsuario({ name: 'Diretor da Etapa' });
  // Transferir exige `athletes.transfer`, que desde R-02 vem de delegação
  // central — e quem a recebe precisa ser administrador central para o banco
  // também o reconhecer. Ver `tests/vinculo-equipe.test.mjs`.
  centralAutorizado = await criarUsuario({ role: 'ADMIN', name: 'Administradora Delegada' });

  orgId = (await criarOrganizacao(admin, { name: unico('Federação') })).id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');

  const concessao = await api().post('/api/v1/central-authorizations').set(admin.auth()).send({
    userId: centralAutorizado.id, permission: 'athletes.transfer', organizationId: orgId,
    reason: 'Delegação formal para montar o cenário de R-01.'
  });
  expect(concessao.status, JSON.stringify(concessao.body)).toBe(201);

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  expect(temporada.status).toBeLessThan(300);
  seasonId = temporada.body.id;
  expect((await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }]
  })).status).toBeLessThan(300);

  equipeA = (await api().post('/api/v1/teams').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Equipe A') })).body;
  equipeB = (await api().post('/api/v1/teams').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Equipe B') })).body;
});

/** Monta evento, inscreve, recebe e publica o resultado. Devolve o lançamento. */
async function competirEPublicar(atleta, cpf, { antesDePublicar } = {}) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  // A data oficial é FIXADA, e não a do helper: é ela que R-01 usa, e o teste
  // não pode depender de um padrão que outra suíte talvez mude.
  await comoAtor(admin, tx => tx.event.update({
    where: { id: montado.event.id }, data: { startDate: new Date(DATA_DO_EVENTO) }
  }));

  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  await inscrever(diretor, montado.event.id, { cpf, classIds: [montado.competitionClass.id] });
  await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION', 'IN_JUDGING']);

  const recebido = await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: [{ athleteId: atleta.id, placing: 1, status: 'RANKED' }] });
  expect(recebido.status, JSON.stringify(recebido.body)).toBeLessThan(300);

  // A JANELA: entre receber e publicar, a realidade pode mudar.
  if (antesDePublicar) await antesDePublicar();

  const publicado = await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`)
    .set(diretor.auth()).send({});
  expect(publicado.status, JSON.stringify(publicado.body)).toBeLessThan(300);

  const lancamento = await comoAtor(admin, tx => tx.rankingPoint.findFirst({
    where: { athleteId: atleta.id, seasonId },
    select: { id: true, teamId: true, points: true, companyId: true }
  }));
  expect(lancamento, 'a publicação gerou lançamento').toBeTruthy();
  return { lancamento, evento: montado.event };
}

describe('a equipe do lançamento é a da DATA OFICIAL do evento', () => {
  it('transferência DEPOIS do evento não leva o ponto para a equipe nova', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });

    // Vínculo com a equipe A, ANTES do evento.
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: equipeA.id })).status).toBe(201);
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-01-15T00:00:00.000Z') }
    }));

    const { lancamento } = await competirEPublicar(atleta, cpf, {
      // A TRANSFERÊNCIA ACONTECE NA JANELA entre o resultado recebido e o
      // publicado. É o caso normal de operação, não um caso raro.
      antesDePublicar: async () => {
        const transferencia = await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`)
          .set(centralAutorizado.auth())
          .send({ teamId: equipeB.id, reason: 'Transferência homologada depois da etapa.' });
        expect(transferencia.status, JSON.stringify(transferencia.body)).toBe(200);
      }
    });

    expect(lancamento.teamId, 'o ponto fica com a equipe que competiu').toBe(equipeA.id);
    expect(lancamento.teamId, 'e NÃO com a equipe nova').not.toBe(equipeB.id);
  });

  it('sem transferência, a equipe da época é a equipe atual — nada muda no caso simples', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Carla Souza', cpf });
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: equipeA.id })).status).toBe(201);
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-01-15T00:00:00.000Z') }
    }));

    const { lancamento } = await competirEPublicar(atleta, cpf);
    expect(lancamento.teamId).toBe(equipeA.id);
  });

  it('vínculo que só NASCE depois do evento não reivindica o ponto anterior', async () => {
    // Este é o "sem retroatividade automática" de R-01, no sentido inverso: o
    // atleta competiu SEM equipe e entrou numa depois. O ponto continua sendo
    // individual — a equipe nova não herda o passado.
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Marina Alves', cpf });

    const { lancamento } = await competirEPublicar(atleta, cpf, {
      antesDePublicar: async () => {
        const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
          .send({ teamId: equipeB.id });
        expect(vinculo.status).toBe(201);
        // O vínculo começa DEPOIS da data oficial do evento.
        await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
          where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-08-01T00:00:00.000Z') }
        }));
      }
    });

    expect(lancamento.teamId, 'a equipe que só chegou depois não recebe o ponto').toBeNull();
  });

  it('atleta SEM histórico de vínculo: o espelho responde — e isso não é retroatividade', async () => {
    // O CASO DA BASE ANTIGA, e o da fixture que grava o espelho direto.
    //
    // `athleteService.create` só passou a criar a linha de `AthleteTeamMembership`
    // junto do cadastro numa fase posterior, então pode existir atleta com
    // `Athlete.teamId` preenchido e ZERO histórico. Para ele não há fato temporal
    // a contradizer, e o espelho é o único retrato disponível — a mesma regra 3
    // que o importador já aplicava.
    //
    // MEDIDO: sem este recurso, 9 testes de `ranking-oficial` reprovaram, todos
    // de pontuação de equipe e de empresa. A fixture `eventoPontuado` de lá grava
    // `Athlete.teamId` sem criar vínculo, e antes desta fase era esse espelho que
    // a projeção lia.
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Base Antiga', cpf });

    // O estado LEGADO é montado à mão de propósito: é justamente o estado que o
    // caminho atual não produz mais.
    await comoAtor(admin, tx => tx.athleteTeamMembership.deleteMany({ where: { athleteId: atleta.id } }));
    await comoAtor(admin, tx => tx.athlete.update({ where: { id: atleta.id }, data: { teamId: equipeA.id } }));
    const quantos = await comoAtor(admin, tx => tx.athleteTeamMembership.count({ where: { athleteId: atleta.id } }));
    expect(quantos, 'o cenário é atleta sem histórico nenhum').toBe(0);

    const { lancamento } = await competirEPublicar(atleta, cpf);
    expect(lancamento.teamId, 'o espelho responde quando não há histórico').toBe(equipeA.id);
  });

  it('COM histórico e nenhum vínculo na data, o espelho NÃO é consultado', async () => {
    // A distinção que sustenta R-01: "sem histórico" e "com histórico, mas
    // nenhum vínculo valia naquela data" são respostas DIFERENTES. A segunda é
    // definitiva — cair no espelho ali seria exatamente a retroatividade
    // proibida, porque o espelho aponta para a equipe de HOJE.
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Chegou Depois', cpf });

    const { lancamento } = await competirEPublicar(atleta, cpf, {
      antesDePublicar: async () => {
        const vinculo = await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
          .send({ teamId: equipeB.id });
        expect(vinculo.status).toBe(201);
        await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
          where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-08-01T00:00:00Z') }
        }));
        // O espelho aponta para a equipe B — e mesmo assim o ponto não vai para ela.
        const espelho = await comoAtor(admin, tx => tx.athlete.findUnique({ where: { id: atleta.id }, select: { teamId: true } }));
        expect(espelho.teamId).toBe(equipeB.id);
      }
    });

    expect(lancamento.teamId, 'histórico presente e nenhum vínculo na data = sem equipe').toBeNull();
  });

  it('o RECÁLCULO preserva a equipe já registrada — não reescreve a história', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: equipeA.id })).status).toBe(201);
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-01-15T00:00:00.000Z') }
    }));

    const { lancamento } = await competirEPublicar(atleta, cpf);
    expect(lancamento.teamId).toBe(equipeA.id);

    // Transfere DEPOIS de tudo publicado e manda recalcular a temporada.
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team/transfer`).set(centralAutorizado.auth())
      .send({ teamId: equipeB.id, reason: 'Transferência posterior à publicação.' })).status).toBe(200);

    const recalculo = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth()).send({});
    expect(recalculo.status, JSON.stringify(recalculo.body)).toBeLessThan(300);

    const depois = await comoAtor(admin, tx => tx.rankingPoint.findUnique({
      where: { id: lancamento.id }, select: { teamId: true, points: true }
    }));
    expect(depois.teamId, 'o recálculo não muda a equipe do lançamento').toBe(equipeA.id);
    expect(depois.points, 'nem a pontuação').toBe(lancamento.points);
  });
});

describe('a pergunta temporal tem UMA resposta, e ela é consultável', () => {
  it('`vinculoNaData` devolve o vínculo da época, e nulo antes de existir vínculo', async () => {
    const memberships = await import('../src/services/membershipService.js');
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Joana Ferreira', cpf });
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: equipeA.id })).status).toBe(201);
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-03-01T00:00:00.000Z') }
    }));

    await comoAtor(admin, async () => {
      const antes = await memberships.default.vinculoNaData(atleta.id, new Date('2026-02-01T00:00:00.000Z'));
      expect(antes, 'antes do vínculo, ninguém responde pelo atleta').toBeNull();

      const durante = await memberships.default.vinculoNaData(atleta.id, new Date('2026-05-10T00:00:00.000Z'));
      expect(durante.teamId).toBe(equipeA.id);
    });
  });

  it('a conferência de divergência existe e é SOMENTE leitura', async () => {
    const cpf = cpfSeq();
    const atleta = await criarAtleta(diretor, orgId, { fullName: 'Carla Souza', cpf });
    expect((await api().post(`/api/v1/athletes/${atleta.id}/team`).set(diretor.auth())
      .send({ teamId: equipeA.id })).status).toBe(201);
    await comoAtor(admin, tx => tx.athleteTeamMembership.updateMany({
      where: { athleteId: atleta.id }, data: { startedAt: new Date('2026-01-15T00:00:00.000Z') }
    }));
    const { lancamento } = await competirEPublicar(atleta, cpf);

    const conferencia = await api().get('/api/v1/coaches/ranking/divergences').set(admin.auth())
      .query({ seasonId });
    expect(conferencia.status, JSON.stringify(conferencia.body)).toBe(200);
    expect(conferencia.body.divergencias, 'no caso coerente não há divergência').toEqual([]);
    expect(conferencia.body.analisados).toBeGreaterThan(0);

    // E a conferência NÃO corrige nada: corrigir atribuição de ponto é ato
    // administrativo de R-02, não efeito colateral de uma consulta.
    const intacto = await comoAtor(admin, tx => tx.rankingPoint.findUnique({
      where: { id: lancamento.id }, select: { teamId: true }
    }));
    expect(intacto.teamId).toBe(equipeA.id);
  });
});
