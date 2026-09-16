import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O ACUMULADO DA TEMPORADA, ETAPA A ETAPA.
//
// ORIGEM: teste humano no ambiente de preview. A tela do ranking do campeonato
// mostrava, para a campeã: "Etapas: 2 · Pontos: 30". Quem olhou fez a conta
// certa — 1º vale 5, o Overall vale +10, a participação vale 15 — e concluiu
// que 30 só poderia ser 15 somado duas vezes.
//
// A auditoria do ledger mostrou outra coisa: duas linhas, uma por etapa, cada
// uma com bônus PRÓPRIO, porque havia DOIS títulos — um por evento. Nada estava
// multiplicado. O que faltava era teste que fixasse a diferença entre as duas
// leituras, e tela que explicasse o número.
//
// A regra vigente é por TÍTULO, e título é por evento:
//
//     +10 uma vez por título, na participação da classe absoluta.
//
// Então um título em duas etapas vale +20 na temporada, e isso é correto.
// O que NUNCA pode acontecer é o mesmo título render duas vezes, ou a mesma
// participação virar duas linhas, ou o consolidado divergir do ledger.
//
// Estes testes trancam as duas metades: o número que a regra produz, e a
// identidade entre o que o ranking mostra e o que o ledger soma.
// ============================================================================

let admin, diretor, orgId, seasonId;

const cpfSeq = (() => { let n = 910000000; return () => gerarCpf(n += 6113); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

/** Monta uma etapa com uma classe ABSOLUTA e publica o resultado. */
async function etapa(colocadas) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  const { event, competitionClass } = montado;
  await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscritos = [];
  for (const nome of colocadas) {
    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.push({ nome, registrationId: inscricao.body.registration.id, athleteId: inscricao.body.registration.athlete.id });
  }

  await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const i of inscritos) {
    await api().post(`/api/v1/registrations/${i.registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, event.id, ['IN_JUDGING']);
  await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: inscritos.map((item, i) => ({ athleteId: item.athleteId, placing: i + 1 })) });
  await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });

  return { event, competitionClass, inscritos, idDe: nome => inscritos.find(i => i.nome === nome).athleteId };
}

const declarar = (eventId, athleteId) => api()
  .post(`/api/v1/events/${eventId}/overall`).set(diretor.auth()).send({ athleteId });

/** O ledger da atleta, cru, e o que o ranking consolidado diz dela. */
async function auditar(nome) {
  return comoAtor(diretor, async tx => {
    const atleta = await tx.athlete.findFirst({ where: { fullName: nome }, select: { id: true } });
    const pontos = await tx.rankingPoint.findMany({
      where: { athleteId: atleta.id, seasonId },
      select: {
        eventId: true, resultId: true, categoryId: true, placing: true,
        placementPoints: true, overallBonus: true, points: true, isOverallChampion: true
      },
      orderBy: { awardedAt: 'asc' }
    });
    const consolidado = await tx.ranking.findFirst({
      where: { athleteId: atleta.id, seasonId },
      select: { totalPoints: true, eventCount: true, overallWins: true }
    });
    const titulos = await tx.eventOverallTitle.count({ where: { athleteId: atleta.id } });

    return {
      athleteId: atleta.id,
      pontos,
      titulos,
      consolidado,
      somaDoLedger: pontos.reduce((t, p) => t + p.points, 0),
      somaDeColocacao: pontos.reduce((t, p) => t + p.placementPoints, 0),
      somaDeBonus: pontos.reduce((t, p) => t + p.overallBonus, 0),
      // Participação é (evento, resultado, recorte). A mesma não pode virar
      // duas linhas — é a duplicação que o teste humano suspeitou.
      participacoesRepetidas: (() => {
        const chaves = pontos.map(p => `${p.eventId}|${p.resultId}|${p.categoryId}`);
        return chaves.filter((c, i) => chaves.indexOf(c) !== i);
      })()
    };
  });
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  cpfPorNome = new Map();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
  diretor = await criarUsuario({ name: 'Diretora' });
  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;
});

describe('duas etapas, Overall em uma só', () => {
  it('5 + (5 + 10) = 20 — e NÃO 30', async () => {
    const etapaA = await etapa(['ATLETA A', 'ATLETA B']);
    const etapaB = await etapa(['ATLETA A', 'ATLETA B']);

    // O título é declarado SÓ na etapa A.
    expect((await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'))).status).toBe(201);

    const a = await auditar('ATLETA A');

    expect(a.pontos, 'uma linha por participação, nunca duas').toHaveLength(2);
    expect(a.participacoesRepetidas, 'nenhuma participação duplicada').toEqual([]);
    expect(a.titulos, 'um único título').toBe(1);

    expect(a.somaDeColocacao, '5 + 5 de colocação').toBe(10);
    expect(a.somaDeBonus, 'o bônus entra UMA vez').toBe(10);
    expect(a.somaDoLedger, '10 de colocação + 10 de bônus').toBe(20);

    expect(a.consolidado.totalPoints, 'o consolidado é 20, não 30').toBe(20);
    expect(a.consolidado.eventCount, 'duas etapas').toBe(2);
    expect(a.consolidado.overallWins, 'um título').toBe(1);

    // A etapa SEM título não pode ter bônus nenhum.
    const semTitulo = a.pontos.find(p => p.eventId === etapaB.event.id);
    expect(semTitulo.overallBonus, 'a etapa sem título vale só a colocação').toBe(0);
    expect(semTitulo.points).toBe(5);
  }, 120000);

  it('30 só é possível com DOIS títulos — e aí é a regra, não um defeito', async () => {
    // Este teste existe para fixar a leitura correta do número que o teste
    // humano encontrou. Overall é POR EVENTO: ganhar dois vale dois bônus.
    // O que se prova aqui é que cada bônus veio do SEU título, e que nenhuma
    // participação foi contada duas vezes.
    const etapaA = await etapa(['ATLETA A', 'ATLETA B']);
    const etapaB = await etapa(['ATLETA A', 'ATLETA B']);

    expect((await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'))).status).toBe(201);
    expect((await declarar(etapaB.event.id, etapaB.idDe('ATLETA A'))).status).toBe(201);

    const a = await auditar('ATLETA A');

    expect(a.pontos, 'ainda duas linhas: uma por participação').toHaveLength(2);
    expect(a.participacoesRepetidas).toEqual([]);
    expect(a.titulos, 'dois títulos, um por evento').toBe(2);
    expect(a.pontos.map(p => p.overallBonus).sort(), 'um bônus por título').toEqual([10, 10]);
    expect(a.somaDoLedger).toBe(30);
    expect(a.consolidado.totalPoints).toBe(30);
    expect(a.consolidado.overallWins, 'e a tela tem como explicar o 30').toBe(2);
  }, 120000);

  it('o consolidado é SEMPRE a soma do ledger — nunca um número à parte', async () => {
    // O gate que o defeito pediu: se o ranking exibir um total que a soma dos
    // RankingPoint não produz, há duplicação em algum lugar do caminho.
    const etapaA = await etapa(['ATLETA A', 'ATLETA B', 'ATLETA C']);
    const etapaB = await etapa(['ATLETA B', 'ATLETA A']);
    const etapaC = await etapa(['ATLETA C', 'ATLETA A', 'ATLETA B']);

    await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'));
    await declarar(etapaC.event.id, etapaC.idDe('ATLETA C'));
    void etapaB;

    for (const nome of ['ATLETA A', 'ATLETA B', 'ATLETA C']) {
      const a = await auditar(nome);
      expect(a.consolidado.totalPoints, `${nome}: consolidado = soma do ledger`).toBe(a.somaDoLedger);
      expect(a.consolidado.eventCount, `${nome}: etapas = linhas do ledger`).toBe(a.pontos.length);
      expect(a.consolidado.overallWins, `${nome}: títulos = linhas com bônus`)
        .toBe(a.pontos.filter(p => p.overallBonus > 0).length);
      expect(a.participacoesRepetidas, `${nome}: sem participação duplicada`).toEqual([]);
    }
  }, 180000);
});

describe('"Etapas" conta CAMPEONATOS, não linhas do ledger', () => {
  // O outro número que o teste humano leu na tela. Um atleta inscrito em três
  // classes do MESMO campeonato tem três linhas no ledger e participou de UMA
  // etapa. Se "Etapas" passasse a contar linhas, a tela diria 3 — e o leitor
  // dividiria o total por 3 para conferir, chegando a um valor que não existe.
  it('três classes no mesmo campeonato contam como UMA etapa', async () => {
    const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
    await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    // Duas classes a mais DENTRO da mesma categoria que o helper já montou.
    // Criar outra categoria traria a primeira do catálogo, que é masculina — e
    // a inscrição seria recusada por elegibilidade, que é a regra funcionando.
    const classes = [montado.competitionClass.id];
    for (const def of [
      { divisao: 'Novatas', codigoDivisao: 'ACU-NOV', nome: 'Novice', codigo: 'NOVICE' },
      { divisao: 'Master', codigoDivisao: 'ACU-MST', nome: 'Master', codigo: 'MASTER' }
    ]) {
      const divisao = await api().post(`/api/v1/event-categories/${montado.eventCategory.id}/divisions`)
        .set(diretor.auth()).send({ name: def.divisao, code: def.codigoDivisao });
      const classe = await api().post(`/api/v1/divisions/${divisao.body.id}/classes`)
        .set(diretor.auth()).send({ name: def.nome, code: def.codigo });
      classes.push(classe.body.id);
    }

    const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe('ATLETA MULTI'), athlete: { fullName: 'ATLETA MULTI', sex: 'FEMALE' }, classIds: classes });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    const athleteId = inscricao.body.registration.athlete.id;

    await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretor.auth()).send({});
    await transicionar(diretor, montado.event.id, ['IN_JUDGING']);

    for (const classId of classes) {
      await api().post(`/api/v1/classes/${classId}/result`).set(diretor.auth())
        .send({ entries: [{ athleteId, placing: 1 }] });
      await api().post(`/api/v1/classes/${classId}/result/publish`).set(diretor.auth()).send({ note: 'Homologado' });
    }

    const a = await auditar('ATLETA MULTI');
    expect(a.pontos, 'três linhas no ledger, uma por classe').toHaveLength(3);
    expect(a.consolidado.eventCount, '"Etapas" é o número de CAMPEONATOS, e é 1').toBe(1);
    expect(a.consolidado.totalPoints, '5 por classe').toBe(15);
    expect(a.somaDoLedger).toBe(15);
  }, 180000);
});

describe('idempotência do acumulado', () => {
  it('declarar 3× e repontuar 3× não move o total', async () => {
    const etapaA = await etapa(['ATLETA A', 'ATLETA B']);
    await etapa(['ATLETA A', 'ATLETA B']);

    for (let i = 0; i < 3; i += 1) {
      const r = await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'));
      expect([200, 201], `declaração ${i + 1}`).toContain(r.status);
    }

    const depoisDeDeclarar = await auditar('ATLETA A');
    expect(depoisDeDeclarar.titulos, 'três declarações, um título').toBe(1);
    expect(depoisDeDeclarar.somaDoLedger).toBe(20);

    for (let i = 0; i < 3; i += 1) {
      const r = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({});
      expect(r.status, `repontuação ${i + 1}`).toBe(200);
    }

    const depoisDeRepontuar = await auditar('ATLETA A');
    expect(depoisDeRepontuar.pontos, 'repontuar não cria linha').toHaveLength(2);
    expect(depoisDeRepontuar.somaDoLedger, 'repontuar não muda o total').toBe(20);
    expect(depoisDeRepontuar.consolidado.totalPoints).toBe(20);
    expect(depoisDeRepontuar.titulos, 'e não cria título').toBe(1);
  }, 180000);
});

describe('a prévia não promete um ponto que já foi dado', () => {
  // A prévia é o que o operador lê ANTES de confirmar. Ela mostra o impacto no
  // acumulado da temporada — e esse impacto é ZERO quando o bônus já está
  // lançado, porque homologar de novo é idempotente.
  //
  // Sem esta trava, a tela diria "+10" numa operação que não soma nada. Quem
  // confirmasse esperando 10 pontos a mais veria o total não mexer, e não
  // teria como saber se o sistema errou ou se a tela mentiu. Foi essa leitura
  // — número na tela que a conta não explica — que originou este arquivo.
  it('re-homologar mostra impacto ZERO, e não +10 de novo', async () => {
    const etapaA = await etapa(['ATLETA A', 'ATLETA B']);
    const atleta = etapaA.idDe('ATLETA A');

    const antes = await api().get(`/api/v1/events/${etapaA.event.id}/overall/preview`)
      .set(diretor.auth()).query({ athleteId: atleta });
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);
    expect(antes.body.overallBonus, 'o título vale +10').toBe(10);
    expect(antes.body.participation.placementPoints, '1º lugar vale 5').toBe(5);
    expect(antes.body.participation.pointsAfter, '5 + 10 = 15').toBe(15);
    expect(antes.body.seasonImpact, 'ainda não homologado: o acumulado sobe 10').toBe(10);
    expect(antes.body.alreadyDeclared).toBe(false);

    expect((await declarar(etapaA.event.id, atleta)).status).toBe(201);

    const depois = await api().get(`/api/v1/events/${etapaA.event.id}/overall/preview`)
      .set(diretor.auth()).query({ athleteId: atleta });
    expect(depois.status).toBe(200);
    expect(depois.body.seasonImpact, 'já homologado: confirmar de novo não soma nada').toBe(0);
    expect(depois.body.alreadyDeclared, 'e a tela sabe que já está declarado').toBe(true);
    // A conta da participação continua a mesma: o que muda é o IMPACTO.
    expect(depois.body.participation.pointsAfter).toBe(15);

    const a = await auditar('ATLETA A');
    expect(a.somaDoLedger, 'e o ledger não mexeu').toBe(15);
  }, 120000);
});

describe('a ordem das operações não muda o acumulado', () => {
  // Resultado → Overall → ranking, contra
  // Resultado → ranking → Overall → ranking.
  // Os dois caminhos existem na operação real: o operador pode declarar o
  // Overall antes ou depois de alguém abrir a tela de ranking.
  it('declarar antes ou depois de consultar o ranking dá o mesmo número', async () => {
    const etapaA = await etapa(['ATLETA A', 'ATLETA B']);
    await etapa(['ATLETA A', 'ATLETA B']);

    // Caminho 1: consultar primeiro.
    const antes = await api().get('/api/v1/ranking').set(diretor.auth()).query({ seasonId, limit: 50 });
    expect(antes.status).toBe(200);

    await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'));
    const caminho1 = await auditar('ATLETA A');

    // Caminho 2: revogar, repontuar, declarar de novo — a mesma decisão,
    // tomada noutra ordem.
    const titulo = await comoAtor(diretor, tx => tx.eventOverallTitle.findFirst({ where: { eventId: etapaA.event.id } }));
    const revogacao = await api().delete(`/api/v1/events/${etapaA.event.id}/overall/${titulo.id}`)
      .set(diretor.auth()).send({ reason: 'Teste de ordem das operações' });
    expect(revogacao.status).toBe(200);

    const semTitulo = await auditar('ATLETA A');
    expect(semTitulo.somaDoLedger, 'sem título, só a colocação').toBe(10);
    expect(semTitulo.consolidado.overallWins).toBe(0);

    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({});
    await declarar(etapaA.event.id, etapaA.idDe('ATLETA A'));
    const caminho2 = await auditar('ATLETA A');

    expect(caminho2.somaDoLedger, 'mesma decisão, mesmo total').toBe(caminho1.somaDoLedger);
    expect(caminho2.consolidado.totalPoints).toBe(caminho1.consolidado.totalPoints);
    expect(caminho2.titulos).toBe(1);
    expect(caminho2.pontos).toHaveLength(2);
  }, 180000);
});
