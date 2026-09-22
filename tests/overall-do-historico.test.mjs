import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O OVERALL DE UM CAMPEONATO IMPORTADO.
//
// O QUE ESTAVA BLOQUEADO, MEDIDO NO CÓDIGO
//
// `EventOverallTitle.athleteId` era NOT NULL e apontava para `Athlete`. Os 191
// do Ipiranga estão no ledger com `athleteId` NULO — o MCI carrega histórico
// oficial ANTES de os atletas se cadastrarem, que é o caminho normal.
//
// E a conferência de elegibilidade lia `RegistrationItem`: a inscrição de um
// campeonato montado dentro do MCI. Resultado importado não tem inscrição, não
// tem `EventCategory` e não tem `CompetitionClass` — ele entra pronto.
//
// Resultado: declarar o Overall do Ipiranga respondia
// 422 OVERALL_REQUIRES_ABSOLUTE_CLASS. Não por regra esportiva — por forma do
// modelo. A organização tinha o campeão na súmula e a plataforma não tinha
// onde gravar o fato.
//
// A REGRA ESPORTIVA NÃO MUDOU. O título continua sendo da classe ABSOLUTA, o
// bônus continua valendo uma vez, e o sistema continua não escolhendo campeão.
// O que mudou foi ONDE a plataforma procura a participação: no ledger, quando
// a grade não existe.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

// Duas categorias, classe ABSOLUTA (Open) nas duas, e uma classe que NÃO é
// absoluta — é ela que prova que o bônus não pousa fora da absoluta.
const LINHAS = [
  ['QA-O-1', 'MENS_BODYBUILDING', "Men's Bodybuilding - Open Heavyweight", '1'],
  ['QA-O-2', 'MENS_BODYBUILDING', "Men's Bodybuilding - Open Heavyweight", '2'],
  ['QA-O-3', 'BIKINI', "Women's Bikini - Open Class A", '1'],
  ['QA-O-4', 'BIKINI', "Women's Bikini - Open Class A", '2'],
  ['QA-O-5', 'BIKINI', "Women's Bikini - Masters 35+", '1']
];

const arquivo = () => [
  CABECALHO,
  ...LINHAS.map(([id, categoria, classe, colocacao], i) =>
    `${id},QA ATLETA ${i + 1},NPC,${id.replace('QA-O-', 'QA-R-')},${categoria},${classe},${colocacao},Etapa QA`)
].join('\n');

const TABELA = [
  { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
  { placing: 4, points: 2 }, { placing: 5, points: 1 }
];

let admin;
let gerente;
let organizationId;
let seasonId;
let eventId;

const noLedger = consulta => comoAtor(gerente, consulta);

const recalcular = () => api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

const pontoDe = externalId => noLedger(async tx => {
  const externo = await tx.externalResult.findFirst({ where: { externalId }, select: { id: true } });
  return tx.rankingPoint.findFirst({
    where: { externalResultId: externo.id },
    select: {
      id: true, placing: true, placementPoints: true, overallBonus: true,
      adjustmentPoints: true, points: true, superOverallPoints: true,
      superOverallEligible: true, isOverallChampion: true,
      categoryId: true, externalAthleteId: true
    }
  });
});

const categoriaPorCodigo = async code => comoAtor(admin, tx =>
  tx.category.findUnique({ where: { code }, select: { id: true } }));

const declarar = corpo => api().post(`/api/v1/events/${eventId}/overall`).set(admin.auth()).send(corpo);
const candidatos = () => api().get(`/api/v1/events/${eventId}/overall/candidates`).set(admin.auth());
// O controlador devolve `{ items }` — a lista vem de lá.
const titulos = async () => (await api().get(`/api/v1/events/${eventId}/overall`).set(admin.auth())).body.items;
const revogar = (titleId, reason) => api().delete(`/api/v1/events/${eventId}/overall/${titleId}`)
  .set(admin.auth()).send({ reason });

beforeAll(() => garantirCatalogo());

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

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({ rules: TABELA });

  // O EVENTO EXISTE — foi criado no MCI e o lote foi amarrado a ele. É assim
  // que o Ipiranga entrou: evento sim, grade não.
  eventId = (await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: 'Etapa QA Ipiranga', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Sao Paulo', state: 'SP', seasonId
  })).body.id;

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, eventId, sourceType: 'CSV',
    sourceRef: unico('overall') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
});

describe('o campeonato importado não tem grade, e mesmo assim tem candidatos', () => {
  it('os candidatos vêm do ledger, por categoria, com a colocação da súmula', async () => {
    const resposta = await candidatos();
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(200);
    expect(resposta.body.fromLedger).toBe(true);

    const porCategoria = new Map(resposta.body.items.map(item => [item.category.code, item]));
    expect([...porCategoria.keys()].sort()).toEqual(['BIKINI', 'MENS_BODYBUILDING']);

    // SÓ A ABSOLUTA É CANDIDATA. "Masters 35+" competiu em Bikini e não
    // aparece: o título é da absoluta e de mais ninguém.
    const bikini = porCategoria.get('BIKINI');
    expect(bikini.candidates.length).toBe(2);
    expect(bikini.candidates.map(c => c.placing)).toEqual([1, 2]);
    // O competidor não tem cadastro: quem o identifica é o histórico.
    expect(bikini.candidates.every(c => c.athlete === null)).toBe(true);
    expect(bikini.candidates.every(c => c.externalAthlete?.displayName)).toBe(true);
    expect(bikini.declaredTitle).toBeNull();
  });
});

describe('declarar o Overall de quem ainda não tem cadastro', () => {
  it('o bônus pousa na participação certa, e só nela', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');

    const declaracao = await declarar({
      externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id
    });
    expect(declaracao.status, JSON.stringify(declaracao.body).slice(0, 400)).toBe(201);

    const comBonus = await pontoDe('QA-O-3');
    expect(comBonus.overallBonus).toBe(10);
    expect(comBonus.isOverallChampion).toBe(true);
    expect(comBonus.placementPoints).toBe(5);
    expect(comBonus.points).toBe(15);

    // E EM MAIS NINGUÉM.
    expect((await pontoDe('QA-O-4')).overallBonus).toBe(0);
    expect((await pontoDe('QA-O-1')).overallBonus).toBe(0);
    expect((await pontoDe('QA-O-5')).overallBonus).toBe(0);
  });

  it('o bônus NÃO vai para a classe que não é absoluta', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    // O 1º de "Masters 35+" — mesma categoria, classe que não é a absoluta.
    const masters = await pontoDe('QA-O-5');
    expect(masters.superOverallEligible).toBe(false);

    const declaracao = await declarar({
      externalAthleteId: masters.externalAthleteId, categoryId: bikini.id
    });
    // A regra vigente recusa: o título é da absoluta, e este competidor não
    // tem participação nela.
    expect(declaracao.status).toBe(422);
    expect(JSON.stringify(declaracao.body)).toMatch(/OVERALL_REQUIRES_ABSOLUTE_CLASS/);
    expect((await pontoDe('QA-O-5')).overallBonus).toBe(0);
  });

  it('com DUAS participações absolutas, o bônus pousa em UMA só', async () => {
    // O MUTATION TESTING PEDIU ESTE TESTE.
    //
    // No cenário anterior cada competidor tinha uma única participação
    // absoluta, e aí "o portador" e "todos" são o mesmo conjunto: trocar
    // `linha.id === portadora.id` por `true` passava batido.
    //
    // A regra homologada é que o bônus de Overall vale UMA VEZ — é um título,
    // não um prêmio por inscrição. Quem se inscreve em duas classes absolutas
    // da mesma categoria não leva +20.
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    const segunda = await pontoDe('QA-O-4');

    // A segunda participação passa a ser do MESMO competidor, na mesma
    // categoria e também na absoluta.
    await comoAtor(gerente, tx => tx.rankingPoint.update({
      where: { id: segunda.id }, data: { externalAthleteId: campeao.externalAthleteId }
    }));

    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    const primeira = await pontoDe('QA-O-3');
    const outra = await pontoDe('QA-O-4');

    // UMA carrega o bônus, a outra não. Qual delas é escolha de LOCALIZAÇÃO
    // (a melhor colocação), e não de mérito: o total do competidor é o mesmo.
    const bonus = [primeira.overallBonus, outra.overallBonus].sort();
    expect(bonus, 'exatamente um +10').toEqual([0, 10]);
    expect(primeira.overallBonus + outra.overallBonus).toBe(10);
    // A colocação continua acumulando normalmente: 5 + 4 + 10 = 19.
    expect(primeira.points + outra.points).toBe(19);
  });

  it('declarar de novo o MESMO campeão é idempotente: um título, um bônus', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    const corpo = { externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id };

    expect((await declarar(corpo)).status).toBe(201);
    expect((await declarar(corpo)).status).toBe(201);

    expect((await titulos()).length).toBe(1);
    expect((await pontoDe('QA-O-3')).overallBonus).toBe(10);
    expect((await pontoDe('QA-O-3')).points).toBe(15);
  });

  it('trocar o campeão exige revogar antes, e o bônus antigo sai', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const primeiro = await pontoDe('QA-O-3');
    const segundo = await pontoDe('QA-O-4');

    expect((await declarar({ externalAthleteId: primeiro.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    // TÍTULO HOMOLOGADO NÃO SE TROCA POR UM POST REPETIDO.
    const tentativa = await declarar({ externalAthleteId: segundo.externalAthleteId, categoryId: bikini.id });
    expect(tentativa.status).toBe(409);
    expect(JSON.stringify(tentativa.body)).toMatch(/OVERALL_ALREADY_DECLARED/);

    const titulo = (await titulos())[0];
    expect((await revogar(titulo.id, 'Campeão corrigido conforme a súmula oficial')).status).toBe(200);

    expect((await declarar({ externalAthleteId: segundo.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    // O bônus antigo saiu, o novo entrou, e não há bônus duplicado.
    expect((await pontoDe('QA-O-3')).overallBonus).toBe(0);
    expect((await pontoDe('QA-O-3')).points).toBe(5);
    expect((await pontoDe('QA-O-4')).overallBonus).toBe(10);
    expect((await pontoDe('QA-O-4')).points).toBe(14);
  });

  it('revogar tira o bônus e preserva a colocação', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    const titulo = (await titulos())[0];
    expect((await revogar(titulo.id, 'Homologação revertida por decisão da organização')).status).toBe(200);

    const depois = await pontoDe('QA-O-3');
    expect(depois.overallBonus).toBe(0);
    expect(depois.isOverallChampion).toBe(false);
    // A COLOCAÇÃO NÃO É TOCADA: só o bônus sai.
    expect(depois.placementPoints).toBe(5);
    expect(depois.points).toBe(5);
    expect((await titulos()).length).toBe(0);
  });

  it('o recálculo não duplica nem perde o bônus, dez vezes seguidas', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    const antes = await pontoDe('QA-O-3');
    expect(antes.points).toBe(15);

    for (let i = 0; i < 10; i += 1) {
      const resposta = await recalcular();
      expect(resposta.status).toBe(200);
      const agora = await pontoDe('QA-O-3');
      expect(agora.overallBonus, `recálculo ${i + 1}`).toBe(10);
      expect(agora.points, `recálculo ${i + 1}`).toBe(15);
    }

    expect(await pontoDe('QA-O-3')).toEqual(antes);
  });

  it('o recálculo reconstrói o bônus a partir do título declarado', async () => {
    // O TÍTULO É A FONTE, E O RECÁLCULO VOLTA A ELA.
    //
    // Se o bônus sumir do ledger por qualquer caminho — uma correção manual
    // malfeita, um estado herdado de antes desta fase —, "Recalcular" tem de
    // reconstituí-lo a partir da declaração, que é o fato homologado. Sem
    // isso, o operador teria de revogar e declarar de novo para consertar um
    // número que a plataforma já sabe calcular.
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);
    expect((await pontoDe('QA-O-3')).points).toBe(15);

    await comoAtor(gerente, tx => tx.rankingPoint.update({
      where: { id: campeao.id },
      data: { overallBonus: 0, isOverallChampion: false, points: 5, superOverallPoints: 5 }
    }));
    expect((await pontoDe('QA-O-3')).overallBonus).toBe(0);

    expect((await recalcular()).status).toBe(200);

    const reconstituido = await pontoDe('QA-O-3');
    expect(reconstituido.overallBonus).toBe(10);
    expect(reconstituido.isOverallChampion).toBe(true);
    expect(reconstituido.points).toBe(15);
  });

  it('mudar a tabela recalcula a colocação e mantém o bônus uma vez só', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
      .send({ rules: [{ placing: 1, points: 25 }, { placing: 2, points: 18 }] });
    expect((await recalcular()).status).toBe(200);

    const depois = await pontoDe('QA-O-3');
    expect(depois.placementPoints).toBe(25);
    expect(depois.overallBonus).toBe(10);
    expect(depois.points).toBe(35);
  });
});

describe('o ajuste administrativo sobrevive a declarar e revogar Overall', () => {
  it('a parcela de ajuste não é apagada pela normalização do bônus', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');
    expect(campeao.points).toBe(5);

    // O operador corrige para 8, com motivo: a parcela de ajuste vale +3.
    const ajuste = await api().post(`/api/v1/ranking/points/${campeao.id}/adjust`).set(admin.auth())
      .send({ points: 8, expectedPoints: 5, reason: 'Correção homologada pela organização em ata' });
    expect(ajuste.status, JSON.stringify(ajuste.body).slice(0, 300)).toBe(200);
    expect((await pontoDe('QA-O-3')).adjustmentPoints).toBe(3);

    // DECLARAR O OVERALL NÃO REVOGA DECISÃO ADMINISTRATIVA.
    //
    // Antes desta correção, `normalizarBonusOverall` somava só
    // `placementPoints + overallBonus` — e o +3 sumia em silêncio, com a
    // trilha de auditoria do ajuste continuando lá, apontando para um número
    // que o ledger já não tinha.
    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    const comBonus = await pontoDe('QA-O-3');
    expect(comBonus.placementPoints).toBe(5);
    expect(comBonus.overallBonus).toBe(10);
    expect(comBonus.adjustmentPoints).toBe(3);
    expect(comBonus.points).toBe(18);

    // E REVOGAR TAMBÉM NÃO.
    const titulo = (await titulos())[0];
    expect((await revogar(titulo.id, 'Homologação revertida por decisão da organização')).status).toBe(200);

    const semBonus = await pontoDe('QA-O-3');
    expect(semBonus.overallBonus).toBe(0);
    expect(semBonus.adjustmentPoints).toBe(3);
    expect(semBonus.points).toBe(8);
  });
});

describe('as recusas continuam recusando', () => {
  it('competidor e atleta juntos, ou nenhum dos dois, é recusado', async () => {
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');

    const nenhum = await declarar({ categoryId: bikini.id });
    expect(nenhum.status).toBe(400);

    const atleta = await comoAtor(admin, tx => tx.athlete.create({
      data: { organizationId, fullName: 'QA ATLETA CADASTRADO', sex: 'MALE' }
    }));
    const ambos = await declarar({
      athleteId: atleta.id, externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id
    });
    expect(ambos.status).toBe(400);
  });

  it('competidor de OUTRA organização é recusado', async () => {
    const vizinha = await criarOrganizacao(admin, { name: 'MCI Vizinha' });
    const bikini = await categoriaPorCodigo('BIKINI');

    const externoDaVizinha = await comoAtor(admin, tx => tx.externalAthlete.create({
      data: {
        organizationId: vizinha.id, identityKey: unico('ik'),
        displayName: 'COMPETIDOR DA VIZINHA'
      }
    }));

    const resposta = await declarar({ externalAthleteId: externoDaVizinha.id, categoryId: bikini.id });
    expect(resposta.status).toBe(422);
    expect(JSON.stringify(resposta.body)).toMatch(/ATHLETE_OTHER_ORGANIZATION/);
  });

  it('categoria que não é deste campeonato é recusada com o erro certo', async () => {
    const fitness = await categoriaPorCodigo('FITNESS');
    const campeao = await pontoDe('QA-O-3');

    const resposta = await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: fitness.id });
    expect(resposta.status).toBe(422);
    expect(JSON.stringify(resposta.body)).toMatch(/CATEGORY_NOT_IN_EVENT/);
  });

  it('dois títulos do MESMO competidor em categorias diferentes continuam recusados', async () => {
    // A regra de pontuação para esse caso NÃO está homologada. A plataforma
    // recusa em vez de legislar.
    const bikini = await categoriaPorCodigo('BIKINI');
    const bodybuilding = await categoriaPorCodigo('MENS_BODYBUILDING');

    // O mesmo competidor em duas categorias: uma linha a mais, pelo ledger.
    const campeao = await pontoDe('QA-O-3');
    const outra = await pontoDe('QA-O-1');
    await comoAtor(gerente, tx => tx.rankingPoint.update({
      where: { id: outra.id }, data: { externalAthleteId: campeao.externalAthleteId }
    }));

    expect((await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id })).status).toBe(201);

    const segunda = await declarar({ externalAthleteId: campeao.externalAthleteId, categoryId: bodybuilding.id });
    expect(segunda.status).toBe(409);
    expect(JSON.stringify(segunda.body)).toMatch(/OVERALL_MULTIPLE_CATEGORIES_PENDING_RULE/);
  });

  it('usuário sem permissão de ranking não declara', async () => {
    const qualquer = await criarUsuario({ name: 'Usuário Comum' });
    const bikini = await categoriaPorCodigo('BIKINI');
    const campeao = await pontoDe('QA-O-3');

    const resposta = await api().post(`/api/v1/events/${eventId}/overall`).set(qualquer.auth())
      .send({ externalAthleteId: campeao.externalAthleteId, categoryId: bikini.id });
    expect([401, 403]).toContain(resposta.status);
    expect((await pontoDe('QA-O-3')).overallBonus).toBe(0);
  });
});
