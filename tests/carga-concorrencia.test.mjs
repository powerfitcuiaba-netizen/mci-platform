import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 13.7 / 13.8 — CONCORRÊNCIA E IDEMPOTÊNCIA.
//
// Duplo clique, dois operadores na mesma sala, duas abas abertas. Nada disso é
// hipótese: é o dia de competição. O que não pode acontecer, em nenhum deles:
//
//   dois títulos Overall no mesmo recorte
//   +20 de bônus
//   ponto de ranking duplicado
//   revogação dupla deixando estado inconsistente
//
// O teste não afirma que a corrida é impossível — ele a PROVOCA, disparando as
// requisições em paralelo, e confere o estado final.
// ============================================================================

let admin, diretor, gerente, orgId, seasonId, evento, inscritos;

const cpfSeq = (() => { let n = 660000000; return () => gerarCpf(n += 5273); })();

async function montarEtapa(nomes) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const lista = [];
  for (const nome of nomes) {
    const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfSeq(), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [montado.competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    lista.push({ nome, registrationId: inscricao.body.registration.id, athleteId: inscricao.body.registration.athlete.id });
  }

  await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const i of lista) {
    await api().post(`/api/v1/registrations/${i.registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, montado.event.id, ['IN_JUDGING']);
  await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: lista.map((item, i) => ({ athleteId: item.athleteId, placing: i + 1 })) });
  await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });

  return { ...montado, inscritos: lista };
}

const pontosDe = nome => comoAtor(diretor, async tx => {
  const atleta = await tx.athlete.findFirst({ where: { fullName: nome } });
  return tx.rankingPoint.findMany({ where: { athleteId: atleta.id } });
});
const somar = (pontos, campo) => pontos.reduce((t, p) => t + p[campo], 0);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretora' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');
  await vincular(orgId, gerente, 'RANKING_MANAGER');

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;

  const montado = await montarEtapa(['ATLETA A', 'ATLETA B', 'ATLETA C']);
  evento = montado.event;
  inscritos = montado.inscritos;
});

const idDe = nome => inscritos.find(i => i.nome === nome).athleteId;
const declarar = (ator, corpo) => api().post(`/api/v1/events/${evento.id}/overall`).set(ator.auth()).send(corpo);

describe('13.7 — dois operadores ao mesmo tempo', () => {
  it('dois DECLARE simultâneos do mesmo atleta: um título, +10', async () => {
    const respostas = await Promise.all([
      declarar(diretor, { athleteId: idDe('ATLETA A') }),
      declarar(gerente, { athleteId: idDe('ATLETA A') })
    ]);

    expect(respostas.every(r => [200, 201, 409].includes(r.status)),
      JSON.stringify(respostas.map(r => ({ s: r.status, b: r.body })))).toBe(true);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos, 'um título, não dois').toHaveLength(1);
    expect(somar(await pontosDe('ATLETA A'), 'overallBonus'), 'nunca +20').toBe(10);
  });

  it('dois DECLARE simultâneos de atletas DIFERENTES: um vence, o outro é recusado', async () => {
    const respostas = await Promise.all([
      declarar(diretor, { athleteId: idDe('ATLETA A') }),
      declarar(gerente, { athleteId: idDe('ATLETA B') })
    ]);

    const criados = respostas.filter(r => r.status === 201);
    const recusados = respostas.filter(r => r.status !== 201);

    expect(criados.length, 'exatamente um título nasce').toBe(1);
    expect(recusados.length, 'o outro é recusado, não aceito em silêncio').toBe(1);

    // 409 COM O CÓDIGO DO NEGÓCIO, e não 500 nem um CONFLICT genérico.
    //
    // Quando esta asserção aceitava 500, ela documentava a falha em vez de
    // cobrá-la: perder a corrida virava "a aplicação quebrou" para quem estava
    // na sala. O código também importa — `CONFLICT` vindo da rede do
    // errorHandler significaria que o serviço deixou o erro passar cru, e o
    // operador perderia a instrução de revogar antes de declarar.
    expect(recusados[0].status, JSON.stringify(recusados[0].body)).toBe(409);
    expect(recusados[0].body.error.code).toBe('OVERALL_ALREADY_DECLARED');

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos).toHaveLength(1);

    // Só o campeão que venceu a corrida tem bônus; o outro, zero.
    const bonusA = somar(await pontosDe('ATLETA A'), 'overallBonus');
    const bonusB = somar(await pontosDe('ATLETA B'), 'overallBonus');
    expect([bonusA, bonusB].sort()).toEqual([0, 10]);
  });

  it('duas REVOGAÇÕES simultâneas não deixam estado inconsistente', async () => {
    const titulo = await declarar(diretor, { athleteId: idDe('ATLETA A') });
    expect(titulo.status).toBe(201);

    const revogar = ator => api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(ator.auth()).send({ reason: 'Correção simultânea de ata' });

    const respostas = await Promise.all([revogar(diretor), revogar(gerente)]);
    expect(respostas.some(r => r.status === 200), 'ao menos uma revoga').toBe(true);
    expect(respostas.every(r => [200, 404, 409].includes(r.status)),
      JSON.stringify(respostas.map(r => ({ s: r.status, b: r.body })))).toBe(true);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos, 'o título sumiu, e só uma vez').toHaveLength(0);
    expect(somar(await pontosDe('ATLETA A'), 'overallBonus'), 'o bônus saiu').toBe(0);
    expect(somar(await pontosDe('ATLETA A'), 'placementPoints'), 'a colocação ficou').toBe(5);
  });

  it('duas REPONTUAÇÕES simultâneas do mesmo resultado não duplicam ponto', async () => {
    const antes = await comoAtor(diretor, tx => tx.rankingPoint.count({ where: { seasonId } }));

    await Promise.all([
      api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({}),
      api().post(`/api/v1/seasons/${seasonId}/recompute`).set(gerente.auth()).send({})
    ]);

    const depois = await comoAtor(diretor, tx => tx.rankingPoint.count({ where: { seasonId } }));
    expect(depois, 'recomputar não cria ponto').toBe(antes);
  });

  it('duplo submit do MESMO resultado não duplica lançamento', async () => {
    const montado = await montarEtapa(['DUPLO 1', 'DUPLO 2']);

    // A publicação já aconteceu dentro do helper; repetir o recebimento e a
    // publicação em paralelo é o duplo clique do operador.
    const entries = montado.inscritos.map((item, i) => ({ athleteId: item.athleteId, placing: i + 1 }));
    await Promise.all([
      api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth()).send({ entries }),
      api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(gerente.auth()).send({ entries })
    ]);

    const pontos = await pontosDe('DUPLO 1');
    expect(pontos.length, 'uma linha por participação, não duas').toBeLessThanOrEqual(1);
  });
});

describe('13.8 — idempotência: repetir converge', () => {
  it('declarar 3× o mesmo Overall converge em +10', async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await declarar(diretor, { athleteId: idDe('ATLETA A') });
      expect([200, 201], `tentativa ${i + 1}`).toContain(r.status);
    }
    expect(somar(await pontosDe('ATLETA A'), 'overallBonus')).toBe(10);
  });

  it('declarar → revogar → declarar converge no estado final', async () => {
    const primeiro = await declarar(diretor, { athleteId: idDe('ATLETA A') });
    await api().delete(`/api/v1/events/${evento.id}/overall/${primeiro.body.id}`)
      .set(diretor.auth()).send({ reason: 'Ata corrigida' });
    const segundo = await declarar(diretor, { athleteId: idDe('ATLETA B') });
    expect(segundo.status).toBe(201);

    expect(somar(await pontosDe('ATLETA A'), 'overallBonus')).toBe(0);
    expect(somar(await pontosDe('ATLETA B'), 'overallBonus')).toBe(10);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos).toHaveLength(1);
  });

  it('recompute repetido converge nos mesmos números', async () => {
    await declarar(diretor, { athleteId: idDe('ATLETA A') });
    const referencia = await comoAtor(diretor, tx => tx.ranking.findMany({
      where: { seasonId }, orderBy: { athleteId: 'asc' },
      select: { athleteId: true, totalPoints: true, position: true, overallWins: true }
    }));

    for (let i = 0; i < 3; i += 1) {
      await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({});
    }

    const depois = await comoAtor(diretor, tx => tx.ranking.findMany({
      where: { seasonId }, orderBy: { athleteId: 'asc' },
      select: { athleteId: true, totalPoints: true, position: true, overallWins: true }
    }));
    expect(depois, 'três recomputações, mesmo resultado').toEqual(referencia);
  });
});

// ============================================================================
// A CORRIDA, SEM SORTE.
//
// O teste acima DISPARA duas requisições em paralelo e confere o estado final.
// Ele é honesto, mas depende de as duas se cruzarem no ponto certo: se a
// primeira terminar antes de a segunda ler a tabela, a segunda encontra o
// título pelo caminho normal e nunca chega ao índice. O caminho de exceção —
// o que traduz a violação do índice PARCIAL em 409 — fica sem cobrança em uma
// parte das execuções, e uma regressão nele passaria despercebida.
//
// Aqui a corrida é ENCENADA, não sorteada: uma transação do teste insere o
// título e NÃO confirma. A requisição HTTP não enxerga a linha pendente (o
// PostgreSQL lê o confirmado), segue para a escrita e FICA BLOQUEADA no
// índice. O teste então confirma sua transação, e o bloqueio se resolve do
// único jeito possível: violação de unicidade dentro da requisição.
//
// É exatamente a corrida do dia de competição, com o relógio nas mãos do
// teste.
// ============================================================================
describe('13.7 — a corrida perdida no índice, de forma determinística', () => {
  it('quem perde recebe 409 com o código do negócio, nunca 500', async () => {
    let resposta = null;
    let soltar;

    // O disparo é ARMADO AQUI FORA de propósito. O contexto de RLS viaja por
    // AsyncLocalStorage e é capturado no momento em que a continuação é
    // REGISTRADA: uma requisição disparada de dentro do callback herdaria a
    // transação do teste, enxergaria a linha pendente e jamais chegaria ao
    // índice — o teste passaria medindo outro caminho. Registrada aqui, ela
    // corre em contexto próprio, como uma requisição de verdade.
    const gatilho = new Promise(resolve => { soltar = resolve; });
    const emVoo = gatilho
      .then(() => declarar(gerente, { athleteId: idDe('ATLETA B') }))
      .then(r => { resposta = { status: r.status, body: r.body }; })
      .catch(erro => { resposta = { status: 'erro de transporte', body: String(erro) }; });

    await comoAtor(diretor, async tx => {
      // O vencedor da corrida, ainda NÃO confirmado.
      await tx.eventOverallTitle.create({
        data: { eventId: evento.id, athleteId: idDe('ATLETA A'), categoryId: null, declaredById: diretor.id }
      });

      soltar();
      // Tempo para a requisição percorrer validação e chegar à escrita.
      await new Promise(resolve => { setTimeout(resolve, 1500); });
      expect(resposta, 'a requisição precisa estar travada no índice neste ponto').toBeNull();
    }, { timeout: 25000, maxWait: 25000 });

    // Fora do callback a transação já foi confirmada: o bloqueio se resolve.
    await emVoo;

    expect(resposta, 'a requisição respondeu').not.toBeNull();
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(409);
    expect(resposta.body.error.code, 'traduzido pelo serviço, não pela rede genérica')
      .toBe('OVERALL_ALREADY_DECLARED');
    expect(resposta.body.error.message).toMatch(/Revogue/);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos, 'o vencedor ficou, e sozinho').toHaveLength(1);
    expect(titulos[0].athleteId).toBe(idDe('ATLETA A'));
  });
});
