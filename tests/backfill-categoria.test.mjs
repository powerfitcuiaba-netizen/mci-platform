import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// A CATEGORIA DOS LANÇAMENTOS HISTÓRICOS — CONTRA O SCRIPT DE VERDADE.
//
// Os 191 do Ipiranga entraram contra um catálogo de categorias VAZIO: a
// resolução por código devolveu null e `categoryId` nasceu NULO nas 191. O
// catálogo já foi provisionado e a classe já foi reconstituída; falta a
// categoria do lançamento.
//
// O caminho é um só, e é exato:
//     ExternalResult.categoryCode -> Category.code -> Category.id
//
// O cenário central deste arquivo é o estado da produção: `categoryId` NULO em
// todos os lançamentos e `catalogClassId` PREENCHIDO em todos. A classe não
// pode ser tocada por esta correção, e é isso que o retrato completo mede.
//
// Este arquivo executa o script COMO PROCESSO. Testar uma reimplementação
// provaria que a reimplementação funciona — o que vai rodar contra produção é
// o script.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

// "Masters 35+" aparece em BIKINI **e** em MENS_PHYSIQUE de propósito: é o par
// que prova que a categoria sai do CÓDIGO da origem, e não do nome da classe.
const LINHAS = [
  ['QA-K-1', 'BIKINI', "Women's Bikini - Masters 35+", 1],
  ['QA-K-2', 'MENS_PHYSIQUE', "Men's Physique - Masters 35+", 1],
  ['QA-K-3', 'MENS_PHYSIQUE', "Men's Physique - Open Class D", 2],
  ['QA-K-4', 'MENS_BODYBUILDING', "Men's Bodybuilding - Open Light Heavyweight", 3],
  ['QA-K-5', 'CLASSIC_PHYSIQUE', "Men's Classic Physique - True Novice", 1],
  ['QA-K-6', 'WELLNESS', "Women's Wellness - Masters 40+", 2]
];

const arquivo = () => [
  CABECALHO,
  ...LINHAS.map(([id, categoria, classe, colocacao], i) =>
    `${id},QA ATLETA ${i + 1},NPC,${id.replace('QA-K-', 'QA-N-')},${categoria},${classe},${colocacao},Etapa QA`)
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

const rodar = (...args) => spawnSync('node', ['scripts/backfill-categoria-do-lancamento.js', ...args], {
  cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 120000
});

const retrato = (recorte = { seasonId }) => noLedger(tx => tx.rankingPoint.findMany({
  where: recorte, select: CAMPOS, orderBy: { id: 'asc' }
}));

async function montarOrganizacao(nome) {
  const org = await criarOrganizacao(admin, { name: nome });
  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org.id, name: `NPC ${nome}`, code: unico('NPC').slice(0, 12).toUpperCase() });
  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org.id, name: `Temporada ${nome}`, year: 2026 });
  return { organizationId: org.id, seasonId: temporada.body.id };
}

async function importarEAplicar(alvo, conteudo) {
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId: alvo.organizationId, seasonId: alvo.seasonId, sourceType: 'CSV',
    sourceRef: unico('categoria') + '.csv', content: conteudo
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
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

  await importarEAplicar({ organizationId, seasonId }, arquivo());
});

// O ESTADO DA PRODUÇÃO, construído à mão: `categoryId` NULO porque a
// importação rodou contra catálogo vazio, e `catalogClassId` PREENCHIDO porque
// o backfill da classe já passou. É exatamente a base da federação hoje.
async function estadoDaProducao() {
  await comoAtor(gerente, tx => tx.rankingPoint.updateMany({
    where: { seasonId }, data: { categoryId: null }
  }));
  const pontos = await retrato();
  expect(pontos.length).toBe(6);
  expect(pontos.every(p => p.categoryId === null), 'categoryId nulo em todos').toBe(true);
  expect(pontos.every(p => p.catalogClassId !== null), 'catalogClassId preenchido em todos').toBe(true);
}

const externoDe = externalId => comoAtor(admin, tx =>
  tx.externalResult.findFirst({ where: { externalId }, select: { id: true } }));

describe('a auditoria não escreve, e diz exatamente o que faria', () => {
  it('relata total, resolvidos, não resolvidos, conflitos e quantidade por categoria', async () => {
    await estadoDaProducao();
    const antes = await retrato();

    const saida = rodar();
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);

    // Por expressão, e não por espaçamento exato: o alinhamento do relatório é
    // apresentação, e prender o teste a ele faria uma mudança cosmética
    // reprovar um script correto.
    expect(saida.stdout).toMatch(/total analisado\s*\.+\s*6/);
    expect(saida.stdout).toMatch(/resolvidos\s*\.+\s*6/);
    expect(saida.stdout).toMatch(/não resolvidos\s*\.+\s*0/);
    expect(saida.stdout).toMatch(/conflitos\s*\.+\s*0/);
    // Cinco categorias distintas em seis linhas: MENS_PHYSIQUE aparece duas vezes.
    expect(saida.stdout).toMatch(/categorias encontradas\s*\.+\s*5/);
    expect(saida.stdout).toMatch(/com classe do catálogo\s*\.+\s*6/);
    expect(saida.stdout).toMatch(/BIKINI\s+1/);
    expect(saida.stdout).toMatch(/MENS_PHYSIQUE\s+2/);
    expect(saida.stdout).toContain('AUDITORIA — nada foi escrito');

    // E não escreveu mesmo.
    expect(await retrato()).toEqual(antes);
  });
});

describe('a aplicação resolve pela origem, e não toca em mais nada', () => {
  it('preenche categoryId 6/6 pelo código do arquivo', async () => {
    await estadoDaProducao();

    const saida = rodar('--aplicar');
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);
    expect(saida.stdout).toMatch(/APLICADO\. 6 lançamentos receberam a categoria/);
    expect(saida.stdout).toMatch(/ainda sem categoria\s*\.+\s*0/);

    const pontos = await noLedger(tx => tx.rankingPoint.findMany({
      where: { seasonId },
      select: { externalResult: { select: { externalId: true, categoryCode: true } }, category: { select: { code: true } } }
    }));

    expect(pontos.length).toBe(6);
    expect(pontos.every(p => p.category !== null), 'nenhum lançamento sem categoria').toBe(true);
    // A categoria gravada é EXATAMENTE a que o arquivo declarou, linha a linha.
    for (const ponto of pontos) {
      expect(ponto.category.code).toBe(ponto.externalResult.categoryCode);
    }
  });

  it('a MESMA classe em categorias diferentes vai para categorias diferentes', async () => {
    // Se a categoria fosse deduzida do nome da classe, estas duas linhas
    // — "Masters 35+" em Bikini e "Masters 35+" em Men's Physique — cairiam
    // na mesma categoria. É o erro que esta correção não pode cometer.
    await estadoDaProducao();
    expect(rodar('--aplicar').status).toBe(0);

    const bikini = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
    const mensPhysique = await prisma.category.findUnique({ where: { code: 'MENS_PHYSIQUE' } });

    const categoriaDe = async externalId => {
      const externo = await externoDe(externalId);
      const ponto = await noLedger(tx => tx.rankingPoint.findFirst({
        where: { externalResultId: externo.id }, select: { categoryId: true, catalogClass: { select: { displayName: true } } }
      }));
      return ponto;
    };

    const um = await categoriaDe('QA-K-1');
    const dois = await categoriaDe('QA-K-2');

    expect(um.catalogClass.displayName).toBe('Masters 35+');
    expect(dois.catalogClass.displayName).toBe('Masters 35+');
    expect(um.categoryId).toBe(bikini.id);
    expect(dois.categoryId).toBe(mensPhysique.id);
    expect(um.categoryId).not.toBe(dois.categoryId);
  });

  it('o retrato do lançamento sai idêntico, menos categoryId', async () => {
    await estadoDaProducao();
    const antes = await retrato();

    expect(rodar('--aplicar').status).toBe(0);
    const depois = await retrato();

    expect(depois.length).toBe(antes.length);
    for (let i = 0; i < antes.length; i += 1) {
      // categoryId é o ÚNICO campo autorizado a mudar. Comparar o resto campo
      // a campo é o que prova que pontuação, classe, colocação, elegibilidade
      // e vínculos ficaram onde estavam.
      const { categoryId: categoriaAntes, ...restoAntes } = antes[i];
      const { categoryId: categoriaDepois, ...restoDepois } = depois[i];
      expect(restoDepois).toEqual(restoAntes);
      expect(categoriaAntes).toBeNull();
      expect(categoriaDepois).not.toBeNull();
    }
  });

  it('catalogClassId preservado 6/6, e nenhuma classe criada ou removida', async () => {
    await estadoDaProducao();
    const classesAntes = await noLedger(tx => tx.classCatalog.findMany({
      where: { organizationId }, select: { id: true, code: true, displayName: true, categoryId: true }, orderBy: { id: 'asc' }
    }));

    expect(rodar('--aplicar').status).toBe(0);

    const classesDepois = await noLedger(tx => tx.classCatalog.findMany({
      where: { organizationId }, select: { id: true, code: true, displayName: true, categoryId: true }, orderBy: { id: 'asc' }
    }));
    expect(classesDepois).toEqual(classesAntes);

    const pontos = await retrato();
    expect(pontos.filter(p => p.catalogClassId).length).toBe(6);
  });

  it('nenhuma categoria criada, nenhum atleta criado, nenhum lançamento criado ou removido', async () => {
    await estadoDaProducao();
    const categoriasAntes = await prisma.category.count();
    const atletasAntes = await comoAtor(admin, tx => tx.athlete.count());
    const pontosAntes = await noLedger(tx => tx.rankingPoint.count());
    const externosAntes = await comoAtor(admin, tx => tx.externalResult.count());

    expect(rodar('--aplicar').status).toBe(0);

    expect(await prisma.category.count()).toBe(categoriasAntes);
    expect(await comoAtor(admin, tx => tx.athlete.count())).toBe(atletasAntes);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(pontosAntes);
    expect(await comoAtor(admin, tx => tx.externalResult.count())).toBe(externosAntes);
  });

  it('é idempotente: a segunda execução não encontra mais nada', async () => {
    await estadoDaProducao();
    expect(rodar('--aplicar').status).toBe(0);
    const depoisDaPrimeira = await retrato();

    const segunda = rodar('--aplicar');
    expect(segunda.status, segunda.stderr?.slice(0, 400)).toBe(0);
    expect(segunda.stdout).toMatch(/total analisado\s*\.+\s*0/);
    expect(segunda.stdout).toMatch(/APLICADO\. 0 lançamentos/);

    expect(await retrato()).toEqual(depoisDaPrimeira);
  });

  it('não sobrescreve categoria que já estava resolvida', async () => {
    await estadoDaProducao();

    // Uma linha volta a ter categoria, e de propósito uma ERRADA: se o script
    // sobrescrevesse o que já está resolvido, esta linha mudaria — e reescrever
    // história por cima de decisão anterior é o que a condição de nulidade no
    // `where` existe para impedir.
    const figure = await prisma.category.findUnique({ where: { code: 'FIGURE' } });
    const externo = await externoDe('QA-K-3');
    await comoAtor(gerente, tx => tx.rankingPoint.updateMany({
      where: { externalResultId: externo.id }, data: { categoryId: figure.id }
    }));

    const saida = rodar('--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toMatch(/total analisado\s*\.+\s*5/);

    const intocado = await noLedger(tx => tx.rankingPoint.findFirst({
      where: { externalResultId: externo.id }, select: { categoryId: true }
    }));
    expect(intocado.categoryId).toBe(figure.id);
  });
});

describe('o que não resolve interrompe a aplicação inteira', () => {
  it('código fora do catálogo oficial é conflito, e --aplicar não escreve NADA', async () => {
    await estadoDaProducao();
    const externo = await externoDe('QA-K-4');
    await comoAtor(admin, tx => tx.externalResult.update({
      where: { id: externo.id }, data: { categoryCode: 'CATEGORIA_INEXISTENTE' }
    }));
    const antes = await retrato();

    const auditoria = rodar();
    expect(auditoria.status).toBe(0);
    expect(auditoria.stdout).toMatch(/não resolvidos\s*\.+\s*1/);
    expect(auditoria.stdout).toMatch(/conflitos\s*\.+\s*1/);
    expect(auditoria.stdout).toContain('CATEGORIA_INEXISTENTE');
    expect(auditoria.stdout).toContain('código não existe no catálogo oficial de categorias');

    const aplicacao = rodar('--aplicar');
    expect(aplicacao.status, 'a aplicação recusa').toBe(1);
    expect(aplicacao.stderr).toContain('RECUSADO');

    // NEM AS LINHAS BOAS. Escrever a parte que resolveu deixaria a base em
    // dois estados, e o resto teria de ser descoberto a mão.
    expect(await retrato()).toEqual(antes);
  });

  it('origem sem código de categoria não é resolvida, e --aplicar recusa', async () => {
    await estadoDaProducao();
    const externo = await externoDe('QA-K-5');
    await comoAtor(admin, tx => tx.externalResult.update({
      where: { id: externo.id }, data: { categoryCode: null }
    }));
    const antes = await retrato();

    const auditoria = rodar();
    expect(auditoria.status).toBe(0);
    expect(auditoria.stdout).toMatch(/não resolvidos\s*\.+\s*1/);
    expect(auditoria.stdout).toContain('(sem código de categoria na origem)');
    // Sem código, o nome da classe continua lá — e não é usado.
    expect(auditoria.stdout).not.toContain('True Novice');

    const aplicacao = rodar('--aplicar');
    expect(aplicacao.status).toBe(1);
    expect(await retrato()).toEqual(antes);
  });
});

describe('o recorte e o isolamento', () => {
  it('--temporada alcança uma temporada e deixa a outra como estava', async () => {
    const vizinha = await montarOrganizacao('MCI Vizinha');
    await vincular(vizinha.organizationId, gerente, 'RANKING_MANAGER');
    await vincular(vizinha.organizationId, gerente, 'REGISTRATION_OPERATOR');
    await importarEAplicar(vizinha, arquivo().replace(/QA-K-/g, 'QA-V-').replace(/QA-N-/g, 'QA-W-'));

    await comoAtor(gerente, tx => tx.rankingPoint.updateMany({ data: { categoryId: null } }));

    const saida = rodar(`--temporada=${seasonId}`, '--aplicar');
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);
    expect(saida.stdout).toMatch(/APLICADO\. 6 lançamentos/);

    const daTemporada = await retrato();
    expect(daTemporada.every(p => p.categoryId !== null), 'a temporada alvo foi resolvida').toBe(true);

    const daVizinha = await retrato({ seasonId: vizinha.seasonId });
    expect(daVizinha.length).toBe(6);
    expect(daVizinha.every(p => p.categoryId === null), 'a outra temporada não foi tocada').toBe(true);
  });
});
