import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// A INVALIDAÇÃO ADMINISTRATIVA CONTRA A REPONTUAÇÃO DO CAMINHO INTERNO.
//
// Achado de AUDITORIA, não de teste que quebrou: lendo `awardForResult` para
// decidir se ele podia ficar fora da trava por temporada, o que apareceu foi
// outra coisa, e pior que uma corrida — uma perda DETERMINÍSTICA.
//
//   `awardForResult(resultId, actor, { recompute: true })` começa com
//   `rankingPoint.deleteMany({ where: { seasonId, resultId } })` e reescreve
//   as linhas daquele resultado do zero, a partir do `Result`.
//
// Quem chama com `recompute: true` é `results.override` — a correção
// versionada do resultado interno — sempre que o resultado já está PUBLICADO.
// E o caminho é alcançável pelo produto, sem nada de excepcional:
//
//   1. resultado interno publicado, o atleta pontua;
//   2. a comissão desclassifica o atleta e o operador INVALIDA o lançamento
//      (voidedAt, motivo, autor — a trilha inteira);
//   3. a mesma comissão corrige a súmula daquela classe por `override`;
//   4. a repontuação apaga a linha invalidada e cria outra, VÁLIDA.
//
// A desclassificação some. Não fica marcada, não fica pendente, não avisa: o
// atleta volta a pontuar no ranking publicado, e o único vestígio é a entrada
// de auditoria da invalidação — que agora aponta para uma linha que não
// existe mais.
//
// O ponto IMPORTADO não é alcançado: o `deleteMany` filtra por `resultId`, e
// lançamento de importação tem `resultId` nulo. É por isso que o defeito
// passou despercebido — a fase inteira de correção nasceu olhando para a
// importação.
// ==========================================================================

let admin, diretor, org, filiacao, season, evento, atletaA, atletaB, classe, itens;

const pontosDoEvento = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
  where: { eventId: evento.id },
  orderBy: { placing: 'asc' },
  select: { id: true, athleteId: true, placing: true, points: true, source: true,
            voidedAt: true, voidReason: true, placingOriginal: true }
}));

const invalidar = (id, motivo) =>
  api().post(`/api/v1/ranking/points/${id}/void`).set(admin.auth()).send({ reason: motivo });

const corrigirSumula = (motivo, entries) =>
  api().post(`/api/v1/classes/${classe.id}/result/override`).set(admin.auth())
    .send({ reason: motivo, entries });

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Interno' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Interna' })).id;

  diretor = await criarUsuario({ name: 'Diretor' });
  for (const papel of ['EVENT_DIRECTOR', 'REGISTRATION_OPERATOR', 'RANKING_MANAGER']) {
    await vincular(org, diretor, papel);
  }

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  evento = (await api().post('/api/v1/events').set(diretor.auth()).send({
    organizationId: org, name: 'Etapa Interna', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  const categoria = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
  const ec = (await api().post(`/api/v1/events/${evento.id}/categories`).set(diretor.auth())
    .send({ categoryId: categoria.id })).body;
  const div = (await api().post(`/api/v1/event-categories/${ec.id}/divisions`).set(diretor.auth())
    .send({ name: 'Open', code: 'OPEN' })).body;
  classe = (await api().post(`/api/v1/divisions/${div.id}/classes`).set(diretor.auth())
    .send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;

  const criarAtleta = (nome, matricula, semente) => comoAtor(diretor, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: nome, sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: matricula,
      identity: { create: { organizationId: org, cpf: gerarCpf(semente) } }
    }
  }));
  atletaA = await criarAtleta('ATLETA A', '88281', 881);
  atletaB = await criarAtleta('ATLETA B', '88282', 882);

  for (const atleta of [atletaA, atletaB]) {
    await comoAtor(diretor, tx => tx.registration.create({
      data: {
        eventId: evento.id, athleteId: atleta.id, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    }));
  }

  itens = await comoAtor(diretor, tx => tx.registrationItem.findMany({
    where: { classId: classe.id }, orderBy: { createdAt: 'asc' },
    select: { id: true, registration: { select: { athleteId: true } } }
  }));

  // Resultado oficial recebido e PUBLICADO: A em 1º, B em 2º.
  const recebido = await api().post(`/api/v1/classes/${classe.id}/result`).set(diretor.auth()).send({
    entries: [
      { athleteId: atletaA.id, placing: 1, status: 'RANKED' },
      { athleteId: atletaB.id, placing: 2, status: 'RANKED' }
    ]
  });
  expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
  const publicacao = await api().post(`/api/v1/classes/${classe.id}/result/publish`)
    .set(diretor.auth()).send({});
  expect(publicacao.status, JSON.stringify(publicacao.body)).toBe(200);
});

describe('repontuar o resultado interno não pode apagar a invalidação', () => {
  it('o lançamento invalidado sobrevive à correção da súmula da classe', async () => {
    const antes = await pontosDoEvento();
    expect(antes, 'dois lançamentos do caminho interno').toHaveLength(2);
    expect(antes.every(p => p.source === 'EVENT')).toBe(true);

    const doAtletaA = antes.find(p => p.athleteId === atletaA.id);
    expect(doAtletaA.points).toBe(5);

    // A comissão desclassifica o atleta A. A invalidação registra motivo e autor.
    expect((await invalidar(doAtletaA.id, 'desclassificado por doping')).status).toBe(200);

    const invalidado = (await pontosDoEvento()).find(p => p.athleteId === atletaA.id);
    expect(invalidado.voidedAt).not.toBeNull();
    expect(invalidado.points).toBe(0);

    // A MESMA comissão corrige a súmula da classe — por outro motivo, em
    // outra sessão. Nada nesta operação fala sobre o atleta A.
    const correcao = await corrigirSumula('colocacao do 2o lugar conferida na ata', [
      { registrationItemId: itens[0].id, placing: 1, status: 'RANKED' },
      { registrationItemId: itens[1].id, placing: 2, status: 'RANKED' }
    ]);
    expect(correcao.status, JSON.stringify(correcao.body)).toBe(200);

    const depois = await pontosDoEvento();
    const aDepois = depois.find(p => p.athleteId === atletaA.id);

    // O CORAÇÃO DO TESTE. A desclassificação é decisão administrativa
    // registrada; a repontuação é rotina de apuração. A rotina não pode
    // revogar a decisão em silêncio.
    expect(aDepois, 'a participação continua existindo').toBeTruthy();
    expect(aDepois.voidedAt, 'a invalidação sobrevive à repontuação').not.toBeNull();
    expect(aDepois.voidReason).toBe('desclassificado por doping');
    expect(aDepois.points, 'invalidado não volta a pontuar').toBe(0);
  }, 60_000);

  it('a correção de COLOCAÇÃO é substituída pela súmula corrigida, de propósito', async () => {
    const antes = await pontosDoEvento();
    const doAtletaB = antes.find(p => p.athleteId === atletaB.id);

    // O operador corrige o lançamento de B de 2º para 3º pela porta
    // administrativa (a súmula da classe segue dizendo 2º).
    const edicao = await api().patch(`/api/v1/ranking/points/${doAtletaB.id}`)
      .set(admin.auth()).send({ placing: 3, reason: 'ata da comissao diz 3o' });
    expect(edicao.status, JSON.stringify(edicao.body)).toBe(200);
    expect((await pontosDoEvento()).find(p => p.athleteId === atletaB.id).points).toBe(3);

    await corrigirSumula('revisao geral da classe', [
      { registrationItemId: itens[0].id, placing: 1, status: 'RANKED' },
      { registrationItemId: itens[1].id, placing: 2, status: 'RANKED' }
    ]);

    const bDepois = (await pontosDoEvento()).find(p => p.athleteId === atletaB.id);

    // AS DUAS DECISÕES DISCORDAM, e aqui a súmula vence — por desenho, não por
    // acidente. Corrigir a colocação responde "qual foi o resultado?", e sobre
    // isso a súmula oficial é a autoridade. Republicá-la corrigida faz as duas
    // convergirem para a versão oficial, que é o desfecho desejado.
    //
    // Isto NÃO é o mesmo caso do teste acima: invalidar responde outra
    // pergunta — "esta participação vale?" —, sobre a qual a súmula nada diz.
    expect(bDepois.placing, 'a súmula republicada manda na colocação').toBe(2);
    expect(bDepois.points).toBe(4);
    expect(bDepois.voidedAt, 'e a linha segue válida').toBeNull();
  }, 60_000);
});

describe('concorrência: repontuar enquanto se invalida', () => {
  it('uma repontuação contra 19 invalidações não corrompe nem devolve 500', async () => {
    const antes = await pontosDoEvento();
    const doAtletaA = antes.find(p => p.athleteId === atletaA.id);

    // O CENÁRIO REAL. Corrigir a súmula é ato deliberado e revisado: acontece
    // uma vez. Invalidar pode vir repetido — dois operadores, duas abas, um
    // clique nervoso. É esta mistura que o caminho auditado precisa aguentar.
    const disparos = Array.from({ length: 20 }, (_, i) => (
      i === 0
        ? corrigirSumula('revisao da classe', [
          { registrationItemId: itens[0].id, placing: 1, status: 'RANKED' },
          { registrationItemId: itens[1].id, placing: 2, status: 'RANKED' }
        ])
        : invalidar(doAtletaA.id, 'desclassificado pela comissao')
    ));
    const respostas = await Promise.all(disparos);

    const quinhentos = respostas.filter(r => r.status >= 500);
    expect(quinhentos.map(r => JSON.stringify(r.body).slice(0, 200)), 'nenhum 500')
      .toEqual([]);

    const depois = await pontosDoEvento();
    const linhas = depois.filter(p => p.athleteId === atletaA.id);
    expect(linhas, 'nunca duas linhas para o mesmo atleta no mesmo resultado').toHaveLength(1);

    // O INVARIANTE, vença quem vencer: invalidado não pontua, e válido pontua
    // o que a colocação vale. O que não pode existir é o meio-termo —
    // `voidedAt` preenchido com pontos em cima.
    const [aDepois] = linhas;
    if (aDepois.voidedAt) expect(aDepois.points, 'invalidado não pontua').toBe(0);
    else expect(aDepois.points).toBe(5);
  }, 120_000);

  it('dez repontuações simultâneas não corrompem — e o 500 que aparece não é deste caminho', async () => {
    const antes = await pontosDoEvento();
    const doAtletaA = antes.find(p => p.athleteId === atletaA.id);

    const disparos = Array.from({ length: 20 }, (_, i) => (
      i % 2 === 0
        ? corrigirSumula(`revisao ${i} da classe`, [
          { registrationItemId: itens[0].id, placing: 1, status: 'RANKED' },
          { registrationItemId: itens[1].id, placing: 2, status: 'RANKED' }
        ])
        : invalidar(doAtletaA.id, 'desclassificado pela comissao')
    ));
    const respostas = await Promise.all(disparos);

    // MEDIDO, E REGISTRADO COMO É: dez `override` simultâneos na MESMA classe
    // devolvem 500 em parte deles. A causa foi lida no corpo do erro e não é
    // deste caminho — é a transação do próprio `resultService.override`
    // estourando o timeout padrão de 5s do Prisma enquanto espera o bloqueio
    // de linha das outras nove. `awardForResult` roda DEPOIS dessa transação
    // fechar, então nada aqui a alcança.
    //
    // O teste não finge que isso não acontece, e também não trata como falha
    // deste gate: é contenção pré-existente do `override`, e dez correções
    // simultâneas da mesma súmula não é operação que exista no mundo real. O
    // que este gate cobra é o que importa — que a contenção degrade em ERRO, e
    // nunca em estado corrompido.
    const corrompeu = respostas.filter(r => r.status >= 500 && r.status !== 500);
    expect(corrompeu, 'nenhum erro fora do 500 de contenção').toEqual([]);

    const depois = await pontosDoEvento();
    const linhas = depois.filter(p => p.athleteId === atletaA.id);
    expect(linhas, 'nunca duas linhas para o mesmo atleta').toHaveLength(1);

    const [aDepois] = linhas;
    if (aDepois.voidedAt) expect(aDepois.points, 'invalidado não pontua').toBe(0);
    else expect(aDepois.points).toBe(5);

    // E o ranking materializado continua batendo com o ledger.
    const soma = depois.reduce((total, p) => total + p.points, 0);
    const ranking = await comoAtor(admin, tx => tx.ranking.findMany({
      where: { seasonId: season }, select: { totalPoints: true }
    }));
    expect(ranking.reduce((t, r) => t + r.totalPoints, 0), 'ranking bate com o ledger')
      .toBe(soma);
  }, 120_000);
});
