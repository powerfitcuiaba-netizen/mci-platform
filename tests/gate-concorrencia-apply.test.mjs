import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// GATE DE CONCORRÊNCIA DO /apply — 20 REQUISIÇÕES SIMULTÂNEAS.
//
// Este arquivo existe porque a medição anterior encontrou um defeito REAL
// aqui: 20 /apply simultâneos devolviam 8 × HTTP 500 e NENHUM ponto era
// gravado. A causa foi a violação de unicidade em ExternalResult abortando a
// transação inteira da requisição (PostgreSQL 25P02) — o tratador de
// duplicata escrevia numa transação já morta.
//
// Por isso o gate NÃO se contenta com "status < 500". Ele registra a
// DISTRIBUIÇÃO exata, porque é a distribuição que denuncia a regressão:
// um 500 a mais, ou dois 200, significam que uma das três barreiras caiu.
//
// CRITÉRIO (por rodada):
//   1 × 200 · 19 × 422 · 0 × 500 · 1 RankingPoint · 1 ExternalResult
// ==========================================================================

const SIMULTANEAS = 20;

let org, admin, operador, season, athlete, lote, item;

const CLASSE = "Men's Bodybuilding - Novice";
const csv = linhas => ['Athlete #,Class,First Name,Last Name,Member Number,Placing', ...linhas].join('\n');

const criarLote = conteudo =>
  api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: 'QA', defaultAffiliationCode: 'NPC'
  });

const totais = () => comoAtor(admin, async tx => ({
  pontos: await tx.rankingPoint.count(),
  externos: await tx.externalResult.count()
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Gate' });
  const organizacao = await criarOrganizacao(admin, { name: 'Federacao Gate' });
  org = organizacao.id;

  operador = await criarUsuario({ name: 'Operador Gate' });
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
      organizationId: org, fullName: 'ATLETA GATE', sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: org, cpf: gerarCpf(901) } }
    }
  }));

  lote = (await criarLote(csv([`1,${CLASSE},Atleta,Sobrenome,77777,1`]))).body.import;
  [item] = await comoAtor(operador, tx => tx.muscleWarImportItem.findMany({ where: { importId: lote.id } }));
  await api().post(`/api/v1/musclewar/items/${item.id}/link`).set(operador.auth())
    .send({ athleteId: athlete.id });
});

describe('gate de concorrência — 20 /apply simultâneos', () => {
  it('a distribuição é exatamente 1×200 · 19×422 · 0×500, com 1 ponto e 1 resultado externo', async () => {
    const respostas = await Promise.all(Array.from({ length: SIMULTANEAS }, () =>
      api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({})));

    const porStatus = respostas.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    const finais = await totais();

    // Registro legível no log da execução — é o que o gate audita rodada a rodada.
    console.log(`[GATE-CONCORRENCIA] distribuicao=${JSON.stringify(porStatus)} ` +
      `rankingPoint=${finais.pontos} externalResult=${finais.externos}`);

    expect(porStatus[200]).toBe(1);
    expect(porStatus[422]).toBe(SIMULTANEAS - 1);
    expect(porStatus[500] ?? 0).toBe(0);
    expect(Object.keys(porStatus).sort()).toEqual(['200', '422']);
    expect(finais.pontos).toBe(1);
    expect(finais.externos).toBe(1);
  }, 120_000);
});
