import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// "RECALCULAR" PASSA A RECALCULAR.
//
// O QUE ESTAVA ERRADO, MEDIDO NA BASE REAL DA FEDERAÇÃO
//
// O botão Recalcular só reconstruía o AGREGADO: lia `RankingPoint.points` e
// somava. Se a linha valia zero, o ranking valia zero — para sempre.
//
// Os 191 do Ipiranga entraram ANTES de a temporada ter tabela de pontos.
// `pontuarResultado` não achou regra para colocação nenhuma e gravou zero nas
// 191, corretamente. Depois a tabela foi cadastrada (1=5 … 5=1), e não havia
// caminho que a fizesse alcançar o que já estava gravado: tabela certa na
// tela, `placing` certo no lançamento, zero ponto no ranking.
//
// Reimportar não resolvia — a idempotência marca tudo como DUPLICATE, que é
// justamente a proteção que impede duplicar os 191.
//
// Este arquivo reproduz esse cenário exato: importa com a temporada SEM
// tabela, cadastra a tabela depois, e exige que o recálculo alcance o
// histórico sem criar, apagar ou duplicar lançamento nenhum.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

// Colocações 1 a 6 mais um não comparecimento: os dois extremos da regra
// homologada (do 6º em diante vale zero, NS vale zero) entram no cenário.
const LINHAS = [
  ['QA-P-1', 'BIKINI', "Women's Bikini - Open Class A", '1'],
  ['QA-P-2', 'BIKINI', "Women's Bikini - Open Class A", '2'],
  ['QA-P-3', 'BIKINI', "Women's Bikini - Open Class A", '3'],
  ['QA-P-4', 'BIKINI', "Women's Bikini - Open Class A", '4'],
  ['QA-P-5', 'BIKINI', "Women's Bikini - Open Class A", '5'],
  ['QA-P-6', 'BIKINI', "Women's Bikini - Open Class A", '6'],
  ['QA-P-7', 'BIKINI', "Women's Bikini - Open Class A", 'NS']
];

const arquivo = () => [
  CABECALHO,
  ...LINHAS.map(([id, categoria, classe, colocacao], i) =>
    `${id},QA ATLETA ${i + 1},NPC,${id.replace('QA-P-', 'QA-Q-')},${categoria},${classe},${colocacao},Etapa QA`)
].join('\n');

const TABELA = [
  { placing: 1, points: 5 },
  { placing: 2, points: 4 },
  { placing: 3, points: 3 },
  { placing: 4, points: 2 },
  { placing: 5, points: 1 }
];

let admin;
let gerente;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

// O retrato COMPLETO do lançamento: a comparação antes/depois usa o objeto
// inteiro, porque enumerar só os campos que eu lembrar deixaria de fora
// justamente o que eu não pensei em proteger.
const CAMPOS = {
  id: true, placing: true, placingOriginal: true, didNotShow: true,
  points: true, placementPoints: true, overallBonus: true, adjustmentPoints: true,
  superOverallPoints: true, superOverallEligible: true, isOverallChampion: true,
  categoryId: true, catalogClassId: true, classId: true,
  athleteId: true, externalAthleteId: true, externalResultId: true,
  eventId: true, seasonId: true, organizationId: true, source: true,
  teamId: true, companyId: true, affiliationId: true, affiliationNumber: true,
  voidedAt: true, voidReason: true, resultId: true
};

const retrato = () => noLedger(tx => tx.rankingPoint.findMany({
  where: { seasonId }, select: CAMPOS, orderBy: { externalResultId: 'asc' }
}));

const porOrigem = async () => {
  const pontos = await noLedger(tx => tx.rankingPoint.findMany({
    where: { seasonId },
    select: { placing: true, didNotShow: true, placementPoints: true, points: true, externalResult: { select: { externalId: true } } }
  }));
  return new Map(pontos.map(p => [p.externalResult.externalId, p]));
};

const recalcular = () => api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

const definirTabela = tabela => api().put(`/api/v1/seasons/${seasonId}/points-rules`)
  .set(admin.auth()).send({ rules: tabela });

const apagarTabela = () => comoAtor(admin, tx => tx.rankingPointsRule.deleteMany({ where: { seasonId } }));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('motor') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);

  await voltarAoEstadoDoIpiranga();
});

// ===========================================================================
// O ESTADO DA PRODUÇÃO, RECONSTRUÍDO — PORQUE A PORTA DA FRENTE JÁ FOI FECHADA.
// ===========================================================================
//
// Hoje `apply` RECUSA com 422 SEASON_WITHOUT_POINTS_TABLE quando a temporada
// não tem tabela: a guarda existe justamente para nenhuma importação nova
// nascer valendo zero. Isso é a correção certa, e é por isso que este cenário
// não pode mais ser produzido importando de verdade.
//
// Os 191 do Ipiranga são ANTERIORES a essa guarda. O que a base da federação
// tem hoje é: colocação, categoria e classe corretas, e as três parcelas de
// pontuação zeradas. É esse estado que se reconstrói aqui — sem tocar em
// `placing`, `categoryId` nem `catalogClassId`, que em produção estão certos.
async function voltarAoEstadoDoIpiranga() {
  await comoAtor(admin, tx => tx.rankingPoint.updateMany({
    where: { seasonId },
    data: { placementPoints: 0, points: 0, superOverallPoints: 0, overallBonus: 0 }
  }));
  const pontos = await retrato();
  expect(pontos.length).toBe(7);
  expect(pontos.every(p => p.points === 0), 'zerados como em produção').toBe(true);
  expect(pontos.every(p => p.placing !== null || p.didNotShow), 'colocação preservada').toBe(true);
  expect(pontos.every(p => p.categoryId !== null), 'categoria preservada').toBe(true);
  expect(pontos.every(p => p.catalogClassId !== null), 'classe preservada').toBe(true);
}

describe('o histórico que nasceu sem tabela está classificado e valendo zero', () => {
  it('os sete lançamentos existem, classificados, e todos valem zero', async () => {
    const pontos = await retrato();
    expect(pontos.length).toBe(7);
    expect(pontos.every(p => p.points === 0), 'todos valem zero').toBe(true);
    expect(pontos.every(p => p.placementPoints === 0)).toBe(true);
    // E já nascem classificados: a colocação, a categoria e a classe estão lá.
    expect(pontos.every(p => p.categoryId !== null), 'categoria resolvida').toBe(true);
    expect(pontos.every(p => p.catalogClassId !== null), 'classe resolvida').toBe(true);
  });
});

describe('cadastrar a tabela e recalcular alcança o histórico', () => {
  it('cada colocação recebe o que a tabela manda, e o 6º e o NS valem zero', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);

    const recompute = await recalcular();
    expect(recompute.status, JSON.stringify(recompute.body).slice(0, 300)).toBe(200);
    expect(recompute.body.lancamentos).toBe(7);
    // CINCO, e não seis: o 6º lugar e o NS já valiam zero, e a etapa só
    // escreve onde algum campo difere. É a mesma propriedade que torna o
    // recálculo idempotente.
    expect(recompute.body.lancamentosAlterados).toBe(5);
    expect(recompute.body.semTabelaDePontos).toBe(false);

    const pontos = await porOrigem();
    expect(pontos.get('QA-P-1').placementPoints).toBe(5);
    expect(pontos.get('QA-P-2').placementPoints).toBe(4);
    expect(pontos.get('QA-P-3').placementPoints).toBe(3);
    expect(pontos.get('QA-P-4').placementPoints).toBe(2);
    expect(pontos.get('QA-P-5').placementPoints).toBe(1);
    // Do 6º em diante vale zero pela regra homologada — não um valor
    // extrapolado, e não recusa.
    expect(pontos.get('QA-P-6').placementPoints).toBe(0);
    // Não comparecimento vale zero, e continua sendo participação.
    expect(pontos.get('QA-P-7').didNotShow).toBe(true);
    expect(pontos.get('QA-P-7').points).toBe(0);

    for (const [, ponto] of pontos) expect(ponto.points).toBe(ponto.placementPoints);
  });

  it('a tabela é a do administrador, e não 5/4/3/2/1 embutido', async () => {
    // Uma tabela deliberadamente diferente da oficial: se houvesse número
    // embutido no motor, este teste o encontraria.
    expect((await definirTabela([
      { placing: 1, points: 25 },
      { placing: 2, points: 18 },
      { placing: 3, points: 9 }
    ])).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const pontos = await porOrigem();
    expect(pontos.get('QA-P-1').placementPoints).toBe(25);
    expect(pontos.get('QA-P-2').placementPoints).toBe(18);
    expect(pontos.get('QA-P-3').placementPoints).toBe(9);
    // Fora da tabela configurada: zero, e não o valor da tabela oficial.
    expect(pontos.get('QA-P-4').placementPoints).toBe(0);
    expect(pontos.get('QA-P-5').placementPoints).toBe(0);
  });

  it('nenhum lançamento criado, removido ou duplicado; nada além da pontuação muda', async () => {
    const antes = await retrato();
    const externosAntes = await comoAtor(admin, tx => tx.externalResult.count());

    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const depois = await retrato();
    expect(depois.length).toBe(antes.length);
    expect(await comoAtor(admin, tx => tx.externalResult.count())).toBe(externosAntes);
    expect(new Set(depois.map(p => p.id)).size).toBe(7);

    for (let i = 0; i < antes.length; i += 1) {
      // SÓ as parcelas de pontuação podem mudar. Comparar o resto campo a
      // campo é o que prova que colocação, categoria, classe, atleta, evento,
      // origem e vínculos ficaram onde estavam.
      const derivadas = ['points', 'placementPoints', 'superOverallPoints'];
      for (const campo of Object.keys(CAMPOS)) {
        if (derivadas.includes(campo)) continue;
        expect(depois[i][campo], campo).toEqual(antes[i][campo]);
      }
    }
  });

  it('o agregado e a projeção pública recebem os pontos recalculados', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const projecao = await comoAtor(admin, tx => tx.publicRankingEntry.findMany({
      where: { seasonId }, select: { id: true, points: true }
    }));
    expect(projecao.length).toBe(7);
    expect(projecao.reduce((soma, linha) => soma + linha.points, 0)).toBe(15);

    const agregado = await comoAtor(admin, tx => tx.ranking.findMany({
      where: { seasonId }, select: { totalPoints: true }
    }));
    expect(agregado.length).toBe(7);
    expect(agregado.reduce((soma, linha) => soma + linha.totalPoints, 0)).toBe(15);
  });

  it('é idempotente: dez recálculos seguidos produzem o mesmo estado', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);
    const depoisDoPrimeiro = await retrato();

    for (let i = 0; i < 9; i += 1) {
      const resposta = await recalcular();
      expect(resposta.status).toBe(200);
      // Da segunda em diante nada muda — é essa a propriedade.
      expect(resposta.body.lancamentosAlterados, `recálculo ${i + 2}`).toBe(0);
    }

    expect(await retrato()).toEqual(depoisDoPrimeiro);
  });
});

describe('temporada sem tabela de pontos não zera nada', () => {
  it('o recálculo avisa e deixa o histórico intacto', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);
    const comPontos = await retrato();
    expect(comPontos.some(p => p.points > 0), 'há pontuação a perder').toBe(true);

    // A tabela some — por engano, por migração, por qualquer motivo.
    await apagarTabela();

    const resposta = await recalcular();
    expect(resposta.status).toBe(200);
    expect(resposta.body.semTabelaDePontos).toBe(true);
    expect(resposta.body.lancamentosAlterados).toBe(0);

    // ZERAR 191 LANÇAMENTOS PORQUE A TABELA SUMIU SERIA DESTRUIR HISTÓRICO
    // POR CAUSA DE UMA CONFIGURAÇÃO AUSENTE.
    expect(await retrato()).toEqual(comPontos);
  });
});

describe('o ajuste administrativo sobrevive ao recálculo', () => {
  it('a parcela de ajuste é preservada e a conta continua fechando', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const primeiro = (await noLedger(tx => tx.rankingPoint.findFirst({
      where: { seasonId, placing: 1 }, select: { id: true, points: true }
    })));
    expect(primeiro.points).toBe(5);

    // O operador corrige para 8 com motivo: a parcela de ajuste vale +3.
    const ajuste = await api().post(`/api/v1/ranking/points/${primeiro.id}/adjust`).set(admin.auth())
      .send({ points: 8, expectedPoints: 5, reason: 'Correção homologada pela organização em ata' });
    expect(ajuste.status, JSON.stringify(ajuste.body).slice(0, 300)).toBe(200);

    const depoisDoAjuste = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: primeiro.id }, select: { points: true, placementPoints: true, adjustmentPoints: true }
    }));
    expect(depoisDoAjuste.adjustmentPoints).toBe(3);
    expect(depoisDoAjuste.points).toBe(8);

    // RECALCULAR NÃO REVOGA DECISÃO ADMINISTRATIVA. Ela tem motivo e trilha;
    // desfazê-la é outro ato, pelo caminho do ajuste, que registra.
    expect((await recalcular()).status).toBe(200);

    const depoisDoRecalculo = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: primeiro.id }, select: { points: true, placementPoints: true, adjustmentPoints: true }
    }));
    expect(depoisDoRecalculo.adjustmentPoints).toBe(3);
    expect(depoisDoRecalculo.placementPoints).toBe(5);
    expect(depoisDoRecalculo.points).toBe(8);
  });

  it('mudar a tabela recalcula a colocação e mantém a parcela de ajuste', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const primeiro = await noLedger(tx => tx.rankingPoint.findFirst({
      where: { seasonId, placing: 1 }, select: { id: true }
    }));
    const ajuste = await api().post(`/api/v1/ranking/points/${primeiro.id}/adjust`).set(admin.auth())
      .send({ points: 8, expectedPoints: 5, reason: 'Correção homologada pela organização em ata' });
    expect(ajuste.status, JSON.stringify(ajuste.body).slice(0, 300)).toBe(200);

    // A organização passa a pagar 25 pelo primeiro lugar.
    expect((await definirTabela([{ placing: 1, points: 25 }, { placing: 2, points: 18 }])).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: primeiro.id }, select: { points: true, placementPoints: true, adjustmentPoints: true }
    }));
    // A parcela de ajuste vale o MESMO TANTO; quem mudou foi a colocação.
    expect(depois.placementPoints).toBe(25);
    expect(depois.adjustmentPoints).toBe(3);
    expect(depois.points).toBe(28);
  });
});

describe('o lançamento invalidado não volta a pontuar pelo recálculo', () => {
  it('continua valendo zero, e a colocação histórica fica preservada', async () => {
    expect((await definirTabela(TABELA)).status).toBe(200);
    expect((await recalcular()).status).toBe(200);

    const primeiro = await noLedger(tx => tx.rankingPoint.findFirst({
      where: { seasonId, placing: 1 }, select: { id: true }
    }));

    const invalidacao = await api().post(`/api/v1/ranking/points/${primeiro.id}/void`).set(admin.auth())
      .send({ reason: 'Resultado anulado pela organização por decisão em ata' });
    expect(invalidacao.status, JSON.stringify(invalidacao.body).slice(0, 300)).toBe(200);

    const invalidado = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: primeiro.id }, select: { points: true, placementPoints: true, voidedAt: true }
    }));
    expect(invalidado.voidedAt).not.toBeNull();
    expect(invalidado.points).toBe(0);

    // RECALCULAR NÃO RESSUSCITA. O lançamento vale zero por decisão
    // administrativa registrada; devolver a colocação aqui o traria de volta
    // sem ninguém ter restaurado nada.
    expect((await recalcular()).status).toBe(200);

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: primeiro.id }, select: { points: true, placementPoints: true, voidedAt: true }
    }));
    expect(depois.points).toBe(0);
    expect(depois.voidedAt).not.toBeNull();
    // A colocação histórica continua guardada: é dela que a restauração parte.
    expect(depois.placementPoints).toBe(invalidado.placementPoints);
  });
});
