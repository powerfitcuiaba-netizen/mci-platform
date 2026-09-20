import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// E2E DO IMPORTADOR — O CAMINHO INTEIRO, COMO O OPERADOR O PERCORRE.
//
// As suítes existentes atacam cada peça em separado: o adaptador, o matching,
// a pontuação, a concorrência, a segurança. Nenhuma percorre a corrente
// completa — arquivo, evento, prévia, aprovação, aplicação, ranking,
// histórico, auditoria — e é justamente na emenda entre duas peças corretas
// que um defeito se esconde: `eventId` era validado na entrada, guardado no
// lote, e desaparecia na hora de escrever o ponto. Cada peça passava.
//
// QA apenas: matrículas e CPF sintéticos, organizações de teste, nenhum dado
// real de competição.
// ==========================================================================

// O serviço é CommonJS: `createRequire` é como as outras suítes o alcançam.
const { vincularPendentesDoAtleta } = createRequire(import.meta.url)('../src/services/muscleWarService.js');

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';
const CABECALHO_OVERALL = `${CABECALHO},Overall`;
const OPEN = "Men's Bodybuilding - Open";
const NOVICE = "Men's Bodybuilding - Novice";

const csv = linhas => [CABECALHO, ...linhas].join('\n');
const csvOverall = linhas => [CABECALHO_OVERALL, ...linhas].join('\n');
const linha = (matricula, colocacao, n = 1, classe = OPEN) =>
  `${n},${classe},Atleta,Sobrenome,${matricula},${colocacao}`;

let A, B;

async function montarFederacao(nome, semente) {
  const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: `Admin ${nome}` });
  const organizacao = await criarOrganizacao(admin, { name: nome });

  const operador = await criarUsuario({ name: `Operador ${nome}` });
  for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
    await vincular(organizacao.id, operador, papel);
  }

  const filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: organizacao.id, name: 'NPC', code: 'NPC' })).body;

  const season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: organizacao.id, name: `Temporada ${nome}`, year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  const evento = alvo => api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: organizacao.id, name: alvo, slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  });

  const eventoA = (await evento(`${nome} Etapa 1`)).body;
  const eventoB = (await evento(`${nome} Etapa 2`)).body;

  const atleta = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: organizacao.id, fullName: `ATLETA ${nome}`, sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '88281',
      identity: { create: { organizationId: organizacao.id, cpf: gerarCpf(semente) } }
    }
  }));

  const lote = (conteudo, extras = {}) =>
    api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
      organizationId: organizacao.id, seasonId: season, sourceType: 'CSV',
      sourceRef: unico('etapa') + '.csv', content: conteudo,
      externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
      defaultAffiliationCode: 'NPC', ...extras
    });

  const aplicar = id => api().post(`/api/v1/musclewar/imports/${id}/apply`).set(operador.auth()).send({});
  const previa = id => api().get(`/api/v1/musclewar/imports/${id}`).set(operador.auth());

  return { admin, org: organizacao.id, operador, filiacao, season, eventoA, eventoB, atleta, lote, aplicar, previa };
}

// O ATOR COMPLETO, COMO O `requireAuth` O ENTREGA.
//
// O usuário que os helpers devolvem é só credencial: id, token e `auth()`.
// Não tem `memberships`, e a barreira de tenant (`belongsToOrganization`) lê
// exatamente esse campo. Chamar um serviço direto com o objeto cru passa nos
// caminhos que não conferem tenant e estoura nos que conferem — foi o que
// aconteceu aqui: o vínculo tardio materializou o ponto certo e depois
// tropeçou na prévia que `aplicarLote` monta no final.
//
// Em produção este caminho nunca vê o objeto cru: o ator vem do middleware de
// autenticação, com os vínculos carregados. O teste precisa do mesmo ator, ou
// mede o arreio em vez do produto.
const atorCompleto = async usuario => ({
  ...usuario,
  memberships: await comoAtor(usuario, tx => tx.organizationMember.findMany({
    where: { userId: usuario.id }, select: { organizationId: true, role: true }
  }))
});

const pontosDe = (quem, where = {}) => comoAtor(quem, tx => tx.rankingPoint.findMany({
  where,
  select: {
    id: true, eventId: true, athleteId: true, placing: true, didNotShow: true,
    placementPoints: true, overallBonus: true, points: true, isOverallChampion: true,
    superOverallEligible: true, superOverallPoints: true
  },
  orderBy: { points: 'desc' }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  A = await montarFederacao('Federacao A', 771);
  B = await montarFederacao('Federacao B', 772);
});

describe('CENÁRIO 1 — importação nova, do arquivo ao ranking', () => {
  it('percorre prévia, aprovação, aplicação, ranking, histórico e auditoria', async () => {
    const criacao = await A.lote(csvOverall([`1,${OPEN},Atleta,Sobrenome,88281,1,Overall`]), { eventId: A.eventoA.id });
    expect(criacao.status).toBe(201);
    const lote = criacao.body.import;
    expect(lote.eventId).toBe(A.eventoA.id);

    // 7) a prévia responde tudo o que o operador precisa conferir
    const previa = await A.previa(lote.id);
    expect(previa.status).toBe(200);
    expect(previa.body.import.event.name).toBe(A.eventoA.name);
    const [item] = previa.body.items;
    expect(item.categoryCode).toBe('MENS_BODYBUILDING');
    expect(item.divisionName).toBe('Open');
    expect(item.className).toBe(OPEN);
    expect(item.memberNumber).toBe('88281');
    expect(item.placing).toBe(1);
    expect(item.isOverallChampion).toBe(true);
    expect(item.didNotShow).toBe(false);
    expect(item.matchStatus).toBe('MATCHED');

    // NADA foi aplicado pela prévia.
    expect(await pontosDe(A.admin)).toHaveLength(0);

    // 8–9) aprovação explícita e aplicação
    expect((await A.aplicar(lote.id)).status).toBe(200);

    // 10) o ponto sabe de qual evento veio
    const [ponto] = await pontosDe(A.admin);
    expect(ponto.eventId).toBe(A.eventoA.id);
    expect(ponto.placementPoints).toBe(5);
    expect(ponto.overallBonus).toBe(10);
    expect(ponto.points).toBe(15);
    expect(ponto.isOverallChampion).toBe(true);

    // 11) ranking
    const ranking = await api().get('/api/v1/ranking').set(A.admin.auth())
      .query({ organizationId: A.org, seasonId: A.season });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items.find(i => i.athlete.id === A.atleta.id).totalPoints).toBe(15);

    // 12) histórico do ponto, com origem
    const origem = await api().get(`/api/v1/athletes/${A.atleta.id}/ranking-points`)
      .set(A.admin.auth()).query({ seasonId: A.season });
    expect(origem.status).toBe(200);
    expect(origem.body.items).toHaveLength(1);

    // 13) auditoria registrou a aplicação
    const auditoria = await comoAtor(A.admin, tx => tx.auditLog.findMany({
      where: { organizationId: A.org }, select: { action: true }
    }));
    expect(auditoria.map(a => a.action)).toContain('MUSCLEWAR_APPLY');
  }, 60_000);
});

describe('CENÁRIO 2 — reaplicação não duplica nada', () => {
  it('o mesmo /apply repetido deixa ranking, ponto e resultado externo idênticos', async () => {
    const lote = (await A.lote(csvOverall([`1,${OPEN},Atleta,Sobrenome,88281,1,Overall`]), { eventId: A.eventoA.id })).body.import;
    expect((await A.aplicar(lote.id)).status).toBe(200);

    const antes = await pontosDe(A.admin);
    const externosAntes = await comoAtor(A.admin, tx => tx.externalResult.count());
    expect(antes).toHaveLength(1);
    expect(externosAntes).toBe(1);

    for (let i = 0; i < 4; i += 1) await A.aplicar(lote.id);

    expect(await pontosDe(A.admin)).toEqual(antes);
    expect(await comoAtor(A.admin, tx => tx.externalResult.count())).toBe(1);
    const somaDeBonus = (await pontosDe(A.admin)).reduce((t, p) => t + p.overallBonus, 0);
    expect(somaDeBonus).toBe(10);
  }, 60_000);
});

describe('CENÁRIO 3 — dois eventos, dois lançamentos, ranking acumulado', () => {
  it('5 no evento A e 4 no evento B somam 9, com cada ponto no seu evento', async () => {
    const loteA = (await A.lote(csv([linha('88281', 1)]), { eventId: A.eventoA.id })).body.import;
    const loteB = (await A.lote(csv([linha('88281', 2)]), { eventId: A.eventoB.id })).body.import;
    expect((await A.aplicar(loteA.id)).status).toBe(200);
    expect((await A.aplicar(loteB.id)).status).toBe(200);

    const pontos = await pontosDe(A.admin);
    expect(pontos).toHaveLength(2);
    expect(pontos.map(p => p.points)).toEqual([5, 4]);
    expect(new Set(pontos.map(p => p.eventId))).toEqual(new Set([A.eventoA.id, A.eventoB.id]));

    const ranking = await api().get('/api/v1/ranking').set(A.admin.auth())
      .query({ organizationId: A.org, seasonId: A.season });
    expect(ranking.body.items.find(i => i.athlete.id === A.atleta.id).totalPoints).toBe(9);

    // O histórico separa as duas etapas — não soma uma linha só.
    const origem = await api().get(`/api/v1/athletes/${A.atleta.id}/ranking-points`)
      .set(A.admin.auth()).query({ seasonId: A.season });
    expect(origem.body.items).toHaveLength(2);
  }, 60_000);
});

describe('CENÁRIO 4 — isolamento entre federações', () => {
  it('A não enxerga, não usa e não alcança nada da B', async () => {
    const loteB = (await B.lote(csv([linha('88281', 1)]), { eventId: B.eventoA.id })).body.import;
    await B.aplicar(loteB.id);

    // 1) não enxerga o evento da B na sua listagem
    const eventos = await api().get('/api/v1/events').set(A.operador.auth())
      .query({ organizationId: A.org });
    expect(eventos.body.items.map(e => e.id)).not.toContain(B.eventoA.id);

    // 2) não usa o eventId da B no próprio lote
    const comEventoDaB = await A.lote(csv([linha('88281', 1)]), { eventId: B.eventoA.id });
    expect(comEventoDaB.status).toBe(422);
    expect(JSON.stringify(comEventoDaB.body)).toMatch(/EVENT_INVALID/);

    // 3) não redireciona a própria publicação para o evento da B
    const meu = (await A.lote(csv([linha('88281', 1)]), { eventId: A.eventoA.id })).body.import;
    expect((await api().post(`/api/v1/musclewar/imports/${meu.id}/apply`)
      .set(A.operador.auth()).send({ eventId: B.eventoA.id })).status).toBe(200);
    const [meuPonto] = await pontosDe(A.admin, { athleteId: A.atleta.id });
    expect(meuPonto.eventId).toBe(A.eventoA.id);

    // 4) não alcança o lote nem o resultado da B
    for (const resposta of await Promise.all([
      api().get(`/api/v1/musclewar/imports/${loteB.id}`).set(A.operador.auth()),
      api().post(`/api/v1/musclewar/imports/${loteB.id}/apply`).set(A.operador.auth()).send({})
    ])) {
      expect([401, 403, 404]).toContain(resposta.status);
    }
  }, 60_000);
});

describe('CENÁRIO 5 — o evento do lote é imutável', () => {
  it('não há porta que troque o evento, nem antes nem depois de aplicar', async () => {
    const lote = (await A.lote(csv([linha('88281', 1)]), { eventId: A.eventoA.id })).body.import;

    const antesDeAplicar = await Promise.all([
      api().patch(`/api/v1/musclewar/imports/${lote.id}`).set(A.operador.auth()).send({ eventId: A.eventoB.id }),
      api().put(`/api/v1/musclewar/imports/${lote.id}`).set(A.operador.auth()).send({ eventId: A.eventoB.id })
    ]);
    for (const r of antesDeAplicar) expect(r.status).toBeGreaterThanOrEqual(400);

    await A.aplicar(lote.id);

    const depoisDeAplicar = await Promise.all([
      api().patch(`/api/v1/musclewar/imports/${lote.id}`).set(A.operador.auth()).send({ eventId: A.eventoB.id }),
      api().post(`/api/v1/musclewar/imports/${lote.id}/apply`).set(A.operador.auth()).send({ eventId: A.eventoB.id })
    ]);
    expect(depoisDeAplicar[0].status).toBeGreaterThanOrEqual(400);

    const guardado = await comoAtor(A.admin, tx => tx.muscleWarImport.findUnique({ where: { id: lote.id } }));
    expect(guardado.eventId).toBe(A.eventoA.id);
    const [ponto] = await pontosDe(A.admin);
    expect(ponto.eventId).toBe(A.eventoA.id);
  }, 60_000);
});

describe('CENÁRIO 6 — PENDING até o atleta existir, e nem um ponto antes disso', () => {
  it('matrícula desconhecida fica pendente e só pontua depois do cadastro', async () => {
    // DUAS linhas de propósito: uma do atleta já cadastrado, que faz o lote ser
    // de fato PUBLICADO, e uma de matrícula desconhecida, que fica pendente.
    // Um lote em que nada é reconhecido nunca chega a APPLIED — e não poderia
    // mesmo: um lote que ninguém publicou não pode se autopublicar só porque
    // um atleta se cadastrou depois. É a metade da regra que o cenário precisa
    // exercitar junto com a outra.
    const lote = (await A.lote(csv([linha('88281', 1, 1), linha('99999', 2, 2)]), { eventId: A.eventoA.id })).body.import;

    const itens = (await A.previa(lote.id)).body.items;
    const pendente = itens.find(i => i.memberNumber === '99999');
    expect(pendente.matchStatus).toBe('MATCH_PENDING');
    expect(pendente.athleteId ?? null).toBeNull();

    expect((await A.aplicar(lote.id)).status).toBe(200);

    // O lote PRECISA ter chegado a APPLIED: é essa a condição que faz o
    // vínculo tardio materializar o ponto depois.
    const publicado = await comoAtor(A.admin, tx => tx.muscleWarImport.findUnique({ where: { id: lote.id } }));
    expect(publicado.status).toBe('APPLIED');

    // 3) O PENDENTE PONTUA AGORA — e esta é a inversão desta fase.
    //
    // O cenário chamava-se "nem um ponto antes disso", e trancava a regra de
    // um sistema que já tinha cadastro. O MCI carrega o histórico oficial
    // ANTES de as pessoas se cadastrarem: o resultado de matrícula
    // desconhecida entra, vale o que a colocação dele vale, e fica esperando
    // dono. O que NÃO muda é a parte que importa — ninguém é cadastrado
    // automaticamente para isso acontecer.
    const depoisDaAplicacao = await pontosDe(A.admin);
    expect(depoisDaAplicacao).toHaveLength(2);

    const doCadastrado = depoisDaAplicacao.find(p => p.athleteId === A.atleta.id);
    const semDono = depoisDaAplicacao.find(p => p.athleteId === null);
    expect(doCadastrado, 'o resultado de quem tem cadastro').toBeTruthy();
    expect(semDono, 'o resultado histórico sem dono').toBeTruthy();
    expect(semDono.externalAthleteId).not.toBeNull();
    // Já com o evento e a colocação certos, antes de existir atleta nenhum.
    expect(semDono.eventId).toBe(A.eventoA.id);
    expect(semDono.placing).toBe(2);
    expect(semDono.points).toBe(4);

    // NENHUM ATLETA CRIADO. Continua sendo a asserção que não pode ceder.
    expect(await comoAtor(A.admin, tx => tx.athlete.count({ where: { organizationId: A.org } }))).toBe(1);

    // 4–7) o atleta passa a existir COM a matrícula que estava no arquivo
    const novo = await comoAtor(A.operador, tx => tx.athlete.create({
      data: {
        organizationId: A.org, fullName: 'ATLETA TARDIO', sex: 'MALE',
        affiliationId: A.filiacao.id, affiliationNumber: '99999',
        identity: { create: { organizationId: A.org, cpf: gerarCpf(773) } }
      }
    }));
    const ator = await atorCompleto(A.operador);
    const resultado = await comoAtor(ator, () => vincularPendentesDoAtleta(novo, ator));
    expect(resultado.vinculados).toBe(1);
    expect(resultado.conflitos).toBe(0);
    // O LOTE NÃO É REAPLICADO, e isso também inverteu. O ponto já existe: o
    // vínculo dá dono a ele, não o cria. Reaplicar aqui só produziria um 422
    // `NOTHING_TO_APPLY` a cada aprovação de cadastro.
    expect(resultado.lotesAplicados).toBe(0);
    expect(resultado.lancamentosVinculados).toBe(1);

    // 8–9) O MESMO PONTO, agora com dono. Não um ponto novo.
    const doTardio = await pontosDe(A.admin, { athleteId: novo.id });
    expect(doTardio).toHaveLength(1);
    expect(doTardio[0].id, 'é o mesmo lançamento, não um refeito').toBe(semDono.id);
    expect(doTardio[0].eventId).toBe(A.eventoA.id);
    expect(doTardio[0].placing).toBe(2);
    expect(doTardio[0].points).toBe(4);

    // 10) nada duplica, e o total não se mexe
    await comoAtor(A.operador, () => vincularPendentesDoAtleta(novo, A.operador));
    expect(await pontosDe(A.admin, { athleteId: novo.id })).toHaveLength(1);
    expect(await pontosDe(A.admin)).toHaveLength(2);
  }, 60_000);
});

describe('CENÁRIO 7 — conflito de identidade não se resolve no chute', () => {
  it('matrícula que aponta para mais de um atleta vira CONFLICT e não pontua', async () => {
    // Dois atletas da MESMA federação e filiação com a MESMA matrícula: a
    // chave deixa de identificar, e escolher um dos dois seria arbitrário.
    await comoAtor(A.operador, tx => tx.athlete.create({
      data: {
        organizationId: A.org, fullName: 'HOMONIMO UM', sex: 'MALE',
        affiliationId: A.filiacao.id, affiliationNumber: '55555',
        identity: { create: { organizationId: A.org, cpf: gerarCpf(774) } }
      }
    }));
    await comoAtor(A.operador, tx => tx.athlete.create({
      data: {
        organizationId: A.org, fullName: 'HOMONIMO DOIS', sex: 'MALE',
        affiliationId: A.filiacao.id, affiliationNumber: '55555',
        identity: { create: { organizationId: A.org, cpf: gerarCpf(775) } }
      }
    }));

    const lote = (await A.lote(csv([linha('55555', 1)]), { eventId: A.eventoA.id })).body.import;
    const [item] = (await A.previa(lote.id)).body.items;
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.athleteId ?? null).toBeNull();
    expect(item.matchCandidates.length).toBeGreaterThanOrEqual(2);

    await A.aplicar(lote.id);
    expect(await pontosDe(A.admin)).toHaveLength(0);
  }, 60_000);
});

describe('CENÁRIO 8 — não comparecimento é participação que vale zero', () => {
  it('NS entra como registro válido, sem colocação e sem ponto', async () => {
    const lote = (await A.lote(csv([linha('88281', 'NS')]), { eventId: A.eventoA.id })).body.import;
    const [item] = (await A.previa(lote.id)).body.items;
    expect(item.didNotShow).toBe(true);
    expect(item.placing).toBeNull();
    expect(item.matchStatus).toBe('MATCHED');

    expect((await A.aplicar(lote.id)).status).toBe(200);
    const [ponto] = await pontosDe(A.admin);
    expect(ponto.didNotShow).toBe(true);
    expect(ponto.placing).toBeNull();
    expect(ponto.placementPoints).toBe(0);
    expect(ponto.overallBonus).toBe(0);
    expect(ponto.points).toBe(0);
    expect(ponto.superOverallPoints).toBe(0);
  }, 60_000);
});

describe('§6 — o defeito do Overall, com o cenário exato pedido', () => {
  it('E1 · Men\'s Bodybuilding · Open · 1º + Overall = 5 + 10 = 15, preso ao E1', async () => {
    const lote = (await A.lote(csvOverall([`1,${OPEN},Atleta,Sobrenome,88281,1,Overall`]), { eventId: A.eventoA.id })).body.import;
    await A.aplicar(lote.id);

    const [ponto] = await pontosDe(A.admin);
    expect(ponto.placementPoints).toBe(5);
    expect(ponto.overallBonus).toBe(10);
    expect(ponto.points).toBe(15);
    expect(ponto.isOverallChampion).toBe(true);
    expect(ponto.superOverallEligible).toBe(true);
    expect(ponto.eventId).toBe(A.eventoA.id);
  }, 60_000);

  it('Novice 1º com Overall declarado indevidamente NÃO recebe bônus', async () => {
    const lote = (await A.lote(csvOverall([`1,${NOVICE},Atleta,Sobrenome,88281,1,Overall`]), { eventId: A.eventoA.id })).body.import;
    await A.aplicar(lote.id);

    const [ponto] = await pontosDe(A.admin);
    expect(ponto.placementPoints).toBe(5);
    expect(ponto.overallBonus).toBe(0);
    expect(ponto.points).toBe(5);
    expect(ponto.superOverallEligible).toBe(false);
    expect(ponto.superOverallPoints).toBe(0);
  }, 60_000);

  it('E2 não herda o Overall declarado em E1', async () => {
    const e1 = (await A.lote(csvOverall([`1,${OPEN},Atleta,Sobrenome,88281,1,Overall`]), { eventId: A.eventoA.id })).body.import;
    const e2 = (await A.lote(csv([linha('88281', 1)]), { eventId: A.eventoB.id })).body.import;
    await A.aplicar(e1.id);
    await A.aplicar(e2.id);

    const pontos = await pontosDe(A.admin);
    const noE1 = pontos.find(p => p.eventId === A.eventoA.id);
    const noE2 = pontos.find(p => p.eventId === A.eventoB.id);
    expect(noE1.points).toBe(15);
    expect(noE2.points).toBe(5);
    expect(noE2.overallBonus).toBe(0);
    expect(noE2.isOverallChampion).toBe(false);
  }, 60_000);
});
