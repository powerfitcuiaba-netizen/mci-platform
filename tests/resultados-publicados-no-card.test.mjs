import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// O CARTÃO "RESULTADOS PUBLICADOS" CONTANDO AS DUAS ORIGENS.
//
// O DEFEITO, COMO FOI OBSERVADO
//
// A federação importou o campeonato do Ipiranga, aplicou o lote, e os dois
// cartões de "Resultados publicados" — o da vitrine e o do painel —
// continuaram marcando ZERO. Não era tela: os dois contavam
// `Result WHERE status = 'PUBLISHED'`, tabela que só a RECEPÇÃO de apuração
// escreve. O importador nunca a toca.
//
// O que esta suíte cobra não é "o número subiu". É a distinção que o defeito
// apagava: EXISTEM RESULTADOS é uma pergunta, RESULTADOS PUBLICADOS é outra, e
// o histórico importado responde sim às duas.
//
// A CONTAGEM ANTIGA PASSARIA EM QUASE TUDO AQUI. O que a reprova é o primeiro
// caso: etapa importada, aplicada, base de atletas vazia — exatamente a
// operação real desta plataforma.
// ============================================================================

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
const CLASSES_DO_ARQUIVO = ["Women's Bikini - Open Class A", "Men's Physique - Open Class B"];
const LINHAS = 10;

// Arquivo no formato real: nome partido em duas colunas, matrícula própria por
// competidor, colocação de 1 a 5 dentro de cada bloco.
function arquivoDaEtapa(prefixo = 'QA') {
  const linhas = [CABECALHO];
  for (let i = 0; i < LINHAS; i += 1) {
    linhas.push([
      i + 1, CLASSES_DO_ARQUIVO[i % 2], `${prefixo}${i + 1}`, 'DA SILVA',
      `${prefixo}-${100000 + i}`, 'Brazil', 25, 1, '90.0', (Math.floor(i / 2) % 5) + 1
    ].join(','));
  }
  return linhas.join('\n');
}

let admin;
let gerente;
let diretor;
let organizationId;
let seasonId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  diretor = await criarUsuario({ name: 'Diretor' });
  await vincular(organizationId, diretor, 'EVENT_DIRECTOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  // A tabela homologada: 1º=5, 2º=4, 3º=3, 4º=2, 5º=1, 6º+=0.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

/** Importa uma etapa e aplica o lote. Devolve o id do lote. */
async function importarEAplicar({ prefixo = 'QA', externalIdPrefix = 'IPIRANGA', eventId } = {}) {
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
    content: arquivoDaEtapa(prefixo), externalIdPrefix,
    ...(eventId ? { eventId } : {})
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

  const aplicado = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
    .set(gerente.auth());
  expect(aplicado.status, JSON.stringify(aplicado.body).slice(0, 400)).toBe(200);
  expect(aplicado.body.applied).toBe(LINHAS);

  return lote.body.import.id;
}

/**
 * Um campeonato disputado no MCI: inscrição, check-in, recepção do resultado
 * de fora e publicação. Devolve quantas participações foram publicadas.
 *
 * O MCI NÃO JULGA — o resultado chega de fora e é RECEBIDO. Esta função existe
 * para que a suíte exercite a outra metade da conta, e não para simular
 * julgamento.
 */
async function disputarEPublicar(nomes) {
  const montado = await criarEventoCompleto(diretor, organizationId, { seasonId });
  await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const atletas = [];
  for (const [indice, nome] of nomes.entries()) {
    const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`)
      .set(diretor.auth())
      .send({
        cpf: gerarCpf(700000000 + indice),
        athlete: { fullName: nome, sex: 'FEMALE' },
        classIds: [montado.competitionClass.id]
      });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    atletas.push(inscricao.body.registration);
  }

  await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const registro of atletas) {
    await api().post(`/api/v1/registrations/${registro.id}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, montado.event.id, ['IN_JUDGING']);

  const recebido = await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`)
    .set(diretor.auth())
    .send({ entries: atletas.map((registro, i) => ({ athleteId: registro.athlete.id, placing: i + 1 })) });
  expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

  const publicado = await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`)
    .set(diretor.auth()).send({ note: 'Homologado' });
  expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);

  return { event: montado.event, competitionClass: montado.competitionClass, publicadas: nomes.length };
}

const vitrine = () => api().get('/api/v1/public/summary').then(r => r.body);
// `analytics.read` é a permissão do painel, e RANKING_MANAGER não a tem: o
// painel é do EVENT_DIRECTOR. Medi isso com um 403 — vale registrar, porque a
// intuição diz o contrário para um cartão que fala de ranking.
const painel = ator => api()
  .get('/api/v1/dashboard/admin').query({ organizationId }).set(ator.auth())
  .then(r => r.body);

describe('o cartão conta o histórico importado', () => {
  it('etapa importada e aplicada: os dois cartões deixam de marcar zero', async () => {
    // A LINHA DE BASE. Sem ela, um número maior que zero no fim não prova que
    // foi a importação que o produziu.
    expect((await vitrine()).publishedResults, 'antes da importação').toBe(0);
    expect((await painel(diretor)).publishedResults, 'antes da importação').toBe(0);

    await importarEAplicar();

    // A vitrine é a página mais pedida da plataforma, e o cartão passou de UMA
    // contagem para DUAS. As duas são agregados — `count`, não laço —, então o
    // custo é constante no volume: não há N+1 a nascer aqui. O tempo sai medido
    // de propósito, para que a afirmação não fique só no comentário.
    const comecou = Date.now();
    const publica = await vitrine();
    const duracao = Date.now() - comecou;

    const administrativo = await painel(diretor);

    // O NÚMERO QUE O DEFEITO MANTINHA EM ZERO.
    expect(publica.publishedResults, 'vitrine pública').toBe(LINHAS);
    expect(administrativo.publishedResults, 'painel administrativo').toBe(LINHAS);

    // E a composição diz de onde ele vem, que é o que faltava na tela.
    expect(publica.publishedResultsBreakdown).toEqual({ received: 0, imported: LINHAS });
    expect(administrativo.publishedResultsBreakdown).toEqual({ received: 0, imported: LINHAS });

    // A CONFERÊNCIA DE QUE O CENÁRIO É O REAL: nenhum `Result` existe, e
    // nenhum atleta foi cadastrado. É exatamente o estado do Ipiranga.
    const estado = await comoAtor(admin, async tx => ({
      resultados: await tx.result.count(),
      atletas: await tx.athlete.count(),
      externos: await tx.externalResult.count(),
      lancamentos: await tx.rankingPoint.count()
    }));
    expect(estado.resultados, 'o importador não escreve em Result').toBe(0);
    expect(estado.atletas, 'nenhum atleta fabricado').toBe(0);
    expect(estado.externos).toBe(LINHAS);
    expect(estado.lancamentos).toBe(LINHAS);

    expect(duracao, `/public/summary respondeu em ${duracao}ms`).toBeLessThan(3000);
  });

  it('as duas origens somam, e a composição separa uma da outra', async () => {
    await importarEAplicar();
    const { publicadas } = await disputarEPublicar(['ANA QA', 'BEATRIZ QA', 'CARLA QA']);

    const publica = await vitrine();
    expect(publica.publishedResults).toBe(LINHAS + publicadas);
    expect(publica.publishedResultsBreakdown).toEqual({ received: publicadas, imported: LINHAS });

    const administrativo = await painel(diretor);
    expect(administrativo.publishedResults).toBe(LINHAS + publicadas);
    expect(administrativo.publishedResultsBreakdown).toEqual({ received: publicadas, imported: LINHAS });
  });

  it('a vitrine e o painel chegam ao mesmo número lendo tabelas diferentes', async () => {
    // O público lê a PROJEÇÃO (`PublicRankingEntry`), porque `RankingPoint` tem
    // política de operador e o visitante contaria zero nela. O operador lê o
    // LEDGER. Duas consultas para a mesma pergunta é risco de divergirem — e
    // esta é a asserção que o impede de passar em silêncio.
    await importarEAplicar();
    await disputarEPublicar(['DANIELA QA', 'ELISA QA']);

    expect((await vitrine()).publishedResults).toBe((await painel(diretor)).publishedResults);
  });
});

describe('publicado é publicado, e invalidado não é', () => {
  it('resultado recebido só entra depois de publicado', async () => {
    const montado = await criarEventoCompleto(diretor, organizationId, { seasonId });
    await transicionar(diretor, montado.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricao = await api().post(`/api/v1/events/${montado.event.id}/registrations`)
      .set(diretor.auth())
      .send({
        cpf: gerarCpf(811111111),
        athlete: { fullName: 'FERNANDA QA', sex: 'FEMALE' },
        classIds: [montado.competitionClass.id]
      });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);

    await transicionar(diretor, montado.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`)
      .set(diretor.auth()).send({});
    await transicionar(diretor, montado.event.id, ['IN_JUDGING']);

    await api().post(`/api/v1/classes/${montado.competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: [{ athleteId: inscricao.body.registration.athlete.id, placing: 1 }] });

    // RECEBIDO, ainda não publicado: rascunho não é resultado publicado.
    //
    // A ASSERÇÃO QUE PESA É A DO OPERADOR. Para a vitrine, o zero é
    // sobredeterminado: a política `resultado_publicado` de `Result` já esconde
    // o rascunho do anônimo, e `entrada_do_resultado` esconde a entrada junto.
    // Medido: um mutante que apagava o filtro de status do ramo público
    // SOBREVIVEU, e sobreviveu com razão — ali o filtro é redundante com a
    // RLS. Quem enxerga o rascunho é o operador da organização, e é o número
    // dele que prova que a conta separa recebido de publicado.
    expect((await painel(diretor)).publishedResults, 'operador vê o rascunho e não o conta').toBe(0);
    expect((await vitrine()).publishedResults, 'a RLS também esconde o rascunho').toBe(0);

    // E o rascunho EXISTE — sem isto o zero acima seria "não há resultado".
    const rascunho = await comoAtor(diretor, tx => tx.result.findFirst({
      select: { status: true, entries: { select: { id: true } } }
    }));
    expect(rascunho?.status).toBe('DRAFT');
    expect(rascunho?.entries.length, 'há participação apurada esperando publicação').toBe(1);

    // A DEMONSTRAÇÃO DA EQUIVALÊNCIA DO MUTANTE, e não a afirmação dela.
    //
    // Contada SEM filtro de status nenhum, pelo caminho anônimo, a entrada do
    // rascunho continua invisível — é a política `entrada_do_resultado`
    // exigindo que o `Result` seja visível, e `resultado_publicado` só abre o
    // rascunho ao operador da organização do evento. Pelo caminho do operador,
    // a mesma contagem acha a linha.
    //
    // É por isso que apagar `status: 'PUBLISHED'` APENAS do ramo público não é
    // observável: ali o filtro é redundante com a RLS. Apagá-lo dos dois ramos
    // é observável, e a asserção do operador acima é quem o mata.
    expect(await prisma.resultEntry.count(), 'anônimo, sem filtro de status').toBe(0);
    expect(await comoAtor(diretor, tx => tx.resultEntry.count()),
      'operador, sem filtro de status').toBe(1);

    await api().post(`/api/v1/classes/${montado.competitionClass.id}/result/publish`)
      .set(diretor.auth()).send({ note: 'Homologado' });

    expect((await vitrine()).publishedResults).toBe(1);
    expect((await painel(diretor)).publishedResults).toBe(1);
  });

  it('invalidar o lote derruba o número, e o ExternalResult continua lá', async () => {
    const importId = await importarEAplicar();
    expect((await vitrine()).publishedResults).toBe(LINHAS);

    const invalidado = await api().delete(`/api/v1/musclewar/imports/${importId}`)
      .set(gerente.auth()).send({ reason: 'Arquivo trocado pela federação' });
    expect(invalidado.status, JSON.stringify(invalidado.body)).toBe(200);
    expect(invalidado.body.operation).toBe('INVALIDATED');

    // O CARTÃO ACOMPANHA A DECISÃO ADMINISTRATIVA.
    expect((await vitrine()).publishedResults, 'depois de invalidar').toBe(0);
    expect((await painel(diretor)).publishedResults, 'depois de invalidar').toBe(0);

    // E É POR ISTO QUE A CONTA NÃO PODE SAIR DE `ExternalResult`: ele
    // permanece, porque é a chave de idempotência. Contá-lo chamaria de
    // publicado justamente o resultado que a federação acabou de tirar do ar.
    const depois = await comoAtor(admin, async tx => ({
      externos: await tx.externalResult.count(),
      vivos: await tx.rankingPoint.count({ where: { voidedAt: null } }),
      invalidados: await tx.rankingPoint.count({ where: { voidedAt: { not: null } } })
    }));
    expect(depois.externos, 'ExternalResult preservado').toBe(LINHAS);
    expect(depois.vivos).toBe(0);
    expect(depois.invalidados).toBe(LINHAS);
  });
});

describe('o discriminador de origem da projeção', () => {
  // `PublicRankingEntry` não tem coluna `source`; o público separa as origens
  // por `classId`. A afirmação é do schema — "`classId` é nulo em todo
  // resultado histórico importado" — e passou a ser LOAD-BEARING. Comentário
  // não reprova nada; este teste reprova.
  it('importado tem classId nulo, recebido tem classId preenchido', async () => {
    await importarEAplicar();
    const { competitionClass } = await disputarEPublicar(['GISELE QA', 'HELENA QA']);

    const lancamentos = await comoAtor(gerente, tx => tx.rankingPoint.findMany({
      select: { source: true, classId: true }
    }));
    expect(lancamentos.length).toBeGreaterThan(LINHAS);

    for (const lancamento of lancamentos) {
      if (lancamento.source === 'MUSCLEWAR') {
        expect(lancamento.classId, 'importado com classe de evento').toBeNull();
      } else {
        expect(lancamento.classId, 'recebido sem classe de evento').toBe(competitionClass.id);
      }
    }

    // E a projeção herda a separação, que é o que o público consulta.
    const projecao = await comoAtor(gerente, tx => tx.publicRankingEntry.findMany({
      select: { classId: true }
    }));
    expect(projecao.filter(linha => linha.classId === null).length).toBe(LINHAS);
  });
});

describe('escopo de organização', () => {
  it('o painel de uma federação não conta o histórico da outra', async () => {
    await importarEAplicar();
    // AS DUAS METADES, e não só a importada. O escopo da apuração recebida
    // chega por um caminho diferente — `result.event` —, e um teste sem
    // resultado recebido na organização dona não tem o que vazar: foi assim
    // que o mutante que apaga esse escopo sobreviveu à primeira bateria.
    const { publicadas } = await disputarEPublicar(['IARA QA', 'JULIA QA']);

    const outraOrg = (await criarOrganizacao(admin, { name: 'Federação Vizinha' })).id;
    const outroDiretor = await criarUsuario({ name: 'Diretor Vizinho' });
    await vincular(outraOrg, outroDiretor, 'EVENT_DIRECTOR');

    const vizinho = await api().get('/api/v1/dashboard/admin')
      .query({ organizationId: outraOrg }).set(outroDiretor.auth());

    expect(vizinho.status, JSON.stringify(vizinho.body)).toBe(200);
    expect(vizinho.body.publishedResults, 'acervo da outra federação').toBe(0);
    expect(vizinho.body.publishedResultsBreakdown).toEqual({ received: 0, imported: 0 });

    // CONTROLE: o número existe, e é a organização dona que o vê — as duas
    // metades, cada uma com o seu caminho de escopo.
    const dono = await painel(diretor);
    expect(dono.publishedResults).toBe(LINHAS + publicadas);
    expect(dono.publishedResultsBreakdown).toEqual({ received: publicadas, imported: LINHAS });
  });
});
