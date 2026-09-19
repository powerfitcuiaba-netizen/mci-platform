import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// EXCLUIR UMA IMPORTAÇÃO SÃO DUAS OPERAÇÕES DIFERENTES, E CONFUNDI-LAS APAGA
// RESULTADO PUBLICADO.
//
//   LOTE QUE NUNCA FOI APLICADO  não gerou ponto nenhum. Ele é rascunho: some
//   inteiro, com os seus itens, e o ranking sequer sabe que existiu.
//
//   LOTE JÁ APLICADO             gerou RankingPoint no ledger. DELETE físico
//   aqui é perda de histórico esportivo: some a participação do atleta, some
//   a auditoria, e o ranking fica com um buraco que ninguém consegue explicar
//   depois. Este caminho é INVALIDAÇÃO, pelo mesmo mecanismo homologado que
//   invalida um lançamento avulso — a linha continua no histórico, marcada,
//   valendo zero, com o motivo à vista.
//
// O ExternalResult NÃO é removido na invalidação, de propósito: ele é a chave
// de idempotência. Apagá-lo faria a reimportação do mesmo arquivo pontuar de
// novo, que é exatamente o acidente que a invalidação existe para evitar.
// ==========================================================================

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';
const CLASSE = "Men's Bodybuilding - Open Middleweight";

let admin, operador, semPermissao, org, filiacao, season, evento;
let outraOrg, operadorDaOutra;

const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = (n, matricula, colocacao) => `${n},${CLASSE},Atleta,Sobrenome,${matricula},${colocacao}`;

const criarLote = (conteudo, { prefixo = null, ator = null } = {}) =>
  api().post('/api/v1/musclewar/imports').set((ator || operador).auth()).send({
    organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: prefixo || unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  });

const aplicar = loteId => api().post(`/api/v1/musclewar/imports/${loteId}/apply`).set(operador.auth()).send({});

const excluir = (loteId, corpo = {}, ator = null) =>
  api().delete(`/api/v1/musclewar/imports/${loteId}`).set((ator || operador).auth()).send(corpo);

const pontos = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
  select: {
    id: true, categoryId: true, placing: true, placingOriginal: true, points: true,
    placementPoints: true, overallBonus: true, athleteId: true, voidedAt: true,
    voidReason: true, externalResultId: true
  }
}));

const externos = () => comoAtor(admin, tx => tx.externalResult.findMany({
  select: { id: true, externalId: true, appliedAt: true, importItemId: true }
}));

const lotes = () => comoAtor(admin, tx => tx.muscleWarImport.findMany({
  select: { id: true, status: true, appliedCount: true, totalRecords: true }
}));

const itensDoLote = loteId => comoAtor(admin, tx => tx.muscleWarImportItem.findMany({
  where: { importId: loteId }, select: { id: true }
}));

const auditoria = acao => comoAtor(admin, tx => tx.auditLog.findMany({
  where: { action: acao }, select: { action: true, entityId: true, metadata: true, userId: true, organizationId: true }
}));

const criarAtleta = (nome, matricula, semente, organizacao = null, filial = null) =>
  comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: organizacao || org, fullName: nome, sex: 'MALE',
      affiliationId: (filial || filiacao).id, affiliationNumber: matricula,
      identity: { create: { organizationId: organizacao || org, cpf: gerarCpf(semente) } }
    }
  }));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Exclusao' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Exclusao' })).id;

  operador = await criarUsuario({ name: 'Operador Exclusao' });
  for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
    await vincular(org, operador, papel);
  }

  // Alguém DENTRO da organização, mas sem o papel que autoriza mexer em lote.
  semPermissao = await criarUsuario({ name: 'Sem Permissao' });
  await vincular(org, semPermissao, 'ATHLETE');

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  evento = (await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: 'Etapa Exclusao', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  // Segunda federação, para a prova de isolamento.
  outraOrg = (await criarOrganizacao(admin, { name: 'Federacao Vizinha' })).id;
  operadorDaOutra = await criarUsuario({ name: 'Operador Vizinho' });
  for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
    await vincular(outraOrg, operadorDaOutra, papel);
  }
});

// ==========================================================================
// A) LOTE QUE NUNCA FOI APLICADO — exclusão de verdade.
// ==========================================================================
describe('lote nunca aplicado é excluído por inteiro', () => {
  it('some o lote e somem os itens, e o ranking não é tocado', async () => {
    await criarAtleta('ATLETA UM', '88281', 1001);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect(await itensDoLote(lote.id)).toHaveLength(1);

    const r = await excluir(lote.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A resposta precisa dizer QUAL das duas operações aconteceu: é isso que a
    // tela usa para escolher entre "excluída" e "invalidada".
    expect(r.body.operation).toBe('DELETED');

    expect(await lotes(), 'o lote tinha de sumir').toHaveLength(0);
    expect(await itensDoLote(lote.id), 'os itens vão junto').toHaveLength(0);
    expect(await pontos(), 'ranking intocado').toHaveLength(0);
    expect(await externos(), 'nenhum resultado externo existia').toHaveLength(0);
  }, 60_000);

  it('o motivo é OPCIONAL quando nada foi publicado', async () => {
    await criarAtleta('ATLETA UM', '88281', 1002);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;

    const r = await excluir(lote.id, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }, 60_000);

  it('excluído o lote, o MESMO arquivo pode ser reimportado', async () => {
    await criarAtleta('ATLETA UM', '88281', 1003);
    const conteudo = csv([linha(1, '88281', 1)]);
    const prefixo = 'QAREIMPORT';

    const primeiro = (await criarLote(conteudo, { prefixo })).body.import;
    expect((await excluir(primeiro.id)).status).toBe(200);

    // Sem nenhum resíduo, o mesmo identificador externo volta a estar livre.
    const segundo = (await criarLote(conteudo, { prefixo })).body.import;
    expect((await aplicar(segundo.id)).body.applied, 'a reimportação entra normalmente').toBe(1);

    const gravados = await pontos();
    expect(gravados).toHaveLength(1);
    expect(gravados[0].points).toBe(5);
  }, 90_000);
});

// ==========================================================================
// B) LOTE APLICADO — invalidação, nunca DELETE físico.
// ==========================================================================
describe('lote já aplicado é invalidado, e não apagado', () => {
  const loteAplicado = async (semente = 1100) => {
    const atleta = await criarAtleta('ATLETA PUB', '88281', semente);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);
    return { atleta, lote };
  };

  it('o lote CONTINUA existindo, marcado como invalidado', async () => {
    const { lote } = await loteAplicado(1101);

    const r = await excluir(lote.id, { reason: 'arquivo incorreto' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.operation, 'publicado NUNCA é DELETE físico').toBe('INVALIDATED');

    const [gravado] = await lotes();
    expect(gravado, 'o lote publicado não pode sumir do histórico').toBeTruthy();
    expect(gravado.status).toBe('INVALIDATED');
  }, 60_000);

  it('os lançamentos são invalidados pelo mecanismo oficial, não removidos', async () => {
    const { lote } = await loteAplicado(1102);
    expect((await pontos())[0].points).toBe(5);

    expect((await excluir(lote.id, { reason: 'erro na súmula' })).status).toBe(200);

    const gravados = await pontos();
    expect(gravados, 'a linha continua no ledger').toHaveLength(1);

    const [ponto] = gravados;
    expect(ponto.voidedAt, 'invalidada, e não apagada').not.toBeNull();
    expect(ponto.points, 'deixa de pontuar').toBe(0);
    expect(ponto.overallBonus).toBe(0);
    expect(ponto.voidReason, 'o motivo do operador fica gravado na linha').toContain('erro na súmula');
    // O que ACONTECEU é preservado: a colocação de origem continua legível,
    // senão a restauração teria de recalcular às cegas.
    expect(ponto.placingOriginal ?? ponto.placing).toBe(1);
  }, 60_000);

  it('o ranking do atleta deixa de contar os pontos invalidados', async () => {
    const { atleta, lote } = await loteAplicado(1103);

    const antes = await api().get('/api/v1/ranking')
      .set(operador.auth()).query({ seasonId: season });
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);
    expect((antes.body.items || []).find(l => l.athleteId === atleta.id)?.totalPoints,
      'antes da invalidação o atleta pontua').toBe(5);

    expect((await excluir(lote.id, { reason: 'evento incorreto' })).status).toBe(200);

    const depois = await api().get('/api/v1/ranking')
      .set(operador.auth()).query({ seasonId: season });
    expect(depois.status).toBe(200);
    const doAtleta = (depois.body.items || []).find(l => l.athleteId === atleta.id);
    // O agregado ou some, ou fica zerado — as duas leituras significam a mesma
    // coisa: o ponto invalidado não conta mais.
    expect(doAtleta?.totalPoints ?? 0, 'o ponto invalidado não conta mais').toBe(0);
  }, 60_000);

  it('o histórico do atleta preserva a participação, marcada como invalidada', async () => {
    const { atleta, lote } = await loteAplicado(1104);
    expect((await excluir(lote.id, { reason: 'correção administrativa' })).status).toBe(200);

    const historico = await api().get(`/api/v1/athletes/${atleta.id}/ranking-points`)
      .set(operador.auth()).query({ seasonId: season });
    expect(historico.status, JSON.stringify(historico.body)).toBe(200);

    const linhas = historico.body.items || historico.body.points || [];
    expect(linhas.length, 'a participação continua aparecendo').toBeGreaterThan(0);
    expect(linhas.some(l => l.voidedAt), 'e aparece MARCADA como invalidada').toBe(true);
  }, 60_000);

  it('nada de cadastro é apagado junto: atleta, evento, categoria e filiação ficam', async () => {
    const { atleta, lote } = await loteAplicado(1105);
    expect((await excluir(lote.id, { reason: 'resultado duplicado' })).status).toBe(200);

    expect(await comoAtor(admin, tx => tx.athlete.findUnique({ where: { id: atleta.id } })),
      'o atleta não é apagado').toBeTruthy();
    expect(await comoAtor(admin, tx => tx.event.findUnique({ where: { id: evento.id } })),
      'o evento não é apagado').toBeTruthy();
    expect(await comoAtor(admin, tx => tx.affiliation.findUnique({ where: { id: filiacao.id } })),
      'a filiação não é apagada').toBeTruthy();
    expect(await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } }),
      'a categoria não é apagada').toBeTruthy();
  }, 60_000);

  it('o resultado externo é PRESERVADO — ele é a chave de idempotência', async () => {
    const { lote } = await loteAplicado(1106);
    expect((await externos())).toHaveLength(1);

    expect((await excluir(lote.id, { reason: 'erro na súmula' })).status).toBe(200);

    expect(await externos(), 'apagá-lo faria a reimportação pontuar de novo').toHaveLength(1);
  }, 60_000);

  it('reimportar o mesmo arquivo depois de invalidar NÃO duplica pontuação', async () => {
    const atleta = await criarAtleta('ATLETA PUB', '88281', 1107);
    const conteudo = csv([linha(1, '88281', 1)]);
    const prefixo = 'QAINVALIDA';

    const primeiro = (await criarLote(conteudo, { prefixo })).body.import;
    expect((await aplicar(primeiro.id)).body.applied).toBe(1);
    expect((await excluir(primeiro.id, { reason: 'arquivo incorreto' })).status).toBe(200);

    const segundo = (await criarLote(conteudo, { prefixo })).body.import;
    const reaplicacao = await aplicar(segundo.id);
    // A idempotência existente reconhece o identificador externo já aplicado.
    expect(reaplicacao.status === 422 || reaplicacao.body.applied === 0,
      `reimportação duplicou: ${JSON.stringify(reaplicacao.body)}`).toBe(true);

    const gravados = await pontos();
    expect(gravados, 'continua existindo UM lançamento, o invalidado').toHaveLength(1);
    expect(gravados[0].voidedAt).not.toBeNull();
    expect(gravados[0].points).toBe(0);
    expect(gravados[0].athleteId).toBe(atleta.id);
  }, 120_000);

  it('o motivo é OBRIGATÓRIO quando há resultado publicado', async () => {
    const { lote } = await loteAplicado(1108);

    const r = await excluir(lote.id, {});
    expect(r.status, `sem motivo não pode invalidar: ${JSON.stringify(r.body)}`).toBe(422);

    expect((await pontos())[0].voidedAt, 'e nada pode ter sido invalidado').toBeNull();
    expect((await lotes())[0].status).toBe('APPLIED');
  }, 60_000);

  it('invalidar duas vezes é conflito controlado, nunca 500', async () => {
    const { lote } = await loteAplicado(1109);
    expect((await excluir(lote.id, { reason: 'erro na súmula' })).status).toBe(200);

    const segunda = await excluir(lote.id, { reason: 'de novo' });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.status).not.toBe(500);

    expect((await pontos())[0].voidReason, 'o primeiro motivo permanece')
      .toContain('erro na súmula');
  }, 60_000);
});

// ==========================================================================
// AUDITORIA
// ==========================================================================
describe('toda exclusão e toda invalidação ficam registradas', () => {
  it('lote não aplicado: MUSCLEWARE_IMPORT_DELETED com o retrato do que sumiu', async () => {
    await criarAtleta('ATLETA UM', '88281', 1201);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    await excluir(lote.id, { reason: 'arquivo incorreto' });

    const registros = await auditoria('MUSCLEWARE_IMPORT_DELETED');
    expect(registros, 'a exclusão precisa deixar rastro').toHaveLength(1);

    const [registro] = registros;
    expect(registro.entityId).toBe(lote.id);
    expect(registro.organizationId).toBe(org);
    expect(registro.userId, 'quem executou').toBe(operador.id);

    const meta = registro.metadata || {};
    expect(meta.reason).toBe('arquivo incorreto');
    expect(meta.eventId).toBe(evento.id);
    expect(meta.totalRecords).toBe(1);
    expect(meta.statusAnterior).toBeTruthy();
    expect(meta.operation).toBe('DELETED');
  }, 60_000);

  it('lote aplicado: MUSCLEWARE_IMPORT_INVALIDATED, e a auditoria de cada lançamento', async () => {
    await criarAtleta('ATLETA PUB', '88281', 1202);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    await aplicar(lote.id);
    await excluir(lote.id, { reason: 'erro na súmula' });

    const registros = await auditoria('MUSCLEWARE_IMPORT_INVALIDATED');
    expect(registros).toHaveLength(1);

    const meta = registros[0].metadata || {};
    expect(meta.reason).toBe('erro na súmula');
    expect(meta.statusAnterior).toBe('APPLIED');
    expect(meta.statusPosterior).toBe('INVALIDATED');
    expect(meta.pontosInvalidados, 'quantos lançamentos foram atingidos').toBe(1);
    expect(meta.operation).toBe('INVALIDATED');

    // O mecanismo oficial de invalidação de lançamento continua deixando o
    // rastro dele: quem audita uma linha do ranking olha por ali.
    expect(await auditoria('RANKING_POINT_VOIDED'),
      'cada lançamento invalidado tem a sua própria linha de auditoria').toHaveLength(1);
  }, 60_000);

  it('a auditoria NÃO é apagada quando o lote não aplicado some', async () => {
    await criarAtleta('ATLETA UM', '88281', 1203);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    const antes = await comoAtor(admin, tx => tx.auditLog.count());
    expect(antes).toBeGreaterThan(0);

    await excluir(lote.id);

    const depois = await comoAtor(admin, tx => tx.auditLog.count());
    expect(depois, 'auditoria só cresce').toBeGreaterThanOrEqual(antes);
  }, 60_000);
});

// ==========================================================================
// PERMISSÃO E ISOLAMENTO
// ==========================================================================
describe('quem pode excluir', () => {
  it('membro da organização SEM permissão de importação é recusado', async () => {
    await criarAtleta('ATLETA UM', '88281', 1301);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;

    const r = await excluir(lote.id, {}, semPermissao);

    // MEDIDO, e não suposto: a recusa vem como 404, não 403, porque o RLS nega
    // a linha ANTES de a permissão ser conferida — nenhum papel deste sistema
    // enxerga um lote de importação sem também poder aplicá-lo. É a mesma
    // política do lançamento avulso: quem não pode ver não recebe confirmação
    // de que a coisa existe. Negação mais forte que 403, não mais fraca.
    expect([403, 404], `recusa inesperada: ${r.status}`).toContain(r.status);
    expect(r.status, 'o que não pode, em hipótese alguma, é executar').not.toBe(200);

    // A prova de que é o RLS: a linha é invisível para esse usuário.
    const visivel = await comoAtor(semPermissao,
      tx => tx.muscleWarImport.findUnique({ where: { id: lote.id }, select: { id: true } }));
    expect(visivel, 'o RLS é quem nega, e nega escondendo').toBeNull();

    expect(await lotes(), 'e o lote continua lá').toHaveLength(1);
  }, 60_000);

  it('operador de OUTRA organização não alcança o lote', async () => {
    await criarAtleta('ATLETA UM', '88281', 1302);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;

    const r = await excluir(lote.id, { reason: 'tentativa' }, operadorDaOutra);
    expect([403, 404], `IDOR: respondeu ${r.status}`).toContain(r.status);

    expect(await lotes(), 'nada foi excluído').toHaveLength(1);
  }, 60_000);

  it('identificador inexistente responde 404, sem vazar existência', async () => {
    const r = await excluir('cmu0000000000000000000000', { reason: 'lote inexistente' });
    expect(r.status).toBe(404);
  }, 60_000);

  it('identificador malformado não derruba a rota', async () => {
    const r = await excluir('../../etc/passwd', { reason: 'entrada manipulada' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status, 'nunca 500 por entrada manipulada').toBeLessThan(500);
  }, 60_000);
});

// ==========================================================================
// CONCORRÊNCIA
// ==========================================================================
describe('chamadas simultâneas', () => {
  it('vinte exclusões do mesmo lote não aplicado: uma vence, nenhuma quebra', async () => {
    await criarAtleta('ATLETA UM', '88281', 1401);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;

    const respostas = await Promise.all(
      Array.from({ length: 20 }, () => excluir(lote.id, { reason: 'corrida' }))
    );
    const status = respostas.map(r => r.status);

    expect(status.filter(s => s === 200), 'exatamente uma execução').toHaveLength(1);
    expect(status.filter(s => s >= 500), `500 em corrida normal: ${status.join(',')}`).toHaveLength(0);
    expect(status.every(s => s === 200 || s === 404 || s === 409),
      `status fora do contrato: ${status.join(',')}`).toBe(true);

    expect(await lotes()).toHaveLength(0);
  }, 120_000);

  it('vinte invalidações do mesmo lote publicado: uma vence, o ledger fica íntegro', async () => {
    await criarAtleta('ATLETA PUB', '88281', 1402);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const respostas = await Promise.all(
      Array.from({ length: 20 }, (_, i) => excluir(lote.id, { reason: `corrida ${i}` }))
    );
    const status = respostas.map(r => r.status);

    expect(status.filter(s => s === 200), 'exatamente uma invalidação').toHaveLength(1);
    expect(status.filter(s => s >= 500), `500 em corrida normal: ${status.join(',')}`).toHaveLength(0);

    const gravados = await pontos();
    expect(gravados, 'nenhuma linha duplicada nem removida').toHaveLength(1);
    expect(gravados[0].voidedAt).not.toBeNull();
    expect(gravados[0].points).toBe(0);

    expect(await auditoria('MUSCLEWARE_IMPORT_INVALIDATED'),
      'uma auditoria de lote, não vinte').toHaveLength(1);
  }, 180_000);
});

// ==========================================================================
// OS CASOS QUE O MUTATION TESTING MOSTROU QUE FALTAVAM.
//
// A primeira rodada matou 6 de 12 mutantes. Os sobreviventes não eram ruído:
// cada um apontava um caminho que nenhum teste percorria, e um deles apontava
// para uma guarda que os papéis do sistema nunca alcançam.
// ==========================================================================

describe('a autorização é conferida mesmo quando o RLS deixa ver', () => {
  it('quem VÊ o lote e não pode aplicá-lo recebe 403, não 404', async () => {
    // A recusa por 404 dos outros testes vem do RLS escondendo a linha, e por
    // isso não exercita `assertCan`: o mutante que apagava a autorização
    // sobrevivia inteiro. `RESULTS_OPERATOR` está na lista de operadores da
    // política de RLS — enxerga o lote — e NÃO tem `musclewar.apply`. É aqui
    // que a autorização é a única coisa entre o usuário e a exclusão.
    const operadorDeResultados = await criarUsuario({ name: 'Operador de Resultados' });
    await vincular(org, operadorDeResultados, 'RESULTS_OPERATOR');

    await criarAtleta('ATLETA UM', '88281', 1501);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;

    // A premissa do teste, medida e não suposta: ele CONSEGUE ver a linha.
    const visivel = await comoAtor(operadorDeResultados,
      tx => tx.muscleWarImport.findUnique({ where: { id: lote.id }, select: { id: true } }));
    expect(visivel, 'sem isto o teste não estaria exercitando a autorização').toBeTruthy();

    const r = await excluir(lote.id, { reason: 'tentativa' }, operadorDeResultados);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await lotes(), 'e o lote continua lá').toHaveLength(1);
  }, 60_000);

  it('nenhum papel pode APLICAR importação sem também responder pelo ranking', async () => {
    // Esta é a demonstração de que a segunda guarda (`ranking.manage` na
    // invalidação) é hoje inalcançável por papel — e a garantia de que ela
    // deixa de ser no dia em que alguém criar um papel que aplique importação
    // sem responder pelo ledger. Nesse dia este teste falha e a guarda passa a
    // ter caso de uso, em vez de virar código morto silencioso.
    const { ROLE_PERMISSIONS, permissionsForRole } = await import('../src/utils/permissions.js')
      .then(m => m.default ?? m);

    const infratores = Object.keys(ROLE_PERMISSIONS).filter(papel => {
      const permissoes = permissionsForRole(papel);
      return permissoes.has('musclewar.apply') && !permissoes.has('ranking.manage');
    });

    expect(infratores,
      `papéis que aplicam importação sem ranking.manage: ${infratores.join(', ')}`).toEqual([]);
  }, 60_000);
});

describe('o que decide o caminho é o LEDGER, não o rótulo do lote', () => {
  it('lote com lançamento vivo é invalidado mesmo com status diferente de APPLIED', async () => {
    await criarAtleta('ATLETA PUB', '88281', 1601);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    // O rótulo é adulterado de propósito: é o que aconteceria com um lote
    // antigo, migrado, ou com um estado gravado por um caminho que ainda não
    // existe. O ponto continua valendo 5 no ranking.
    await comoAtor(admin, tx => tx.muscleWarImport.update({
      where: { id: lote.id }, data: { status: 'PREVIEWED' }
    }));

    const r = await excluir(lote.id, { reason: 'rótulo divergente' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.operation, 'com ponto vivo, NUNCA apagar').toBe('INVALIDATED');

    expect(await lotes(), 'o lote não pode sumir').toHaveLength(1);
    const [ponto] = await pontos();
    expect(ponto.voidedAt).not.toBeNull();
    expect(ponto.points).toBe(0);
  }, 60_000);
});

describe('invalidar preserva a LINHA, e não só um estado parecido com ela', () => {
  it('o lançamento mantém o mesmo id depois de invalidado', async () => {
    await criarAtleta('ATLETA PUB', '88281', 1701);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const [antes] = await pontos();

    expect((await excluir(lote.id, { reason: 'erro na súmula' })).status).toBe(200);

    const [depois] = await pontos();
    // Apagar e recriar produziria uma linha com os mesmos VALORES e outra
    // identidade — e toda a auditoria que aponta para o id antigo passaria a
    // apontar para o nada. O id é o que liga a linha à sua própria história.
    expect(depois.id, 'invalidar não pode trocar a linha por uma cópia').toBe(antes.id);
    expect(depois.externalResultId).toBe(antes.externalResultId);
    expect(depois.athleteId).toBe(antes.athleteId);
  }, 60_000);

  it('lançamento já invalidado avulso NÃO é reinvalidado pelo lote', async () => {
    await criarAtleta('ATLETA PUB', '88281', 1702);
    const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const [ponto] = await pontos();
    const avulsa = await api().post(`/api/v1/ranking/points/${ponto.id}/void`)
      .set(operador.auth()).send({ reason: 'desclassificado na súmula' });
    expect(avulsa.status, JSON.stringify(avulsa.body)).toBe(200);

    expect((await excluir(lote.id, { reason: 'arquivo incorreto' })).status).toBe(200);

    const [depois] = await pontos();
    // O motivo da desclassificação é um FATO ESPORTIVO; o da invalidação do
    // lote é administrativo. Sobrescrever o primeiro pelo segundo apagaria a
    // razão pela qual o atleta não pontuou.
    expect(depois.voidReason, 'o motivo original não pode ser sobrescrito')
      .toContain('desclassificado na súmula');
  }, 60_000);
});

describe('invalidar um lote não encosta nos lançamentos de outro', () => {
  it('dois lotes aplicados: só o alvo é invalidado', async () => {
    await criarAtleta('ATLETA A', '88281', 1801);
    await criarAtleta('ATLETA B', '88282', 1802);

    const alvo = (await criarLote(csv([linha(1, '88281', 1)]), { prefixo: 'QAALVO' })).body.import;
    expect((await aplicar(alvo.id)).body.applied).toBe(1);

    const vizinho = (await criarLote(csv([linha(1, '88282', 2)]), { prefixo: 'QAVIZINHO' })).body.import;
    expect((await aplicar(vizinho.id)).body.applied).toBe(1);

    expect(await pontos()).toHaveLength(2);

    expect((await excluir(alvo.id, { reason: 'arquivo incorreto' })).status).toBe(200);

    const gravados = await pontos();
    expect(gravados).toHaveLength(2);

    const invalidados = gravados.filter(p => p.voidedAt);
    expect(invalidados, 'um lote invalidado, um lançamento invalidado').toHaveLength(1);

    const vivo = gravados.find(p => !p.voidedAt);
    expect(vivo.points, 'o lote vizinho continua pontuando').toBe(4);
  }, 120_000);
});

describe('invalidação avulsa e invalidação de lote na MESMA linha, ao mesmo tempo', () => {
  it('a linha é invalidada UMA vez só, e a auditoria registra uma', async () => {
    // O MUTANTE QUE ESTE TESTE EXISTE PARA MATAR remove a RE-LEITURA sob a
    // trava da temporada em `voidRankingPoints`, fazendo a função trabalhar
    // sobre a lista lida ANTES de travar.
    //
    // Sequencialmente o defeito não aparece: o filtro de `aInvalidar` já
    // descarta o que estava invalidado quando a lista foi montada. Ele só
    // aparece quando alguém invalida a linha DEPOIS dessa leitura e ANTES de o
    // lote conseguir a trava — e então o lote invalida de novo por cima,
    // sobrescrevendo o motivo e gravando uma segunda auditoria para um fato
    // que aconteceu uma vez.
    //
    // Cinco rodadas porque é corrida: o intercalamento não é garantido em
    // nenhuma delas, mas o defeito, quando existe, é visível em qualquer uma.
    for (let rodada = 0; rodada < 5; rodada += 1) {
      await limparBanco();

      admin = await criarUsuario({ role: 'SUPER_ADMIN', name: `Admin R${rodada}` });
      org = (await criarOrganizacao(admin, { name: `Federacao R${rodada}` })).id;
      operador = await criarUsuario({ name: `Operador R${rodada}` });
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
        organizationId: org, name: 'Etapa', slug: unico('ev'),
        startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
      })).body;

      await criarAtleta('ATLETA PUB', '88281', 1900 + rodada);
      const lote = (await criarLote(csv([linha(1, '88281', 1)]))).body.import;
      expect((await aplicar(lote.id)).body.applied).toBe(1);
      const [ponto] = await pontos();

      await Promise.all([
        api().post(`/api/v1/ranking/points/${ponto.id}/void`)
          .set(operador.auth()).send({ reason: 'desclassificado na súmula' }),
        excluir(lote.id, { reason: 'arquivo incorreto' })
      ]);

      const gravados = await pontos();
      expect(gravados, `rodada ${rodada}: a linha não pode se multiplicar`).toHaveLength(1);
      expect(gravados[0].voidedAt, `rodada ${rodada}`).not.toBeNull();
      expect(gravados[0].points, `rodada ${rodada}`).toBe(0);

      // A invariante que mata o mutante: UM fato, UMA auditoria. Invalidar
      // duas vezes a mesma linha grava duas — e a segunda descreve uma
      // transição que nunca existiu, de válida para inválida, quando a linha
      // já estava inválida.
      const auditadas = await auditoria('RANKING_POINT_VOIDED');
      expect(auditadas.length,
        `rodada ${rodada}: ${auditadas.length} auditorias para uma invalidação`).toBe(1);
    }
  }, 240_000);
});
