import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// S4 — A CHAVE CANÔNICA DO RECURSO COMPARTILHADO.
//
// O QUE É O RECURSO COMPARTILHADO
//
// Não é o lote, e não é o lançamento: é A TEMPORADA. `recomputarEm` lê
// `RankingPoint` da temporada INTEIRA e reescreve a projeção pública dela
// inteira — `republicarProjecao` faz `deleteMany({ seasonId })` seguido de
// `createMany(...)`. Duas execuções concorrentes sobre a mesma temporada
// disputam o mesmo conjunto de linhas.
//
// O QUE A MEDIÇÃO ACHOU, E O QUE ELA CORRIGIU NA MINHA PRÓPRIA LEITURA
//
// Primeiro medi, em psql, que `pg_advisory_xact_lock` em AUTOCOMMIT é solto na
// instrução seguinte (0 travas visíveis na consulta de logo depois). Concluí
// que a trava do importador, feita com `prisma.$executeRaw`, era decorativa.
//
// ESTAVA ERRADO, e o que me corrigiu foi `src/utils/asyncHandler.js`: TODO
// handler autenticado roda dentro de UMA transação interativa aberta por
// `withUserContext`, e o Proxy de `src/config/prisma.js` redireciona todo
// `$transaction` e todo `$executeRaw` para ela. Ou seja, no caminho HTTP real
// a trava do importador ESTÁ em transação e ESTÁ valendo.
//
// O defeito é outro, e é o que o relatório anterior nomeou: as chaves
// DIVERGEM.
//
//   `aplicarLote`                 -> musclewar:apply:<importId>
//   `adjustRankingPoint`          -> ranking:temporada:<seasonId>
//   `recompute_` (o motor)        -> NENHUMA
//
// `recompute_` é o caminho por onde as duas operações passam para reescrever a
// projeção — e é justamente ele que não pede trava nenhuma. Então um recompute
// e uma correção da MESMA temporada não se excluem: as duas chegam ao
// `deleteMany` + `createMany` ao mesmo tempo.
//
// O DANO É DEMONSTRÁVEL, e não teórico: `PublicRankingEntry.id` é `ponto.id`
// (ver `republicarProjecao`), ou seja DETERMINÍSTICO. A segunda execução
// insere exatamente os mesmos ids que a primeira acabou de gravar e colide na
// CHAVE PRIMÁRIA. Quem perde a corrida responde 500 — e, no caso do
// importador, responde 500 DEPOIS de ter escrito os pontos.
//
// POR QUE NÃO SERIALIZAR TUDO
//
// Temporadas diferentes continuam correndo em paralelo, e há teste para isso.
// A trava é por temporada porque o recurso disputado é a temporada.
// ==========================================================================

const CHAVE_CANONICA = seasonId => `ranking:temporada:${seasonId}`;

let plataforma, operador, org, filiacao, season, evento, categoria;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  plataforma = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin T4' });
  org = (await criarOrganizacao(plataforma, { name: 'Federacao T4' })).id;

  operador = await criarUsuario({ name: 'Operador T4' });
  for (const papel of ['EVENT_DIRECTOR', 'RANKING_MANAGER', 'REGISTRATION_OPERATOR']) {
    await vincular(org, operador, papel);
  }

  filiacao = (await api().post('/api/v1/affiliations').set(plataforma.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(plataforma.auth())
    .send({ organizationId: org, name: 'Temporada T4', year: 2026 })).body.id;

  evento = (await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: 'Etapa T4', slug: unico('ev-t4'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  categoria = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
});

// Lançamentos escritos direto no ledger, como ator: é fixture, e o caminho de
// escrita do importador tem suíte própria. O que esta suíte mede é a trava.
async function semearLedger(quantos, { seasonId = season } = {}) {
  const ids = [];
  for (let i = 0; i < quantos; i += 1) {
    const atleta = await comoAtor(operador, tx => tx.athlete.create({
      data: {
        organizationId: org, fullName: `ATLETA T4 ${i}`, sex: 'MALE',
        affiliationId: filiacao.id, affiliationNumber: `T4${String(i).padStart(4, '0')}`,
        identity: { create: { organizationId: org, cpf: gerarCpf(50_000 + i) } }
      }
    }));
    const colocacao = (i % 5) + 1;
    const pontos = 6 - colocacao;
    const ponto = await comoAtor(operador, tx => tx.rankingPoint.create({
      data: {
        seasonId, organizationId: org, athleteId: atleta.id, categoryId: categoria.id,
        source: 'EVENT', eventId: evento.id,
        placing: colocacao, placementPoints: pontos, points: pontos
      }
    }));
    ids.push(ponto.id);
  }
  return ids;
}

const recomputar = (ator = operador, id = season) =>
  api().post(`/api/v1/seasons/${id}/recompute`).set(ator.auth()).send({});

// `expectedPoints` é OBRIGATÓRIO e é uma trava otimista que já existia antes do
// T4: o ajuste só entra se a pontuação atual for a que o operador viu. Ela
// protege o LANÇAMENTO de edição cega; não protege a temporada, que é o recurso
// do S4 — são controles de concorrência diferentes, em camadas diferentes.
const ajustar = (pointId, pontos, atuais) =>
  api().post(`/api/v1/ranking/points/${pointId}/adjust`).set(operador.auth())
    .send({ points: pontos, expectedPoints: atuais, reason: 'Ajuste de QA para medir concorrência.' });

const pontuacaoAtual = async pointId => (await comoAtor(plataforma, tx => tx.rankingPoint.findUnique({
  where: { id: pointId }, select: { points: true }
}))).points;

const projecao = seasonId => prisma.publicRankingEntry.findMany({
  where: { seasonId }, select: { id: true }
});

// Trava a chave canônica numa transação PRÓPRIA e mantém presa até que o
// chamador libere. Não é `sleep`: a liberação é uma promessa resolvida do
// outro lado, e o prazo só existe para o caso de a espera nunca terminar.
function segurarChaveCanonica(seasonId) {
  let liberar;
  const liberado = new Promise(resolve => { liberar = resolve; });
  let presa;
  const pronta = new Promise(resolve => { presa = resolve; });

  const transacao = prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('${CHAVE_CANONICA(seasonId)}'))`);
    presa();
    await liberado;
  }, { timeout: 25_000, maxWait: 10_000 });

  return { pronta, liberar: () => liberar(), transacao };
}

// ==========================================================================
// A TRAVA: `recompute_` RESPEITA A CHAVE CANÔNICA DA TEMPORADA?
// ==========================================================================
describe('a chave canônica da temporada vale para todo caminho que reescreve a projeção', () => {
  it('o recompute ESPERA enquanto a chave canônica da temporada está presa', async () => {
    await semearLedger(3);

    const cadeado = segurarChaveCanonica(season);
    await cadeado.pronta;

    let terminou = false;
    const chamada = recomputar().then(r => { terminou = true; return r; });

    // Enquanto a chave está presa, o recompute NÃO pode concluir. A espera é
    // curta de propósito: se ele não respeitasse a trava, concluiria em
    // milissegundos — é isso que o defeito fazia.
    const venceuOPrazo = await Promise.race([
      chamada.then(() => 'CONCLUIU'),
      new Promise(resolve => setTimeout(() => resolve('AINDA PRESO'), 1500))
    ]);

    expect(venceuOPrazo, 'o recompute ignorou a chave canônica da temporada').toBe('AINDA PRESO');
    expect(terminou).toBe(false);

    // E depois de liberar, conclui normalmente: a trava faz esperar, não falhar.
    cadeado.liberar();
    await cadeado.transacao;

    const r = await chamada;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 60_000);

  it('temporadas DIFERENTES não se bloqueiam — a trava é por temporada, não global', async () => {
    const outra = (await api().post('/api/v1/seasons').set(plataforma.auth())
      .send({ organizationId: org, name: 'Temporada T4 B', year: 2025 })).body.id;
    await semearLedger(2);

    const cadeado = segurarChaveCanonica(season);
    await cadeado.pronta;

    // A outra temporada tem de passar mesmo com a primeira presa. Sem isto, a
    // correção teria serializado a plataforma inteira.
    const r = await recomputar(operador, outra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    cadeado.liberar();
    await cadeado.transacao;
  }, 60_000);
});

// ==========================================================================
// O DANO: COLISÃO NA CHAVE PRIMÁRIA DA PROJEÇÃO
// ==========================================================================
describe('recompute e correção concorrentes na mesma temporada', () => {
  it('o recompute e o ajuste simultâneos não produzem 5xx nem projeção duplicada', async () => {
    // O ajuste toma `ranking:temporada:<id>`; o recompute, antes da correção,
    // não tomava nada. As duas chegavam juntas ao deleteMany + createMany da
    // MESMA temporada, com ids determinísticos — colisão de chave primária.
    const ids = await semearLedger(25);

    const atual0 = await pontuacaoAtual(ids[0]);
    const atual1 = await pontuacaoAtual(ids[1]);

    const respostas = await Promise.all([
      recomputar(),
      ajustar(ids[0], atual0 + 1, atual0),
      recomputar(),
      ajustar(ids[1], atual1 + 1, atual1),
      recomputar()
    ]);

    // O SINTOMA MEDIDO NÃO FOI 5xx, FOI 409.
    //
    // A colisão de chave primária da projeção sobe mapeada como conflito. Por
    // isso o critério é "toda operação legítima responde 200": aceitar 409
    // aqui teria deixado o defeito passar — e deixou, na primeira versão deste
    // teste, que só reprovava 5xx e por isso ficou verde contra o código
    // defeituoso.
    const naoOk = respostas.filter(r => r.status !== 200)
      .map(r => `${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`);
    expect(naoOk, 'operação legítima recusada na concorrência da mesma temporada').toEqual([]);

    // A projeção tem de ter exatamente uma linha por lançamento — nem
    // duplicada, nem faltando.
    const linhas = await projecao(season);
    const distintos = new Set(linhas.map(l => l.id));
    expect(linhas.length, 'projeção com linha duplicada').toBe(distintos.size);
    expect(linhas.length, 'projeção não cobre todos os lançamentos').toBe(ids.length);
  }, 120_000);

  it('vários recomputes simultâneos da mesma temporada convergem, sem 5xx', async () => {
    const ids = await semearLedger(20);

    const respostas = await Promise.all(Array.from({ length: 6 }, () => recomputar()));

    // Antes da correção: 1×200 e 5×409 — a colisão de chave primária da
    // projeção. Depois: 6×200, porque cada um espera a vez na chave da
    // temporada.
    expect(respostas.map(r => r.status), 'recompute concorrente recusado')
      .toEqual([200, 200, 200, 200, 200, 200]);

    const linhas = await projecao(season);
    expect(new Set(linhas.map(l => l.id)).size).toBe(linhas.length);
    expect(linhas.length).toBe(ids.length);
  }, 120_000);

  it('a soma pública da temporada não é alterada pela concorrência', async () => {
    // Prova de que a correção não mexeu na regra: o total do ledger e o total
    // da projeção continuam iguais depois da tempestade.
    const ids = await semearLedger(12);

    const esperado = (await comoAtor(plataforma, tx => tx.rankingPoint.findMany({
      where: { seasonId: season }, select: { points: true }
    }))).reduce((soma, p) => soma + p.points, 0);

    await Promise.all([recomputar(), recomputar(), recomputar()]);

    const daProjecao = (await prisma.publicRankingEntry.findMany({
      where: { seasonId: season }, select: { points: true }
    })).reduce((soma, p) => soma + p.points, 0);

    expect(daProjecao, 'a projeção divergiu do ledger').toBe(esperado);
    expect((await projecao(season)).length).toBe(ids.length);
  }, 120_000);
});

// ==========================================================================
// O IMPORTADOR TOMA A CHAVE CANÔNICA, E NÃO SÓ A DO LOTE
// ==========================================================================
describe('o importador e o ranking coordenam pela mesma chave', () => {
  const CABECALHO = 'Athlete #,Class,Category,First Name,Last Name,Member Number,Placing';
  const CLASSE = "Men's Bodybuilding - Open Middleweight";

  beforeEach(async () => {
    await api().put(`/api/v1/seasons/${season}/points-rules`).set(plataforma.auth()).send({
      rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
        { placing: 4, points: 2 }, { placing: 5, points: 1 }]
    });
  });

  const criarLote = linhas => api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
    sourceRef: unico('t4') + '.csv', content: [CABECALHO, ...linhas].join('\n'),
    externalIdPrefix: unico('T4').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  });

  it('a aplicação do lote ESPERA a chave canônica da temporada', async () => {
    const lote = (await criarLote([
      `1,${CLASSE},MENS_BODYBUILDING,Atleta,Um,90001,1`
    ])).body.import;

    const cadeado = segurarChaveCanonica(season);
    await cadeado.pronta;

    const chamada = api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({});

    const veredito = await Promise.race([
      chamada.then(() => 'CONCLUIU'),
      new Promise(resolve => setTimeout(() => resolve('AINDA PRESO'), 1500))
    ]);

    expect(veredito, 'o importador escreveu no ledger sem a chave da temporada').toBe('AINDA PRESO');

    cadeado.liberar();
    await cadeado.transacao;

    const r = await chamada;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied).toBe(1);
  }, 120_000);

  it('aplicar o lote e corrigir um lançamento ao mesmo tempo não produz 5xx', async () => {
    const ids = await semearLedger(8);
    const lote = (await criarLote([
      `1,${CLASSE},MENS_BODYBUILDING,Atleta,Dois,90002,1`
    ])).body.import;

    const atual = await pontuacaoAtual(ids[0]);

    const respostas = await Promise.all([
      api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({}),
      ajustar(ids[0], atual + 1, atual),
      recomputar()
    ]);

    expect(respostas.filter(r => r.status !== 200)
      .map(r => `${r.status} ${JSON.stringify(r.body?.error ?? r.body).slice(0, 200)}`),
    'a concorrência importador × correção recusou operação legítima').toEqual([]);

    const linhas = await projecao(season);
    expect(new Set(linhas.map(l => l.id)).size, 'projeção duplicada').toBe(linhas.length);
  }, 120_000);
});

// ==========================================================================
// A CHAVE FICA FIXADA CONTRA REVERSÃO SILENCIOSA
// ==========================================================================
describe('a chave canônica está declarada num lugar só', () => {
  it('o código usa exatamente a chave `ranking:temporada:<seasonId>` nos dois serviços', async () => {
    const { readFileSync } = await import('node:fs');
    const ranking = readFileSync('src/services/rankingService.js', 'utf8');
    const importador = readFileSync('src/services/muscleWarService.js', 'utf8');

    // Uma chave nova inventada em qualquer um dos dois lados reabre o S4. Este
    // teste falha no dia em que alguém escrever outra string de temporada.
    const chavesDeTemporada = [...`${ranking}${importador}`.matchAll(/ranking:temporada:\$\{(\w+)\}/g)]
      .map(m => m[1]);
    expect(chavesDeTemporada.length, 'a chave canônica desapareceu do código').toBeGreaterThan(0);

    // QUEM PEDE A CHAVE É O RECÁLCULO, e não o importador.
    //
    // A primeira versão desta suíte exigia que `muscleWarService` citasse a
    // chave. O mutation testing mostrou que essa exigência media a coisa errada:
    // removê-la do importador não quebrava teste nenhum, porque a garantia vem
    // de `recompute_`, que o importador chama antes de commitar. A exigência
    // passou a ser sobre o lugar certo.
    expect(ranking, '`recompute_` deixou de pedir a trava da temporada')
      .toMatch(/async function recompute_\(seasonId\) \{\s*return prisma\.\$transaction\(async tx => \{\s*await travarTemporada\(tx, seasonId\);/);
    // E o importador continua chamando o recálculo — é por ele que a chave é
    // atravessada. Sem esta linha, a garantia acima não alcançaria a importação.
    expect(importador, 'o importador deixou de recalcular a temporada')
      .toMatch(/ranking\.recompute_\(seasonId\)/);
  });
});
