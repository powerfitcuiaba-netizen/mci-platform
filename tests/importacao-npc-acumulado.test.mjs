import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// O ARQUIVO OFICIAL DE UMA ETAPA, DO JEITO QUE ELE VEM.
//
// Sem coluna de identificador, sem coluna de filiação, com o nome partido em
// duas e com uma coluna `Total Score` que é NOTA DE JULGAMENTO e não ponto de
// ranking. O reconhecimento fecha pela chave homologada — filiação +
// matrícula — com a filiação declarada para a etapa inteira.
//
// O que este arquivo prova, e que nenhum teste anterior provava junto:
//
//   1. o mesmo atleta em VÁRIAS classes soma todas as participações;
//   2. `Total Score` não vira ponto;
//   3. arquivo sem coluna de Overall não produz +10 em lugar nenhum;
//   4. aplicar 1x, 2x e 3x dá o mesmo ledger;
//   5. Ranking.totalPoints é a SOMA do ledger, não um número paralelo.
//
// A estrutura é a mesma do caso de referência da etapa: seis participações do
// mesmo atleta somando 23 pontos de colocação.
// ==========================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;

const FILIACAO = 'NPC';
const PREFIXO = 'IPIRANGA';

// (classe, matrícula, primeiro nome, sobrenome, nota de julgamento, colocação)
// As classes vêm no formato do arquivo oficial: categoria, divisão e classe
// numa string só. É a estrutura real do caso de referência da etapa.
const LINHAS = [
  ["Men's Bodybuilding - Novice", '88281', 'Yuri', 'Santinelli', '95.5', 1],
  ["Men's Bodybuilding - Masters 35+", '88281', 'Yuri', 'Santinelli', '88.0', 5],
  ["Men's Bodybuilding - Open Light Heavyweight", '88281', 'Yuri', 'Santinelli', '91.2', 3],
  ["Men's Classic Physique - Novice", '88281', 'Yuri', 'Santinelli', '93.4', 1],
  ["Men's Classic Physique - Masters 35+", '88281', 'Yuri', 'Santinelli', '90.1', 1],
  ["Men's Classic Physique - Open Class B", '88281', 'Yuri', 'Santinelli', '89.7', 2],
  ["Women's Bikini - Open Class B", '147986', 'Kananda', 'Dos Santos Azevedo', '87.3', 2],
  ["Women's Bikini - Novice", '147986', 'Kananda', 'Dos Santos Azevedo', '86.0', 4]
];

// 1º=5, 2º=4, 3º=3, 4º=2, 5º=1 — a regra homologada.
const ESPERADO = { 88281: 5 + 1 + 3 + 5 + 5 + 4, 147986: 4 + 2 };

const ARQUIVO = [
  'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing',
  ...LINHAS.map(([classe, matricula, primeiro, ultimo, nota, colocacao], i) =>
    `${i + 1},${classe},${primeiro},${ultimo},${matricula},Brazil,29,1,${nota},${colocacao}`)
].join('\n');

const importar = (extras = {}) => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId,
  seasonId,
  sourceType: 'CSV',
  sourceRef: unico('etapa') + '.csv',
  content: ARQUIVO,
  externalIdPrefix: PREFIXO,
  defaultAffiliationCode: FILIACAO,
  ...extras
});

const aplicar = importId => api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()).send({});

const ledgerDe = async matricula => {
  const atleta = await prisma.athlete.findFirst({ where: { affiliationNumber: matricula }, select: { id: true } });
  return prisma.rankingPoint.findMany({
    where: { athleteId: atleta.id },
    select: { points: true, placementPoints: true, placing: true, isOverallChampion: true, externalResultId: true, didNotShow: true }
  });
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administradora' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'National Physique Committee', code: FILIACAO })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  // A tabela HOMOLOGADA, e só ela.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  await comoAtor(gerente, async tx => {
    for (const [i, matricula] of ['88281', '147986'].entries()) {
      await tx.athlete.create({
        data: {
          organizationId,
          fullName: i ? 'KANANDA DOS SANTOS AZEVEDO' : 'YURI SANTINELLI',
          sex: 'FEMALE',
          affiliationId: filiacao.id,
          affiliationNumber: matricula,
          identity: { create: { organizationId, cpf: gerarCpf(400000000 + i) } }
        }
      });
    }
  });
});

describe('prévia do arquivo oficial', () => {
  it('reconhece todas as linhas pela chave filiação + matrícula', async () => {
    const resposta = await importar();
    expect(resposta.status).toBe(201);

    const resumo = resposta.body.summary;
    expect(resumo.totalRecords).toBe(LINHAS.length);
    expect(resumo.recognized).toBe(LINHAS.length);
    expect(resumo.pending).toBe(0);
    expect(resumo.conflicts).toBe(0);
  });

  it('a prévia não grava ponto nenhum', async () => {
    await importar();
    expect(await prisma.rankingPoint.count()).toBe(0);
  });

  it('cada linha registra POR QUE casou', async () => {
    const { body } = await importar();
    const previa = await api().get(`/api/v1/musclewar/imports/${body.import.id}`).set(gerente.auth());
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);
    for (const item of previa.body.items) expect(item.matchedBy).toBe('AFFILIATION_NUMBER');
  });

  it('nenhuma linha é marcada como campeã Overall', async () => {
    const { body } = await importar();
    const previa = await api().get(`/api/v1/musclewar/imports/${body.import.id}`).set(gerente.auth());
    for (const item of previa.body.items) expect(item.isOverallChampion).toBe(false);
  });
});

describe('aplicação e ledger', () => {
  it('grava uma participação por linha, todas com bônus zero', async () => {
    const { body } = await importar();
    expect((await aplicar(body.import.id)).status).toBe(200);

    const ledger = await ledgerDe('88281');
    expect(ledger).toHaveLength(6);
    for (const ponto of ledger) {
      expect(ponto.isOverallChampion).toBe(false);
      // points === placementPoints + 0. Um +10 aqui seria Overall inventado.
      expect(ponto.points).toBe(ponto.placementPoints);
    }
  });

  it('a nota de julgamento não vira ponto de ranking', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);

    // 95.5 é nota do júri externo. O ponto da mesma linha é 5.
    const primeiro = (await ledgerDe('88281')).find(p => p.placing === 1);
    expect(primeiro.points).toBe(5);
    for (const ponto of await ledgerDe('88281')) expect(ponto.points).toBeLessThanOrEqual(5);
  });

  it('o acumulado soma TODAS as classes do mesmo atleta', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);

    for (const [matricula, total] of Object.entries(ESPERADO)) {
      const soma = (await ledgerDe(matricula)).reduce((acc, p) => acc + p.points, 0);
      expect(soma, `matrícula ${matricula}`).toBe(total);
    }
  });

  it('Ranking.totalPoints é a soma do ledger, não um número paralelo', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);
    await api().post(`/api/v1/seasons/${seasonId}/ranking/recalculate`).set(gerente.auth()).send({});

    for (const linha of await prisma.ranking.findMany({ select: { athleteId: true, totalPoints: true, categoryId: true } })) {
      const pontos = await prisma.rankingPoint.findMany({
        where: { athleteId: linha.athleteId, ...(linha.categoryId ? { categoryId: linha.categoryId } : {}) },
        select: { points: true }
      });
      expect(linha.totalPoints).toBe(pontos.reduce((acc, p) => acc + p.points, 0));
    }
  });
});

describe('idempotência — aplicar de novo não pode somar de novo', () => {
  it('três aplicações do mesmo lote deixam o ledger idêntico', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);
    const depoisDaPrimeira = await ledgerDe('88281');

    await aplicar(body.import.id);
    await aplicar(body.import.id);

    const depoisDaTerceira = await ledgerDe('88281');
    expect(depoisDaTerceira).toHaveLength(depoisDaPrimeira.length);
    expect(depoisDaTerceira.reduce((a, p) => a + p.points, 0))
      .toBe(depoisDaPrimeira.reduce((a, p) => a + p.points, 0));
  });

  it('reimportar o MESMO arquivo reconhece as linhas como já aplicadas', async () => {
    const primeiro = await importar();
    await aplicar(primeiro.body.import.id);

    // Reexportação do mesmo arquivo: `Athlete #` poderia mudar, a chave não.
    const segundo = await importar();
    expect(segundo.body.summary.duplicates).toBe(LINHAS.length);
    expect(segundo.body.summary.recognized).toBe(0);
  });

  it('a chave derivada distingue as participações do mesmo atleta', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);

    // `RankingPoint.externalResultId` é a CHAVE ESTRANGEIRA para a linha de
    // origem; a chave do arquivo vive em `ExternalResult.externalId`. É o que
    // mantém o ledger rastreável até o arquivo sem copiar texto de origem
    // para dentro do ponto.
    const atleta = await prisma.athlete.findFirst({ where: { affiliationNumber: '88281' }, select: { id: true } });
    const origens = await prisma.externalResult.findMany({
      where: { athleteId: atleta.id }, select: { externalId: true }
    });
    const chaves = origens.map(o => o.externalId);

    expect(new Set(chaves).size).toBe(6);
    expect(chaves).toContain(`${PREFIXO}-88281-MEN_S_BODYBUILDING_NOVICE`);
    expect(chaves).toContain(`${PREFIXO}-88281-MEN_S_CLASSIC_PHYSIQUE_MASTERS_35`);
  });
});

describe('sem a declaração do operador o arquivo não entra', () => {
  it('sem prefixo, as linhas são recusadas em vez de importadas', async () => {
    const { body } = await importar({ externalIdPrefix: undefined });
    expect(body.summary.recognized).toBe(0);
    expect(body.summary.rejected).toBe(LINHAS.length);
  });

  it('sem filiação declarada, nada é reconhecido pela matrícula', async () => {
    const { body } = await importar({ defaultAffiliationCode: undefined });
    expect(body.summary.recognized).toBe(0);
  });
});

// ==========================================================================
// NS ATRAVESSANDO O CAMINHO INTEIRO.
//
// O adaptador já separa "não compareceu" de "colocação ilegível". Falta provar
// que a separação sobrevive ao resto: à análise, que recusava a linha; à
// gravação, que precisa lançar ZERO sem lançar colocação; e ao acumulado, que
// não pode mudar de valor por causa disso.
// ==========================================================================

describe('NS percorre a importação inteira como participação', () => {
  const COM_NS = [
    'Athlete #,Class,First Name,Last Name,Member Number,Placing',
    "1,Men's Bodybuilding - Novice,Yuri,Santinelli,88281,1",
    "2,Men's Bodybuilding - Open Class A,Yuri,Santinelli,88281,NS",
    "3,Men's Bodybuilding - Novice,Kananda,Dos Santos Azevedo,147986,2"
  ].join('\n');

  const importarNS = () => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('ns') + '.csv',
    content: COM_NS, externalIdPrefix: PREFIXO, defaultAffiliationCode: FILIACAO
  });

  it('a linha NS NÃO é recusada', async () => {
    const { body } = await importarNS();
    expect(body.summary.rejected).toBe(0);
    expect(body.summary.recognized).toBe(3);
  });

  it('a linha NS é gravada com zero, e sem colocação', async () => {
    const { body } = await importarNS();
    await aplicar(body.import.id);

    const ledger = await ledgerDe('88281');
    const ausencia = ledger.find(p => p.didNotShow);

    expect(ausencia).toBeDefined();
    expect(ausencia.points).toBe(0);
    expect(ausencia.placementPoints).toBe(0);
    // Zero NÃO é uma colocação. Gravar 0 aqui faria a linha disputar a tabela
    // de pontos como se fosse um lugar no pódio.
    expect(ausencia.placing).toBeNull();
    expect(ausencia.isOverallChampion).toBe(false);
  });

  it('a participação NS existe no histórico, em vez de sumir', async () => {
    const { body } = await importarNS();
    await aplicar(body.import.id);
    expect(await ledgerDe('88281')).toHaveLength(2);
  });

  it('o acumulado não muda por causa do NS', async () => {
    const { body } = await importarNS();
    await aplicar(body.import.id);
    const soma = (await ledgerDe('88281')).reduce((a, p) => a + p.points, 0);
    expect(soma).toBe(5);
  });

  it('a linha que participou de verdade não é marcada como ausência', async () => {
    const { body } = await importarNS();
    await aplicar(body.import.id);
    const primeira = (await ledgerDe('88281')).find(p => p.placing === 1);
    expect(primeira.didNotShow).toBe(false);
  });
});

describe('a categoria deixa de chegar nula', () => {
  it('cada ponto entra no recorte da sua categoria', async () => {
    const { body } = await importar();
    await aplicar(body.import.id);

    const pontos = await prisma.rankingPoint.findMany({
      select: { categoryId: true, category: { select: { code: true } } }
    });
    expect(pontos.length).toBeGreaterThan(0);
    for (const p of pontos) expect(p.categoryId).not.toBeNull();

    // O arquivo do teste só tem Bikini e Classic Physique.
    expect(new Set(pontos.map(p => p.category.code)))
      .toEqual(new Set(['MENS_BODYBUILDING', 'CLASSIC_PHYSIQUE', 'BIKINI']));
  });

  it('a revisão mostra divisão e classe separadas do texto de origem', async () => {
    const { body } = await importar();
    const previa = await api().get(`/api/v1/musclewar/imports/${body.import.id}`).set(gerente.auth());

    const masters = previa.body.items.find(i => i.className === "Men's Classic Physique - Masters 35+");
    expect(masters).toBeDefined();
    // As três leituras da mesma string, lado a lado na revisão.
    expect(masters.categoryCode).toBe('CLASSIC_PHYSIQUE');
    expect(masters.divisionName).toBe('Masters');
    expect(masters.classLabel).toBe('35+');
  });
});
