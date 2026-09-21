import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { vincularPendentesDoAtleta } = require('../src/services/muscleWarService.js');

// ============================================================================
// IDENTIDADE É ÚNICA; PONTUAÇÃO É MULTIDIMENSIONAL.
//
// A REGRA ESTRUTURAL DO MCI QUE ESTE ARQUIVO TRANCA
//
// O vínculo por CPF ou por filiação + matrícula responde UMA pergunta: de quem
// é este resultado. Ele NÃO responde a outra: em que categoria a pontuação
// entra. Essa vem do resultado original, e nada no caminho do vínculo pode
// tocá-la.
//
// O mesmo atleta compete em Classic Physique, Bodybuilding e Men's Physique no
// mesmo ano. O cadastro é um; os rankings são três. Somar os três e devolver o
// total dentro de uma delas seria dar ao atleta, em Classic Physique, pontos
// que ele ganhou subindo no palco de outra categoria — e o ranking daquela
// categoria deixaria de ser o que ela diz ser.
//
// POR QUE ISTO É UM ARQUIVO SEPARADO, E NÃO UMA ASSERÇÃO A MAIS
//
// A separação por categoria é invisível quando está certa: o número aparece no
// lugar certo e ninguém repara. Ela só se manifesta quando quebra, e quando
// quebra o resultado continua sendo um número plausível na tela. Defeito que
// não se anuncia precisa de teste que o procure de propósito.
// ============================================================================

// A tabela homologada: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1.
const PARTICIPACOES = [
  { categoria: 'CLASSIC_PHYSIQUE', classe: "Men's Classic Physique - Open Class A", colocacao: 1, pontos: 5 },
  { categoria: 'CLASSIC_PHYSIQUE', classe: "Men's Classic Physique - Open Class B", colocacao: 3, pontos: 3 },
  { categoria: 'MENS_BODYBUILDING', classe: "Men's Bodybuilding - Open Middleweight", colocacao: 1, pontos: 5 },
  { categoria: 'MENS_BODYBUILDING', classe: "Men's Bodybuilding - Open Heavyweight", colocacao: 4, pontos: 2 },
  { categoria: 'MENS_PHYSIQUE', classe: "Men's Physique - Open Class B", colocacao: 2, pontos: 4 }
];

const ESPERADO_POR_CATEGORIA = { CLASSIC_PHYSIQUE: 8, MENS_BODYBUILDING: 7, MENS_PHYSIQUE: 4 };
const TOTAL_GERAL = 19;

let admin, gerente, organizationId, npc, seasonId;

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,cpf,categoria,Placing';

const csv = linhas => [CABECALHO, ...linhas].join('\n');

const linhaDe = (p, i, { matricula, cpf }) =>
  `${i + 1},${p.classe},ATLETA,A,${matricula},${cpf},${p.categoria},${p.colocacao}`;

const importar = conteudo => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
  content: conteudo, externalIdPrefix: unico('CAT').toUpperCase(), defaultAffiliationCode: 'NPC'
});

const noLedger = consulta => comoAtor(gerente, consulta);

// A soma por categoria, lida do LEDGER. É a fonte da verdade: o ranking é
// projeção dela, e comparar projeção com projeção esconderia divergência.
async function pontosPorCategoria(filtro = {}) {
  const pontos = await noLedger(tx => tx.rankingPoint.findMany({
    where: { seasonId, ...filtro },
    select: { points: true, categoryId: true, athleteId: true, externalAthleteId: true }
  }));
  const categorias = await noLedger(tx => tx.category.findMany({ select: { id: true, code: true } }));
  const codigoDe = new Map(categorias.map(c => [c.id, c.code]));

  const soma = {};
  for (const ponto of pontos) {
    const codigo = codigoDe.get(ponto.categoryId) ?? '__sem_categoria__';
    soma[codigo] = (soma[codigo] ?? 0) + ponto.points;
  }
  return soma;
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

describe('§10 cinco participações, três categorias, um atleta', () => {
  it('cada categoria fica com os pontos que são dela — sem cadastro nenhum', async () => {
    const identidade = { matricula: 'NPC-4242', cpf: '' };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
      .set(gerente.auth());
    expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 400)).toBe(200);
    expect(aplicacao.body.applied).toBe(PARTICIPACOES.length);

    // AS CINCO LINHAS SÃO DA MESMA PESSOA: uma identidade externa só, porque a
    // matrícula é a mesma. É justamente o caso em que a fusão indevida
    // aconteceria.
    const identidades = await noLedger(tx => tx.externalAthlete.findMany());
    expect(identidades, 'mesma matrícula, uma identidade').toHaveLength(1);

    expect(await pontosPorCategoria()).toEqual(ESPERADO_POR_CATEGORIA);
  });

  it('o ranking devolve UMA linha por categoria, e não uma linha somada', async () => {
    const identidade = { matricula: 'NPC-4242', cpf: '' };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const linhas = await noLedger(tx => tx.ranking.findMany({
      where: { seasonId },
      select: { competitorKey: true, categoryId: true, totalPoints: true }
    }));

    // TRÊS linhas: uma por categoria. Uma linha só, com 19, seria o defeito.
    expect(linhas).toHaveLength(3);
    expect(new Set(linhas.map(l => l.competitorKey)).size, 'é a mesma pessoa nas três').toBe(1);
    expect([...new Set(linhas.map(l => l.categoryId))].length, 'três categorias distintas').toBe(3);
    expect(linhas.map(l => l.totalPoints).sort((a, b) => a - b)).toEqual([4, 7, 8]);
    expect(linhas.reduce((s, l) => s + l.totalPoints, 0), 'o total geral existe como soma').toBe(TOTAL_GERAL);

    // E NENHUMA linha carrega o total geral: 19 numa categoria é o defeito.
    expect(linhas.some(l => l.totalPoints === TOTAL_GERAL),
      'uma categoria recebeu o total geral').toBe(false);
  });
});

describe('§11 e §12 — o vínculo identifica, e não realoca', () => {
  async function medirAntesEDepois({ cpf, matricula, vincularPor }) {
    const identidade = { matricula, cpf };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const antes = await pontosPorCategoria();
    expect(antes).toEqual(ESPERADO_POR_CATEGORIA);

    const semDono = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: null } }));
    expect(semDono, 'os cinco entram sem dono').toBe(PARTICIPACOES.length);

    // O CADASTRO CHEGA DEPOIS.
    const atleta = await criarAtleta(admin, organizationId, {
      fullName: 'ATLETA A', cpf: vincularPor === 'CPF' ? cpf : gerarCpf(818181818),
      sex: 'MALE', birthDate: '1995-03-10',
      ...(vincularPor === 'MATRICULA' ? { affiliationId: npc.id, affiliationNumber: matricula } : {})
    });

    const efeito = await comoAtor(gerente, () => vincularPendentesDoAtleta({
      ...atleta, organizationId,
      affiliationId: vincularPor === 'MATRICULA' ? npc.id : null,
      affiliationNumber: vincularPor === 'MATRICULA' ? matricula : null
    }, { id: gerente.id }));

    expect(efeito.vinculados, `${vincularPor} devia alcançar as cinco`).toBe(PARTICIPACOES.length);

    const depois = await pontosPorCategoria();
    const doAtleta = await pontosPorCategoria({ athleteId: atleta.id });

    return { atleta, antes, depois, doAtleta };
  }

  it('vínculo por CPF: as cinco mudam de dono, nenhuma muda de categoria', async () => {
    const { atleta, antes, depois, doAtleta } = await medirAntesEDepois({
      cpf: gerarCpf(919191919), matricula: 'NPC-5151', vincularPor: 'CPF'
    });

    // A DISTRIBUIÇÃO POR CATEGORIA É IDÊNTICA ANTES E DEPOIS.
    expect(depois).toEqual(antes);
    // E agora ela é do atleta: as mesmas três categorias, os mesmos números.
    expect(doAtleta).toEqual(ESPERADO_POR_CATEGORIA);

    const semCategoria = await noLedger(tx => tx.rankingPoint.count({
      where: { seasonId, categoryId: null }
    }));
    expect(semCategoria, 'nenhum lançamento perdeu a categoria no caminho').toBe(0);

    const pontos = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: atleta.id } }));
    expect(pontos, 'cinco lançamentos, nem um a mais').toBe(PARTICIPACOES.length);
  });

  it('vínculo por filiação + matrícula: mesmo resultado, outra chave', async () => {
    const { atleta, antes, depois, doAtleta } = await medirAntesEDepois({
      cpf: '', matricula: 'NPC-6262', vincularPor: 'MATRICULA'
    });

    expect(depois).toEqual(antes);
    expect(doAtleta).toEqual(ESPERADO_POR_CATEGORIA);

    const pontos = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: atleta.id } }));
    expect(pontos).toBe(PARTICIPACOES.length);
  });

  it('depois do vínculo o ranking continua com três linhas, uma por categoria', async () => {
    const { atleta } = await medirAntesEDepois({
      cpf: gerarCpf(929292929), matricula: 'NPC-7373', vincularPor: 'CPF'
    });

    const linhas = await noLedger(tx => tx.ranking.findMany({
      where: { seasonId, athleteId: atleta.id },
      select: { categoryId: true, totalPoints: true }
    }));

    expect(linhas, 'três categorias, três linhas — o cadastro não as funde').toHaveLength(3);
    expect(linhas.map(l => l.totalPoints).sort((a, b) => a - b)).toEqual([4, 7, 8]);
    expect(linhas.some(l => l.totalPoints === TOTAL_GERAL)).toBe(false);
  });
});

describe('§13 cross-category: a agregação não pode esquecer a categoria', () => {
  it('o ranking público filtrado por categoria devolve SÓ aquela categoria', async () => {
    const identidade = { matricula: 'NPC-8484', cpf: gerarCpf(939393939) };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const categorias = await noLedger(tx => tx.category.findMany({ select: { id: true, code: true } }));
    const idDe = new Map(categorias.map(c => [c.code, c.id]));

    for (const [codigo, esperado] of Object.entries(ESPERADO_POR_CATEGORIA)) {
      const resposta = await api().get('/api/v1/ranking')
        .query({ seasonId, categoryId: idDe.get(codigo) });
      expect(resposta.status, codigo).toBe(200);

      const linhas = resposta.body.items;
      expect(linhas, `${codigo} devia ter uma linha`).toHaveLength(1);
      expect(linhas[0].totalPoints, `${codigo} devia somar ${esperado}`).toBe(esperado);
      // O TOTAL GERAL NUNCA APARECE DENTRO DE UMA CATEGORIA.
      expect(linhas[0].totalPoints, `${codigo} recebeu o total geral`).not.toBe(TOTAL_GERAL);
    }
  });

  it('sem filtro, o mesmo atleta aparece nas três — e isso é o correto', async () => {
    const identidade = { matricula: 'NPC-9595', cpf: gerarCpf(949494949) };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const resposta = await api().get('/api/v1/ranking').query({ seasonId });
    expect(resposta.status).toBe(200);

    // Três linhas para a mesma pessoa não é duplicação: é a mesma pessoa em
    // três competições diferentes. Deduplicar por atleta aqui apagaria duas
    // das três carreiras dela.
    expect(resposta.body.items).toHaveLength(3);
    expect(resposta.body.items.map(l => l.totalPoints).sort((a, b) => a - b)).toEqual([4, 7, 8]);
  });

  it('a projeção pública preserva a categoria em cada linha', async () => {
    const identidade = { matricula: 'NPC-1616', cpf: gerarCpf(959595959) };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const projecao = await noLedger(tx => tx.publicRankingEntry.findMany({
      where: { seasonId }, select: { categoryId: true, points: true, competitorKey: true }
    }));

    expect(projecao).toHaveLength(PARTICIPACOES.length);
    expect(projecao.every(l => l.categoryId !== null),
      'linha da projeção sem categoria não sabe a que ranking pertence').toBe(true);
    expect(new Set(projecao.map(l => l.categoryId)).size).toBe(3);
  });
});

// ------------------------------------------------------------------- §6
describe('§6 a área do atleta mostra o desempenho SEGMENTADO', () => {
  it('/me/history devolve uma linha por categoria, e o total como visão à parte', async () => {
    const cpf = gerarCpf(969696969);
    const identidade = { matricula: 'NPC-2727', cpf };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    // A pessoa se cadastra pela porta do interessado, e o vínculo acontece na
    // aprovação — é assim que ela chega à própria área.
    const pessoa = await criarUsuario({ name: 'ATLETA A' });
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'ATLETA A', cpf, sex: 'MALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: 'NPC-2727'
    });
    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 300)).toBe(201);
    const aprovado = await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`)
      .set(admin.auth()).send({});
    expect(aprovado.status, JSON.stringify(aprovado.body).slice(0, 300)).toBe(200);

    const historico = await api().get('/api/v1/me/history').set(pessoa.auth());
    expect(historico.status, JSON.stringify(historico.body).slice(0, 300)).toBe(200);

    const porCategoria = historico.body.byCategory;
    expect(porCategoria, 'a área do atleta precisa da visão por categoria').toBeTruthy();
    expect(porCategoria).toHaveLength(3);

    const soma = Object.fromEntries(porCategoria.map(l => [l.category.code, l.points]));
    expect(soma).toEqual(ESPERADO_POR_CATEGORIA);

    const participacoes = Object.fromEntries(
      porCategoria.map(l => [l.category.code, l.participations]));
    expect(participacoes).toEqual({
      CLASSIC_PHYSIQUE: 2, MENS_BODYBUILDING: 2, MENS_PHYSIQUE: 1
    });

    // O CONSOLIDADO EXISTE, E É OUTRA COISA. Ele soma as três; nenhuma das
    // três recebe o número dele.
    expect(historico.body.totals.points).toBe(TOTAL_GERAL);
    expect(historico.body.totals.participations).toBe(PARTICIPACOES.length);
    expect(porCategoria.some(l => l.points === TOTAL_GERAL),
      'uma categoria recebeu o total geral').toBe(false);

    // E a soma das categorias FECHA com o consolidado: se não fechasse, uma
    // das duas visões estaria mentindo.
    expect(porCategoria.reduce((s, l) => s + l.points, 0)).toBe(historico.body.totals.points);

    // Cada participação individual continua carregando a própria categoria —
    // a lista é o extrato, e extrato sem categoria não se confere.
    expect(historico.body.items).toHaveLength(PARTICIPACOES.length);
    expect(historico.body.items.every(i => i.category?.code), 'participação sem categoria').toBe(true);
  });

  it('a visão por categoria é ordenada por pontos, e é estável', async () => {
    const cpf = gerarCpf(979797979);
    const identidade = { matricula: 'NPC-3838', cpf };
    const lote = await importar(csv(PARTICIPACOES.map((p, i) => linhaDe(p, i, identidade))));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const pessoa = await criarUsuario({ name: 'ATLETA ORDENADA' });
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'ATLETA A', cpf, sex: 'MALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: 'NPC-3838'
    });
    await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`).set(admin.auth()).send({});

    const primeira = await api().get('/api/v1/me/history').set(pessoa.auth());
    const segunda = await api().get('/api/v1/me/history').set(pessoa.auth());

    expect(primeira.body.byCategory.map(l => l.points)).toEqual([8, 7, 4]);
    // Duas aberturas da mesma tela não podem trocar a ordem das categorias.
    expect(segunda.body.byCategory.map(l => l.category.code))
      .toEqual(primeira.body.byCategory.map(l => l.category.code));
  });

  it('atleta sem histórico recebe lista vazia, e não erro', async () => {
    const pessoa = await criarUsuario({ name: 'SEM HISTORICO' });
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'SEM HISTORICO', cpf: gerarCpf(987654321), sex: 'MALE',
      birthDate: '1995-03-10', affiliationId: npc.id, affiliationNumber: 'NPC-0001'
    });
    await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`).set(admin.auth()).send({});

    const historico = await api().get('/api/v1/me/history').set(pessoa.auth());
    expect(historico.status).toBe(200);
    expect(historico.body.byCategory).toEqual([]);
    expect(historico.body.totals.points).toBe(0);
  });
});
