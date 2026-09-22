import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O REPARO DOS HISTÓRICOS JÁ APLICADOS — CONTRA O SCRIPT DE VERDADE.
//
// Os 191 resultados do Ipiranga entraram no ledger ANTES de
// `RankingPoint.catalogClassId` existir. Não se reimporta, não se apaga e não
// se aplica de novo: a classe deles está gravada como TEXTO em
// `ExternalResult.className`, e é de lá que o reparo parte.
//
// Este arquivo executa `scripts/backfill-classe-do-catalogo.js` como processo,
// e não uma cópia da lógica dele. Testar uma reimplementação provaria que a
// reimplementação funciona — o que vai rodar contra produção é o script.
//
// AS TRÊS PERGUNTAS:
//
//   1. sem `--aplicar`, ele escreve alguma coisa? (não pode)
//   2. com `--aplicar`, ele repõe a classe SEM tocar em mais nada?
//   3. rodando duas vezes, ele faz o trabalho duas vezes? (não pode)
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const arquivo = () => [
  CABECALHO,
  'QA-B-1,QA ATLETA UM,NPC,QA-B-001,WOMENS_PHYSIQUE,Women\'s Physique - Masters 35+,1,Etapa QA',
  'QA-B-2,QA ATLETA DOIS,NPC,QA-B-002,WOMENS_PHYSIQUE,Women\'s Physique - Masters 35+,2,Etapa QA',
  'QA-B-3,QA ATLETA TRES,NPC,QA-B-003,BIKINI,Women\'s Bikini - Open Class A,1,Etapa QA',
  'QA-B-4,QA ATLETA QUATRO,NPC,QA-B-004,MENS_BODYBUILDING,Men\'s Bodybuilding - Open Heavyweight,3,Etapa QA'
].join('\n');

const CAMPOS = {
  id: true, placing: true, points: true, placementPoints: true, overallBonus: true,
  adjustmentPoints: true, superOverallPoints: true, categoryId: true, catalogClassId: true,
  athleteId: true, eventId: true, seasonId: true, organizationId: true, externalResultId: true,
  didNotShow: true, isOverallChampion: true
};

let admin;
let gerente;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

const rodarBackfill = (...args) => spawnSync('node', ['scripts/backfill-classe-do-catalogo.js', ...args], {
  cwd: process.cwd(), encoding: 'utf8', env: process.env, timeout: 120000
});

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('backfill') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
});

// O ESTADO ANTERIOR À COLUNA, construído à mão. É o único jeito de medir o
// reparo: a importação de hoje já resolve a classe, então sem desfazê-la não
// haveria o que reparar.
async function apagarAsClassesDosLancamentos() {
  await comoAtor(gerente, tx => tx.rankingPoint.updateMany({
    where: { seasonId }, data: { catalogClassId: null }
  }));
}

describe('o backfill repõe a classe dos históricos já aplicados', () => {
  it('sem --aplicar ele não escreve NADA, e diz quantos seriam alterados', async () => {
    await apagarAsClassesDosLancamentos();
    const antes = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));

    const saida = rodarBackfill();
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);
    expect(saida.stdout).toContain('DIAGNÓSTICO');
    expect(saida.stdout).toContain('4 lançamentos SERIAM alterados');
    // O relatório por categoria e classe, que é o que se apresenta antes de
    // autorizar escrita em produção.
    expect(saida.stdout).toContain('WOMENS_PHYSIQUE');
    expect(saida.stdout).toContain('Masters 35+');

    const depois = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));
    expect(depois).toEqual(antes);
    expect(depois.every(p => p.catalogClassId === null)).toBe(true);
  });

  it('com --aplicar ele repõe a classe e não move mais nada', async () => {
    const original = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));
    expect(original.every(p => p.catalogClassId !== null), 'a importação de hoje já resolve a classe').toBe(true);

    const externosAntes = await noLedger(tx => tx.externalResult.count());
    const pontosAntes = await noLedger(tx => tx.rankingPoint.count());

    await apagarAsClassesDosLancamentos();

    const saida = rodarBackfill('--aplicar');
    expect(saida.status, saida.stderr?.slice(0, 400)).toBe(0);
    expect(saida.stdout).toContain('APLICADO');

    const reparado = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));

    // A CLASSE VOLTOU, e é a MESMA que a importação havia resolvido.
    expect(reparado).toEqual(original);

    // E nada nasceu: nem resultado externo, nem lançamento.
    expect(await noLedger(tx => tx.externalResult.count())).toBe(externosAntes);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(pontosAntes);
  });

  it('rodar duas vezes não faz o trabalho duas vezes', async () => {
    await apagarAsClassesDosLancamentos();

    const primeira = rodarBackfill('--aplicar');
    expect(primeira.status).toBe(0);
    const depoisDaPrimeira = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));
    const classesDepoisDaPrimeira = await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }));

    const segunda = rodarBackfill('--aplicar');
    expect(segunda.status).toBe(0);
    // Nada sobrou para fazer.
    expect(segunda.stdout).toContain('0 lançamentos receberam a classe');

    const depoisDaSegunda = await noLedger(tx => tx.rankingPoint.findMany({ where: { seasonId }, select: CAMPOS, orderBy: { id: 'asc' } }));
    expect(depoisDaSegunda).toEqual(depoisDaPrimeira);
    // E nenhuma classe duplicada no catálogo.
    expect(await noLedger(tx => tx.classCatalog.count({ where: { organizationId } }))).toBe(classesDepoisDaPrimeira);
  });

  it('o recorte por temporada não alcança outra temporada', async () => {
    await apagarAsClassesDosLancamentos();

    const outra = await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId, name: 'Temporada Vizinha', year: 2027 });

    const saida = rodarBackfill(`--temporada=${outra.body.id}`, '--aplicar');
    expect(saida.status).toBe(0);
    expect(saida.stdout).toContain('0 lançamentos receberam a classe');

    // Os lançamentos da OUTRA temporada continuam sem classe: o recorte
    // funcionou, e o reparo não saiu do alvo.
    const intocados = await noLedger(tx => tx.rankingPoint.count({ where: { seasonId, catalogClassId: null } }));
    expect(intocados).toBe(4);
  });
});
