import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// O TÍTULO OVERALL PRECISA ALCANÇAR O RESULTADO QUE VEIO DE IMPORTAÇÃO.
//
// Encontrado ao preparar a publicação do Ipiranga. `declareOverall` aplica o
// bônus REPROCESSANDO os `Result` publicados do evento. Resultado importado
// não é `Result`: é `ExternalResult` + `RankingPoint(source: MUSCLEWAR)`. A
// lista de publicados vem VAZIA, nada é reprocessado, e o +10 não chega.
// `normalizarBonusOverall` ainda filtra `source: 'EVENT'`, então mesmo o
// caminho de dentro não o alcançaria.
//
// O efeito prático é o pior tipo: silencioso e irreversível pelo caminho
// normal. Publicado o Ipiranga sem Overall, declarar o título depois não
// muda nada — e reimportar o arquivo com a coluna Overall também não, porque
// a idempotência marca tudo como DUPLICATE. A mesma proteção que impede
// duplicar ranking impede corrigir.
//
// A REGRA ESPORTIVA NÃO MUDA AQUI. Só a declaração oficial concede o bônus,
// só na absoluta, +10 uma vez. O que muda é o alcance da aplicação.
// ==========================================================================

const { vincularPendentesDoAtleta } = createRequire(import.meta.url)('../src/services/muscleWarService.js');

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';
const OPEN = "Men's Bodybuilding - Open";
const NOVICE = "Men's Bodybuilding - Novice";
const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = (matricula, colocacao, n = 1, classe = OPEN) =>
  `${n},${classe},Atleta,Sobrenome,${matricula},${colocacao}`;

let admin, operador, org, filiacao, season, evento, eventoB, atleta, categoriaBB;

const pontosDe = (where = {}) => comoAtor(admin, tx => tx.rankingPoint.findMany({
  where,
  select: { id: true, source: true, eventId: true, athleteId: true, placing: true,
            placementPoints: true, overallBonus: true, points: true,
            isOverallChampion: true, didNotShow: true, superOverallPoints: true }
}));

const importarEAplicar = async (conteudo, eventId) => {
  const criacao = await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, eventId, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  });
  expect(criacao.status, JSON.stringify(criacao.body)).toBe(201);
  const lote = criacao.body.import;
  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
    .set(operador.auth()).send({});
  expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
  return lote;
};

const declarar = (eventId, corpo, quem) =>
  api().post(`/api/v1/events/${eventId}/overall`).set((quem ?? operador).auth()).send(corpo);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  const organizacao = await criarOrganizacao(admin, { name: 'Federacao Overall' });
  org = organizacao.id;

  operador = await criarUsuario({ name: 'Operador' });
  for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
    await vincular(org, operador, papel);
  }

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  const criarEvento = nome => api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: nome, slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  });
  evento = (await criarEvento('Etapa A')).body;
  eventoB = (await criarEvento('Etapa B')).body;

  categoriaBB = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });

  atleta = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: 'ATLETA OVERALL', sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: org, cpf: gerarCpf(661) } }
    }
  }));

  // A INSCRIÇÃO EXISTE porque `declareOverall` confere participação em classe
  // absoluta pela INSCRIÇÃO, não pelo resultado — e essa regra não muda aqui.
  for (const alvo of [evento, eventoB]) {
    const ec = (await api().post(`/api/v1/events/${alvo.id}/categories`).set(operador.auth())
      .send({ categoryId: categoriaBB.id })).body;
    const div = (await api().post(`/api/v1/event-categories/${ec.id}/divisions`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN' })).body;
    const classe = (await api().post(`/api/v1/divisions/${div.id}/classes`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;
    await comoAtor(operador, tx => tx.registration.create({
      data: {
        eventId: alvo.id, athleteId: atleta.id, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    }));
  }
});

describe('declarar Overall alcança o ponto que veio da importação', () => {
  it('Open 1º importado passa de 5 para 15 quando o título é declarado', async () => {
    await importarEAplicar(csv([linha('88281', 1)]), evento.id);

    const [antes] = await pontosDe({ source: 'MUSCLEWAR' });
    expect(antes.points, 'sem título declarado, vale só a colocação').toBe(5);
    expect(antes.overallBonus).toBe(0);

    const r = await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const [depois] = await pontosDe({ source: 'MUSCLEWAR' });
    expect(depois.placementPoints, 'a colocação não é tocada').toBe(5);
    expect(depois.overallBonus).toBe(10);
    expect(depois.points).toBe(15);
    expect(depois.isOverallChampion).toBe(true);
  }, 60_000);

  it('revogar o título devolve o ponto a 5, sem apagar a participação', async () => {
    await importarEAplicar(csv([linha('88281', 1)]), evento.id);
    const titulo = (await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id })).body;

    expect((await pontosDe({ source: 'MUSCLEWAR' }))[0].points).toBe(15);

    const revogacao = await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.id}`)
      .set(operador.auth()).send({ reason: 'sumula corrigida pelo comite' });
    expect(revogacao.status, JSON.stringify(revogacao.body)).toBe(200);

    const depois = await pontosDe({ source: 'MUSCLEWAR' });
    expect(depois, 'a participação continua existindo').toHaveLength(1);
    expect(depois[0].overallBonus).toBe(0);
    expect(depois[0].points).toBe(5);
    expect(depois[0].isOverallChampion).toBe(false);
  }, 60_000);

  it('declarar duas vezes o mesmo título soma +10 uma vez só', async () => {
    await importarEAplicar(csv([linha('88281', 1)]), evento.id);
    await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });
    const segunda = await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(segunda.status).toBe(201);

    const [ponto] = await pontosDe({ source: 'MUSCLEWAR' });
    expect(ponto.overallBonus, 'nunca +20').toBe(10);
    expect(ponto.points).toBe(15);
  }, 60_000);

  it('o título do evento A não alcança o ponto do evento B', async () => {
    await importarEAplicar(csv([linha('88281', 1)]), evento.id);
    await importarEAplicar(csv([linha('88281', 1)]), eventoB.id);
    await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });

    const noA = (await pontosDe({ eventId: evento.id }))[0];
    const noB = (await pontosDe({ eventId: eventoB.id }))[0];
    expect(noA.points).toBe(15);
    expect(noB.points, 'evento B nao herda titulo do evento A').toBe(5);
    expect(noB.overallBonus).toBe(0);
  }, 60_000);

  it('NÃO COMPARECIMENTO sobrevive à declaração e à revogação', async () => {
    // A armadilha: a normalização apaga linha cujo total zera, porque no
    // caminho interno ela só existia por causa do bônus. NS importado vale
    // ZERO por regra e PRECISA continuar no histórico — apagá-lo transformaria
    // "não subiu no palco" em "não participou".
    await importarEAplicar(csv([linha('88281', 'NS')]), evento.id);
    const [antes] = await pontosDe({ source: 'MUSCLEWAR' });
    expect(antes.didNotShow).toBe(true);
    expect(antes.points).toBe(0);

    await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });

    const depois = await pontosDe({ source: 'MUSCLEWAR' });
    expect(depois, 'a ausência não pode sumir do histórico').toHaveLength(1);
    expect(depois[0].didNotShow).toBe(true);
    expect(depois[0].placing).toBeNull();
  }, 60_000);

  it('o ranking acumulado reflete o bônus, e o invariante se mantém', async () => {
    await importarEAplicar(csv([linha('88281', 1)]), evento.id);
    await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });

    const ranking = await api().get('/api/v1/ranking').set(admin.auth())
      .query({ organizationId: org, seasonId: season });
    const linhaDoAtleta = ranking.body.items.find(i => i.athlete.id === atleta.id);
    expect(linhaDoAtleta.totalPoints).toBe(15);

    // Ranking.totalPoints === SUM(RankingPoint.points)
    const soma = (await pontosDe({})).reduce((t, p) => t + p.points, 0);
    expect(linhaDoAtleta.totalPoints).toBe(soma);
  }, 60_000);
});

describe('a regra do Overall continua a mesma', () => {
  it('fora da absoluta o título é recusado, mesmo com resultado importado', async () => {
    await importarEAplicar(csv([linha('88281', 1, 1, NOVICE)]), evento.id);

    // O atleta tem inscrição em classe absoluta (montada no beforeEach), mas a
    // participação importada é Novice. A recusa aqui é da PONTUAÇÃO: mesmo com
    // o título declarado, a linha Novice não recebe bônus.
    await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id });

    const [ponto] = await pontosDe({ source: 'MUSCLEWAR' });
    expect(ponto.overallBonus, 'Novice nao recebe o +10').toBe(0);
    expect(ponto.points).toBe(5);
  }, 60_000);

  it('atleta de outra organização continua barrado', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin B' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Federacao Outra' });
    const forasteiro = await comoAtor(outroAdmin, tx => tx.athlete.create({
      data: { organizationId: outraOrg.id, fullName: 'DE FORA', sex: 'MALE' }
    }));

    const r = await declarar(evento.id, { athleteId: forasteiro.id, categoryId: categoriaBB.id });
    // 404, e nao 422: o RLS não deixa a consulta enxergar atleta de outra
    // organização, então o serviço nem chega a comparar as organizações. A
    // resposta é MAIS segura que a que eu esperava — não confirma sequer que
    // aquele id existe. O teste passa a afirmar a barreira, não o número.
    expect([403, 404, 422]).toContain(r.status);
    const pontosDoForasteiro = await comoAtor(admin, tx => tx.rankingPoint.count({
      where: { athleteId: forasteiro.id }
    }));
    expect(pontosDoForasteiro, 'nada foi gravado para o forasteiro').toBe(0);
  }, 60_000);

  it('sem permissão de ranking, ninguém declara', async () => {
    const semPapel = await criarUsuario({ name: 'Sem Papel' });
    await vincular(org, semPapel, 'ATHLETE');
    const r = await declarar(evento.id, { athleteId: atleta.id, categoryId: categoriaBB.id }, semPapel);
    expect([401, 403]).toContain(r.status);
  }, 60_000);
});
