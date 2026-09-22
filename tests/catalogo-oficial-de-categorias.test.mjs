import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O CATÁLOGO OFICIAL DE CATEGORIAS — E O SILÊNCIO QUE A FALTA DELE PRODUZIU.
//
// O QUE ACONTECEU, MEDIDO NA BASE REAL DA FEDERAÇÃO
//
// `render.yaml` roda `prisma migrate deploy` no pre-deploy e NUNCA rodou o
// seed. `prisma/seed.js` era o único lugar que criava as categorias oficiais,
// então `Category` nasceu vazia em produção.
//
// Os 191 resultados do Ipiranga foram importados contra esse catálogo vazio, e
// a importação respondeu "191 aplicados, 0 conflitos".
//
// A guarda que recusa categoria desconhecida EXISTIA e TINHA TESTE. Ela só
// ficava depois da resolução do atleta — e a base de atletas também estava
// vazia, que é o caminho normal do histórico oficial carregado antes do
// cadastro. Toda linha saía como MATCH_PENDING antes de alcançá-la.
//
// Duas correções, uma em cada metade:
//   · a guarda subiu para antes da resolução do atleta;
//   · o catálogo virou migration, que é o caminho que o deploy já percorre.
//
// O teste central deste arquivo é o que reproduz o caminho inteiro: catálogo
// vazio MAIS base de atletas vazia. Era a combinação que ninguém tinha
// testado junta, e é por isso que o defeito chegou em produção.
// ============================================================================

const OFICIAIS = [
  'MENS_BODYBUILDING', 'MENS_PHYSIQUE', 'CLASSIC_PHYSIQUE', 'BODYBUILDING_212',
  'WOMENS_BODYBUILDING', 'WOMENS_PHYSIQUE', 'WELLNESS', 'BIKINI',
  'FITNESS', 'FIGURE', 'FITMODEL'
];

// Os oito que o arquivo do Ipiranga usa, e que o adaptador produz.
const DO_IPIRANGA = [
  'BIKINI', 'CLASSIC_PHYSIQUE', 'FIGURE', 'FITMODEL',
  'MENS_BODYBUILDING', 'MENS_PHYSIQUE', 'WELLNESS', 'WOMENS_PHYSIQUE'
];

const MIGRATION = path.join(
  process.cwd(), 'prisma/migrations/20260922210000_catalogo_oficial_de_categorias/migration.sql'
);

let admin;
let gerente;
let organizationId;
let seasonId;

const noLedger = consulta => comoAtor(gerente, consulta);

const csv = linhas => ['external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento', ...linhas].join('\n');

beforeAll(() => garantirCatalogo());

// O CATÁLOGO É GLOBAL E `limparBanco` NÃO O APAGA — de propósito, porque ele é
// pré-requisito do domínio e não cenário de teste. Um teste deste arquivo
// esvazia `Category` para reproduzir produção; sem esta restauração ele levaria
// junto todos os testes seguintes do arquivo, que passariam a falhar por uma
// causa que não é a deles. Reprovisiona só quando de fato ficou vazio.
afterEach(async () => {
  if (await prisma.category.count() === 0) garantirCatalogo();
});

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;
});

describe('a migration provisiona o catálogo pelo caminho que o deploy já percorre', () => {
  it('as onze categorias oficiais existem, e as oito do Ipiranga estão entre elas', async () => {
    const existentes = (await prisma.category.findMany({ select: { code: true } })).map(c => c.code);

    for (const codigo of OFICIAIS) expect(existentes, codigo).toContain(codigo);
    for (const codigo of DO_IPIRANGA) expect(existentes, `${codigo} — usada pelo arquivo do Ipiranga`).toContain(codigo);
  });

  it('a migration e o seed não divergem — a lista é uma só', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const seed = readFileSync(path.join(process.cwd(), 'prisma/seed.js'), 'utf8');

    // Acrescentar categoria em um lugar só é o jeito mais fácil de as duas
    // listas se separarem sem ninguém notar — e aí o ambiente provisionado por
    // migration passa a ter um catálogo diferente do provisionado por seed.
    const naMigration = [...sql.matchAll(/'([A-Z_0-9]+)',\s+'[^']/g)].map(m => m[1]);
    const noSeed = [...seed.matchAll(/code: '([A-Z_0-9]+)', name:/g)].map(m => m[1]);

    expect(noSeed.length, 'o seed declara categorias').toBeGreaterThan(0);
    expect([...naMigration].sort()).toEqual([...noSeed].sort());
  });

  it('é idempotente: aplicar de novo não duplica nem reescreve', async () => {
    const antes = await prisma.category.findMany({
      select: { id: true, code: true, name: true, sex: true, sortOrder: true, active: true },
      orderBy: { code: 'asc' }
    });

    // O ON CONFLICT DO NOTHING da migration, exercitado contra a base real.
    await prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8')
      .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n'));

    const depois = await prisma.category.findMany({
      select: { id: true, code: true, name: true, sex: true, sortOrder: true, active: true },
      orderBy: { code: 'asc' }
    });

    expect(depois).toEqual(antes);
  });
});

describe('a guarda de categoria protege a linha SEM atleta — que é o caso do histórico', () => {
  it('categoria desconhecida vira CONFLITO mesmo com a base de atletas vazia', async () => {
    // O CAMINHO EXATO DO DEFEITO. Antes da correção, esta linha saía como
    // MATCH_PENDING sem nunca passar pela guarda, e seria aplicada com
    // `categoryId` nulo.
    expect(await prisma.athlete.count(), 'base de atletas vazia').toBe(0);

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('sem-cat') + '.csv',
      content: csv(['QA-C-1,QA ATLETA UM,NPC,QA-C-001,CATEGORIA_INEXISTENTE,Alguma Coisa - Open,1,Etapa QA'])
    });

    expect(lote.status).toBe(201);
    expect(lote.body.summary.conflicts, 'a guarda alcança a linha sem atleta').toBe(1);
    expect(lote.body.summary.pending).toBe(0);
    expect(lote.body.items[0].matchStatus).toBe('CONFLICT');
    expect(lote.body.items[0].reason).toMatch(/Categoria desconhecida no MCI: CATEGORIA_INEXISTENTE/);
  });

  it('CATÁLOGO VAZIO recusa o arquivo inteiro, em vez de aplicar em silêncio', async () => {
    // A reprodução do que aconteceu em produção: catálogo vazio E base de
    // atletas vazia, juntos. Era a combinação que ninguém tinha testado.
    await comoAtor(admin, tx => tx.category.deleteMany({}));
    expect(await prisma.category.count()).toBe(0);

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('vazio') + '.csv',
      content: csv([
        "QA-C-1,QA ATLETA UM,NPC,QA-C-001,BIKINI,Women's Bikini - Masters 35+,1,Etapa QA",
        "QA-C-2,QA ATLETA DOIS,NPC,QA-C-002,MENS_PHYSIQUE,Men's Physique - Open Class D,2,Etapa QA"
      ])
    });

    expect(lote.status).toBe(201);
    // ANTES DA CORREÇÃO ISTO ERA `pending: 2, conflicts: 0` — e o operador
    // aplicava sem saber que estava gravando resultado sem recorte nenhum.
    expect(lote.body.summary.conflicts).toBe(2);
    expect(lote.body.summary.applicable, 'nada aplicável contra catálogo vazio').toBe(0);

    // E o apply RECUSA o lote inteiro, em vez de aplicar zero linha e devolver
    // 200 — um 200 com `applied: 0` é exatamente o silêncio que produziu este
    // defeito. O operador recebe a recusa nomeada.
    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.status).toBe(422);
    expect(aplicacao.body.error?.code ?? aplicacao.body.code).toBe('NOTHING_TO_APPLY');
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(0);
  });

  it('com o catálogo provisionado, as mesmas linhas entram com categoria', async () => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('ok') + '.csv',
      content: csv([
        "QA-C-1,QA ATLETA UM,NPC,QA-C-001,BIKINI,Women's Bikini - Masters 35+,1,Etapa QA",
        "QA-C-2,QA ATLETA DOIS,NPC,QA-C-002,MENS_PHYSIQUE,Men's Physique - Open Class D,2,Etapa QA"
      ])
    });

    expect(lote.body.summary.conflicts).toBe(0);
    expect(lote.body.summary.applicable).toBe(2);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
    expect(aplicacao.body.applied).toBe(2);

    const pontos = await noLedger(tx => tx.rankingPoint.findMany({
      where: { seasonId },
      select: { athleteId: true, points: true, category: { select: { code: true } }, catalogClass: { select: { displayName: true, categoryId: true } } }
    }));

    expect(pontos.length).toBe(2);
    // O QUE A FALTA DO CATÁLOGO TINHA CUSTADO: categoria nula e "Geral".
    expect(pontos.every(p => p.category !== null), 'nenhum ponto sem categoria').toBe(true);
    expect(pontos.map(p => p.category.code).sort()).toEqual(['BIKINI', 'MENS_PHYSIQUE']);
    // E sem cadastro de atleta, que continua sendo o caminho normal.
    expect(pontos.every(p => p.athleteId === null)).toBe(true);
    // A classe é específica da categoria, não genérica.
    expect(pontos.every(p => p.catalogClass?.categoryId), 'classe específica').toBeTruthy();
  });

  it('linha sem classe E sem categoria é CONFLITO, e não pendência', async () => {
    // O MUTATION TESTING PEDIU ESTE TESTE.
    //
    // A suíte matava o mutante que afrouxa a guarda do código DESCONHECIDO,
    // mas não o que afrouxa a guarda do código AUSENTE: trocar CONFLICT por
    // MATCH_PENDING no primeiro ramo passava batido. E é o ramo do arquivo
    // que não trouxe nem a coluna Class nem a de categoria — o mesmo defeito
    // silencioso por outra porta, com a linha entrando sem recorte nenhum.
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('sem-classe') + '.csv',
      content: csv(['QA-F-1,QA ATLETA UM,NPC,QA-F-001,,,1,Etapa QA'])
    });

    expect(lote.status).toBe(201);
    expect(lote.body.summary.conflicts, JSON.stringify(lote.body.items?.map(i => [i.matchStatus, i.reason])).slice(0, 300)).toBe(1);
    expect(lote.body.summary.pending).toBe(0);
    expect(lote.body.items[0].matchStatus).toBe('CONFLICT');
    expect(lote.body.items[0].reason).toMatch(/não informou classe nem categoria/);
  });

  it('cada um dos oito códigos do Ipiranga resolve sozinho', async () => {
    const porCategoria = {
      BIKINI: "Women's Bikini - Open Class A",
      CLASSIC_PHYSIQUE: "Men's Classic Physique - True Novice",
      FIGURE: "Women's Figure - Open",
      FITMODEL: "Women's Fit Model - Open Class A",
      MENS_BODYBUILDING: "Men's Bodybuilding - Open Heavyweight",
      MENS_PHYSIQUE: "Men's Physique - Open Class D",
      WELLNESS: "Women's Wellness - Masters 40+",
      WOMENS_PHYSIQUE: "Women's Physique - Masters 35+"
    };

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('oito') + '.csv',
      content: csv(DO_IPIRANGA.map((codigo, i) =>
        `QA-D-${i},QA ATLETA ${i},NPC,QA-D-${i},${codigo},${porCategoria[codigo]},1,Etapa QA`))
    });

    expect(lote.body.summary.conflicts, JSON.stringify(lote.body.items?.map(i => i.reason)).slice(0, 300)).toBe(0);
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const codigos = await noLedger(async tx => {
      const pontos = await tx.rankingPoint.findMany({
        where: { seasonId }, select: { category: { select: { code: true } } }
      });
      return pontos.map(p => p.category?.code).sort();
    });

    expect(codigos).toEqual([...DO_IPIRANGA].sort());
  });
});

describe('o isolamento continua de pé', () => {
  it('a categoria é global; a CLASSE resolvida é da organização do lançamento', async () => {
    const vizinha = await criarOrganizacao(admin, { name: 'MCI Vizinha' });

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('tenant') + '.csv',
      content: csv(["QA-E-1,QA ATLETA UM,NPC,QA-E-001,BIKINI,Women's Bikini - Masters 35+,1,Etapa QA"])
    });
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const classes = await comoAtor(admin, tx => tx.classCatalog.findMany({
      where: { code: 'MASTERS_35' }, select: { organizationId: true }
    }));

    expect(classes.length).toBe(1);
    expect(classes[0].organizationId).toBe(organizationId);
    expect(classes[0].organizationId).not.toBe(vizinha.id);
  });
});
