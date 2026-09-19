import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// CORRIGIR UMA SÚMULA DEPOIS DE PUBLICADA — SEM DESTRUIR A HISTÓRIA.
//
// O caminho INTERNO já sabia fazer isso: `results.override` grava um
// `ResultVersion` com snapshot e motivo, e a apuração é refeita. O caminho
// IMPORTADO não sabia. Depois do `/apply`, um 3º que era 2º ficava errado para
// sempre, e a única "saída" seria mexer no ledger por fora — exatamente o que
// as regras proíbem.
//
// O QUE ESTES TESTES TRANCAM, e por quê:
//
//   * corrigir recalcula pelo MOTOR, nunca por número digitado. Aceitar pontos
//     do operador abriria a porta que a importação fechou ao recusar a coluna
//     de pontos do arquivo;
//   * invalidar ZERA o que pontua e PRESERVA o que aconteceu. Apagar a linha
//     faria a participação sumir do histórico do atleta;
//   * restaurar volta ao estado anterior, e não a um estado recalculado do
//     nada — por isso a colocação original é guardada;
//   * motivo é obrigatório nas três. Correção sem motivo é indistinguível de
//     adulteração seis meses depois;
//   * o invariante `Ranking.totalPoints === SUM(RankingPoint.points)` vale
//     depois de cada operação;
//   * lançamento invalidado não carrega bônus de Overall.
// ==========================================================================

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';
const OPEN = "Men's Bodybuilding - Open";
const csv = linhas => [CABECALHO, ...linhas].join('\n');
const linha = (matricula, colocacao, n = 1, classe = OPEN) =>
  `${n},${classe},Atleta,Sobrenome,${matricula},${colocacao}`;

let admin, operador, org, filiacao, season, evento, atleta, categoriaBB;

const lancamentos = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
  orderBy: { createdAt: 'asc' },
  select: {
    id: true, source: true, eventId: true, athleteId: true, placing: true,
    placingOriginal: true, placementPoints: true, overallBonus: true, points: true,
    didNotShow: true, voidedAt: true, voidReason: true, voidedById: true,
    superOverallPoints: true, isOverallChampion: true
  }
}));

const totalNoRanking = async () => {
  const r = await api().get('/api/v1/ranking').set(admin.auth())
    .query({ organizationId: org, seasonId: season });
  // SOMA, e não `find`. Um atleta com participações em duas categorias tem
  // uma linha de ranking em cada recorte, e pegar "a primeira que casa" faria
  // o teste depender da ordem da resposta — exatamente o tipo de acoplamento
  // que produz falha intermitente sem defeito nenhum por trás.
  return r.body.items
    .filter(i => i.athlete.id === atleta.id)
    .reduce((soma, i) => soma + i.totalPoints, 0);
};

const somaDoLedger = async () =>
  (await lancamentos()).reduce((t, p) => t + p.points, 0);

const importarEAplicar = async conteudo => {
  const criacao = await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  });
  expect(criacao.status, JSON.stringify(criacao.body)).toBe(201);
  const lote = criacao.body.import;
  expect((await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
    .set(operador.auth()).send({})).status).toBe(200);
  return lote;
};

const corrigir = (id, corpo, quem) =>
  api().patch(`/api/v1/ranking/points/${id}`).set((quem ?? operador).auth()).send(corpo);
const invalidar = (id, corpo, quem) =>
  api().post(`/api/v1/ranking/points/${id}/void`).set((quem ?? operador).auth()).send(corpo);
const restaurar = (id, corpo, quem) =>
  api().post(`/api/v1/ranking/points/${id}/restore`).set((quem ?? operador).auth()).send(corpo);
const previa = (id, params, quem) =>
  api().get(`/api/v1/ranking/points/${id}/preview`).set((quem ?? operador).auth()).query(params);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  const organizacao = await criarOrganizacao(admin, { name: 'Federacao Correcao' });
  org = organizacao.id;

  operador = await criarUsuario({ name: 'Operador' });
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
    organizationId: org, name: 'Etapa A', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  categoriaBB = await comoAtor(admin, tx => tx.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } }));

  atleta = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: 'ATLETA CORRECAO', sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: org, cpf: gerarCpf(551) } }
    }
  }));
});

describe('corrigir a colocação de um lançamento publicado', () => {
  it('3º vira 2º: os pontos sobem de 3 para 4, recalculados pelo motor', async () => {
    await importarEAplicar(csv([linha('88281', 3)]));
    const [antes] = await lancamentos();
    expect(antes.points).toBe(3);

    const r = await corrigir(antes.id, { placing: 2, reason: 'Correcao conforme sumula oficial' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const [depois] = await lancamentos();
    expect(depois.placing).toBe(2);
    expect(depois.placementPoints).toBe(4);
    expect(depois.points).toBe(4);
    // A colocação com que nasceu fica guardada — é o que permite restaurar.
    expect(depois.placingOriginal).toBe(3);
    expect(await totalNoRanking()).toBe(4);
    expect(await somaDoLedger()).toBe(4);
  }, 60_000);

  it('5º vira 6º: fora da tabela vale zero, e a linha continua existindo', async () => {
    await importarEAplicar(csv([linha('88281', 5)]));
    const [antes] = await lancamentos();
    expect(antes.points).toBe(1);

    expect((await corrigir(antes.id, { placing: 6, reason: 'Correcao conforme sumula' })).status).toBe(200);

    const depois = await lancamentos();
    expect(depois, 'a participação não some por valer zero').toHaveLength(1);
    expect(depois[0].placing).toBe(6);
    expect(depois[0].points).toBe(0);
    expect(await totalNoRanking()).toBe(0);
  }, 60_000);

  it('colocação vira NS: zera os pontos e marca a ausência', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [antes] = await lancamentos();

    expect((await corrigir(antes.id, { didNotShow: true, reason: 'Atleta nao subiu ao palco' })).status).toBe(200);

    const [depois] = await lancamentos();
    expect(depois.didNotShow).toBe(true);
    expect(depois.placing).toBeNull();
    expect(depois.points).toBe(0);
  }, 60_000);

  it('NS vira colocação: a ausência é desfeita e os pontos entram', async () => {
    await importarEAplicar(csv([linha('88281', 'NS')]));
    const [antes] = await lancamentos();
    expect(antes.didNotShow).toBe(true);

    expect((await corrigir(antes.id, { placing: 1, reason: 'Sumula confirma primeiro lugar' })).status).toBe(200);

    const [depois] = await lancamentos();
    expect(depois.didNotShow).toBe(false);
    expect(depois.placing).toBe(1);
    expect(depois.points).toBe(5);
  }, 60_000);

  it('sem motivo, não corrige', async () => {
    await importarEAplicar(csv([linha('88281', 3)]));
    const [ponto] = await lancamentos();
    const r = await corrigir(ponto.id, { placing: 2 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await lancamentos())[0].points, 'nada mudou').toBe(3);
  }, 60_000);
});

describe('prévia do impacto antes de salvar', () => {
  it('mostra o antes, o depois e a diferença', async () => {
    await importarEAplicar(csv([linha('88281', 3)]));
    const [ponto] = await lancamentos();

    const r = await previa(ponto.id, { placing: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.atual.placing).toBe(3);
    expect(r.body.atual.points).toBe(3);
    expect(r.body.novo.placing).toBe(2);
    expect(r.body.novo.points).toBe(4);
    expect(r.body.diferenca).toBe(1);

    // A prévia NÃO grava.
    expect((await lancamentos())[0].points).toBe(3);
  }, 60_000);
});

describe('invalidar e restaurar', () => {
  it('invalidar zera a pontuação e mantém a participação no histórico', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [antes] = await lancamentos();
    expect(antes.points).toBe(5);

    const r = await invalidar(antes.id, { reason: 'Desclassificado pelo comite' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await lancamentos();
    expect(depois, 'a linha continua existindo').toHaveLength(1);
    expect(depois[0].voidedAt).not.toBeNull();
    expect(depois[0].voidReason).toBe('Desclassificado pelo comite');
    expect(depois[0].voidedById).toBe(operador.id);
    expect(depois[0].points).toBe(0);
    // A colocação original sobrevive: é o histórico do que aconteceu.
    expect(depois[0].placingOriginal).toBe(1);
    expect(await totalNoRanking()).toBe(0);
    expect(await somaDoLedger()).toBe(0);
  }, 60_000);

  it('restaurar devolve exatamente o estado anterior', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    await invalidar(ponto.id, { reason: 'engano do operador' });

    const r = await restaurar(ponto.id, { reason: 'invalidacao foi engano' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await lancamentos();
    expect(depois).toHaveLength(1);
    expect(depois[0].voidedAt).toBeNull();
    expect(depois[0].placing).toBe(1);
    expect(depois[0].points).toBe(5);
    expect(await totalNoRanking()).toBe(5);
  }, 60_000);

  it('restaurar devolve a colocação CORRIGIDA, não a que foi importada', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [original] = await lancamentos();

    // Importado como 1º; a súmula dizia outra coisa e o operador corrige duas
    // vezes, chegando em 2º.
    await corrigir(original.id, { placing: 3, reason: 'sumula dizia 3' });
    await corrigir(original.id, { placing: 2, reason: 'conferido: era 2' });

    const [corrigido] = await lancamentos();
    expect(corrigido.placing).toBe(2);
    expect(corrigido.points).toBe(4);
    // Proveniência: registra DE ONDE partiu, e não muda a cada correção.
    expect(corrigido.placingOriginal, 'de onde o lancamento partiu').toBe(1);

    await invalidar(original.id, { reason: 'desclassificado' });
    await restaurar(original.id, { reason: 'desclassificacao revertida' });

    // MEDIDO COMO DEFEITO ANTES DA CORREÇÃO: voltava como 1º valendo 5, a
    // colocação da importação. As duas correções do operador eram descartadas
    // em silêncio e o ranking republicava o que a súmula já tinha desmentido.
    const [restaurado] = await lancamentos();
    expect(restaurado.placing, 'volta ao estado de antes da invalidacao').toBe(2);
    expect(restaurado.points).toBe(4);
    expect(restaurado.voidedAt).toBeNull();
    expect(restaurado.placingOriginal, 'proveniencia preservada').toBe(1);
    expect(await totalNoRanking()).toBe(4);
    expect(await somaDoLedger()).toBe(4);
  }, 60_000);

  it('invalidar duas vezes não duplica nem corrompe', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    await invalidar(ponto.id, { reason: 'primeira' });
    const segunda = await invalidar(ponto.id, { reason: 'segunda' });
    expect(segunda.status).toBeGreaterThanOrEqual(400);

    const depois = await lancamentos();
    expect(depois).toHaveLength(1);
    expect(depois[0].points).toBe(0);
    expect(depois[0].voidReason, 'o motivo original nao e sobrescrito').toBe('primeira');
  }, 60_000);

  it('sem motivo, não invalida', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    expect((await invalidar(ponto.id, {})).status).toBeGreaterThanOrEqual(400);
    expect((await lancamentos())[0].points).toBe(5);
  }, 60_000);

  it('restaurar o que não está invalidado é recusado, e nada muda', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();

    const r = await restaurar(ponto.id, { reason: 'restaurando o que esta valido' });
    expect(r.status).toBe(409);

    // Restaurar é recalcular a partir de `placingOriginal`. Num lançamento
    // nunca invalidado esse campo é nulo, e deixar a operação passar
    // reescreveria a colocação com o que sobrou — uma corrupção silenciosa
    // disparada por uma operação que não deveria nem começar.
    const [depois] = await lancamentos();
    expect(depois.placing).toBe(1);
    expect(depois.points).toBe(5);
    expect(depois.voidedAt).toBeNull();
    expect(await totalNoRanking()).toBe(5);
  }, 60_000);

  it('corrigir só campos não editáveis não é uma correção', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();

    // Sem `placing` nem `didNotShow`, não sobrou nada corrigível. Responder
    // 200 aqui gravaria uma entrada de auditoria dizendo que houve correção
    // onde nada mudou — e um rastro que mente é pior que rastro nenhum.
    const r = await corrigir(ponto.id, {
      reason: 'so campos de identidade', athleteId: 'outro-atleta', eventId: 'outro-evento'
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);

    const [depois] = await lancamentos();
    expect(depois.athleteId).toBe(atleta.id);
    expect(depois.points).toBe(5);
  }, 60_000);

  it('lançamento invalidado não recebe bônus de Overall', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    await invalidar(ponto.id, { reason: 'desclassificado' });

    // O título é declarado DEPOIS da invalidação. A participação existe no
    // histórico, mas não pontua — e não pode carregar bônus.
    const ec = (await api().post(`/api/v1/events/${evento.id}/categories`).set(operador.auth())
      .send({ categoryId: categoriaBB.id })).body;
    const div = (await api().post(`/api/v1/event-categories/${ec.id}/divisions`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN' })).body;
    const classe = (await api().post(`/api/v1/divisions/${div.id}/classes`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;
    await comoAtor(operador, tx => tx.registration.create({
      data: {
        eventId: evento.id, athleteId: atleta.id, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    }));
    await api().post(`/api/v1/events/${evento.id}/overall`).set(operador.auth())
      .send({ athleteId: atleta.id, categoryId: categoriaBB.id });

    const [depois] = await lancamentos();
    expect(depois.overallBonus, 'invalidado nao carrega bonus').toBe(0);
    expect(depois.points).toBe(0);
    expect(await totalNoRanking()).toBe(0);
  }, 60_000);

  it('com duas participações, o bônus vai para a válida e não para a invalidada', async () => {
    // Duas participações elegíveis do MESMO atleta no MESMO evento, em
    // categorias diferentes: 1º numa, 2º na outra. A de 1º é a que a regra
    // escolheria para carregar o +10 — melhor colocação. Ela é invalidada
    // ANTES da declaração do título.
    await importarEAplicar(csv([
      linha('88281', 1, 1, OPEN),
      linha('88281', 2, 2, "Men's Classic Physique - Open Class A")
    ]));
    const antes = await lancamentos();
    expect(antes, 'as duas participacoes entraram no ledger').toHaveLength(2);

    const primeira = antes.find(p => p.placing === 1);
    const segunda = antes.find(p => p.placing === 2);
    await invalidar(primeira.id, { reason: 'desclassificado nesta participacao' });

    const ec = (await api().post(`/api/v1/events/${evento.id}/categories`).set(operador.auth())
      .send({ categoryId: categoriaBB.id })).body;
    const div = (await api().post(`/api/v1/event-categories/${ec.id}/divisions`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN' })).body;
    const classe = (await api().post(`/api/v1/divisions/${div.id}/classes`).set(operador.auth())
      .send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;
    await comoAtor(operador, tx => tx.registration.create({
      data: {
        eventId: evento.id, athleteId: atleta.id, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    }));

    // Título do EVENTO, sem recorte de categoria: alcança as duas linhas, e é
    // a escolha da portadora que decide qual recebe.
    const declaracao = await api().post(`/api/v1/events/${evento.id}/overall`)
      .set(operador.auth()).send({ athleteId: atleta.id });
    expect(declaracao.status, JSON.stringify(declaracao.body)).toBeLessThan(400);

    const depois = await lancamentos();
    const invalidada = depois.find(p => p.id === primeira.id);
    const valida = depois.find(p => p.id === segunda.id);

    expect(invalidada.overallBonus, 'invalidada nao carrega bonus').toBe(0);
    expect(invalidada.points).toBe(0);

    // O PONTO DESTE TESTE. Excluir a invalidada da escolha não basta se ela
    // continuar sendo ELEITA e o bônus for depois descartado na escrita: aí o
    // título declarado não chega a ninguém, e o atleta perde os 10 pontos que
    // a organização lhe reconheceu. A válida tem de RECEBER.
    expect(valida.overallBonus, 'a valida herda o bonus').toBe(10);
    expect(valida.isOverallChampion).toBe(true);
    expect(valida.points, '4 da colocacao + 10 do titulo').toBe(14);
    expect(await totalNoRanking()).toBe(14);
    expect(await somaDoLedger()).toBe(14);
  }, 60_000);
});

describe('lançamentos do campeonato, para a tela de correção', () => {
  const lista = (id, quem) =>
    api().get(`/api/v1/events/${id}/ranking-points`).set((quem ?? operador).auth());

  it('lista os lançamentos do evento com o que a correção precisa', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));

    const r = await lista(evento.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.event.id).toBe(evento.id);
    expect(r.body.items).toHaveLength(1);

    const [item] = r.body.items;
    expect(item.athlete.fullName).toBe('ATLETA CORRECAO');
    expect(item.placing).toBe(1);
    expect(item.points).toBe(5);
    expect(item.voidedAt).toBeNull();
    // Sem esses três a tela não consegue distinguir válido de invalidado nem
    // mostrar por quê, e o operador ficaria decidindo no escuro.
    expect(item).toHaveProperty('voidReason');
    expect(item).toHaveProperty('placingOriginal');
    expect(item).toHaveProperty('didNotShow');
  }, 60_000);

  it('o lançamento invalidado continua na lista, marcado e com o motivo', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    await invalidar(ponto.id, { reason: 'atleta desclassificado' });

    const r = await lista(evento.id);
    // NÃO SOME. A tela precisa da linha para oferecer "Restaurar", e o
    // histórico do atleta precisa dela para não perder a etapa.
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].voidedAt).not.toBeNull();
    expect(r.body.items[0].voidReason).toBe('atleta desclassificado');
    expect(r.body.items[0].points).toBe(0);
  }, 60_000);

  it('quem não gerencia ranking não lista, e anônimo também não', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));

    const semPermissao = await criarUsuario({ name: 'Sem Permissao' });
    await vincular(org, semPermissao, 'REGISTRATION_OPERATOR');
    expect((await lista(evento.id, semPermissao)).status).toBe(403);

    expect((await api().get(`/api/v1/events/${evento.id}/ranking-points`)).status).toBe(401);
  }, 60_000);

  it('operador de OUTRA organização não lista o campeonato alheio', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin C' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Federacao C' });
    const forasteiro = await criarUsuario({ name: 'Operador C' });
    await vincular(outraOrg.id, forasteiro, 'RANKING_MANAGER');

    const r = await lista(evento.id, forasteiro);
    expect(r.status, 'sonda cross-tenant nao pode virar 500').toBeLessThan(500);
    expect([403, 404]).toContain(r.status);
  }, 60_000);
});

describe('quem pode, e quem não pode', () => {
  it('sem ranking.manage, ninguém corrige nem invalida', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();

    const semPapel = await criarUsuario({ name: 'Atleta Comum' });
    await vincular(org, semPapel, 'ATHLETE');

    for (const resposta of await Promise.all([
      corrigir(ponto.id, { placing: 2, reason: 'tentativa' }, semPapel),
      invalidar(ponto.id, { reason: 'tentativa' }, semPapel),
      restaurar(ponto.id, { reason: 'tentativa' }, semPapel)
    ])) {
      expect([401, 403, 404]).toContain(resposta.status);
    }
    expect((await lancamentos())[0].points, 'nada mudou').toBe(5);
  }, 60_000);

  it('anônimo não alcança nenhuma das portas', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();
    for (const resposta of await Promise.all([
      api().patch(`/api/v1/ranking/points/${ponto.id}`).send({ placing: 2, reason: 'x y z' }),
      api().post(`/api/v1/ranking/points/${ponto.id}/void`).send({ reason: 'x y z' }),
      api().post(`/api/v1/ranking/points/${ponto.id}/restore`).send({ reason: 'x y z' })
    ])) {
      expect([401, 403]).toContain(resposta.status);
    }
  }, 60_000);

  it('operador de OUTRA organização não alcança o lançamento', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin B' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Federacao B' });
    const forasteiro = await criarUsuario({ name: 'Operador B' });
    await vincular(outraOrg.id, forasteiro, 'RANKING_MANAGER');

    for (const resposta of await Promise.all([
      corrigir(ponto.id, { placing: 2, reason: 'invasao' }, forasteiro),
      invalidar(ponto.id, { reason: 'invasao' }, forasteiro)
    ])) {
      // NUNCA 500. Medido: o `include` de uma relação obrigatória recebia nulo
      // do RLS e o Prisma estourava, transformando a negação correta num erro
      // interno — que conta ao invasor que ele encostou em algo.
      expect(resposta.status, 'sonda cross-tenant nao pode virar 500')
        .toBeLessThan(500);
      // MEDIDO: 403, e é o 403 do `assertCan`, não um 404 do RLS.
      //
      // As duas leituras ATRAVESSAM — o lançamento e a temporada são visíveis
      // ao operador forasteiro. Não é falha de política: o ranking é dado
      // PÚBLICO por decisão de produto (o visitante anônimo lê a classificação
      // inteira), então o RLS não tem por que esconder a linha. Quem nega a
      // ESCRITA é a autorização, e é ela que responde.
      //
      // A asserção fica em 403 de propósito, e não num 404 mais discreto: o
      // 403 do `assertCan` é a resposta que a plataforma inteira dá a violação
      // de tenant, e trocá-la só aqui deixaria este endpoint fora da convenção
      // sem fechar vazamento nenhum — a mesma informação já sai pela leitura
      // pública do ranking.
      expect([401, 403, 404]).toContain(resposta.status);
      expect(resposta.status).toBe(403);
    }
    expect((await lancamentos())[0].points, 'cross-tenant nao muda nada').toBe(5);
  }, 60_000);

  it('campos de identidade não são editáveis pelo corpo da requisição', async () => {
    await importarEAplicar(csv([linha('88281', 1)]));
    const [ponto] = await lancamentos();

    // Atribuição em massa: mandar o que não é editável junto com o que é.
    await corrigir(ponto.id, {
      placing: 2, reason: 'tentativa de atribuicao em massa',
      eventId: 'outro-evento', athleteId: 'outro-atleta',
      source: 'EVENT', externalResultId: 'forjado', points: 999
    });

    const [depois] = await lancamentos();
    expect(depois.eventId, 'evento intocado').toBe(evento.id);
    expect(depois.athleteId, 'atleta intocado').toBe(atleta.id);
    expect(depois.source, 'origem intocada').toBe('MUSCLEWAR');
    expect(depois.points, 'pontos vêm do motor, não do corpo').toBe(4);
  }, 60_000);
});

describe('auditoria reconstrói antes → ação → depois', () => {
  it('cada operação deixa rastro com motivo, autor e os dois estados', async () => {
    await importarEAplicar(csv([linha('88281', 3)]));
    const [ponto] = await lancamentos();

    await corrigir(ponto.id, { placing: 2, reason: 'Correcao conforme sumula oficial' });
    await invalidar(ponto.id, { reason: 'Desclassificado pelo comite' });
    await restaurar(ponto.id, { reason: 'Recurso deferido' });

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { organizationId: org, action: { in: ['RANKING_POINT_EDITED', 'RANKING_POINT_VOIDED', 'RANKING_POINT_RESTORED'] } },
      orderBy: { createdAt: 'asc' },
      select: { action: true, userId: true, metadata: true, entityId: true }
    }));

    expect(trilha.map(t => t.action))
      .toEqual(['RANKING_POINT_EDITED', 'RANKING_POINT_VOIDED', 'RANKING_POINT_RESTORED']);
    for (const evento of trilha) {
      expect(evento.userId).toBe(operador.id);
      expect(evento.entityId).toBe(ponto.id);
      expect(evento.metadata.reason, 'motivo registrado').toBeTruthy();
      expect(evento.metadata.antes, 'estado anterior registrado').toBeDefined();
      expect(evento.metadata.depois, 'estado novo registrado').toBeDefined();
    }
    expect(trilha[0].metadata.antes.points).toBe(3);
    expect(trilha[0].metadata.depois.points).toBe(4);
  }, 60_000);
});
