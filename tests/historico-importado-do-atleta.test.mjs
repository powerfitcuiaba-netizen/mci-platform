import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// O HISTÓRICO IMPORTADO, VISTO DO LADO DO ATLETA — E O VÍNCULO MANUAL.
//
// O CENÁRIO É O DO IPIRANGA, e ele é o caminho normal do MCI: o resultado
// oficial entra ANTES de a pessoa se cadastrar. Os 191 lançamentos daquela
// etapa estão no ledger apontando para identidades externas, sem dono.
//
// Quando o atleta finalmente se cadastra, três coisas podem acontecer:
//
//   * a filiação e a matrícula batem → o vínculo é automático, e já era
//     assim antes desta fase;
//   * só o NOME bate → nada acontece automaticamente, e é justamente isso
//     que esta suíte tranca. Duas atletas chamadas "Ana Silva" existem;
//     creditar a carreira de uma à outra é o erro que só aparece quando a
//     prejudicada vai ver o próprio histórico;
//   * nada bate → o histórico continua sem dono, que é o estado honesto.
//
// O que esta fase acrescenta é a TERCEIRA porta para `adotarLedger`: o
// operador abre o perfil, vê lado a lado o cadastro e o histórico candidato
// COM OS RESULTADOS, e decide. A regra do ledger não muda: preencher
// ponteiro, nunca criar lançamento.
//
// O TESTE DE NÃO-REGRESSÃO QUE IMPORTA: depois do vínculo, a colocação, os
// pontos, a categoria, a classe, o evento e a temporada de cada lançamento
// têm de estar IDÊNTICOS. Vincular diz de quem é; não diz quanto vale.
// ============================================================================

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const NOME_DA_ATLETA = 'JOANA PEREIRA DA SILVA';
const MATRICULA_DA_FONTE = 'QA-M-901';

// Três linhas para a mesma identidade externa (mesma filiação + matrícula):
// é assim que uma carreira aparece no arquivo — várias categorias, um número.
const LINHAS = [
  ['QA-H-1', NOME_DA_ATLETA, MATRICULA_DA_FONTE, 'BIKINI', "Women's Bikini - Open Class A", '1'],
  ['QA-H-2', NOME_DA_ATLETA, MATRICULA_DA_FONTE, 'WELLNESS', 'Wellness - Open', '3'],
  // Uma homônima com OUTRA matrícula: o nome sozinho não distingue as duas.
  ['QA-H-3', NOME_DA_ATLETA, 'QA-M-902', 'FIGURE', 'Figure - Open', '2'],
  // E alguém sem relação nenhuma, que nunca pode virar sugestão.
  ['QA-H-4', 'OUTRA PESSOA QUALQUER', 'QA-M-903', 'BIKINI', "Women's Bikini - Open Class A", '5']
];

const arquivo = () => [
  CABECALHO,
  ...LINHAS.map(([id, nome, matricula, categoria, classe, colocacao]) =>
    `${id},${nome},NPC,${matricula},${categoria},${classe},${colocacao},Etapa QA Ipiranga`)
].join('\n');

const TABELA = [
  { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
  { placing: 4, points: 2 }, { placing: 5, points: 1 }
];

let admin;
let gerente;
let operador;
let deOutraOrg;
let organizationId;
let affiliationId;
let seasonId;
let eventId;

const cpfSeq = (() => { let n = 442000000; return () => gerarCpf(n += 4423); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  operador = await criarUsuario({ name: 'Operador de inscrição' });
  deOutraOrg = await criarUsuario({ name: 'Diretor da federação vizinha' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, operador, 'REGISTRATION_OPERATOR');

  const vizinha = await criarOrganizacao(admin, { name: unico('MCI Vizinha') });
  await vincular(vizinha.id, deOutraOrg, 'EVENT_DIRECTOR');

  affiliationId = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body.id;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({ rules: TABELA });

  eventId = (await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: 'Etapa QA Ipiranga', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Sao Paulo', state: 'SP', seasonId
  })).body.id;

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, eventId, sourceType: 'CSV',
    sourceRef: unico('historico') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
});

// ---------------------------------------------------------------- utilidades

const criarAtleta = async (dados = {}) => {
  const resposta = await api().post('/api/v1/athletes').set(admin.auth()).send({
    organizationId, fullName: NOME_DA_ATLETA, sex: 'FEMALE', cpf: cpfSeq(), ...dados
  });
  expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(201);
  return resposta.body.id;
};

const historico = (athleteId, ator = admin) =>
  api().get(`/api/v1/athletes/${athleteId}/imported-history`).set(ator.auth());

const vincularIdentidade = (athleteId, externalAthleteId, ator = admin) =>
  api().post(`/api/v1/athletes/${athleteId}/imported-history/${externalAthleteId}/link`).set(ator.auth());

// A FOTOGRAFIA DO LEDGER — é ela que não pode mudar por causa de um vínculo.
const retratoDoLedger = () => comoAtor(gerente, async tx => {
  const pontos = await tx.rankingPoint.findMany({
    where: { seasonId },
    select: {
      id: true, placing: true, placementPoints: true, overallBonus: true,
      adjustmentPoints: true, points: true, superOverallPoints: true,
      categoryId: true, catalogClassId: true, eventId: true, seasonId: true,
      externalResultId: true, voidedAt: true
    },
    orderBy: { id: 'asc' }
  });
  const resultados = await tx.externalResult.findMany({
    where: { organizationId },
    select: {
      id: true, externalId: true, categoryCode: true, className: true,
      placing: true, points: true, eventName: true, seasonId: true
    },
    orderBy: { externalId: 'asc' }
  });
  return { pontos, resultados };
});

// O dono fica FORA do retrato de propósito: ele é o único campo que o vínculo
// pode mudar. Quem confere dono é esta consulta, direta e separada.
const donosDaIdentidade = externalAthleteId => comoAtor(gerente, tx => tx.rankingPoint.findMany({
  where: { externalAthleteId }, select: { athleteId: true }, orderBy: { id: 'asc' }
}));

const identidadeDe = matricula => comoAtor(gerente, tx => tx.externalAthlete.findFirst({
  where: { organizationId, affiliationNumber: matricula },
  select: { id: true, athleteId: true, displayName: true }
}));

// ---------------------------------------------------------------- a leitura

describe('o perfil mostra o que já é do atleta e o que pode ser', () => {
  it('atleta recém-cadastrado sem matrícula: nada vinculado, e o nome vira SUGESTÃO — nunca vínculo', async () => {
    const athleteId = await criarAtleta();

    const resposta = await historico(athleteId);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body.linked).toEqual([]);

    // As duas identidades com o mesmo nome aparecem; a de outra pessoa, não.
    const nomes = resposta.body.suggestions.map(s => s.displayName);
    expect(nomes).toEqual([NOME_DA_ATLETA, NOME_DA_ATLETA]);
    expect(resposta.body.suggestions.every(s => s.matchedBy === 'NAME')).toBe(true);
    expect(resposta.body.suggestions.every(s => s.exigeConfirmacaoHumana)).toBe(true);
    // E o sistema DIZ que há ambiguidade em vez de escolher.
    expect(resposta.body.suggestions.every(s => s.homonimos)).toBe(true);

    // NADA foi vinculado por nome: o ledger continua inteiro sem dono.
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);
    expect(identidade.athleteId).toBeNull();
  });

  it('a sugestão carrega os RESULTADOS, para que o operador confirme uma carreira e não um nome', async () => {
    const athleteId = await criarAtleta();
    const { body } = await historico(athleteId);

    const daMatricula = body.suggestions.find(s => s.affiliationNumber === MATRICULA_DA_FONTE);
    expect(daMatricula).toBeTruthy();
    expect(daMatricula.results.map(r => r.categoryCode).sort()).toEqual(['BIKINI', 'WELLNESS']);
    expect(daMatricula.results.map(r => r.placing).sort()).toEqual([1, 3]);
    expect(daMatricula.results.every(r => r.eventName === 'Etapa QA Ipiranga')).toBe(true);
    expect(daMatricula.results.every(r => r.seasonId === seasonId)).toBe(true);
  });

  it('filiação + matrícula é chave FORTE: vincula sozinha no cadastro, e aparece como já vinculada', async () => {
    const athleteId = await criarAtleta({ affiliationId, affiliationNumber: MATRICULA_DA_FONTE });

    const { body } = await historico(athleteId);
    expect(body.linked).toHaveLength(1);
    expect(body.linked[0].affiliationNumber).toBe(MATRICULA_DA_FONTE);
    expect(body.linked[0].results).toHaveLength(2);

    // E a identidade já vinculada NÃO reaparece entre as sugestões.
    expect(body.suggestions.map(s => s.affiliationNumber)).not.toContain(MATRICULA_DA_FONTE);
  });

  it('a identidade que já pertence a OUTRO atleta nunca é sugerida', async () => {
    const daMatricula = await criarAtleta({ affiliationId, affiliationNumber: MATRICULA_DA_FONTE });
    expect(daMatricula).toBeTruthy();

    const outra = await criarAtleta({ fullName: NOME_DA_ATLETA });
    const { body } = await historico(outra);

    expect(body.suggestions.map(s => s.affiliationNumber)).not.toContain(MATRICULA_DA_FONTE);
    // Só sobra a homônima sem dono.
    expect(body.suggestions.map(s => s.affiliationNumber)).toEqual(['QA-M-902']);
  });
});

// ---------------------------------------------------------------- o vínculo

describe('o vínculo manual adota o ledger sem tocar em pontuação', () => {
  it('a colocação, os pontos, a categoria, a classe, o evento e a temporada ficam idênticos', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    const antes = await retratoDoLedger();
    // O ponto de partida é o do Ipiranga: lançamento gravado, sem dono.
    const donosAntes = await donosDaIdentidade(identidade.id);
    expect(donosAntes).toHaveLength(2);
    expect(donosAntes.every(ponto => ponto.athleteId === null)).toBe(true);

    const resposta = await vincularIdentidade(athleteId, identidade.id);
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
    expect(resposta.body.alreadyLinked).toBe(false);
    expect(resposta.body.lancamentos).toBe(2);

    const depois = await retratoDoLedger();

    // MESMA QUANTIDADE DE LANÇAMENTOS: vincular não cria linha nenhuma.
    expect(depois.pontos).toHaveLength(antes.pontos.length);
    // E cada lançamento é IDÊNTICO ao que era, campo a campo.
    expect(depois.pontos).toEqual(antes.pontos);
    // Os resultados importados também: nada de reescrever a súmula.
    expect(depois.resultados).toEqual(antes.resultados);
  });

  it('o que muda é só o dono: os lançamentos daquela identidade passam a apontar para o cadastro', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    await vincularIdentidade(athleteId, identidade.id);

    const donos = await comoAtor(gerente, tx => tx.rankingPoint.findMany({
      where: { externalAthleteId: identidade.id },
      select: { athleteId: true, points: true, placing: true }
    }));
    expect(donos).toHaveLength(2);
    expect(donos.every(ponto => ponto.athleteId === athleteId)).toBe(true);
    // Os valores continuam os da súmula: 1º = 5, 3º = 3.
    expect(donos.map(p => p.points).sort((a, b) => a - b)).toEqual([3, 5]);

    // A identidade da homônima continua sem dono.
    const homonima = await identidadeDe('QA-M-902');
    expect(homonima.athleteId).toBeNull();
  });

  it('repetir o vínculo não faz nada — e diz que não fez', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    await vincularIdentidade(athleteId, identidade.id);
    const antes = await retratoDoLedger();

    const segunda = await vincularIdentidade(athleteId, identidade.id);
    expect(segunda.status).toBe(200);
    expect(segunda.body.alreadyLinked).toBe(true);
    expect(segunda.body.lancamentos).toBe(0);

    expect(await retratoDoLedger()).toEqual(antes);
  });

  it('depois do vínculo a sugestão vira vínculo, e some da lista de candidatas', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);
    await vincularIdentidade(athleteId, identidade.id);

    const { body } = await historico(athleteId);
    expect(body.linked.map(l => l.id)).toEqual([identidade.id]);
    expect(body.suggestions.map(s => s.id)).not.toContain(identidade.id);
  });

  it('o agregado da temporada troca de competidor sem trocar de total', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    const totalAntes = await comoAtor(gerente, tx => tx.ranking.aggregate({
      where: { seasonId }, _sum: { totalPoints: true }
    }));

    await vincularIdentidade(athleteId, identidade.id);

    const totalDepois = await comoAtor(gerente, tx => tx.ranking.aggregate({
      where: { seasonId }, _sum: { totalPoints: true }
    }));
    expect(totalDepois._sum.totalPoints).toBe(totalAntes._sum.totalPoints);

    // E o agregado daquela carreira agora tem dono.
    const linhas = await comoAtor(gerente, tx => tx.ranking.findMany({
      where: { seasonId, athleteId }, select: { totalPoints: true, categoryId: true }
    }));
    expect(linhas.length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ recusas

describe('o vínculo recusa o que não pode', () => {
  it('identidade que já tem OUTRO dono responde 409 e não muda nada', async () => {
    const primeira = await criarAtleta({ affiliationId, affiliationNumber: MATRICULA_DA_FONTE });
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);
    expect(identidade.athleteId).toBe(primeira);

    const segunda = await criarAtleta({ fullName: NOME_DA_ATLETA });
    const antes = await retratoDoLedger();

    const resposta = await vincularIdentidade(segunda, identidade.id);
    expect(resposta.status).toBe(409);
    expect(resposta.body.error?.code || resposta.body.code).toBe('EXTERNAL_ATHLETE_ALREADY_LINKED');

    expect(await retratoDoLedger()).toEqual(antes);
    expect((await identidadeDe(MATRICULA_DA_FONTE)).athleteId).toBe(primeira);
  });

  it('identidade de outra organização não existe para este ator', async () => {
    const athleteId = await criarAtleta();
    const externoDaVizinha = await comoAtor(admin, async tx => {
      const vizinha = await tx.organization.findFirst({
        where: { NOT: { id: organizationId } }, select: { id: true }
      });
      return tx.externalAthlete.create({
        data: { organizationId: vizinha.id, identityKey: unico('EXT:QA'), displayName: 'QA DE OUTRA FEDERAÇÃO' },
        select: { id: true }
      });
    });

    const resposta = await vincularIdentidade(athleteId, externoDaVizinha.id);
    expect(resposta.status).toBe(404);
  });

  it('quem não tem `musclewar.review` não vincula', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    const resposta = await vincularIdentidade(athleteId, identidade.id, operador);
    expect(resposta.status).toBe(403);
    expect((await identidadeDe(MATRICULA_DA_FONTE)).athleteId).toBeNull();
  });

  it('operador de outra organização não lê o histórico deste atleta', async () => {
    const athleteId = await criarAtleta();
    const resposta = await historico(athleteId, deOutraOrg);
    expect([403, 404]).toContain(resposta.status);
  });

  it('sem autenticação, 401 nas duas rotas', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);

    expect((await api().get(`/api/v1/athletes/${athleteId}/imported-history`)).status).toBe(401);
    expect((await api().post(`/api/v1/athletes/${athleteId}/imported-history/${identidade.id}/link`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------- auditoria

describe('o vínculo manual deixa autor e data', () => {
  it('grava RESULTADO_EXTERNAL_LINKED dizendo que veio do perfil e que foi manual', async () => {
    const athleteId = await criarAtleta();
    const identidade = await identidadeDe(MATRICULA_DA_FONTE);
    await vincularIdentidade(athleteId, identidade.id);

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: 'RESULTADO_EXTERNAL_LINKED', entity: 'ExternalAthlete', entityId: identidade.id },
      select: { userId: true, metadata: true }
    }));

    expect(trilha.length).toBeGreaterThan(0);
    expect(trilha.some(linha => linha.metadata?.via === 'perfil-do-atleta' && linha.metadata?.manual === true)).toBe(true);
    expect(trilha.every(linha => linha.userId === admin.id)).toBe(true);

    // E a identidade guarda quem vinculou e quando.
    const marcada = await comoAtor(gerente, tx => tx.externalAthlete.findUnique({
      where: { id: identidade.id }, select: { linkedById: true, linkedAt: true }
    }));
    expect(marcada.linkedById).toBe(admin.id);
    expect(marcada.linkedAt).toBeTruthy();
  });
});
