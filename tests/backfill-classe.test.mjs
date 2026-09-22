import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O REPARO DOS HISTÓRICOS JÁ APLICADOS — CONTRA O SCRIPT DE VERDADE.
//
// Os 191 resultados do Ipiranga entraram no ledger ANTES de
// `RankingPoint.catalogClassId` existir. Não se reimporta, não se apaga e não
// se aplica de novo: a informação está gravada no `ExternalResult` daquele
// lançamento, e é de lá que o reparo parte.
//
// A CATEGORIA VEM DO `ExternalResult.categoryCode`, E NÃO DO LANÇAMENTO.
//
// Medido na base real da federação: os 191 estão com
// `RankingPoint.categoryId` NULO. A primeira versão do script lia essa coluna
// — e teria resolvido as 191 linhas como classe GENÉRICA da organização.
// "Masters 35+" de Bikini e "Masters 35+" de Men's Physique viravam A MESMA
// CLASSE, somando participações de categorias diferentes sob um rótulo que
// não é de nenhuma das duas.
//
// Por isso o cenário central deste arquivo tem `categoryId: null` em TODOS os
// lançamentos e `categoryCode` preenchido em todos: é o estado da produção, e
// é ele que separa o script certo do errado.
//
// Este arquivo executa o script COMO PROCESSO. Testar uma reimplementação
// provaria que a reimplementação funciona — o que vai rodar contra produção é
// o script.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

// O CENÁRIO DE REGRESSÃO PEDIDO NA HOMOLOGAÇÃO, e mais o par que prova a
// separação: "Masters 35+" aparece em BIKINI **e** em MENS_PHYSIQUE.
const LINHAS = [
  ['QA-B-1', 'BIKINI', "Women's Bikini - Masters 35+", 1],
  ['QA-B-2', 'MENS_PHYSIQUE', "Men's Physique - Masters 35+", 1],
  ['QA-B-3', 'MENS_PHYSIQUE', "Men's Physique - Open Class D", 2],
  ['QA-B-4', 'MENS_BODYBUILDING', "Men's Bodybuilding - Open Light Heavyweight", 3],
  ['QA-B-5', 'CLASSIC_PHYSIQUE', "Men's Classic Physique - True Novice", 1],
  ['QA-B-6', 'WELLNESS', "Women's Wellness - Masters 40+", 2]
];

const arquivo = () => [
  CABECALHO,
  ...LINHAS.map(([id, categoria, classe, colocacao], i) =>
    `${id},QA ATLETA ${i + 1},NPC,${id.replace('QA-B-', 'QA-M-')},${categoria},${classe},${colocacao},Etapa QA`)
].join('\n');

// O retrato COMPLETO do lançamento. A comparação antes/depois usa este objeto
// inteiro: enumerar só os campos que eu lembrar deixaria de fora justamente o
// que eu não pensei em proteger.
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

let admin;
let gerente;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

const rodar = (...args) => spawnSync('node', ['scripts/backfill-classe-do-catalogo.js', ...args], {
  cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 120000
});

const retrato = () => noLedger(tx => tx.rankingPoint.findMany({
  where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' }
}));

async function montarOrganizacao(nome) {
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

  const montada = await montarOrganizacao('MCI Brasil');
  organizationId = montada.organizationId;
  seasonId = montada.seasonId;

  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('backfill') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
});

// O ESTADO DA PRODUÇÃO, construído à mão: `catalogClassId` nulo porque a
// coluna não existia, e `categoryId` nulo — que é o que a base real tem, e o
// que a importação de hoje não produz mais. Sem desfazer as duas não há o que
// reparar, e o teste mediria o cenário errado.
async function voltarAoEstadoAnteriorAColuna() {
  await comoAtor(gerente, tx => tx.rankingPoint.updateMany({
    where: { seasonId }, data: { catalogClassId: null, categoryId: null }
  }));
}

const classeDe = async pontoId => noLedger(async tx => {
  const ponto = await tx.rankingPoint.findUnique({
    where: { id: pontoId },
    select: { catalogClass: { select: { code: true, displayName: true, categoryId: true, organizationId: true } } }
  });
  return ponto?.catalogClass ?? null;
});

const pontoDe = async externalId => noLedger(async tx => {
  const externo = await tx.externalResult.findFirst({ where: { externalId }, select: { id: true } });
  return tx.rankingPoint.findFirst({ where: { externalResultId: externo.id }, select: CAMPOS });
});

describe('a categoria vem do ExternalResult, e não do lançamento', () => {
  it('com categoryId NULO, a categoria ainda é resolvida — pelo código da origem', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const saida = rodar();
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);

    // O diagnóstico não pode mais dizer "(sem categoria)" quando o código
    // está lá para ser resolvido.
    // Por expressão, e não por espaçamento exato: o alinhamento do relatório
    // é apresentação, e prender o teste a ele faria uma mudança cosmética
    // reprovar um script correto.
    expect(saida.stdout).toMatch(/com categoria resolvida\s*\.+\s*6/);
    expect(saida.stdout).toMatch(/sem categoria resolvida\s*\.+\s*0/);
    expect(saida.stdout).not.toContain('(sem categoria)');
    expect(saida.stdout).toContain('BIKINI');
    expect(saida.stdout).toContain('MENS_PHYSIQUE');
  });

  it('BIKINI + Masters 35+ e MENS_PHYSIQUE + Masters 35+ viram DUAS classes distintas', async () => {
    await voltarAoEstadoAnteriorAColuna();
    expect(rodar('--aplicar').status).toBe(0);

    const bikini = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
    const mensPhysique = await prisma.category.findUnique({ where: { code: 'MENS_PHYSIQUE' } });

    const deBikini = await classeDe((await pontoDe('QA-B-1')).id);
    const deMensPhysique = await classeDe((await pontoDe('QA-B-2')).id);

    expect(deBikini.displayName).toBe('Masters 35+');
    expect(deMensPhysique.displayName).toBe('Masters 35+');

    // O MESMO TEXTO, DUAS CLASSES. É o que separa o recorte real do rótulo
    // solto: somá-las juntaria participações de categorias diferentes.
    expect(deBikini.categoryId).toBe(bikini.id);
    expect(deMensPhysique.categoryId).toBe(mensPhysique.id);
    expect(deBikini.categoryId).not.toBe(deMensPhysique.categoryId);

    // E nenhuma das duas é a genérica.
    expect(deBikini.categoryId).not.toBeNull();
    expect(deMensPhysique.categoryId).not.toBeNull();

    const masters35 = await noLedger(tx => tx.classCatalog.count({
      where: { organizationId, code: 'MASTERS_35' }
    }));
    expect(masters35, 'uma por categoria, nenhuma genérica').toBe(2);
  });

  it('cada exemplo da homologação resolve na categoria certa', async () => {
    await voltarAoEstadoAnteriorAColuna();
    expect(rodar('--aplicar').status).toBe(0);

    const esperado = [
      ['QA-B-3', 'MENS_PHYSIQUE', 'Open Class D', 'OPEN_CLASS_D'],
      ['QA-B-4', 'MENS_BODYBUILDING', 'Open Light Heavyweight', 'OPEN_LIGHT_HEAVYWEIGHT'],
      ['QA-B-5', 'CLASSIC_PHYSIQUE', 'True Novice', 'TRUE_NOVICE'],
      ['QA-B-6', 'WELLNESS', 'Masters 40+', 'MASTERS_40']
    ];

    for (const [externalId, codigoDaCategoria, exibicao, codigo] of esperado) {
      const categoria = await prisma.category.findUnique({ where: { code: codigoDaCategoria } });
      const classe = await classeDe((await pontoDe(externalId)).id);
      expect(classe, externalId).toBeTruthy();
      expect(classe.displayName, externalId).toBe(exibicao);
      expect(classe.code, externalId).toBe(codigo);
      expect(classe.categoryId, externalId).toBe(categoria.id);
      expect(classe.organizationId, externalId).toBe(organizationId);
    }
  });
});

describe('o que o backfill NÃO pode tocar', () => {
  it('nada além de catalogClassId muda — inclusive categoryId, que continua NULO', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const antes = await retrato();
    const externosAntes = await noLedger(tx => tx.externalResult.count());
    const pontosAntes = await noLedger(tx => tx.rankingPoint.count());
    const atletasAntes = await prisma.athlete.count();
    const titulosAntes = await noLedger(tx => tx.eventOverallTitle.count());

    expect(rodar('--aplicar').status).toBe(0);

    const depois = await retrato();

    expect(depois.length).toBe(antes.length);
    for (let i = 0; i < antes.length; i += 1) {
      // O RETRATO INTEIRO, menos a única coluna que o script pode escrever.
      expect({ ...depois[i], catalogClassId: null }, `lançamento ${antes[i].id}`).toEqual(antes[i]);
      expect(depois[i].catalogClassId, 'a classe foi preenchida').not.toBeNull();
      // Explícito, porque é a instrução que mais importa nesta fase.
      expect(depois[i].categoryId, 'categoryId NÃO é reconstruído aqui').toBeNull();
    }

    // Nada nasceu.
    expect(await noLedger(tx => tx.externalResult.count())).toBe(externosAntes);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(pontosAntes);
    expect(await prisma.athlete.count()).toBe(atletasAntes);
    expect(await noLedger(tx => tx.eventOverallTitle.count())).toBe(titulosAntes);
  });

  it('o ranking acumulado não muda por causa do backfill', async () => {
    await voltarAoEstadoAnteriorAColuna();
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    const antes = await noLedger(tx => tx.ranking.findMany({
      where: { seasonId },
      select: { competitorKey: true, totalPoints: true, eventCount: true, overallWins: true, position: true },
      orderBy: { competitorKey: 'asc' }
    }));

    expect(rodar('--aplicar').status).toBe(0);
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    const depois = await noLedger(tx => tx.ranking.findMany({
      where: { seasonId },
      select: { competitorKey: true, totalPoints: true, eventCount: true, overallWins: true, position: true },
      orderBy: { competitorKey: 'asc' }
    }));

    expect(depois).toEqual(antes);
  });
});

describe('o que não dá para resolver fica pendente, e aparece', () => {
  it('categoryCode fora do catálogo oficial vira CONFLITO, e a linha não é escrita', async () => {
    await voltarAoEstadoAnteriorAColuna();

    // A origem passa a declarar uma categoria que o MCI não conhece. O script
    // não inventa categoria — nem aqui, nem na importação.
    const alvo = await pontoDe('QA-B-1');
    await comoAtor(gerente, tx => tx.externalResult.update({
      where: { id: alvo.externalResultId }, data: { categoryCode: 'CATEGORIA_QUE_NAO_EXISTE' }
    }));

    const saida = rodar('--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('CONFLITOS DE CATEGORIA');
    expect(saida.stdout).toContain('CATEGORIA_QUE_NAO_EXISTE');

    expect((await pontoDe('QA-B-1')).catalogClassId, 'conflito não escreve').toBeNull();
    // E as outras cinco seguiram normalmente.
    expect((await pontoDe('QA-B-2')).catalogClassId).not.toBeNull();
  });

  it('sem código de categoria na origem, a linha NÃO cai na classe genérica', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const alvo = await pontoDe('QA-B-1');
    await comoAtor(gerente, tx => tx.externalResult.update({
      where: { id: alvo.externalResultId }, data: { categoryCode: null }
    }));

    const saida = rodar('--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('sem código de categoria na origem');

    // Resolver como genérica aqui apagaria o recorte que este trabalho existe
    // para criar. A linha fica pendente, que é o estado honesto.
    expect((await pontoDe('QA-B-1')).catalogClassId).toBeNull();
    const genericaMasters = await noLedger(tx => tx.classCatalog.findFirst({
      where: { organizationId, categoryId: null, code: 'MASTERS_35' }
    }));
    expect(genericaMasters, 'nenhuma classe genérica foi criada').toBeNull();
  });

  it('sem texto de classe a linha não é tocada', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const alvo = await pontoDe('QA-B-1');
    await comoAtor(gerente, tx => tx.externalResult.update({
      where: { id: alvo.externalResultId }, data: { className: null }
    }));

    const saida = rodar('--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('sem texto de classe');
    expect((await pontoDe('QA-B-1')).catalogClassId).toBeNull();
  });
});

describe('diagnóstico, idempotência, corrida e tenant', () => {
  it('sem --aplicar nada é escrito, e o relatório sai por categoria e classe', async () => {
    await voltarAoEstadoAnteriorAColuna();
    const antes = await retrato();

    const saida = rodar();
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('DIAGNÓSTICO');
    expect(saida.stdout).toContain('6 lançamentos SERIAM alterados');
    expect(saida.stdout).toContain('categoria | classe | quantidade');
    expect(saida.stdout).toMatch(/BIKINI\s+Masters 35\+\s+1/);
    expect(saida.stdout).toMatch(/MENS_PHYSIQUE\s+Open Class D\s+1/);

    expect(await retrato()).toEqual(antes);
  });

  it('rodar duas vezes não faz o trabalho duas vezes', async () => {
    await voltarAoEstadoAnteriorAColuna();

    expect(rodar('--aplicar').status).toBe(0);
    const depoisDaPrimeira = await retrato();
    const classesDepoisDaPrimeira = await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }));

    const segunda = rodar('--aplicar');
    expect(segunda.status).toBe(0);
    expect(segunda.stdout).toContain('0 lançamentos receberam a classe');

    expect(await retrato()).toEqual(depoisDaPrimeira);
    expect(await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }))).toBe(classesDepoisDaPrimeira);
  });

  it('classe já resolvida entre a leitura e a escrita NÃO é atropelada', async () => {
    await voltarAoEstadoAnteriorAColuna();

    // UMA LINHA QUE JÁ TEM CLASSE NÃO É REPROCESSADA.
    //
    // Este teste mede a porta de entrada: a consulta de pendentes filtra
    // `catalogClassId: null`, então a linha resolvida nem entra na lista.
    //
    // ELE NÃO MEDE o `catalogClassId: null` que também está no `where` da
    // escrita — e é honesto dizer isso. Aquela condição só tem efeito na
    // janela INTERNA de uma execução, entre a leitura da lista e a gravação,
    // e nenhum teste de fora abre essa janela de forma determinística. Ver a
    // classificação do mutante em scripts/qa/mutantes-backfill.mjs.
    const alvo = await pontoDe('QA-B-1');
    const outraClasse = await comoAtor(gerente, tx => tx.classCatalog.create({
      data: {
        organizationId, categoryId: null, code: 'RESOLVIDA_POR_OUTRO',
        name: 'Resolvida por outro', displayName: 'Resolvida por outro'
      }
    }));
    await comoAtor(gerente, tx => tx.rankingPoint.update({
      where: { id: alvo.id }, data: { catalogClassId: outraClasse.id }
    }));

    expect(rodar('--aplicar').status).toBe(0);

    // A linha que já tinha dono continua com o dono dela.
    expect((await pontoDe('QA-B-1')).catalogClassId).toBe(outraClasse.id);
    // E as outras cinco foram resolvidas normalmente.
    for (const externalId of ['QA-B-2', 'QA-B-3', 'QA-B-4', 'QA-B-5', 'QA-B-6']) {
      expect((await pontoDe(externalId)).catalogClassId, externalId).not.toBeNull();
      expect((await pontoDe(externalId)).catalogClassId, externalId).not.toBe(outraClasse.id);
    }
  });

  it('duas execuções simultâneas não geram erro nem classe duplicada', async () => {
    await voltarAoEstadoAnteriorAColuna();

    // A corrida real: os dois processos leem as mesmas linhas pendentes e
    // tentam criar as mesmas classes. Os índices parciais seguram a segunda
    // inserção, e a resolução relê em vez de estourar.
    const [a, b] = await Promise.all([
      new Promise(pronto => pronto(rodar('--aplicar'))),
      new Promise(pronto => pronto(rodar('--aplicar')))
    ]);

    expect(a.status, a.stderr?.slice(0, 300)).toBe(0);
    expect(b.status, b.stderr?.slice(0, 300)).toBe(0);

    const masters35 = await noLedger(tx => tx.classCatalog.count({ where: { organizationId, code: 'MASTERS_35' } }));
    expect(masters35, 'uma por categoria, sem duplicata').toBe(2);
    expect((await retrato()).every(p => p.catalogClassId !== null)).toBe(true);
  });

  it('o recorte por temporada não alcança outra temporada', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const outra = await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId, name: 'Temporada Vizinha', year: 2027 });

    const saida = rodar(`--temporada=${outra.body.id}`, '--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('0 lançamentos receberam a classe');

    expect(await noLedger(tx => tx.rankingPoint.count({ where: { seasonId, catalogClassId: null } }))).toBe(6);
  });

  it('a classe criada é da organização do lançamento, e de nenhuma outra', async () => {
    await voltarAoEstadoAnteriorAColuna();

    const vizinha = await montarOrganizacao('MCI Vizinha');
    expect(rodar('--aplicar').status).toBe(0);

    const criadas = await comoAtor(admin, tx => tx.classCatalog.findMany({
      where: { organizationId, categoryId: { not: null } }, select: { organizationId: true }
    }));
    expect(criadas.length).toBeGreaterThan(0);
    expect(criadas.every(c => c.organizationId === organizationId)).toBe(true);

    // A organização vizinha continua só com as quatro genéricas do nascimento.
    const daVizinha = await comoAtor(admin, tx => tx.classCatalog.findMany({
      where: { organizationId: vizinha.organizationId }, select: { code: true, categoryId: true }
    }));
    expect(daVizinha.map(c => c.code).sort()).toEqual(['ESTREANTE', 'MASTER', 'NOVICE', 'OPEN']);
    expect(daVizinha.every(c => c.categoryId === null)).toBe(true);
  });
});
