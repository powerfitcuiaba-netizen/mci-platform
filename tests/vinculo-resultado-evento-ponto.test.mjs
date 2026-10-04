import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// RESULTADO IMPORTADO → ATLETA → EVENTO → PONTO → O QUE A TELA MOSTRA.
//
// O CASO REAL QUE ORIGINOU ESTE ARQUIVO
//
// Um atleta com NPC + 2932 aparecia com, na aba Pontuação, 15 pontos, 1 etapa
// e 1 Overall — e, na aba Histórico importado, UM resultado com campeonato
// "—" e "0 pontos". Parecia vínculo pela metade. Não era.
//
// A CAUSA, medida: as duas abas leem FONTES DIFERENTES, e as duas estavam
// certas sobre a sua própria fonte.
//
//   `ExternalResult.points`    = a COLUNA DE PONTOS DO ARQUIVO (`@default(0)`).
//                               Arquivo sem essa coluna grava zero, e está
//                               correto: o arquivo não disse nada.
//   `ExternalResult.eventName` = o TEXTO digitado no arquivo. Vazio vira "—".
//
//   `RankingPoint.points`      = a pontuação OFICIAL: tabela homologada
//                               aplicada à colocação + bônus de Overall.
//                               1º = 5, Overall = +10 → 15. Daí os 15.
//   `RankingPoint.eventId`     = o evento, vindo do LOTE. `ExternalResult`
//                               não tem coluna de evento nenhuma.
//
// A aba Histórico importado projetava `ExternalResult` e mostrava o número do
// arquivo sob o rótulo "Pontos". Dado certo, lugar errado.
//
// A CORREÇÃO é de PROJEÇÃO, e é o que este arquivo tranca: a resposta passa a
// carregar também `officialPoints` e `event`, lidos pela relação 1:1
// `ExternalResult.rankingPoint` que JÁ EXISTIA. Nenhuma escrita, nenhum
// recálculo, nenhum lançamento novo, nenhuma migration, nenhum backfill.
//
// O QUE ESTE ARQUIVO NÃO TESTA, de propósito: a identidade. Ela já está
// provada em `identidade-por-matricula.test.mjs` e `matricula-identifica-um`.
// Aqui a pergunta é a seguinte — depois de identificado, o resultado chega
// INTEIRO às consultas do atleta?
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let npc;
let outraFiliacao;

const noLedger = consulta => comoAtor(gerente, consulta);

// O arquivo do caso real NÃO tem coluna de pontos preenchida — é dela que sai
// o zero que a tela mostrava. A coluna `overall` existe porque é o que dá o
// bônus de +10, e sem ela os 15 pontos não se formam.
const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento,overall';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

// Um evento do MCI, para o lote poder declará-lo. É o que faz o ledger ter
// `eventId` e, portanto, o que faz o histórico importado ter campeonato.
async function criarEvento(nome) {
  const evento = await api().post('/api/v1/events').set(admin.auth()).send({
    organizationId, name: nome, slug: unico('ev'),
    startDate: '2026-05-10T12:00:00.000Z', seasonId
  });
  expect(evento.status, JSON.stringify(evento.body).slice(0, 300)).toBe(201);
  return evento.body;
}

async function importarEAplicar(conteudo, { eventId = null } = {}) {
  const criado = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv', content: conteudo,
    ...(eventId ? { eventId } : {})
  });
  expect([200, 201], JSON.stringify(criado.body).slice(0, 300)).toContain(criado.status);
  const importId = criado.body.import?.id ?? criado.body.id;
  const aplicado = await api()
    .post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
  expect([200, 201], JSON.stringify(aplicado.body).slice(0, 300)).toContain(aplicado.status);
  return importId;
}

// A LEITURA PELA ROTA REAL. É ela que a tela consome, e é ela que precisa
// devolver o resultado inteiro.
const historicoImportado = athleteId => api()
  .get(`/api/v1/athletes/${athleteId}/imported-history`).set(admin.auth());

const perfil = athleteId => api().get(`/api/v1/athletes/${athleteId}`).set(admin.auth());

// Todos os resultados que a rota devolve como JÁ VINCULADOS ao atleta.
async function resultadosVinculados(athleteId) {
  const resposta = await historicoImportado(athleteId);
  expect(resposta.status, JSON.stringify(resposta.body).slice(0, 400)).toBe(200);
  return resposta.body.linked.flatMap(identidade => identidade.results);
}

// O retrato do ledger: é ele que não pode mudar de tamanho por causa de leitura
// nem de reprocessamento.
const retratoDoLedger = () => noLedger(async tx => {
  const pontos = await tx.rankingPoint.findMany({
    where: { organizationId },
    select: { id: true, athleteId: true, points: true, eventId: true, externalResultId: true },
    orderBy: { id: 'asc' }
  });
  const resultados = await tx.externalResult.findMany({
    where: { organizationId },
    select: { id: true, athleteId: true, points: true, eventName: true },
    orderBy: { id: 'asc' }
  });
  return {
    pontos: pontos.length,
    resultados: resultados.length,
    total: pontos.reduce((soma, p) => soma + p.points, 0),
    ids: pontos.map(p => p.id),
    comDono: pontos.filter(p => p.athleteId).length
  };
});

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Vínculo' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');
  await vincular(organizationId, gerente, 'EVENT_DIRECTOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC National Physique Committee', code: 'NPC' })).body;
  outraFiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'IFBB Brasil', code: 'IFBB' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  // A TABELA OFICIAL DE COLOCAÇÃO. Este arquivo não inventa regra esportiva:
  // 1º=5, 2º=4, 3º=3, 4º=2, 5º=1, e o bônus de Overall vale +10.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [
      { placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }
    ]
  });
});

// O arquivo do caso real: UMA linha, primeiro lugar, campeão do Overall, e
// NENHUMA coluna de pontos preenchida — que é o que produz o zero.
const LINHA_DO_LUCAS = (matricula = '2932', nome = 'Lucas Lima', overall = 'sim') =>
  `r-${matricula}-${nome.replace(/\s/g, '')},,${nome},${npc.code},${matricula},MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,${overall}`;

const lucas = (extra = {}) => criarAtleta(gerente, organizationId, {
  fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(293293293), sex: 'MALE',
  affiliationId: npc.id, affiliationNumber: '2932', ...extra
});

// ============================ A ORDEM NÃO IMPORTA, E ISSO É O PONTO ========
describe('o resultado chega inteiro ao atleta, importado antes ou depois', () => {
  it('1. importado ANTES do cadastro: o atleta cadastrado depois recebe tudo', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });

    // Antes do cadastro o lançamento existe e não tem dono.
    const antes = await retratoDoLedger();
    expect(antes.pontos, 'um lançamento').toBe(1);
    expect(antes.comDono, 'e ele ainda não tem dono').toBe(0);

    const athlete = await lucas();

    const resultados = await resultadosVinculados(athlete.id);
    expect(resultados.length, 'o resultado é do Lucas').toBe(1);

    const [linha] = resultados;
    // A PONTUAÇÃO OFICIAL, e não a coluna do arquivo.
    expect(linha.officialPoints, '1º = 5 mais o bônus de Overall = 15').toBe(15);
    expect(linha.points, 'e o número do arquivo continua dizível: era zero').toBe(0);
    expect(linha.hasLedgerEntry).toBe(true);
    // O CAMPEONATO, pelo identificador do lançamento.
    expect(linha.event?.id).toBe(evento.id);
    expect(linha.event?.name).toBe('Campeonato Razor');
  });

  it('2. importado DEPOIS do cadastro: mesmo resultado, mesma resposta', async () => {
    const evento = await criarEvento('Campeonato Razor');
    const athlete = await lucas();

    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });

    const resultados = await resultadosVinculados(athlete.id);
    expect(resultados.length).toBe(1);
    expect(resultados[0].officialPoints).toBe(15);
    expect(resultados[0].event?.id).toBe(evento.id);
  });
});

// ================================================= A IDENTIDADE, DE NOVO ===
describe('a identidade continua sendo filiação + número de filiação', () => {
  it('3. mesma matrícula, nomes diferentes: um atleta só, com os dois resultados', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,nao`,
      `r2,,LÚCAS GOUVÊIA LIMA,${npc.code},2932,MENS_BODYBUILDING,OPEN,2,,Campeonato Razor,nao`
    ]), { eventId: evento.id });

    const athlete = await lucas();
    const resultados = await resultadosVinculados(athlete.id);

    expect(resultados.length, 'os dois resultados, um atleta').toBe(2);
    expect(resultados.map(r => r.officialPoints).sort((a, b) => a - b), '2º=4 e 1º=5').toEqual([4, 5]);
  });

  it('4. mesmo nome, matrículas diferentes: atletas diferentes, nada se mistura', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([
      `r1,,Lucas Gouveia Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,nao`,
      `r2,,Lucas Gouveia Lima,${npc.code},7777,MENS_BODYBUILDING,OPEN,2,,Campeonato Razor,nao`
    ]), { eventId: evento.id });

    const dono = await lucas();
    const resultados = await resultadosVinculados(dono.id);

    expect(resultados.length, 'só o da matrícula 2932').toBe(1);
    expect(resultados[0].officialPoints).toBe(5);
  });

  it('5. resultado SEM matrícula não é consolidado pelo nome', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([
      `r1,,Lucas Gouveia Lima,${npc.code},,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,nao`
    ]), { eventId: evento.id });

    const athlete = await lucas();

    expect(await resultadosVinculados(athlete.id), 'nome não é identidade').toEqual([]);
    // E o lançamento continua existindo, sem dono, à espera de decisão humana.
    const ledger = await retratoDoLedger();
    expect(ledger.pontos).toBe(1);
    expect(ledger.comDono).toBe(0);
  });
});

// ======================================== REPROCESSAR NÃO PODE DUPLICAR ====
describe('reprocessar a consolidação não duplica nada', () => {
  it('6. o mesmo resultado continua sendo UM resultado', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const depoisDoCadastro = await retratoDoLedger();

    // A identidade já é dele; adotá-la de novo é a operação repetida.
    const identidade = await noLedger(tx => tx.externalAthlete.findFirst({
      where: { organizationId, affiliationNumber: '2932' }, select: { id: true }
    }));
    const repetido = await api()
      .post(`/api/v1/athletes/${athlete.id}/imported-history/${identidade.id}/link`)
      .set(admin.auth());
    expect([200, 201]).toContain(repetido.status);

    const depois = await retratoDoLedger();
    expect(depois.resultados, 'nenhum resultado novo').toBe(depoisDoCadastro.resultados);
    expect(await resultadosVinculados(athlete.id)).toHaveLength(1);
  });

  it('7. os pontos continuam os mesmos, nos mesmos lançamentos', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const antes = await retratoDoLedger();
    expect(antes.total).toBe(15);

    const identidade = await noLedger(tx => tx.externalAthlete.findFirst({
      where: { organizationId, affiliationNumber: '2932' }, select: { id: true }
    }));
    await api().post(`/api/v1/athletes/${athlete.id}/imported-history/${identidade.id}/link`)
      .set(admin.auth());

    const depois = await retratoDoLedger();
    expect(depois.pontos, 'nenhum lançamento novo').toBe(antes.pontos);
    expect(depois.total, 'nem um ponto a mais').toBe(antes.total);
    expect(depois.ids, 'são os MESMOS lançamentos').toEqual(antes.ids);
  });
});

// ============================= O QUE O RESULTADO CARREGA NÃO SE PERDE =====
describe('evento, categoria, classe e colocação sobrevivem ao vínculo', () => {
  it('8. o evento do lançamento é preservado e devolvido pela rota', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.event?.id).toBe(evento.id);

    // E o ledger continua apontando para o mesmo evento: a leitura não o moveu.
    const ponto = await noLedger(tx => tx.rankingPoint.findFirst({
      where: { organizationId }, select: { eventId: true }
    }));
    expect(ponto.eventId).toBe(evento.id);
  });

  it('9. categoria, classe e colocação continuam disponíveis', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.categoryCode).toBe('MENS_BODYBUILDING');
    expect(linha.className).toBe('OPEN');
    expect(linha.placing).toBe(1);
    expect(linha.isOverallChampion, 'o Overall acompanha a linha').toBe(true);
  });

  it('10. lote SEM evento declarado: o nome do arquivo continua respondendo', async () => {
    // Caso legítimo e preservado: `MuscleWarImport.eventId` é opcional, e
    // existe histórico cujo campeonato nunca foi cadastrado no MCI.
    await importarEAplicar(csv([LINHA_DO_LUCAS()]));
    const athlete = await lucas();

    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.event, 'não há evento do MCI a apontar').toBeNull();
    expect(linha.eventName, 'mas o nome do arquivo está lá').toBe('Campeonato Razor');
    expect(linha.officialPoints, 'e a pontuação oficial continua certa').toBe(15);
  });
});

// ================================= AS DUAS ABAS RESPONDEM COISAS DIFERENTES
describe('histórico importado e histórico esportivo não são a mesma pergunta', () => {
  it('11. resultado importado NÃO aparece como publicado — e isso é correto', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    // A aba Histórico esportivo lê `ResultEntry` de resultado PUBLICADO, que
    // nasce do julgamento interno. Importação não cria essa linha — então o
    // vazio ali é desenho, e não vínculo perdido.
    const { body } = await perfil(athlete.id);
    expect(body.results, 'nenhum resultado publicado, e está certo').toEqual([]);

    // E o mesmo resultado está presente, inteiro, na aba que é dele.
    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.officialPoints).toBe(15);
    expect(linha.hasLedgerEntry).toBe(true);
  });

  it('12. a pontuação do ranking é a mesma que o histórico importado mostra', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const { body } = await perfil(athlete.id);
    const agregado = (body.rankings || []).find(r => r.totalPoints > 0);
    expect(agregado, 'a projeção do ranking existe').toBeTruthy();
    expect(agregado.totalPoints, 'os mesmos 15').toBe(15);
    expect(agregado.eventCount, 'uma etapa').toBe(1);

    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.officialPoints, 'as duas abas dizem o mesmo número')
      .toBe(agregado.totalPoints);
  });

  it('13. o Overall continua contado uma vez, e aparece como tal', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([LINHA_DO_LUCAS()]), { eventId: evento.id });
    const athlete = await lucas();

    const { body } = await perfil(athlete.id);
    const agregado = (body.rankings || []).find(r => r.totalPoints > 0);
    expect(agregado.overallWins, 'um Overall').toBe(1);

    const [linha] = await resultadosVinculados(athlete.id);
    expect(linha.overallBonus, 'e o bônus está decomposto na linha').toBe(10);
    expect(linha.placementPoints, 'junto da parcela de colocação').toBe(5);
  });
});

// ======================================= OS DOIS CAMPEONATOS, LADO A LADO =
describe('dois campeonatos no mesmo atleta não se contaminam', () => {
  it('14. Razor e Ipiranga: dois eventos, dois resultados, soma correta', async () => {
    const razor = await criarEvento('Campeonato Razor');
    const ipiranga = await criarEvento('Etapa Ipiranga');

    await importarEAplicar(csv([
      `r-razor,,Lucas Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,sim`
    ]), { eventId: razor.id });
    await importarEAplicar(csv([
      `r-ipiranga,,Lucas Gouveia Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,2,,Etapa Ipiranga,nao`
    ]), { eventId: ipiranga.id });

    const athlete = await lucas();
    const resultados = await resultadosVinculados(athlete.id);

    expect(resultados.length, 'os dois').toBe(2);

    const porEvento = new Map(resultados.map(r => [r.event?.name, r]));
    expect(porEvento.get('Campeonato Razor').officialPoints, '1º + Overall').toBe(15);
    expect(porEvento.get('Etapa Ipiranga').officialPoints, '2º, sem Overall').toBe(4);

    const { body } = await perfil(athlete.id);
    const agregado = (body.rankings || []).find(r => r.totalPoints > 0);
    expect(agregado.totalPoints, '15 + 4').toBe(19);
    expect(agregado.eventCount, 'duas etapas').toBe(2);
  });

  it('15. a mesma matrícula em OUTRA filiação não entra na conta do Lucas', async () => {
    const evento = await criarEvento('Campeonato Razor');
    await importarEAplicar(csv([
      `r-npc,,Lucas Lima,${npc.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,nao`,
      `r-ifbb,,Outro Lucas,${outraFiliacao.code},2932,MENS_BODYBUILDING,OPEN,1,,Campeonato Razor,nao`
    ]), { eventId: evento.id });

    const athlete = await lucas();
    const resultados = await resultadosVinculados(athlete.id);

    expect(resultados.length, 'só o da NPC').toBe(1);
    expect(resultados[0].officialPoints).toBe(5);

    // O outro lançamento continua existindo, sem dono. Não foi apagado nem
    // adotado: a filiação é parte da identidade.
    const ledger = await retratoDoLedger();
    expect(ledger.pontos).toBe(2);
    expect(ledger.comDono).toBe(1);
  });
});
