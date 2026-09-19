import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// OS DOIS CAMINHOS QUE AINDA CHEGAVAM AO LEDGER SEM CATEGORIA.
//
// `tests/categoria-nao-resolvida.test.mjs` trancou UM caminho: o arquivo
// declara uma classe e o mapa oficial não sabe de que categoria ela é. O
// mutation testing daquela guarda deixou dois mutantes VIVOS, e cada um
// apontava para um caminho que nenhum teste percorria:
//
//   #3  o arquivo traz uma coluna `category_code` EXPLÍCITA, com um código
//       que não existe no catálogo. A guarda por classe não alcança este
//       caso — `categoryCode` não é nulo, é errado.
//
//   #11 o arquivo NÃO TEM coluna Class. `className` e `categoryCode` nascem
//       os dois nulos, e a guarda por classe também não alcança: ela exigia
//       que houvesse classe declarada.
//
// MEDIDO ANTES DE ESCREVER ESTES TESTES, contra o código de então:
//
//   #3  já era CONFLICT ("Categoria desconhecida no MCI: ..."), apply 422,
//       zero RankingPoint. O produto estava certo; faltava o TESTE — por
//       isso o mutante sobrevivia: apagar a guarda não quebrava nada.
//
//   #11 MATCHED, apply 200, applied=1, e um RankingPoint gravado com
//       `categoryId: null` valendo 5 pontos. O produto estava ERRADO: era o
//       mesmo defeito silencioso da guarda original, por outra porta.
//
// Então #11 não se fecha escrevendo teste: a guarda passou a valer para
// QUALQUER linha sem categoria resolvida, e não só para as que declararam
// classe. O motivo distingue os dois casos, porque a correção que o operador
// precisa fazer é diferente em cada um.
//
// Um caminho continua sendo rejeição, e não conflito: arquivo sem Class E sem
// identificador externo morre antes, na guarda de idempotência. Está coberto
// abaixo para que a diferença fique registrada, e não descoberta de novo.
// ==========================================================================

const COM_CATEGORIA = 'Athlete #,Class,Category,First Name,Last Name,Member Number,Placing';
const SEM_CLASSE = 'Athlete #,external_result_id,Category,First Name,Last Name,Member Number,Placing';
const SEM_CLASSE_SEM_ID = 'Athlete #,First Name,Last Name,Member Number,Placing';

const OFICIAL_BB = "Men's Bodybuilding - Open Middleweight";
const INEXISTENTE = 'CATEGORIA_INEXISTENTE';

let admin, operador, org, filiacao, season, evento, categoriaBB;

const juntar = (cabecalho, linhas) => [cabecalho, ...linhas].join('\n');
// Coluna Category vazia = "o arquivo não informou"; o código cai para o que a
// classe disser, que é o comportamento dos arquivos oficiais.
const comCategoria = (n, classe, categoria, matricula, colocacao) =>
  `${n},${classe},${categoria},Atleta,Sobrenome,${matricula},${colocacao}`;
const semClasse = (n, idExterno, categoria, matricula, colocacao) =>
  `${n},${idExterno},${categoria},Atleta,Sobrenome,${matricula},${colocacao}`;

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
  select: { id: true, categoryId: true, placing: true, points: true, athleteId: true,
            superOverallEligible: true, externalResultId: true }
}));

// `appliedAt` separa o que de fato entrou do que só foi registrado como linha
// do lote: conferir só a contagem de ExternalResult confundiria os dois.
const externosAplicados = async () => (await comoAtor(admin, tx => tx.externalResult.findMany({
  select: { id: true, externalId: true, appliedAt: true }
}))).filter(linha => linha.appliedAt != null);

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

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Cat2' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Cat2' })).id;

  operador = await criarUsuario({ name: 'Operador Cat2' });
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
    organizationId: org, name: 'Etapa Cat2', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  categoriaBB = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
});

// ==========================================================================
// MUTANTE #3 — o arquivo DIZ a categoria, e ela não está no catálogo.
// ==========================================================================
describe('category_code explícito que não pertence ao catálogo', () => {
  it('vira CONFLITO, e o motivo nomeia o código recusado', async () => {
    await criarAtleta('ATLETA UM', '88281', 901);
    const lote = (await criarLote(juntar(COM_CATEGORIA, [
      comCategoria(1, OFICIAL_BB, INEXISTENTE, '88281', 1)
    ]))).body.import;

    const r = await previa(lote.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary.conflicts).toBe(1);
    expect(r.body.summary.recognized, 'não pode ficar pronta para aplicar').toBe(0);

    const [item] = r.body.items;
    expect(item.matchStatus).toBe('CONFLICT');
    // O código recusado tem de aparecer no motivo: é o que o operador vai
    // procurar na planilha de origem, ou cadastrar no MCI.
    expect(item.reason, `motivo ilegível: ${item.reason}`).toContain(INEXISTENTE);
    expect(item.reason).toMatch(/categoria/i);
    // E a classe do arquivo era VÁLIDA — a recusa é da categoria explícita,
    // não da classe. Confundir as duas mandaria o operador corrigir a coluna
    // errada.
    expect(item.className).toBe(OFICIAL_BB);
  }, 60_000);

  it('não aplica nada: nenhum RankingPoint, nenhum ExternalResult aplicado', async () => {
    await criarAtleta('ATLETA UM', '88281', 902);
    const lote = (await criarLote(juntar(COM_CATEGORIA, [
      comCategoria(1, OFICIAL_BB, INEXISTENTE, '88281', 1)
    ]))).body.import;

    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(422);
    expect(aplicacao.body.error.code).toBe('NOTHING_TO_APPLY');

    expect(await pontos(), 'ledger intocado').toHaveLength(0);
    expect(await externosAplicados(), 'nada aplicado').toHaveLength(0);
  }, 60_000);

  it('o MESMO código, agora existente no catálogo, segue o caminho normal', async () => {
    await criarAtleta('ATLETA UM', '88281', 903);
    const lote = (await criarLote(juntar(COM_CATEGORIA, [
      comCategoria(1, OFICIAL_BB, 'MENS_BODYBUILDING', '88281', 1)
    ]))).body.import;

    const r = await previa(lote.id);
    expect(r.body.summary.conflicts, 'categoria conhecida não é conflito').toBe(0);
    expect(r.body.summary.recognized).toBe(1);

    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const [ponto] = await pontos();
    expect(ponto.categoryId, 'a categoria explícita é a que vale').toBe(categoriaBB.id);
    expect(ponto.points).toBe(5);
  }, 60_000);

  it('reimportar o arquivo recusado continua não criando nada', async () => {
    await criarAtleta('ATLETA UM', '88281', 904);
    const conteudo = juntar(COM_CATEGORIA, [comCategoria(1, OFICIAL_BB, INEXISTENTE, '88281', 1)]);

    for (const tentativa of [1, 2]) {
      const lote = (await criarLote(conteudo)).body.import;
      const aplicacao = await aplicar(lote.id);
      expect(aplicacao.status, `tentativa ${tentativa}: ${JSON.stringify(aplicacao.body)}`).toBe(422);
      expect(await pontos(), `tentativa ${tentativa} sujou o ledger`).toHaveLength(0);
      expect(await externosAplicados(), `tentativa ${tentativa} aplicou algo`).toHaveLength(0);
    }
  }, 90_000);
});

// ==========================================================================
// MUTANTE #11 — o arquivo NÃO TEM coluna Class.
// ==========================================================================
describe('arquivo sem a coluna Class', () => {
  it('sem classe e sem categoria, a linha vira CONFLITO', async () => {
    await criarAtleta('ATLETA DOIS', '88282', 911);
    const lote = (await criarLote(juntar(SEM_CLASSE, [
      semClasse(1, 'QA-SEM-CLASSE-1', '', '88282', 1)
    ]))).body.import;

    const r = await previa(lote.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary.conflicts, 'linha sem categoria não pode passar').toBe(1);
    expect(r.body.summary.recognized).toBe(0);

    const [item] = r.body.items;
    expect(item.className, 'o arquivo realmente não trouxe classe').toBeNull();
    expect(item.categoryCode).toBeNull();
    expect(item.matchStatus).toBe('CONFLICT');
    // O motivo precisa dizer que o ARQUIVO não informou — é diferente de
    // "informou e o MCI não reconheceu", e a correção também é outra.
    expect(item.reason, `motivo ilegível: ${item.reason}`).toMatch(/categoria/i);
    expect(item.reason).toMatch(/não informou|sem classe|não declarou/i);
  }, 60_000);

  it('nada entra no ledger, e nenhum lançamento nasce sem categoria', async () => {
    await criarAtleta('ATLETA DOIS', '88282', 912);
    const lote = (await criarLote(juntar(SEM_CLASSE, [
      semClasse(1, 'QA-SEM-CLASSE-1', '', '88282', 1)
    ]))).body.import;

    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(422);
    expect(aplicacao.body.error.code).toBe('NOTHING_TO_APPLY');

    expect(await pontos(), 'ledger intocado').toHaveLength(0);
    expect(await externosAplicados()).toHaveLength(0);
  }, 60_000);

  it('reimportar o mesmo arquivo sem classe continua não criando nada', async () => {
    await criarAtleta('ATLETA DOIS', '88282', 913);
    const conteudo = juntar(SEM_CLASSE, [semClasse(1, 'QA-SEM-CLASSE-1', '', '88282', 1)]);

    for (const tentativa of [1, 2]) {
      const lote = (await criarLote(conteudo)).body.import;
      const aplicacao = await aplicar(lote.id);
      expect(aplicacao.status, `tentativa ${tentativa}: ${JSON.stringify(aplicacao.body)}`).toBe(422);
      expect(await pontos(), `tentativa ${tentativa} sujou o ledger`).toHaveLength(0);
      expect(await externosAplicados(), `tentativa ${tentativa} aplicou algo`).toHaveLength(0);
    }
  }, 90_000);

  it('sem Class mas COM category_code válido, a linha entra normalmente', async () => {
    // A classe não é o único caminho oficial até a categoria: declarar a
    // categoria resolve. O que a guarda recusa é a AUSÊNCIA dos dois, não a
    // ausência da coluna Class.
    await criarAtleta('ATLETA TRES', '88283', 914);
    const lote = (await criarLote(juntar(SEM_CLASSE, [
      semClasse(1, 'QA-SEM-CLASSE-2', 'MENS_BODYBUILDING', '88283', 1)
    ]))).body.import;

    const r = await previa(lote.id);
    expect(r.body.summary.conflicts, JSON.stringify(r.body.items[0]?.reason)).toBe(0);
    expect(r.body.summary.recognized).toBe(1);

    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const [ponto] = await pontos();
    expect(ponto.categoryId).toBe(categoriaBB.id);
    // Sem classe não há como afirmar elegibilidade à absoluta, e afirmar por
    // omissão daria +10 a quem não disputou a absoluta.
    expect(ponto.superOverallEligible, 'sem classe não há absoluta a afirmar').toBe(false);
  }, 60_000);

  it('sem Class e sem identificador externo, a recusa é a de idempotência', async () => {
    // Registra a ordem real das guardas: sem `external_result_id` a linha
    // morre antes de chegar à categoria. Não é conflito, é rejeição — e
    // confundir os dois faria o operador procurar a coluna errada.
    await criarAtleta('ATLETA QUATRO', '88284', 915);
    const lote = (await criarLote(juntar(SEM_CLASSE_SEM_ID, [
      '1,Atleta,Sobrenome,88284,1'
    ]))).body.import;

    const r = await previa(lote.id);
    expect(r.body.summary.rejected).toBe(1);
    expect(r.body.items[0].matchStatus).toBe('IMPORT_REJECTED');
    expect(r.body.items[0].reason).toMatch(/identificador externo/i);
    expect(await pontos()).toHaveLength(0);
  }, 60_000);
});

// ==========================================================================
// ARQUIVO MISTO — uma linha ruim não pode derrubar as boas, nem passar junto.
// ==========================================================================
describe('190 linhas válidas e 1 com categoria inexistente', () => {
  it('as 190 entram; a inválida fica em conflito e não vira ponto', async () => {
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
      await criarAtleta(`ATLETA ${a}`, matricula, 920 + a);
      for (const classe of CLASSES) {
        n += 1;
        // Coluna Category em branco: quem resolve é a classe, como nos
        // arquivos oficiais.
        linhas.push(comCategoria(n, classe, '', matricula, (n % 5) + 1));
      }
    }
    expect(linhas).toHaveLength(190);

    await criarAtleta('ATLETA RUIM', '99999', 949);
    linhas.push(comCategoria(191, OFICIAL_BB, INEXISTENTE, '99999', 1));

    const lote = (await criarLote(juntar(COM_CATEGORIA, linhas))).body.import;

    const antes = await previa(lote.id);
    expect(antes.body.summary.totalRecords).toBe(191);
    expect(antes.body.summary.conflicts, 'só a linha ruim').toBe(1);
    expect(antes.body.summary.recognized, 'as 190 seguem prontas').toBe(190);

    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
    expect(aplicacao.body.applied).toBe(190);

    const gravados = await pontos();
    expect(gravados).toHaveLength(190);
    expect(gravados.filter(p => !p.categoryId), 'nenhum lançamento sem categoria')
      .toHaveLength(0);
  }, 180_000);
});
