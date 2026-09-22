import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// CATEGORIA E CLASSE SÃO DUAS COISAS.
//
// "Women's Physique - Masters 35+" é UMA categoria (Women's Physique) com UMA
// classe dentro dela (Masters 35+). Nunca uma categoria nova chamada
// "WOMENS_PHYSIQUE_MASTERS_35", e nunca "Geral".
//
// O adaptador já separava as três partes corretamente. O que faltava era ONDE
// GUARDAR a classe resolvida: `RankingPoint.classId` aponta para
// `CompetitionClass`, que só existe por divisão DE UM EVENTO do MCI, e
// resultado histórico importado não tem evento do MCI. A coluna nascia nula e
// o recorte por classe nunca devolveu uma linha importada.
//
// Este arquivo mede a taxonomia inteira contra a plataforma real: a
// resolução, a idempotência, a precedência da classe específica sobre a
// genérica, o isolamento entre organizações, e — a asserção que não pode
// ceder — que NADA DISSO MUDOU UM PONTO SEQUER.
//
// OS DADOS SÃO DE QA. A distribuição por categoria reproduz a de uma etapa
// real (191 linhas), porque o volume e o formato importam; os nomes começam
// com "QA" e não há um único dado de pessoa de verdade aqui. O arquivo
// oficial não está versionado e não deve estar: este repositório é público.
// ============================================================================

const TOTAL = 191;

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';

// A distribuição por categoria da etapa real. A soma é 191 — conferida pelo
// próprio teste, para que ninguém edite a tabela e desencontre o total.
const DISTRIBUICAO = [
  { code: 'BIKINI', origem: "Women's Bikini", total: 34, classes: ['Open Class A', 'Open Class B', 'Masters 35+'] },
  { code: 'CLASSIC_PHYSIQUE', origem: "Men's Classic Physique", total: 36, classes: ['Open Class A', 'Open Class B', 'Novice'] },
  { code: 'FIGURE', origem: "Women's Figure", total: 6, classes: ['Open'] },
  { code: 'FITMODEL', origem: "Women's Fit Model", total: 12, classes: ['Open Class A', 'Masters 40+'] },
  { code: 'MENS_BODYBUILDING', origem: "Men's Bodybuilding", total: 36, classes: ['Open Middleweight', 'Open Light Heavyweight', 'Open Heavyweight'] },
  { code: 'MENS_PHYSIQUE', origem: "Men's Physique", total: 44, classes: ['Open Class A', 'Open Class B', 'True Novice', 'Masters 35+'] },
  { code: 'WELLNESS', origem: "Women's Wellness", total: 20, classes: ['Open Class A', 'Novice'] },
  { code: 'WOMENS_PHYSIQUE', origem: "Women's Physique", total: 3, classes: ['Masters 35+'] }
];

// A TABELA HOMOLOGADA, escrita aqui uma vez: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1,
// 6º em diante 0, e não comparecimento 0. É contra ela que o antes/depois da
// pontuação é conferido.
const pontosDaColocacao = colocacao => (colocacao == null ? 0 : ({ 1: 5, 2: 4, 3: 3, 4: 2, 5: 1 }[colocacao] ?? 0));

// Uma linha por competidor, com matrícula própria: cada linha é uma
// identidade externa distinta, que é como a etapa real se comporta.
function linhasDaEtapa() {
  const linhas = [];
  let n = 0;
  for (const categoria of DISTRIBUICAO) {
    const porClasse = new Map(categoria.classes.map(classe => [classe, 0]));
    for (let i = 0; i < categoria.total; i += 1) {
      const classe = categoria.classes[i % categoria.classes.length];
      const dentroDaClasse = porClasse.get(classe);
      porClasse.set(classe, dentroDaClasse + 1);
      n += 1;
      linhas.push({
        n,
        categoryCode: categoria.code,
        classeDeExibicao: classe,
        className: `${categoria.origem} - ${classe}`,
        // A última de cada classe vai como NS: ausência é participação e vale
        // zero, e o arquivo não opina sobre isso.
        placing: dentroDaClasse + 1 === categoria.total / categoria.classes.length ? null : dentroDaClasse + 1,
        memberNumber: `QA-${200000 + n}`
      });
    }
  }
  return linhas;
}

function arquivoDaEtapa(linhas) {
  return [CABECALHO, ...linhas.map(linha => [
    linha.n, linha.className, `QA${linha.n}`, 'DA SILVA SANTOS', linha.memberNumber,
    'Brazil', 25, 1, '90.0', linha.placing ?? 'NS'
  ].join(','))].join('\n');
}

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacaoId;

const noLedger = consulta => comoAtor(gerente, consulta);

async function montarTemporada(nomeDaOrg) {
  const org = await criarOrganizacao(admin, { name: nomeDaOrg });
  const filiacao = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org.id, name: `NPC ${nomeDaOrg}`, code: unico('NPC').slice(0, 12).toUpperCase() });

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: 'Temporada QA 2026', year: 2026 });

  await api().put(`/api/v1/seasons/${temporada.body.id}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  return { organizationId: org.id, seasonId: temporada.body.id, affiliationId: filiacao.body.id };
}

async function importarEAplicar(ator, orgId, temporadaId, conteudo, prefixo = 'QA-TAXONOMIA') {
  const lote = await api().post('/api/v1/musclewar/imports').set(ator.auth()).send({
    organizationId: orgId, seasonId: temporadaId, sourceType: 'CSV',
    sourceRef: unico('etapa-taxonomia') + '.csv',
    content: conteudo, externalIdPrefix: prefixo
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(ator.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 400)).toBe(200);
  return { lote: lote.body, aplicacao: aplicacao.body };
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  const montada = await montarTemporada('MCI Brasil');
  organizationId = montada.organizationId;
  seasonId = montada.seasonId;
  filiacaoId = montada.affiliationId;

  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');
});

describe('GATE 1 — as quatro classes genéricas continuam sendo o que eram', () => {
  it('nascem com categoria NULA e a importação não as toca', async () => {
    const antes = await noLedger(tx => tx.classCatalog.findMany({
      where: { organizationId },
      select: { code: true, name: true, superOverallEligible: true, active: true, sortOrder: true, categoryId: true },
      orderBy: { code: 'asc' }
    }));

    expect(antes.map(c => c.code)).toEqual(['ESTREANTE', 'MASTER', 'NOVICE', 'OPEN']);
    expect(antes.every(c => c.categoryId === null), 'genérica é categoria nula').toBe(true);
    // A REGRA HOMOLOGADA, intacta: só a OPEN alimenta o Super Overall.
    expect(antes.filter(c => c.superOverallEligible).map(c => c.code)).toEqual(['OPEN']);

    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const depois = await noLedger(tx => tx.classCatalog.findMany({
      where: { organizationId, code: { in: ['ESTREANTE', 'MASTER', 'NOVICE', 'OPEN'] }, categoryId: null },
      select: { code: true, name: true, superOverallEligible: true, active: true, sortOrder: true, categoryId: true },
      orderBy: { code: 'asc' }
    }));

    // Não apagadas, não recriadas, não duplicadas, não alteradas.
    expect(depois).toEqual(antes);
  });
});

describe('GATE 2 — a unicidade são DUAS regras, e as duas existem no banco', () => {
  it('os dois índices parciais estão no banco, e não só na migration', async () => {
    const indices = await prisma.$queryRawUnsafe(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'ClassCatalog' ORDER BY indexname"
    );
    const nomes = indices.map(i => i.indexname);

    // Índice que só existe no SQL some sem aviso no primeiro `db push`.
    expect(nomes, 'uma genérica por (organização, código)').toContain('ClassCatalog_generica');
    expect(nomes, 'uma por (organização, categoria, código)').toContain('ClassCatalog_especifica');
    // E o antigo, que impediria OPEN de duas categorias, saiu.
    expect(nomes).not.toContain('ClassCatalog_organizationId_code_key');
  });

  it('OPEN genérica e OPEN de duas categorias convivem; a duplicata genérica é recusada', async () => {
    const categorias = await prisma.category.findMany({
      where: { code: { in: ['WOMENS_PHYSIQUE', 'MENS_PHYSIQUE'] } }, select: { id: true, code: true }
    });
    const wp = categorias.find(c => c.code === 'WOMENS_PHYSIQUE');
    const mp = categorias.find(c => c.code === 'MENS_PHYSIQUE');

    // As três combinações do GATE 2, todas válidas e todas diferentes.
    await comoAtor(gerente, tx => tx.classCatalog.create({
      data: { organizationId, categoryId: wp.id, code: 'OPEN', name: 'Open', displayName: 'Open' }
    }));
    await comoAtor(gerente, tx => tx.classCatalog.create({
      data: { organizationId, categoryId: mp.id, code: 'OPEN', name: 'Open', displayName: 'Open' }
    }));

    const abertas = await noLedger(tx => tx.classCatalog.count({ where: { organizationId, code: 'OPEN' } }));
    expect(abertas, 'a genérica mais as duas de categoria').toBe(3);

    // E a duplicata que o UNIQUE simples deixaria passar:
    await expect(comoAtor(gerente, tx => tx.classCatalog.create({
      data: { organizationId, categoryId: null, code: 'OPEN', name: 'Open de novo' }
    }))).rejects.toThrow();

    await expect(comoAtor(gerente, tx => tx.classCatalog.create({
      data: { organizationId, categoryId: wp.id, code: 'OPEN', name: 'Open de novo' }
    }))).rejects.toThrow();
  });
});

describe('GATE 4 e 7 — "Women\'s Physique - Masters 35+" vira categoria MAIS classe', () => {
  it('a categoria é WOMENS_PHYSIQUE e a classe é Masters 35+, com código MASTERS_35', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const categoria = await prisma.category.findUnique({ where: { code: 'WOMENS_PHYSIQUE' } });
    expect(categoria, 'a categoria do catálogo oficial').toBeTruthy();

    const classe = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: categoria.id, code: 'MASTERS_35' }
    }));

    expect(classe, 'a classe foi criada dentro da categoria').toBeTruthy();
    // GATE 3: o texto da origem sobrevive inteiro, com o "+".
    expect(classe.displayName).toBe('Masters 35+');
    // GATE 4: o código é identidade técnica, e não é o que a tela mostra.
    expect(classe.code).toBe('MASTERS_35');
    // Elegibilidade NÃO é inventada aqui: só a OPEN alimenta o Super Overall.
    expect(classe.superOverallEligible).toBe(false);

    // A ASSERÇÃO CENTRAL DESTA FASE: nenhuma categoria composta foi criada.
    const inventadas = await prisma.category.findMany({
      where: { OR: [{ code: { contains: 'MASTERS' } }, { code: { contains: '_35' } }] }
    });
    expect(inventadas, 'WOMENS_PHYSIQUE_MASTERS_35 não existe').toEqual([]);
  });

  it('cada forma do arquivo vira o código previsto', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const catalogo = await noLedger(tx => tx.classCatalog.findMany({ where: { organizationId } }));
    const porNome = new Map(catalogo.map(c => [c.displayName ?? c.name, c.code]));

    expect(porNome.get('Masters 35+')).toBe('MASTERS_35');
    expect(porNome.get('Masters 40+')).toBe('MASTERS_40');
    expect(porNome.get('Open Class A')).toBe('OPEN_CLASS_A');
    expect(porNome.get('Open Class B')).toBe('OPEN_CLASS_B');
    expect(porNome.get('Open Middleweight')).toBe('OPEN_MIDDLEWEIGHT');
    expect(porNome.get('Open Light Heavyweight')).toBe('OPEN_LIGHT_HEAVYWEIGHT');
    expect(porNome.get('Open Heavyweight')).toBe('OPEN_HEAVYWEIGHT');
    expect(porNome.get('True Novice')).toBe('TRUE_NOVICE');
  });
});

describe('GATE 5 — resolver a mesma classe duas vezes não cria duas classes', () => {
  it('reimportar as mesmas classes não acrescenta uma linha ao catálogo', async () => {
    const linhas = linhasDaEtapa();
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhas), 'QA-PRIMEIRA');

    const depoisDaPrimeira = await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }));

    // Mesmas classes, competidores diferentes: só o que é classe se repete.
    const outras = linhas.map(linha => ({ ...linha, memberNumber: `QA-9${linha.memberNumber.slice(3)}` }));
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(outras), 'QA-SEGUNDA');

    const depoisDaSegunda = await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }));
    expect(depoisDaSegunda, 'idempotente: nenhuma classe nova').toBe(depoisDaPrimeira);
  });
});

describe('GATE 6 — a classe da categoria ganha da genérica, sempre', () => {
  it('havendo OPEN da categoria e OPEN genérica, o resultado recebe a da categoria', async () => {
    const figure = await prisma.category.findUnique({ where: { code: 'FIGURE' } });

    const especifica = await comoAtor(gerente, tx => tx.classCatalog.create({
      data: { organizationId, categoryId: figure.id, code: 'OPEN', name: 'Open', displayName: 'Open' }
    }));
    const generica = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: null, code: 'OPEN' }
    }));
    expect(generica, 'a genérica continua existindo').toBeTruthy();

    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const pontosDeFigure = await noLedger(tx => tx.rankingPoint.findMany({
      where: { seasonId, categoryId: figure.id }, select: { catalogClassId: true }
    }));

    expect(pontosDeFigure.length, 'Figure tem resultado na etapa').toBeGreaterThan(0);
    // Sem ambiguidade: todas apontam para a específica, nenhuma para a genérica.
    expect(pontosDeFigure.every(p => p.catalogClassId === especifica.id)).toBe(true);
    expect(pontosDeFigure.some(p => p.catalogClassId === generica.id)).toBe(false);
  });
});

describe('GATE 9, 14 e 16 — a etapa inteira, com a pontuação intocada', () => {
  it('191 linhas: distribuição por categoria, classe em todas, e ZERO atleta criado', async () => {
    const linhas = linhasDaEtapa();
    expect(linhas.length, 'a tabela de distribuição soma 191').toBe(TOTAL);
    expect(await prisma.athlete.count()).toBe(0);

    const { aplicacao } = await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhas));
    expect(aplicacao.applied).toBe(TOTAL);

    // ZERO ATLETAS CRIADOS: a asserção que não pode ceder.
    expect(await prisma.athlete.count()).toBe(0);

    const pontos = await noLedger(tx => tx.rankingPoint.findMany({
      where: { seasonId },
      select: {
        placing: true, points: true, didNotShow: true, athleteId: true,
        categoryId: true, catalogClassId: true,
        category: { select: { code: true } },
        catalogClass: { select: { code: true, name: true, displayName: true, categoryId: true } }
      }
    }));

    expect(pontos.length).toBe(TOTAL);

    // GATE 14: nenhum tem dono, e mesmo assim TODOS têm categoria e classe.
    expect(pontos.every(p => p.athleteId === null), 'histórico antes do cadastro').toBe(true);
    expect(pontos.every(p => p.categoryId !== null), 'nenhum ponto sem categoria').toBe(true);
    expect(pontos.every(p => p.catalogClassId !== null), 'nenhum ponto sem classe').toBe(true);

    // GATE 16: a distribuição por categoria, exatamente a esperada.
    const porCategoria = {};
    for (const ponto of pontos) porCategoria[ponto.category.code] = (porCategoria[ponto.category.code] ?? 0) + 1;
    expect(porCategoria).toEqual(Object.fromEntries(DISTRIBUICAO.map(c => [c.code, c.total])));

    // GATE 9: a pontuação é função da COLOCAÇÃO, e de mais nada.
    const divergentes = pontos.filter(p => p.points !== pontosDaColocacao(p.didNotShow ? null : p.placing));
    expect(divergentes, `${divergentes.length} lançamentos fora da tabela homologada`).toEqual([]);

    // O RECORTE categoria + classe, CONFERIDO — e não impresso.
    //
    // A primeira versão deste bloco imprimia a tabela categoria | classe |
    // quantidade | colocações | pontos. Relatório em log não é garantia: ele
    // passa igual com o número certo e com o número errado, e ninguém lê a
    // saída de uma suíte verde. Quem precisa do relatório é
    // `scripts/backfill-classe-do-catalogo.js`, que o imprime por categoria e
    // por classe — lá ele serve para decidir, aqui ele só ocuparia espaço.
    //
    // O que vale é a conferência: cada par (categoria, classe) tem linhas, as
    // quantidades somam 191, e a pontuação de cada grupo é a soma da tabela
    // homologada aplicada às colocações daquele grupo.
    const relatorio = new Map();
    for (const ponto of pontos) {
      const chave = `${ponto.category.code} | ${ponto.catalogClass.displayName ?? ponto.catalogClass.name}`;
      if (!relatorio.has(chave)) relatorio.set(chave, { quantidade: 0, esperado: 0, pontos: 0 });
      const linha = relatorio.get(chave);
      linha.quantidade += 1;
      linha.esperado += pontosDaColocacao(ponto.didNotShow ? null : ponto.placing);
      linha.pontos += ponto.points;
    }

    expect(relatorio.size, 'há grupos categoria+classe').toBeGreaterThan(0);
    expect([...relatorio.values()].every(l => l.quantidade > 0)).toBe(true);
    expect([...relatorio.values()].reduce((s, l) => s + l.quantidade, 0)).toBe(TOTAL);

    const gruposErrados = [...relatorio.entries()].filter(([, l]) => l.pontos !== l.esperado);
    expect(gruposErrados, `${gruposErrados.length} grupos com soma fora da tabela homologada`).toEqual([]);
  });

  it('o histórico sem atleta aparece no ranking, com categoria — nunca como "Geral" de zero ponto', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    const categoria = await prisma.category.findUnique({ where: { code: 'WOMENS_PHYSIQUE' } });
    const classe = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: categoria.id, code: 'MASTERS_35' }
    }));

    const resposta = await api().get('/api/v1/ranking')
      .query({ seasonId, categoryId: categoria.id, catalogClassId: classe.id });

    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
    expect(resposta.body.items.length, 'o recorte devolve competidores').toBeGreaterThan(0);

    const comPontos = resposta.body.items.filter(linha => linha.totalPoints > 0);
    expect(comPontos.length, 'e eles pontuam').toBeGreaterThan(0);

    // NUNCA "Geral": a categoria do recorte viaja na linha.
    expect(resposta.body.items.every(linha => linha.category?.code === 'WOMENS_PHYSIQUE')).toBe(true);
    // E o competidor sem cadastro tem nome e não tem id de perfil.
    expect(resposta.body.items.every(linha => Boolean(linha.athlete?.fullName))).toBe(true);
  });
});

describe('GATE 11 — o recorte é EXATAMENTE categoria mais classe, e nada além', () => {
  it('a classe recorta de verdade: Open Middleweight devolve a classe, não a categoria inteira', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    const categoria = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
    const classe = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: categoria.id, code: 'OPEN_MIDDLEWEIGHT' }
    }));

    // AUTENTICADO, de propósito: a vista pública mostra só o TOP 5, e contar
    // 12 contra 36 num teto de 5 não mediria recorte nenhum.
    const recorte = await api().get('/api/v1/ranking').set(gerente.auth())
      .query({ seasonId, categoryId: categoria.id, catalogClassId: classe.id, limit: 100 });
    const categoriaInteira = await api().get('/api/v1/ranking').set(gerente.auth())
      .query({ seasonId, categoryId: categoria.id, limit: 100 });

    expect(recorte.status).toBe(200);
    // Uma das três classes da categoria: 12 de 36. Se o filtro de classe for
    // ignorado, este número vira 36 — e é exatamente isso que o mutante
    // "ignorar classe" faz.
    expect(recorte.body.items.length).toBe(12);
    expect(categoriaInteira.body.items.length).toBe(36);
  });

  it('a categoria recorta de verdade: a classe genérica não mistura duas categorias', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    // NOVICE é genérica (categoria nula) e aparece em duas categorias do
    // arquivo: Classic Physique (12) e Wellness (10). Recortar por Wellness
    // tem de devolver 10 — 22 significaria que a categoria foi ignorada.
    const novice = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: null, code: 'NOVICE' }
    }));
    const wellness = await prisma.category.findUnique({ where: { code: 'WELLNESS' } });
    const classic = await prisma.category.findUnique({ where: { code: 'CLASSIC_PHYSIQUE' } });

    const porWellness = await api().get('/api/v1/ranking').set(gerente.auth())
      .query({ seasonId, categoryId: wellness.id, catalogClassId: novice.id, limit: 100 });
    const porClassic = await api().get('/api/v1/ranking').set(gerente.auth())
      .query({ seasonId, categoryId: classic.id, catalogClassId: novice.id, limit: 100 });

    expect(porWellness.status, JSON.stringify(porWellness.body).slice(0, 300)).toBe(200);
    expect(porWellness.body.items.length).toBe(10);
    expect(porClassic.body.items.length).toBe(12);
  });
});

describe('GATE 11 e 12 — o filtro é dinâmico e recusa o cruzamento incoerente', () => {
  it('as classes do filtro vêm do servidor, com displayName, recortadas pela categoria', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const categoria = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
    const resposta = await api().get('/api/v1/ranking/classes').query({ seasonId, categoryId: categoria.id });

    expect(resposta.status).toBe(200);
    const nomes = resposta.body.items.map(c => c.displayName);

    expect(nomes).toContain('Open Middleweight');
    expect(nomes).toContain('Open Light Heavyweight');
    expect(nomes).toContain('Open Heavyweight');
    // A genérica entra em toda categoria: é o que "vale para todas" significa.
    expect(resposta.body.items.some(c => c.code === 'OPEN' && c.categoryId === null)).toBe(true);
    // E a classe de OUTRA categoria não entra.
    expect(nomes).not.toContain('Masters 40+');
  });

  it('uma classe de Women\'s Physique não recorta Figure', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const wp = await prisma.category.findUnique({ where: { code: 'WOMENS_PHYSIQUE' } });
    const figure = await prisma.category.findUnique({ where: { code: 'FIGURE' } });
    const classeDeWp = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: wp.id, code: 'MASTERS_35' }
    }));

    const resposta = await api().get('/api/v1/ranking')
      .query({ seasonId, categoryId: figure.id, catalogClassId: classeDeWp.id });

    // 422 explícito, e não uma lista vazia que a tela leria como
    // "ninguém pontuou".
    expect(resposta.status).toBe(422);
    expect(resposta.body.error.code).toBe('CLASS_CATEGORY_MISMATCH');
  });
});

describe('GATE 15 — vincular o atleta depois não move pontuação nem classe', () => {
  it('athleteId muda; categoria, classe, colocação e pontos não, e nenhum lançamento novo nasce', async () => {
    const linhas = linhasDaEtapa();
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhas));

    const alvo = linhas.find(linha => linha.categoryCode === 'WOMENS_PHYSIQUE' && linha.placing === 1);
    expect(alvo, 'há uma linha de Women\'s Physique com 1º lugar').toBeTruthy();

    // O lançamento é alcançado pela LINHA DO ARQUIVO, e não por uma chave de
    // identidade montada aqui: a chave é detalhe interno do importador, e
    // reconstruí-la no teste mediria o teste, não o produto.
    const item = await noLedger(tx => tx.muscleWarImportItem.findFirst({
      where: { memberNumber: alvo.memberNumber },
      select: { id: true, externalResultId: true }
    }));
    expect(item, 'a linha do arquivo virou item de lote').toBeTruthy();

    const externo = await noLedger(tx => tx.externalResult.findFirst({
      where: { importItemId: item.id }, select: { id: true }
    }));
    expect(externo, 'o resultado externo foi gravado').toBeTruthy();

    const antes = await noLedger(tx => tx.rankingPoint.findFirst({
      where: { seasonId, externalResultId: externo.id },
      select: {
        id: true, athleteId: true, categoryId: true, catalogClassId: true,
        placing: true, points: true, superOverallPoints: true, eventId: true,
        seasonId: true, organizationId: true
      }
    }));
    expect(antes, 'o lançamento existe').toBeTruthy();
    expect(antes.athleteId).toBeNull();
    expect(antes.points).toBe(5);

    const totalAntes = await noLedger(tx => tx.rankingPoint.count({ where: { seasonId } }));

    // O cadastro chega DEPOIS, pela mesma matrícula do arquivo.
    const criado = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: `QA${alvo.n} DA SILVA SANTOS`, cpf: gerarCpf(515151517),
      sex: 'FEMALE', birthDate: '1990-03-03',
      affiliationId: filiacaoId, affiliationNumber: alvo.memberNumber
    });
    expect(criado.status, JSON.stringify(criado.body).slice(0, 300)).toBe(201);

    const depois = await noLedger(tx => tx.rankingPoint.findUnique({
      where: { id: antes.id },
      select: {
        id: true, athleteId: true, categoryId: true, catalogClassId: true,
        placing: true, points: true, superOverallPoints: true, eventId: true,
        seasonId: true, organizationId: true
      }
    }));

    // A ÚNICA coisa que muda é o dono.
    expect(depois.athleteId, 'o lançamento ganhou dono').toBe(criado.body.id ?? criado.body.athlete?.id);
    expect({ ...depois, athleteId: null }).toEqual({ ...antes, athleteId: null });

    // E nenhum lançamento novo nasceu.
    expect(await noLedger(tx => tx.rankingPoint.count({ where: { seasonId } }))).toBe(totalAntes);
  });
});

describe('GATE 17 — classe de outra organização não recorta este ranking', () => {
  it('o id de uma classe de outra organização responde 404, e não a lista inteira', async () => {
    await importarEAplicar(gerente, organizationId, seasonId, arquivoDaEtapa(linhasDaEtapa()));

    const outra = await montarTemporada('MCI Vizinha');
    const wp = await prisma.category.findUnique({ where: { code: 'WOMENS_PHYSIQUE' } });

    const classeDaOutra = await comoAtor(admin, tx => tx.classCatalog.create({
      data: { organizationId: outra.organizationId, categoryId: wp.id, code: 'MASTERS_35', name: 'Masters 35+', displayName: 'Masters 35+' }
    }));

    const resposta = await api().get('/api/v1/ranking')
      .query({ seasonId, categoryId: wp.id, catalogClassId: classeDaOutra.id });

    expect(resposta.status).toBe(404);
    expect(resposta.body.error.code).toBe('CLASS_NOT_FOUND');
  });

  it('o catálogo de uma organização não é editável por quem não é operador dela', async () => {
    const outra = await montarTemporada('MCI Terceira');

    const resposta = await api().post('/api/v1/classes-catalog').set(gerente.auth()).send({
      organizationId: outra.organizationId, code: 'INVASORA', name: 'Invasora'
    });

    expect([401, 403, 404]).toContain(resposta.status);
    const criadas = await comoAtor(admin, tx => tx.classCatalog.count({
      where: { organizationId: outra.organizationId, code: 'INVASORA' }
    }));
    expect(criadas).toBe(0);
  });
});
