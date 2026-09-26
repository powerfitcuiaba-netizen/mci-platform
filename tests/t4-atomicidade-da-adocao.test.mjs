import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// S5 — A ATOMICIDADE DE `adotarLedger`.
//
// O QUE A AUDITORIA ANTERIOR REGISTROU, E O QUE A MEDIÇÃO ENCONTROU
//
// O registro dizia "três escritas fora de uma única transação". Contando o
// código, são QUATRO escritas e mais N recálculos:
//
//   1. `externalAthlete.updateMany`  — compare-and-set que reivindica a identidade
//   2. `externalResult.updateMany`   — dá dono ao resultado externo
//   3. `rankingPoint.updateMany`     — dá dono ao LANÇAMENTO (o ledger)
//   4. `audit.record`                — a rastreabilidade
//   5. `ranking.recompute_` por temporada tocada
//
// Nenhuma delas abre transação. Lidas isoladamente, é uma operação de negócio
// partida em cinco pedaços.
//
// O QUE MUDA A CONCLUSÃO: `src/utils/asyncHandler.js`
//
// TODO handler autenticado roda dentro de UMA transação interativa aberta por
// `withUserContext`, e o Proxy de `src/config/prisma.js` redireciona todo
// `$transaction` e toda operação para ela. Ou seja: no caminho real da
// aplicação as cinco etapas JÁ estão na mesma transação — a da requisição.
//
// Isso não é argumento, é hipótese. Esta suíte a submete a teste: injeta falha
// DEPOIS de cada etapa e vai ao banco conferir o que ficou persistido. Se a
// hipótese estiver certa, nada fica; se estiver errada, o estado parcial
// aparece e o S5 se confirma.
//
// POR QUE NÃO ENVOLVER TUDO NUMA TRANSAÇÃO "NOVA"
//
// Porque já está. Acrescentar `prisma.$transaction` ao redor seria no-op — o
// proxy a devolveria para a transação em curso — e criaria a impressão de uma
// garantia nova onde só há a antiga. O teste que prova a garantia vale mais que
// o `$transaction` decorativo, e é o que este arquivo entrega.
//
// COMO A FALHA É INJETADA, E POR QUE NÃO COM MOCK
//
// A primeira versão desta suíte usava `vi.spyOn(rankingService, 'recompute_')`.
// MEDIDO com uma sonda: o spy nunca era chamado — `recompute_ chamado: 0` — e a
// adoção respondia 200 e gravava normalmente. O objeto que o teste importa por
// `import ... from` de um módulo CJS NÃO é o mesmo que o serviço carregou por
// `require`, então o spy mutava uma cópia. O teste passaria a dar falso negativo
// sem ninguém notar.
//
// A injeção passa a ser REAL, pelo banco, e ataca a última etapa —
// `ranking.recompute_`, que roda depois da escrita no ledger:
//
//   um GATILHO de QA em `PublicRankingEntry` faz o INSERT da projeção falhar.
//   `republicarProjecao` é a última coisa que `recomputarEm` faz, e
//   `recompute_` é a última etapa de `adotarLedger` — então a falha acontece
//   DEPOIS de a identidade ter sido reivindicada, o resultado externo ter
//   recebido dono e o LANÇAMENTO ter sido escrito. É um erro de banco de
//   verdade, no ponto exato que interessa.
//
//   O gatilho é criado e removido por este arquivo, em banco de QA descartável,
//   e tem prefixo `qa_` para não se confundir com objeto de produção.
//
//   DOIS CAMINHOS FORAM TENTADOS ANTES E DESCARTADOS, e ficam registrados para
//   ninguém repetir:
//
//   1. `vi.spyOn` no serviço de ranking. Sonda mediu `recompute_ chamado: 0`
//      com a adoção respondendo 200 — o objeto que o teste importa por
//      `import ... from` de um módulo CJS não é o que o serviço carregou por
//      `require`. O spy mutava uma cópia, e o teste dava falso negativo.
//
//   2. Plantar uma linha de projeção com o id do lançamento em outra temporada,
//      para colidir na chave primária. `PublicRankingEntry.id` é chave primária
//      GLOBAL: o id não pode existir duas vezes, e o INSERT da fixture falhava
//      antes de a armadilha existir.
//
//   3. Prender a chave canônica da temporada e deixar a requisição estourar o
//      prazo. Funciona em teoria e envenena a suíte na prática: a própria
//      fixture aplica um lote, que depois do T4 também pede essa chave, então
//      os testes seguintes travavam atrás do cadeado.
//
// Essa etapa é a que importa: se o ledger volta atrás quando o recálculo falha,
// ele volta atrás em qualquer falha posterior à sua própria escrita.
// ==========================================================================

let plataforma, operador, org, filiacao, season, evento;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  plataforma = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin S5' });
  org = (await criarOrganizacao(plataforma, { name: 'Federacao S5' })).id;

  operador = await criarUsuario({ name: 'Operador S5' });
  for (const papel of ['EVENT_DIRECTOR', 'RANKING_MANAGER', 'REGISTRATION_OPERATOR']) {
    await vincular(org, operador, papel);
  }

  filiacao = (await api().post('/api/v1/affiliations').set(plataforma.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(plataforma.auth())
    .send({ organizationId: org, name: 'Temporada S5', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(plataforma.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  evento = (await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: 'Etapa S5', slug: unico('ev-s5'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;
});

const CABECALHO = 'Athlete #,Class,Category,First Name,Last Name,Member Number,Placing';
const CLASSE = "Men's Bodybuilding - Open Middleweight";
const MATRICULA = '55501';

// Cenário de produção reproduzido: o histórico entra ANTES de o atleta existir,
// e por isso o lançamento nasce sem dono. Depois o atleta se cadastra e alguém
// adota a identidade externa — que é o caminho do `adotarLedger`.
async function historicoSemDono() {
  const lote = (await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
    sourceRef: unico('s5') + '.csv',
    content: [CABECALHO, `1,${CLASSE},MENS_BODYBUILDING,Atleta,Historico,${MATRICULA},1`].join('\n'),
    externalIdPrefix: unico('S5').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  })).body.import;

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.id}/apply`)
    .set(operador.auth()).send({});
  expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
  expect(aplicacao.body.applied).toBe(1);

  const atleta = await comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: 'ATLETA HISTORICO', sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: MATRICULA,
      identity: { create: { organizationId: org, cpf: gerarCpf(55_501) } }
    }
  }));

  const identidade = await comoAtor(plataforma, tx => tx.externalAthlete.findFirst({
    select: { id: true, athleteId: true }
  }));

  return { atleta, identidade };
}

const adotar = (athleteId, externalAthleteId, ator = operador) =>
  api().post(`/api/v1/athletes/${athleteId}/imported-history/${externalAthleteId}/link`)
    .set(ator.auth()).send({});

// Estado efetivamente PERSISTIDO, lido depois da falha. É o que o prompt pede:
// não basta a resposta HTTP, tem de se ir ao banco.
const estadoPersistido = async externalAthleteId => comoAtor(plataforma, async tx => ({
  identidade: (await tx.externalAthlete.findUnique({
    where: { id: externalAthleteId }, select: { athleteId: true, linkedAt: true }
  })),
  resultadosComDono: await tx.externalResult.count({ where: { externalAthleteId, athleteId: { not: null } } }),
  lancamentosComDono: await tx.rankingPoint.count({ where: { externalAthleteId, athleteId: { not: null } } }),
  lancamentosSemDono: await tx.rankingPoint.count({ where: { externalAthleteId, athleteId: null } }),
  auditoriaDoVinculo: await tx.auditLog.count({ where: { action: 'RESULTADO_EXTERNAL_LINKED' } })
}));

// ==========================================================================
// O CAMINHO FELIZ, PRIMEIRO — sem ele, todo "nada foi escrito" abaixo poderia
// ser "nada acontece nunca".
// ==========================================================================
describe('a adoção da identidade externa, sem falha', () => {
  it('dá dono à identidade, ao resultado externo e ao lançamento, e audita', async () => {
    const { atleta, identidade } = await historicoSemDono();
    expect(identidade.athleteId, 'a fixture já nasceu vinculada').toBeNull();

    const r = await adotar(atleta.id, identidade.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await estadoPersistido(identidade.id);
    expect(depois.identidade.athleteId).toBe(atleta.id);
    expect(depois.identidade.linkedAt).not.toBeNull();
    expect(depois.resultadosComDono).toBe(1);
    expect(depois.lancamentosComDono).toBe(1);
    expect(depois.lancamentosSemDono).toBe(0);
    // DUAS linhas, e é por desenho: `adotarLedger` audita o movimento do
    // ledger e `adotarIdentidadeExterna` audita o ato de reconhecer a
    // identidade — o comentário do serviço diz que o vínculo é auditado mesmo
    // quando não move ponto. Medido: 2.
    expect(depois.auditoriaDoVinculo, 'a adoção não foi auditada').toBe(2);
  }, 120_000);

  it('repetir a adoção não duplica lançamento nem pontuação', async () => {
    const { atleta, identidade } = await historicoSemDono();

    expect((await adotar(atleta.id, identidade.id)).status).toBe(200);
    const primeira = await estadoPersistido(identidade.id);

    // A segunda chamada encontra a identidade já reivindicada. O
    // compare-and-set não casa, e nada é escrito de novo.
    await adotar(atleta.id, identidade.id);
    const segunda = await estadoPersistido(identidade.id);

    expect(segunda.lancamentosComDono).toBe(primeira.lancamentosComDono);
    expect(segunda.auditoriaDoVinculo, 'auditou duas vezes a mesma adoção')
      .toBe(primeira.auditoriaDoVinculo);

    const pontos = await comoAtor(plataforma, tx => tx.rankingPoint.findMany({
      where: { externalAthleteId: identidade.id }, select: { points: true }
    }));
    expect(pontos, 'a adoção repetida duplicou o lançamento').toHaveLength(1);
    expect(pontos[0].points, 'a adoção mexeu na pontuação').toBe(5);
  }, 120_000);
});

// ==========================================================================
// FALHA INJETADA DEPOIS DA ESCRITA NO LEDGER
// ==========================================================================
// O GATILHO DE QA. Criado, usado e removido — sempre removido, inclusive se o
// teste falhar no meio, senão ele derrubaria todo recálculo dos testes
// seguintes.
const GATILHO = 'qa_t4_falhar_projecao';

async function comProjecaoFalhando(executar) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION ${GATILHO}() RETURNS trigger AS $BODY$
    BEGIN
      RAISE EXCEPTION 'FALHA QA INJETADA NA PROJECAO PUBLICA';
    END
    $BODY$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER ${GATILHO} BEFORE INSERT ON "PublicRankingEntry"
    FOR EACH ROW EXECUTE FUNCTION ${GATILHO}()`);

  try {
    return await executar();
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${GATILHO} ON "PublicRankingEntry"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${GATILHO}()`);
  }
}

describe('falha depois da escrita no ledger — o que fica persistido', () => {
  it('o gatilho de fato derruba o recálculo — controle do mecanismo', async () => {
    // Sem este controle, todo "nada foi escrito" abaixo poderia ser "a falha
    // nunca aconteceu".
    await historicoSemDono();

    const r = await comProjecaoFalhando(() =>
      api().post(`/api/v1/seasons/${season}/recompute`).set(operador.auth()).send({}));
    expect(r.status, 'o gatilho não derrubou o recálculo').not.toBe(200);

    // E depois de removido, o recálculo volta a funcionar: a falha era a
    // injetada, e não um estado quebrado que ficou.
    const depois = await api().post(`/api/v1/seasons/${season}/recompute`)
      .set(operador.auth()).send({});
    expect(depois.status, JSON.stringify(depois.body)).toBe(200);
  }, 120_000);

  it('falha no RECÁLCULO desfaz a troca de dono por inteiro', async () => {
    const { atleta, identidade } = await historicoSemDono();
    const antes = await estadoPersistido(identidade.id);
    expect(antes.lancamentosSemDono, 'a fixture não tem lançamento sem dono').toBe(1);

    const r = await comProjecaoFalhando(() => adotar(atleta.id, identidade.id));
    expect(r.status, 'a falha injetada não chegou à resposta').not.toBe(200);

    // AQUI ESTÁ O S5: a identidade foi reivindicada, o resultado externo e o
    // LANÇAMENTO receberam dono, e só depois o recálculo falhou. Se qualquer
    // uma dessas escritas tiver sobrevivido, a operação não é atômica.
    const depois = await estadoPersistido(identidade.id);
    expect(depois.identidade.athleteId, 'identidade ficou reivindicada sem o resto').toBeNull();
    expect(depois.resultadosComDono, 'resultado externo ficou com dono').toBe(0);
    expect(depois.lancamentosComDono, 'LEDGER ficou escrito depois da falha').toBe(0);
    expect(depois.lancamentosSemDono).toBe(antes.lancamentosSemDono);
    expect(depois.auditoriaDoVinculo, 'auditou uma adoção que não aconteceu').toBe(0);
  }, 120_000);

  it('depois do rollback, repetir conclui — a operação não fica presa', async () => {
    const { atleta, identidade } = await historicoSemDono();

    expect((await comProjecaoFalhando(() => adotar(atleta.id, identidade.id))).status).not.toBe(200);

    // O compare-and-set voltou atrás junto com o resto, então a identidade está
    // `athleteId: null` de novo e a retentativa funciona. Se a etapa 1 tivesse
    // ficado persistida, esta repetição não adotaria nada — e seria a prova do S5.
    const r = await adotar(atleta.id, identidade.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const depois = await estadoPersistido(identidade.id);
    expect(depois.identidade.athleteId).toBe(atleta.id);
    expect(depois.lancamentosComDono).toBe(1);
    expect(depois.auditoriaDoVinculo, 'a retentativa não deixou rastro').toBeGreaterThan(0);
  }, 120_000);

  it('a projeção pública fica coerente com o ledger depois da adoção', async () => {
    const { atleta, identidade } = await historicoSemDono();
    expect((await adotar(atleta.id, identidade.id)).status).toBe(200);

    const doLedger = await comoAtor(plataforma, tx => tx.rankingPoint.findMany({
      where: { externalAthleteId: identidade.id }, select: { id: true, points: true, athleteId: true }
    }));
    const daProjecao = await prisma.publicRankingEntry.findMany({
      where: { seasonId: season }, select: { id: true, points: true, athleteId: true }
    });

    expect(daProjecao.map(l => l.id).sort(), 'projeção e ledger divergiram')
      .toEqual(doLedger.map(l => l.id).sort());
    // O TOTAL NÃO MUDA: é o mesmo lançamento trocando de competidor externo
    // para competidor com cadastro.
    expect(daProjecao.reduce((soma, l) => soma + l.points, 0))
      .toBe(doLedger.reduce((soma, l) => soma + l.points, 0));
    expect(daProjecao.every(l => l.athleteId === atleta.id),
      'a projeção não reconheceu o novo dono').toBe(true);
  }, 120_000);
});

// ==========================================================================
// DUAS ADOÇÕES SIMULTÂNEAS DA MESMA IDENTIDADE
// ==========================================================================
describe('duas adoções simultâneas do mesmo registro', () => {
  it('apenas uma vence, e o lançamento não é contado duas vezes', async () => {
    const { atleta, identidade } = await historicoSemDono();

    const segundo = await comoAtor(operador, tx => tx.athlete.create({
      data: {
        organizationId: org, fullName: 'OUTRO ATLETA', sex: 'MALE',
        affiliationId: filiacao.id, affiliationNumber: '55502',
        identity: { create: { organizationId: org, cpf: gerarCpf(55_502) } }
      }
    }));

    const respostas = await Promise.all([
      adotar(atleta.id, identidade.id),
      adotar(segundo.id, identidade.id)
    ]);

    // Não se exige qual vence: exige-se que o resultado seja UM dono e um
    // lançamento só. Fixar o vencedor seria fixar o escalonador.
    const finais = await estadoPersistido(identidade.id);
    expect([atleta.id, segundo.id]).toContain(finais.identidade.athleteId);
    expect(finais.lancamentosComDono, 'o lançamento foi contado duas vezes').toBe(1);
    expect(finais.lancamentosSemDono).toBe(0);

    const pontos = await comoAtor(plataforma, tx => tx.rankingPoint.findMany({
      where: { externalAthleteId: identidade.id }, select: { athleteId: true, points: true }
    }));
    expect(pontos, 'a corrida duplicou o lançamento').toHaveLength(1);
    expect(pontos[0].athleteId).toBe(finais.identidade.athleteId);

    // Nenhuma das duas pode ter respondido 5xx: a perdedora encontra a
    // identidade já reivindicada, que é recusa de negócio e não erro.
    expect(respostas.filter(r => r.status >= 500).map(r => r.status),
      'a corrida produziu 5xx').toEqual([]);
  }, 120_000);
});
