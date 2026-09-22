import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// AJUSTE ADMINISTRATIVO DA PONTUAÇÃO — O NÚMERO MUDA, O RESTO NÃO.
//
// A homologação às vezes corrige a pontuação de uma participação sem que a
// COLOCAÇÃO tenha mudado. Já existia a correção de colocação, que recalcula
// pelo motor — certa quando o erro está na colocação, inútil quando está no
// ponto.
//
// O QUE ESTE ARQUIVO PROTEGE, na ordem em que as coisas dão errado:
//
//   1. o total continua reconstituível a partir das parcelas;
//   2. categoria, classe, colocação, evento, temporada, atleta e o resultado
//      externo saem intactos — inclusive quando o corpo tenta alterá-los;
//   3. Overall não é declarado, revogado nem inventado de carona;
//   4. quem não tem `ranking.manage` NAQUELA organização não passa;
//   5. dois operadores simultâneos não gravam por cima um do outro, e o
//      duplo clique não vira dois ajustes;
//   6. a auditoria registra de quanto para quanto e por quê — sem CPF.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const arquivo = () => [
  CABECALHO,
  'QA-A-1,QA ATLETA UM,NPC,QA-A-001,BIKINI,Women\'s Bikini - Open Class A,1,Etapa QA',
  'QA-A-2,QA ATLETA DOIS,NPC,QA-A-002,BIKINI,Women\'s Bikini - Open Class A,2,Etapa QA',
  'QA-A-3,QA ATLETA TRES,NPC,QA-A-003,BIKINI,Women\'s Bikini - Masters 35+,1,Etapa QA'
].join('\n');

let admin;
let gerente;
let intruso;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

async function montar(nome) {
  const org = await criarOrganizacao(admin, { name: nome });
  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org.id, name: `NPC ${nome}`, code: unico('NPC').slice(0, 12).toUpperCase() });
  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: `Temporada ${nome}`, year: 2026 });
  return { organizationId: org.id, seasonId: temporada.body.id };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  intruso = await criarUsuario({ name: 'Operador Sem Poder' });

  const montada = await montar('MCI Brasil');
  organizationId = montada.organizationId;
  seasonId = montada.seasonId;

  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');
  // Membro da organização, SEM ranking.manage: é o caso que separa
  // "é de casa" de "pode mexer na pontuação".
  await vincular(organizationId, intruso, 'REGISTRATION_OPERATOR');

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('ajuste') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
});

const campeao = () => noLedger(tx => tx.rankingPoint.findFirst({
  where: { seasonId, placing: 1, points: 5 },
  select: {
    id: true, points: true, placing: true, placementPoints: true, overallBonus: true,
    adjustmentPoints: true, categoryId: true, catalogClassId: true, athleteId: true,
    eventId: true, seasonId: true, organizationId: true, externalResultId: true,
    superOverallPoints: true, superOverallEligible: true, isOverallChampion: true
  }
}));

const ajustar = (ponto, corpo, ator = gerente) => api()
  .post(`/api/v1/ranking/points/${ponto.id}/adjust`).set(ator.auth()).send(corpo);

describe('o ajuste muda a pontuação e mais nada', () => {
  it('5 vira 4, a diferença é -1, e as parcelas continuam somando o total', async () => {
    const antes = await campeao();
    expect(antes.points).toBe(5);

    const resposta = await ajustar(antes, { points: 4, expectedPoints: 5, reason: 'Correção de homologação' });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
    expect(resposta.body.points).toBe(4);
    expect(resposta.body.diferenca).toBe(-1);

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: antes.id },
      select: {
        points: true, placementPoints: true, overallBonus: true, adjustmentPoints: true,
        placing: true, categoryId: true, catalogClassId: true, athleteId: true,
        eventId: true, seasonId: true, organizationId: true, externalResultId: true,
        superOverallPoints: true, superOverallEligible: true, isOverallChampion: true
      }
    }));

    // O TOTAL CONTINUA RECONSTITUÍVEL. É o que torna o ledger auditável.
    expect(depois.placementPoints + depois.overallBonus + depois.adjustmentPoints).toBe(depois.points);
    expect(depois.adjustmentPoints).toBe(-1);
    // A parcela do motor NÃO foi tocada: quem mudou foi a decisão humana.
    expect(depois.placementPoints).toBe(antes.placementPoints);

    // E TUDO O MAIS ESTÁ INTACTO.
    for (const campo of ['placing', 'categoryId', 'catalogClassId', 'athleteId',
      'eventId', 'seasonId', 'organizationId', 'externalResultId',
      'superOverallEligible', 'isOverallChampion']) {
      expect(depois[campo], campo).toEqual(antes[campo]);
    }
  });

  it('a métrica anual acompanha o total, pela mesma regra de sempre', async () => {
    const antes = await campeao();
    await ajustar(antes, { points: 3, expectedPoints: 5, reason: 'Revisão da comissão técnica' });

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: antes.id }, select: { points: true, superOverallPoints: true, superOverallEligible: true }
    }));

    // Igual ao total onde a classe é elegível, zero nas demais. O ajuste não
    // muda elegibilidade — ela é atributo da classe.
    expect(depois.superOverallPoints).toBe(depois.superOverallEligible ? depois.points : 0);
  });

  it('o ranking reflete a mudança imediatamente, sem participação duplicada', async () => {
    const antes = await campeao();
    const participacoesAntes = await noLedger(tx => tx.rankingPoint.count({ where: { seasonId } }));

    await ajustar(antes, { points: 2, expectedPoints: 5, reason: 'Correção de homologação' });

    const resposta = await api().get('/api/v1/ranking').set(gerente.auth()).query({ seasonId, limit: 100 });
    const totais = resposta.body.items.map(linha => linha.totalPoints).sort((a, b) => b - a);

    // Eram 5, 5 e 4 (dois primeiros lugares em classes diferentes). Vira 5, 4, 2.
    expect(totais).toEqual([5, 4, 2]);
    expect(await noLedger(tx => tx.rankingPoint.count({ where: { seasonId } }))).toBe(participacoesAntes);
  });

  it('não declara, não revoga e não inventa Overall', async () => {
    const antes = await campeao();
    const titulosAntes = await noLedger(tx => tx.eventOverallTitle.count());

    await ajustar(antes, { points: 15, expectedPoints: 5, reason: 'Ajuste para conferir o Overall' });

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: antes.id }, select: { overallBonus: true, isOverallChampion: true }
    }));

    // 15 é o valor de um 1º lugar COM bônus de Overall. Mesmo assim o bônus
    // continua zero e a marca continua falsa: o ajuste não confere título.
    expect(depois.overallBonus).toBe(0);
    expect(depois.isOverallChampion).toBe(false);
    expect(await noLedger(tx => tx.eventOverallTitle.count())).toBe(titulosAntes);
  });

  it('o corpo não consegue alterar colocação, categoria nem atleta de carona', async () => {
    const antes = await campeao();
    const outra = await prisma.category.findUnique({ where: { code: 'FIGURE' } });

    const resposta = await ajustar(antes, {
      points: 4, expectedPoints: 5, reason: 'Tentativa de atribuição em massa',
      placing: 9, categoryId: outra.id, catalogClassId: null, athleteId: null,
      eventId: null, seasonId: null, superOverallEligible: true
    });
    expect(resposta.status).toBe(200);

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: antes.id },
      select: { placing: true, categoryId: true, catalogClassId: true, superOverallEligible: true }
    }));

    expect(depois.placing).toBe(antes.placing);
    expect(depois.categoryId).toBe(antes.categoryId);
    expect(depois.catalogClassId).toBe(antes.catalogClassId);
    expect(depois.superOverallEligible).toBe(antes.superOverallEligible);
  });
});

describe('sem motivo e sem valor válido não se ajusta', () => {
  it('motivo vazio é recusado', async () => {
    const ponto = await campeao();
    for (const reason of ['', '   ', 'ok']) {
      const resposta = await ajustar(ponto, { points: 4, expectedPoints: 5, reason });
      // 400 é a recusa do esquema, antes de o serviço existir — que é onde
      // um motivo vazio tem de morrer.
      expect(resposta.status, `motivo ${JSON.stringify(reason)}`).toBe(400);
    }
    expect((await campeao()).points).toBe(5);
  });

  it('pontuação negativa é recusada', async () => {
    const ponto = await campeao();
    const resposta = await ajustar(ponto, { points: -1, expectedPoints: 5, reason: 'Tentativa de ponto negativo' });
    expect(resposta.status).toBe(400);
    expect((await campeao()).points).toBe(5);
  });

  it('não comparecimento não recebe ponto por ajuste', async () => {
    const ponto = await campeao();
    await api().patch(`/api/v1/ranking/points/${ponto.id}`).set(gerente.auth())
      .send({ didNotShow: true, reason: 'Atleta não compareceu' });

    const resposta = await ajustar({ id: ponto.id }, { points: 5, expectedPoints: 0, reason: 'Tentativa de pontuar ausência' });
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('ADJUST_ON_DID_NOT_SHOW');
  });
});

describe('concorrência e duplo clique', () => {
  it('o segundo operador é recusado com a mensagem que manda atualizar', async () => {
    const ponto = await campeao();

    const primeiro = await ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Primeira correção' });
    expect(primeiro.status).toBe(200);

    // O segundo leu 5 antes da primeira gravação e envia assim mesmo.
    const segundo = await ajustar(ponto, { points: 3, expectedPoints: 5, reason: 'Segunda correção' });

    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('RANKING_POINT_STALE');
    expect(segundo.body.error.message).toContain('alterados por outro operador');

    // E o valor é o do primeiro, não o do segundo.
    expect((await noLedger(tx => tx.rankingPoint.findUnique({ where: { id: ponto.id }, select: { points: true } }))).points).toBe(4);
  });

  it('duplo clique não vira dois ajustes', async () => {
    const ponto = await campeao();

    const [a, b] = await Promise.all([
      ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Correção de homologação' }),
      ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Correção de homologação' })
    ]);

    const situacoes = [a.status, b.status].sort();
    expect(situacoes, `${a.status} e ${b.status}`).toEqual([200, 409]);

    const ajustes = await noLedger(tx => tx.rankingPointAdjustment.count({ where: { rankingPointId: ponto.id } }));
    expect(ajustes, 'um clique, um ajuste').toBe(1);
  });
});

describe('autorização: o frontend não é mecanismo de segurança', () => {
  it('membro da organização sem ranking.manage é recusado', async () => {
    const ponto = await campeao();
    const resposta = await ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Tentativa sem poder' }, intruso);

    expect([401, 403, 404]).toContain(resposta.status);
    expect((await campeao()).points).toBe(5);
  });

  it('gerente de OUTRA organização não alcança este lançamento', async () => {
    const ponto = await campeao();
    const outra = await montar('MCI Vizinha');
    const gerenteDaOutra = await criarUsuario({ name: 'Gerente Vizinho' });
    await vincular(outra.organizationId, gerenteDaOutra, 'RANKING_MANAGER');

    const resposta = await ajustar(ponto, { points: 1, expectedPoints: 5, reason: 'Invasão cross-tenant' }, gerenteDaOutra);

    // 404 discreto: quem não pode ver não recebe confirmação de que existe.
    expect(resposta.status).toBe(404);
    expect((await campeao()).points).toBe(5);
  });

  it('anônimo não ajusta', async () => {
    const ponto = await campeao();
    const resposta = await api().post(`/api/v1/ranking/points/${ponto.id}/adjust`)
      .send({ points: 1, expectedPoints: 5, reason: 'Anônimo tentando' });
    expect([401, 403]).toContain(resposta.status);
    expect((await campeao()).points).toBe(5);
  });
});

describe('auditoria: nunca alteração silenciosa', () => {
  it('registra de quanto para quanto, por quê e onde — sem CPF', async () => {
    const ponto = await campeao();
    await ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Correção de homologação' });

    const log = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'RANKING_POINTS_ADJUSTED', entityId: ponto.id },
      orderBy: { createdAt: 'desc' }
    }));

    expect(log, 'o ajuste foi auditado').toBeTruthy();
    expect(log.organizationId).toBe(organizationId);
    expect(log.actorId ?? log.userId).toBe(gerente.id);

    const meta = log.metadata;
    expect(meta.previousPoints).toBe(5);
    expect(meta.newPoints).toBe(4);
    expect(meta.adjustment).toBe(-1);
    expect(meta.reason).toBe('Correção de homologação');
    expect(meta.seasonId).toBe(seasonId);
    expect(meta.categoryId).toBe(ponto.categoryId);
    expect(meta.catalogClassId).toBe(ponto.catalogClassId);

    // NADA de dado de pessoa no log.
    const texto = JSON.stringify(meta).toLowerCase();
    for (const proibido of ['cpf', 'password', 'token', 'senha']) {
      expect(texto, proibido).not.toContain(proibido);
    }
  });

  it('o histórico do lançamento lista os ajustes, do mais recente ao mais antigo', async () => {
    const ponto = await campeao();
    await ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Primeira correção' });
    await ajustar(ponto, { points: 2, expectedPoints: 4, reason: 'Segunda correção' });

    const resposta = await api().get(`/api/v1/ranking/points/${ponto.id}/adjustments`).set(gerente.auth());

    expect(resposta.status).toBe(200);
    expect(resposta.body.items.map(a => [a.previousPoints, a.newPoints]))
      .toEqual([[4, 2], [5, 4]]);
    expect(resposta.body.items[0].reason).toBe('Segunda correção');
    expect(resposta.body.rankingPoint.points).toBe(2);
  });
});

describe('o ajuste sobrevive a uma correção de colocação posterior', () => {
  it('corrigir a colocação recalcula o motor e conserva a decisão humana', async () => {
    const ponto = await campeao();

    // 1º lugar vale 5; a homologação decide que vale 4.
    await ajustar(ponto, { points: 4, expectedPoints: 5, reason: 'Correção de homologação' });

    // Depois descobre-se que a colocação estava errada: era 2º, que vale 4.
    await api().patch(`/api/v1/ranking/points/${ponto.id}`).set(gerente.auth())
      .send({ placing: 2, reason: 'Colocação corrigida pela súmula' });

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: ponto.id },
      select: { placing: true, placementPoints: true, overallBonus: true, adjustmentPoints: true, points: true }
    }));

    expect(depois.placing).toBe(2);
    // O motor recalculou: 2º vale 4.
    expect(depois.placementPoints).toBe(4);
    // E o ajuste de -1 continua valendo o mesmo tanto — não foi zerado de lado.
    expect(depois.adjustmentPoints).toBe(-1);
    expect(depois.points).toBe(3);
    expect(depois.placementPoints + depois.overallBonus + depois.adjustmentPoints).toBe(depois.points);
  });
});
