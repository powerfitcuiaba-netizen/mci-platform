import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// CATEGORIA QUE NÃO RESOLVE NÃO PODE ENTRAR CALADA.
//
// O importador já recusa categoria DESCONHECIDA: quando o arquivo declara um
// código que não está no catálogo, a linha vira CONFLICT e o operador decide.
// Só que essa guarda é condicionada ao código EXISTIR:
//
//     if (registro.categoryCode) {          // <- nulo pula a guarda inteira
//       if (!categoriasConhecidas.has(...)) return CONFLICT;
//     }
//
// E `categoryCode` nasce nulo sempre que o adaptador não consegue mapear o
// texto da classe — porque o mapa de categorias é EXPLÍCITO e homologado, e
// não adivinha. "Classic Physique - Open" não é o oficial "Men's Classic
// Physique - Open", então não casa, e o código sai nulo.
//
// O efeito é o pior tipo: silencioso e em cascata.
//
//   1. a linha atravessa a revisão parecendo normal;
//   2. entra no ledger com `categoryId` em branco;
//   3. meses depois a organização declara o Overall daquela categoria, e o
//      +10 não encontra linha onde pousar. Paga ZERO. Ninguém é avisado.
//
// Medido no arquivo REAL do Ipiranga: 191 de 191 linhas resolvem a categoria,
// então o campeonato de agora não é atingido. O que estes testes trancam é o
// dia em que uma categoria nova, uma grafia diferente ou uma falha de catálogo
// aparecerem — e aí a diferença entre conflito e silêncio decide se alguém vê.
//
// A REGRA: o arquivo declarou uma classe e o sistema não sabe de que categoria
// ela é? CONFLITO, com motivo legível. Nunca escolher por aproximação, nunca
// chutar, nunca aplicar com o recorte em branco.
// ==========================================================================

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';

// Classes OFICIAIS, exatamente como saem do sistema de origem.
const OFICIAL_BB_OPEN = "Men's Bodybuilding - Open Middleweight";
const OFICIAL_CP_OPEN = "Men's Classic Physique - Open Class A";
const OFICIAL_BB_NOVICE = "Men's Bodybuilding - Novice";

// A MESMA classe acima, com o nome da categoria escrito de forma não oficial:
// falta o "Men's". O adaptador não mapeia, e é exatamente aqui que o código
// saía nulo e a linha passava.
const DESCONHECIDA = 'Classic Physique - Open Class A';

let admin, operador, org, filiacao, season, evento, categoriaBB, categoriaCP;

const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = (n, classe, matricula, colocacao) =>
  `${n},${classe},Atleta,Sobrenome,${matricula},${colocacao}`;

const criarLote = conteudo => api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
  organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
  sourceRef: unico('etapa') + '.csv', content: conteudo,
  externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
  defaultAffiliationCode: 'NPC'
});

const previa = (loteId, params = {}) =>
  api().get(`/api/v1/musclewar/imports/${loteId}`).set(operador.auth()).query({ limit: 500, ...params });

const aplicar = loteId =>
  api().post(`/api/v1/musclewar/imports/${loteId}/apply`).set(operador.auth()).send({});

const pontos = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
  select: { id: true, categoryId: true, placing: true, points: true, overallBonus: true,
            athleteId: true, superOverallEligible: true, externalResultId: true }
}));

const externos = () => comoAtor(admin, tx => tx.externalResult.findMany({
  select: { id: true, externalId: true, className: true, appliedAt: true }
}));

const criarAtleta = (nome, matricula, semente) => comoAtor(operador, tx => tx.athlete.create({
  data: {
    organizationId: org, fullName: nome, sex: 'MALE',
    affiliationId: filiacao.id, affiliationNumber: matricula,
    identity: { create: { organizationId: org, cpf: gerarCpf(semente) } }
  }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Cat' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Cat' })).id;

  operador = await criarUsuario({ name: 'Operador Cat' });
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

  evento = (await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: 'Etapa Cat', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  categoriaBB = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
  categoriaCP = await prisma.category.findUnique({ where: { code: 'CLASSIC_PHYSIQUE' } });
});

describe('classe cuja categoria o sistema não resolve', () => {
  it('vira CONFLITO na prévia, com motivo que o operador entende', async () => {
    await criarAtleta('ATLETA UM', '88281', 501);
    const lote = (await criarLote(csv([linha(1, DESCONHECIDA, '88281', 1)]))).body.import;

    const r = await previa(lote.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary.conflicts, 'a linha tinha de estar em conflito').toBe(1);
    expect(r.body.summary.recognized, 'e NÃO reconhecida como pronta para aplicar').toBe(0);

    const [item] = r.body.items;
    expect(item.matchStatus).toBe('CONFLICT');
    // O motivo precisa nomear a CLASSE do arquivo: é o único dado que o
    // operador tem em mãos para achar a linha na planilha de origem.
    expect(item.reason, `motivo ilegivel: ${item.reason}`).toMatch(/categoria/i);
    expect(item.reason).toContain(DESCONHECIDA);
  }, 60_000);

  it('não é aplicada: nenhum RankingPoint, nenhum ExternalResult aplicado', async () => {
    await criarAtleta('ATLETA UM', '88281', 502);
    const lote = (await criarLote(csv([linha(1, DESCONHECIDA, '88281', 1)]))).body.import;

    // O lote inteiro é a linha em conflito, então não sobra nada reconhecido
    // para aplicar — e a plataforma RECUSA, em vez de responder 200 com zero
    // aplicados. É guarda antiga e é a resposta certa: um 200 silencioso
    // deixaria o operador achar que a importação correu bem.
    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(422);
    expect(aplicacao.body.error.code).toBe('NOTHING_TO_APPLY');

    expect(await pontos(), 'ledger intocado').toHaveLength(0);
    // ExternalResult é o registro de "isto entrou". Se a linha não entrou, ele
    // não pode existir — senão a idempotência passaria a recusar a reimportação
    // da MESMA linha depois que o operador corrigisse a classe.
    expect((await externos()).filter(e => e.appliedAt), 'nenhum resultado externo aplicado')
      .toHaveLength(0);
  }, 60_000);

  it('o diagnóstico sobrevive à aplicação: a linha continua em conflito, com motivo', async () => {
    await criarAtleta('ATLETA UM', '88281', 503);
    const lote = (await criarLote(csv([linha(1, DESCONHECIDA, '88281', 1)]))).body.import;
    await aplicar(lote.id);

    const r = await previa(lote.id);
    expect(r.body.summary.conflicts).toBe(1);
    expect(r.body.summary.applied).toBe(0);
    expect(r.body.items[0].reason).toContain(DESCONHECIDA);
  }, 60_000);
});

describe('uma linha ruim não derruba o lote', () => {
  it('190 classes válidas + 1 desconhecida: 190 aplicam, 1 fica em conflito', async () => {
    // Dez atletas em dezenove classes oficiais produzem 190 linhas com chave
    // externa única (prefixo + matrícula + classe), sem inventar gente.
    const CLASSES = [
      "Men's Bodybuilding - Open Middleweight", "Men's Bodybuilding - Open Heavyweight",
      "Men's Bodybuilding - Novice", "Men's Bodybuilding - True Novice",
      "Men's Bodybuilding - Masters 35+", "Men's Classic Physique - Open Class A",
      "Men's Classic Physique - Open Class B", "Men's Classic Physique - Novice",
      "Men's Physique - Open Class A", "Men's Physique - Open Class D",
      "Men's Physique - Masters 35+", "Women's Bikini - Open Class A",
      "Women's Bikini - Novice", "Women's Figure - Open Class A",
      "Women's Fit Model - Open Class B", "Women's Physique - Open Class A",
      "Women's Wellness - Open Class A", "Women's Wellness - Novice",
      "Men's Bodybuilding - Junior"
    ];
    expect(CLASSES).toHaveLength(19);

    const linhas = [];
    let n = 0;
    for (let a = 0; a < 10; a += 1) {
      const matricula = String(90000 + a);
      await criarAtleta(`ATLETA ${a}`, matricula, 600 + a);
      for (const classe of CLASSES) {
        n += 1;
        linhas.push(linha(n, classe, matricula, (n % 5) + 1));
      }
    }
    expect(linhas).toHaveLength(190);

    await criarAtleta('ATLETA RUIM', '99999', 699);
    linhas.push(linha(191, DESCONHECIDA, '99999', 1));

    const lote = (await criarLote(csv(linhas))).body.import;

    const antes = await previa(lote.id);
    expect(antes.body.summary.totalRecords).toBe(191);
    expect(antes.body.summary.conflicts, 'só a linha ruim').toBe(1);
    expect(antes.body.summary.recognized, 'as outras 190 seguem prontas').toBe(190);

    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status).toBe(200);
    expect(aplicacao.body.applied, 'as 190 boas entram').toBe(190);

    const gravados = await pontos();
    expect(gravados).toHaveLength(190);
    expect(gravados.filter(p => !p.categoryId), 'nenhum lançamento sem categoria')
      .toHaveLength(0);
  }, 180_000);
});

describe('corrigir a classe destrava a linha', () => {
  it('com o nome oficial, o conflito zera e o lançamento nasce com categoria', async () => {
    await criarAtleta('ATLETA UM', '88281', 701);

    const ruim = (await criarLote(csv([linha(1, DESCONHECIDA, '88281', 1)]))).body.import;
    expect((await previa(ruim.id)).body.summary.conflicts).toBe(1);

    // O operador corrige a classe na origem e reimporta. Não há remendo no
    // MCI: o arquivo passa a dizer a verdade.
    const bom = (await criarLote(csv([linha(1, OFICIAL_CP_OPEN, '88281', 1)]))).body.import;
    const depois = await previa(bom.id);
    expect(depois.body.summary.conflicts, 'conflito tem de zerar').toBe(0);
    expect(depois.body.summary.recognized).toBe(1);

    expect((await aplicar(bom.id)).body.applied).toBe(1);

    const [ponto] = await pontos();
    expect(ponto.categoryId, 'categoria resolvida').toBe(categoriaCP.id);
    expect(ponto.placing).toBe(1);
    expect(ponto.points).toBe(5);
    expect(ponto.superOverallEligible, 'Open é elegível ao Super Overall').toBe(true);
  }, 60_000);
});

describe('Overall sobre resultado importado, com a categoria certa', () => {
  const inscreverNaAbsoluta = async (categoria, athleteId) => {
    const ec = (await api().post(`/api/v1/events/${evento.id}/categories`).set(operador.auth())
      .send({ categoryId: categoria.id })).body;
    const div = (await api().post(`/api/v1/event-categories/${ec.id}/divisions`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN' })).body;
    const classe = (await api().post(`/api/v1/divisions/${div.id}/classes`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;
    await comoAtor(operador, tx => tx.registration.create({
      data: {
        eventId: evento.id, athleteId, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    }));
  };

  it('Open 1º importado passa de 5 para 15 quando o título é declarado', async () => {
    const atleta = await criarAtleta('ATLETA OVERALL', '88281', 801);
    const lote = (await criarLote(csv([linha(1, OFICIAL_BB_OPEN, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    expect((await pontos())[0].points).toBe(5);

    await inscreverNaAbsoluta(categoriaBB, atleta.id);
    const decl = await api().post(`/api/v1/events/${evento.id}/overall`).set(operador.auth())
      .send({ athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(decl.status, JSON.stringify(decl.body)).toBe(201);

    const [depois] = await pontos();
    expect(depois.overallBonus, 'o +10 CHEGOU ao lançamento importado').toBe(10);
    expect(depois.points).toBe(15);
  }, 60_000);

  it('classe não elegível não recebe Overall, mesmo com título declarado', async () => {
    const atleta = await criarAtleta('ATLETA NOVICE', '88282', 802);
    const lote = (await criarLote(csv([linha(1, OFICIAL_BB_NOVICE, '88282', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const [antes] = await pontos();
    expect(antes.superOverallEligible, 'Novice não é absoluta').toBe(false);

    // Sem participação em classe absoluta, a própria declaração é recusada —
    // o Overall é título da absoluta, e isso não muda aqui.
    const decl = await api().post(`/api/v1/events/${evento.id}/overall`).set(operador.auth())
      .send({ athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(decl.status).toBeGreaterThanOrEqual(400);

    const [depois] = await pontos();
    expect(depois.overallBonus).toBe(0);
    expect(depois.points).toBe(5);
  }, 60_000);
});
