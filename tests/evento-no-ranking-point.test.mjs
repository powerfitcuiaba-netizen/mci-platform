import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// A TRILHA EVENTO → RANKINGPOINT.
//
// O caminho interno (`source: 'EVENT'`) grava `eventId: result.eventId` no
// lançamento. O caminho da IMPORTAÇÃO não grava nada: o evento sobrevive
// apenas como texto livre (`eventName`, `eventDate`) no ExternalResult.
//
// Isso não é cosmético. A regra homologada diz que o Overall vale +10
// exatamente uma vez POR EVENTO. Sem `eventId` na linha do ledger, a
// plataforma não tem como verificar essa unicidade nos próprios dados — e,
// quando o Ipiranga for seguido de um segundo e de um terceiro campeonato,
// não há como responder "de qual evento veio este ponto?" sem atravessar o
// ExternalResult e confiar num nome digitado no arquivo.
//
// Estes testes nascem VERMELHOS de propósito.
// ==========================================================================

const CLASSE = "Men's Bodybuilding - Open";
const cabecalho = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';

let admin, operador, org, season, athlete;
let eventoA, eventoB;

const csv = linhas => [cabecalho, ...linhas].join('\n');
const linha = (matricula, colocacao = 1, n = 1, classe = CLASSE) =>
  `${n},${classe},Atleta,Sobrenome,${matricula},${colocacao}`;

const criarLote = (conteudo, extras = {}, quem = null) =>
  api().post('/api/v1/musclewar/imports').set((quem ?? operador).auth()).send({
    organizationId: org, seasonId: season, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC', ...extras
  });

const criarEvento = (organizacao, quem, nome, seasonId) =>
  api().post('/api/v1/events').set(quem.auth()).send({
    organizationId: organizacao, name: nome, slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Sao Paulo', state: 'SP',
    ...(seasonId ? { seasonId } : {})
  });

const pontos = quem => comoAtor(quem ?? admin, tx => tx.rankingPoint.findMany({
  select: { id: true, eventId: true, athleteId: true, points: true, overallBonus: true, source: true }
}));

async function montar(nome, semente) {
  const adm = await criarUsuario({ role: 'SUPER_ADMIN', name: `Admin ${nome}` });
  const organizacao = await criarOrganizacao(adm, { name: nome });

  const op = await criarUsuario({ name: `Operador ${nome}` });
  await vincular(organizacao.id, op, 'RANKING_MANAGER');
  await vincular(organizacao.id, op, 'REGISTRATION_OPERATOR');
  await vincular(organizacao.id, op, 'EVENT_DIRECTOR');

  const fil = (await api().post('/api/v1/affiliations').set(adm.auth())
    .send({ organizationId: organizacao.id, name: 'NPC', code: 'NPC' })).body;

  const temporada = (await api().post('/api/v1/seasons').set(adm.auth())
    .send({ organizationId: organizacao.id, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${temporada}/points-rules`).set(adm.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  const atleta = await comoAtor(op, tx => tx.athlete.create({
    data: {
      organizationId: organizacao.id, fullName: `ATLETA ${nome}`, sex: 'MALE',
      affiliationId: fil.id, affiliationNumber: '88281',
      identity: { create: { organizationId: organizacao.id, cpf: gerarCpf(semente) } }
    }
  }));

  return { admin: adm, org: organizacao.id, operador: op, filiacao: fil, season: temporada, athlete: atleta };
}

// A matrícula do atleta cadastrado: a linha nasce MATCHED e chega ao /apply.
const MATRICULA = '88281';

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  const a = await montar('Federacao A', 951);
  admin = a.admin; org = a.org; operador = a.operador;
  season = a.season; athlete = a.athlete;

  eventoA = (await criarEvento(org, operador, 'Etapa Ipiranga QA', season)).body;
  eventoB = (await criarEvento(org, operador, 'Etapa Anhembi QA', season)).body;
});

describe('A2.1–A2.3 — o ponto carrega o evento de onde veio', () => {
  it('lote com evento válido produz RankingPoint com o eventId do lote', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    expect(lote.eventId).toBe(eventoA.id);

    expect((await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({})).status).toBe(200);

    const [ponto] = await pontos();
    expect(ponto.eventId).toBe(eventoA.id);
  });

  it('dois lotes em eventos diferentes mantêm cada ponto no seu evento', async () => {
    const loteA = (await criarLote(csv([linha(MATRICULA, 1)]), { eventId: eventoA.id })).body.import;
    const loteB = (await criarLote(csv([linha(MATRICULA, 2)]), { eventId: eventoB.id })).body.import;

    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operador.auth()).send({});
    await api().post(`/api/v1/musclewar/imports/${loteB.id}/apply`).set(operador.auth()).send({});

    const todos = await pontos();
    expect(todos).toHaveLength(2);
    expect(new Set(todos.map(p => p.eventId))).toEqual(new Set([eventoA.id, eventoB.id]));
    // O mesmo atleta nos dois: nenhum dos pontos pode ficar órfão de evento.
    expect(todos.every(p => p.athleteId === athlete.id)).toBe(true);
    expect(todos.some(p => p.eventId === null)).toBe(false);
  });

  it('o mesmo atleta em dois eventos gera dois lançamentos distintos, um por evento', async () => {
    const loteA = (await criarLote(csv([linha(MATRICULA, 1)]), { eventId: eventoA.id })).body.import;
    const loteB = (await criarLote(csv([linha(MATRICULA, 3)]), { eventId: eventoB.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operador.auth()).send({});
    await api().post(`/api/v1/musclewar/imports/${loteB.id}/apply`).set(operador.auth()).send({});

    const todos = await pontos();
    const porEvento = Object.fromEntries(todos.map(p => [p.eventId, p.points]));
    expect(porEvento[eventoA.id]).toBe(5);
    expect(porEvento[eventoB.id]).toBe(3);
  });
});

describe('A2.4–A2.5 — idempotência não perde nem troca o evento', () => {
  it('reaplicar o mesmo lote não cria segundo ponto e não altera o eventId', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});
    const depoisDaPrimeira = await pontos();
    expect(depoisDaPrimeira).toHaveLength(1);
    expect(depoisDaPrimeira[0].eventId).toBe(eventoA.id);

    for (let i = 0; i < 5; i += 1) {
      await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});
    }
    expect(await pontos()).toEqual(depoisDaPrimeira);
  }, 60_000);

  it('vinte aplicações simultâneas preservam um único ponto, com o evento certo', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    const respostas = await Promise.all(Array.from({ length: 20 }, () =>
      api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({})));
    expect(respostas.filter(r => r.status >= 500)).toHaveLength(0);

    const todos = await pontos();
    expect(todos).toHaveLength(1);
    expect(todos[0].eventId).toBe(eventoA.id);
  }, 120_000);
});

describe('A2.6 — lote sem evento: o caso legítimo, declarado', () => {
  it('sem eventId o ponto fica sem evento, e isso é o comportamento definido', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]))).body.import;
    expect(lote.eventId ?? null).toBeNull();
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});

    const [ponto] = await pontos();
    // NÃO é defeito: `MuscleWarImport.eventId` é opcional no schema, e existe
    // resultado histórico cujo evento nunca foi cadastrado na plataforma. O
    // que o teste fixa é que a ausência é a ÚNICA origem de um ponto órfão —
    // um lote COM evento jamais pode produzir isto.
    expect(ponto.eventId).toBeNull();
  });
});

describe('A2.7–A2.9 + Parte C — o destino do lote não se adultera', () => {
  it('não existe porta que troque o evento de um lote já criado', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;

    const tentativas = await Promise.all([
      api().patch(`/api/v1/musclewar/imports/${lote.id}`).set(operador.auth()).send({ eventId: eventoB.id }),
      api().put(`/api/v1/musclewar/imports/${lote.id}`).set(operador.auth()).send({ eventId: eventoB.id })
    ]);
    for (const r of tentativas) expect(r.status).toBeGreaterThanOrEqual(400);

    const depois = await comoAtor(admin, tx => tx.muscleWarImport.findUnique({ where: { id: lote.id } }));
    expect(depois.eventId).toBe(eventoA.id);
  });

  it('eventId no corpo do /apply não redireciona a publicação', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    expect((await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({ eventId: eventoB.id })).status).toBe(200);

    const [ponto] = await pontos();
    expect(ponto.eventId).toBe(eventoA.id);
  });

  it('evento inexistente é recusado na criação do lote', async () => {
    const r = await criarLote(csv([linha(MATRICULA)]), { eventId: 'ckzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await pontos()).toHaveLength(0);
  });

  it('evento de OUTRA organização é recusado — cross-tenant bloqueado', async () => {
    const b = await montar('Federacao B', 952);
    const eventoDeB = (await criarEvento(b.org, b.operador, 'Etapa da B', b.season)).body;

    const r = await criarLote(csv([linha(MATRICULA)]), { eventId: eventoDeB.id });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/EVENT_INVALID/);
    expect(await pontos()).toHaveLength(0);
  });
});

describe('Parte D — Overall permanece preso ao seu evento', () => {
  // O título é DECLARADO pela origem, nunca calculado: o arquivo traz a marca
  // e a regra homologada soma +10 — e só na absoluta.
  const cabecalhoOverall = `${cabecalho},Overall`;
  const csvOverall = linhas => [cabecalhoOverall, ...linhas].join('\n');
  const comOverall = (colocacao, n, classe) =>
    `${n},${classe},Atleta,Sobrenome,${MATRICULA},${colocacao},Overall`;

  const OPEN = "Men's Bodybuilding - Open";
  const NOVICE = "Men's Bodybuilding - Novice";

  it('Overall declarado no evento A não contamina o evento B', async () => {
    const loteA = (await criarLote(csvOverall([comOverall(1, 1, OPEN)]), { eventId: eventoA.id })).body.import;
    const loteB = (await criarLote(csv([linha(MATRICULA, 1, 1, OPEN)]), { eventId: eventoB.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${loteA.id}/apply`).set(operador.auth()).send({});
    await api().post(`/api/v1/musclewar/imports/${loteB.id}/apply`).set(operador.auth()).send({});

    const todos = await pontos();
    const noA = todos.find(p => p.eventId === eventoA.id);
    const noB = todos.find(p => p.eventId === eventoB.id);
    expect(noA, 'o ponto do evento A existe e sabe que é do evento A').toBeDefined();
    expect(noB, 'o ponto do evento B existe e sabe que é do evento B').toBeDefined();
    // O bônus vive só no evento onde o título foi declarado.
    expect(noA.overallBonus).toBe(10);
    expect(noB.overallBonus).toBe(0);
    expect(noB.points).toBe(5);
  });

  it('Overall declarado FORA da absoluta não vale bônus — a regra não mudou', async () => {
    // Regra homologada: o +10 acompanha a participação na Open/absoluta. Um
    // arquivo que marque Overall numa linha Novice não compra bônus nenhum.
    const lote = (await criarLote(csvOverall([comOverall(1, 1, NOVICE)]), { eventId: eventoA.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});

    const [ponto] = await pontos();
    expect(ponto.eventId).toBe(eventoA.id);
    expect(ponto.overallBonus).toBe(0);
    expect(ponto.points).toBe(5);
  });

  it('reaplicar o lote não soma o bônus de novo', async () => {
    const lote = (await criarLote(csvOverall([comOverall(1, 1, OPEN)]), { eventId: eventoA.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});
    const depois = await pontos();
    expect(depois).toHaveLength(1);
    expect(depois[0].overallBonus).toBe(10);
    expect(depois[0].points).toBe(15);

    for (let i = 0; i < 3; i += 1) {
      await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});
    }
    expect(await pontos()).toEqual(depois);
  }, 60_000);
});

describe('Parte E — o histórico consegue nomear o evento', () => {
  it('a cadeia Import → Item → ExternalResult → RankingPoint → Event não se rompe', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});

    const [ponto] = await comoAtor(admin, tx => tx.rankingPoint.findMany({
      include: { event: true, externalResult: { include: { importItem: true } } }
    }));
    expect(ponto.event).not.toBeNull();
    expect(ponto.event.name).toBe('Etapa Ipiranga QA');
    expect(ponto.externalResult).not.toBeNull();
    expect(ponto.externalResult.importItem.importId).toBe(lote.id);
  });
});

// ==========================================================================
// A CONFERÊNCIA DA PONTUAÇÃO DECLARADA TAMBÉM LÊ A ELEGIBILIDADE.
//
// Achado por mutação: zerar `superOverallEligible` dentro de `analisarLinha`
// sobrevivia à suíte inteira. O efeito do mutante não é cosmético — a análise
// alimenta `conferirPontuacaoImportada`, e sem a elegibilidade ela calcula 5
// onde o arquivo informa 15, marca CONFLICT onde não há, e linha em CONFLICT
// NÃO é aplicada. Ou seja: o campeão Overall perderia os pontos, e a prévia
// diria que o arquivo está errado quando o errado é o cálculo.
//
// Nenhum teste cobria isto porque nenhum importava arquivo COM coluna de
// pontos junto de Overall e classe absoluta — as três condições precisam
// coincidir para a conferência ter o que comparar.
// ==========================================================================
describe('conferência da pontuação declarada — a elegibilidade entra na conta', () => {
  const cabecalhoCompleto = `${cabecalho},Overall,Points`;
  const comPontos = (classe, colocacao, overall, pontos) =>
    [cabecalhoCompleto, `1,${classe},Atleta,Sobrenome,${MATRICULA},${colocacao},${overall},${pontos}`].join('\n');

  const OPEN_BB = "Men's Bodybuilding - Open";
  const NOVICE_BB = "Men's Bodybuilding - Novice";

  it('Open 1º + Overall declarando 15 no arquivo NÃO acusa divergência', async () => {
    const lote = (await criarLote(comPontos(OPEN_BB, 1, 'Overall', 15), { eventId: eventoA.id })).body;
    const [item] = lote.items;
    expect(item.pointsMismatch ?? null).toBeNull();
    expect(item.matchStatus).toBe('MATCHED');

    expect((await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`)
      .set(operador.auth()).send({})).status).toBe(200);
    const [ponto] = await pontos();
    expect(ponto.points).toBe(15);
    expect(ponto.eventId).toBe(eventoA.id);
  });

  it('Open 1º + Overall declarando 5 acusa a divergência, com os três números', async () => {
    const lote = (await criarLote(comPontos(OPEN_BB, 1, 'Overall', 5), { eventId: eventoA.id })).body;
    const [item] = lote.items;
    expect(item.pointsMismatch).toEqual({ importedPoints: 5, calculatedPoints: 15, difference: -10 });
  });

  it('Novice 1º + Overall declarando 15 acusa divergência — fora da absoluta não há bônus', async () => {
    const lote = (await criarLote(comPontos(NOVICE_BB, 1, 'Overall', 15), { eventId: eventoA.id })).body;
    const [item] = lote.items;
    expect(item.pointsMismatch).toEqual({ importedPoints: 15, calculatedPoints: 5, difference: 10 });
  });
});

// ==========================================================================
// A INVARIANTE DO LANÇAMENTO MUSCLEWAR — O QUE VALE E O QUE NÃO VALE.
//
// Os ciclos terminaram com 2 RankingPoint `source: MUSCLEWAR` sem
// `externalResultId` e sem `eventId`, e a pergunta certa foi feita: isso é
// artefato de teste ou porta aberta no produto? São coisas diferentes, e a
// resposta é diferente para cada campo.
//
//   `externalResultId` — o fluxo público NUNCA produz nulo. `aplicarLote`
//   cria o ExternalResult e grava o id na mesma transação; sem ele não há
//   idempotência, porque é `externalResultId @unique` que impede o segundo
//   lançamento. Um ponto MUSCLEWAR órfão de resultado externo só existe se
//   alguém escrever direto no banco — e é exatamente isso que o fixture de
//   `ranking-temporada-padrao` faz, por ser teste de LEITURA.
//
//   `eventId` — pode ser nulo, e isso é DESENHO, não falha:
//   `MuscleWarImport.eventId` é opcional, e existe resultado histórico cujo
//   evento nunca foi cadastrado na plataforma. O que não pode acontecer é o
//   ponto divergir do lote: se o lote declara evento, o ponto carrega AQUELE
//   evento, nunca outro e nunca nulo.
//
// É esta segunda formulação que estes testes trancam. Exigir evento sempre
// seria decisão de homologação, não de implementação.
// ==========================================================================
describe('invariante do lançamento MUSCLEWAR', () => {
  const lancamentosMuscleWar = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
    where: { source: 'MUSCLEWAR' },
    select: { eventId: true, externalResultId: true, athleteId: true }
  }));

  it('publicado COM evento: o ponto carrega o evento do lote e o resultado externo', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]), { eventId: eventoA.id })).body.import;
    expect((await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({})).status).toBe(200);

    const lancamentos = await lancamentosMuscleWar();
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0].eventId).toBe(lote.eventId);
    expect(lancamentos[0].externalResultId).not.toBeNull();
  });

  it('publicado SEM evento: eventId nulo é o caso legítimo, mas o resultado externo continua obrigatório', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]))).body.import;
    expect(lote.eventId ?? null).toBeNull();
    expect((await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({})).status).toBe(200);

    const lancamentos = await lancamentosMuscleWar();
    expect(lancamentos).toHaveLength(1);
    // O ponto acompanha o lote: lote sem evento, ponto sem evento.
    expect(lancamentos[0].eventId).toBeNull();
    // E mesmo sem evento, a âncora de idempotência existe.
    expect(lancamentos[0].externalResultId).not.toBeNull();
  });

  it('NENHUM lançamento publicado pelo fluxo fica órfão de resultado externo', async () => {
    // Três lotes, dois com evento e um sem, e um deles reaplicado: a varredura
    // final não pode achar um único ponto MUSCLEWAR sem `externalResultId`.
    const comA = (await criarLote(csv([linha(MATRICULA, 1)]), { eventId: eventoA.id })).body.import;
    const comB = (await criarLote(csv([linha(MATRICULA, 2)]), { eventId: eventoB.id })).body.import;
    const semEvento = (await criarLote(csv([linha(MATRICULA, 3)]))).body.import;

    for (const lote of [comA, comB, semEvento, comA]) {
      await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(operador.auth()).send({});
    }

    const lancamentos = await lancamentosMuscleWar();
    expect(lancamentos).toHaveLength(3);
    expect(lancamentos.filter(l => l.externalResultId === null)).toHaveLength(0);
    // E cada um no seu evento — o sem evento é o único nulo.
    expect(lancamentos.map(l => l.eventId).sort())
      .toEqual([eventoA.id, eventoB.id, null].sort());
  }, 60_000);

  it('o ponto nunca herda um evento que o lote não declarou', async () => {
    const lote = (await criarLote(csv([linha(MATRICULA)]))).body.import;
    // Tentativa de injetar o evento na hora de publicar, já coberta acima para
    // lote COM evento; aqui o lote não tem nenhum, e o corpo não pode criar um.
    await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
      .set(operador.auth()).send({ eventId: eventoA.id });

    const [lancamento] = await lancamentosMuscleWar();
    expect(lancamento.eventId).toBeNull();
  });
});
