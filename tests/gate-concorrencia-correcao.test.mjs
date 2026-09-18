import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// GATE DE CONCORRÊNCIA DA CORREÇÃO ADMINISTRATIVA — 20 SIMULTÂNEAS.
//
// O gate do /apply nasceu de um defeito REAL encontrado por medição, não de
// hipótese. Este existe pelo mesmo motivo e vigia o mesmo tipo de janela: as
// quatro portas novas leem o lançamento, decidem, e só então escrevem. Entre
// a leitura e a escrita cabe outra requisição.
//
// Três corridas, e o que cada uma quebraria se a barreira caísse:
//
//   1. INVALIDAR × 20 — se todas passarem pela porta, o motivo registrado
//      passa a ser o da última a escrever, e a trilha de auditoria deixa de
//      dizer por que o lançamento saiu do ranking. Um administrador que
//      invalidou "atleta desclassificado" leria "engano do operador".
//
//   2. CORRIGIR × 20 — cada correção recalcula o ranking DEPOIS de escrever
//      o ponto. Se dois recálculos se cruzarem, o ponto fica valendo uma
//      colocação e o ranking materializado mostra outra: a soma publicada
//      deixa de bater com a súmula, que é a única coisa que o ranking
//      promete.
//
//   3. CORRIGIR contra INVALIDAR — a correção confere `voidedAt` antes de
//      escrever. Se a invalidação commitar nessa janela, a correção grava
//      pontos por cima de um lançamento já invalidado e o ressuscita sem
//      ninguém ter restaurado nada. É a mesma ressurreição que o bônus de
//      Overall causava, por outra porta.
//
// CRITÉRIO: nenhum 500 em nenhuma rodada; exatamente uma invalidação vence;
// o motivo registrado é o da vencedora; e o ranking materializado sempre
// bate com o lançamento, seja qual for a corrida que vencer.
// ==========================================================================

const SIMULTANEAS = 20;
const CLASSE = "Men's Bodybuilding - Novice";
const csv = linhas => ['Athlete #,Class,First Name,Last Name,Member Number,Placing', ...linhas].join('\n');

let org, admin, operador, season, athlete, ponto;

const distribuicao = respostas => respostas.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});

const lancamento = () => comoAtor(admin, async tx => {
  const [linha] = await tx.rankingPoint.findMany({ where: { seasonId: season } });
  return linha;
});

const totalNoRanking = () => comoAtor(admin, async tx => {
  const linhas = await tx.ranking.findMany({ where: { seasonId: season }, select: { totalPoints: true } });
  return linhas.reduce((soma, linha) => soma + linha.totalPoints, 0);
});

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Corrida' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Corrida' })).id;

  operador = await criarUsuario({ name: 'Operador Corrida' });
  await vincular(org, operador, 'RANKING_MANAGER');
  await vincular(org, operador, 'REGISTRATION_OPERATOR');

  const filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  athlete = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: 'ATLETA CORRIDA', sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: org, cpf: gerarCpf(902) } }
    }
  }));

  const lote = (await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: csv([`1,${CLASSE},Atleta,Sobrenome,77777,1`]),
    externalIdPrefix: 'QA', defaultAffiliationCode: 'NPC'
  })).body.import;
  const [item] = await comoAtor(operador, tx => tx.muscleWarImportItem.findMany({ where: { importId: lote.id } }));
  await api().post(`/api/v1/musclewar/items/${item.id}/link`).set(operador.auth())
    .send({ athleteId: athlete.id });
  await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});

  ponto = await lancamento();
});

describe('gate de concorrência — correção administrativa sob 20 simultâneas', () => {
  it('20 invalidações simultâneas: uma vence, e o motivo registrado é o dela', async () => {
    const respostas = await Promise.all(Array.from({ length: SIMULTANEAS }, (_, i) =>
      api().post(`/api/v1/ranking/points/${ponto.id}/void`).set(operador.auth())
        .send({ reason: `motivo ${i}` })));

    // A distribuição inteira numa asserção só, pelo mesmo motivo do gate do
    // /apply: a falha imprime o mapa recebido e diz na hora qual barreira caiu.
    expect(distribuicao(respostas)).toEqual({ 200: 1, 409: SIMULTANEAS - 1 });

    const vencedora = respostas.find(r => r.status === 200);
    const depois = await lancamento();
    expect(depois.voidedAt).not.toBeNull();
    expect(depois.points).toBe(0);
    expect(depois.voidReason, 'o motivo gravado e o da requisicao que venceu')
      .toBe(vencedora.body.voidReason ?? `motivo ${respostas.indexOf(vencedora)}`);
    expect(await totalNoRanking()).toBe(0);
  }, 120_000);

  it('20 correções simultâneas: o ranking publicado bate com o lançamento', async () => {
    const colocacoes = Array.from({ length: SIMULTANEAS }, (_, i) => (i % 5) + 1);
    const respostas = await Promise.all(colocacoes.map(placing =>
      api().patch(`/api/v1/ranking/points/${ponto.id}`).set(operador.auth())
        .send({ placing, reason: `corrigindo para ${placing}` })));

    expect(respostas.filter(r => r.status >= 500), 'nenhum 500').toHaveLength(0);
    expect(respostas.every(r => r.status === 200), JSON.stringify(distribuicao(respostas))).toBe(true);

    // Seja qual for a correção que venceu, o ponto e o ranking materializado
    // contam a MESMA história. É essa igualdade que o ranking promete.
    const depois = await lancamento();
    const pontosEsperados = { 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 }[depois.placing];
    expect(depois.points).toBe(pontosEsperados);
    expect(await totalNoRanking()).toBe(pontosEsperados);
  }, 120_000);

  it('20 restaurações simultâneas: uma vence, e as outras são recusadas', async () => {
    await api().post(`/api/v1/ranking/points/${ponto.id}/void`).set(operador.auth())
      .send({ reason: 'invalidado para o teste' });

    const respostas = await Promise.all(Array.from({ length: SIMULTANEAS }, () =>
      api().post(`/api/v1/ranking/points/${ponto.id}/restore`).set(operador.auth())
        .send({ reason: 'restaurando' })));

    // A conferência de fora, feita antes de abrir a transação, deixaria as
    // vinte passarem: todas leem `voidedAt` preenchido no mesmo instante. Só a
    // releitura SOB A TRAVA distingue a primeira das outras dezenove.
    //
    // Restaurar é recalcular a partir de `placingOriginal`, e a primeira
    // restauração o zera. As dezenove seguintes recalculariam a partir de um
    // campo já limpo — cada uma reescrevendo a colocação com o que sobrou.
    expect(distribuicao(respostas)).toEqual({ 200: 1, 409: SIMULTANEAS - 1 });

    const depois = await lancamento();
    expect(depois.voidedAt).toBeNull();
    expect(depois.placing).toBe(1);
    expect(depois.points).toBe(5);
    expect(await totalNoRanking()).toBe(5);
  }, 120_000);

  it('corrigir contra invalidar: o invalidado não volta a pontuar', async () => {
    const disparos = Array.from({ length: SIMULTANEAS }, (_, i) => (
      i % 2 === 0
        ? api().patch(`/api/v1/ranking/points/${ponto.id}`).set(operador.auth())
          .send({ placing: 3, reason: 'corrigindo a colocacao' })
        : api().post(`/api/v1/ranking/points/${ponto.id}/void`).set(operador.auth())
          .send({ reason: 'desclassificado' })
    ));
    const respostas = await Promise.all(disparos);
    expect(respostas.filter(r => r.status >= 500), 'nenhum 500').toHaveLength(0);

    const depois = await lancamento();
    if (depois.voidedAt) {
      expect(depois.points, 'invalidado nao pontua, vencendo quem vencer').toBe(0);
      expect(await totalNoRanking()).toBe(0);
    } else {
      expect(depois.points).toBeGreaterThan(0);
      expect(await totalNoRanking()).toBe(depois.points);
    }
  }, 120_000);
});
