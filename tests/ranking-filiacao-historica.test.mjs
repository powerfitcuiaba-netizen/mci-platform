import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O HISTÓRICO GUARDA A FILIAÇÃO DA ÉPOCA.
//
// Um atleta troca de federação. A partir do dia da troca ele compete pela
// nova — mas os pontos que ganhou antes continuam tendo sido ganhos pela
// antiga. Se o histórico ler a filiação ATUAL do cadastro, a troca reescreve
// o passado: o ranking de ontem passa a creditar uma entidade que não estava
// lá.
//
// Isso não é detalhe de exibição. A filiação é DUAS coisas — a entidade e a
// matrícula do atleta dentro dela — e é por esse par que um resultado é
// reconhecido. Um resultado histórico sem ele é um resultado sem dono.
//
// Cada teste abaixo é uma forma de a troca de filiação vazar para trás.
// ============================================================================

let admin, diretor, orgId, seasonId, federacaoA, federacaoB;

const cpfSeq = (() => { let n = 810000000; return () => gerarCpf(n += 4409); })();

async function criarFiliacao(nome, code) {
  const resposta = await api().post('/api/v1/affiliations').set(diretor.auth())
    .send({ organizationId: orgId, name: nome, code });
  expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
  return resposta.body;
}

// Uma etapa completa, com o atleta inscrito pela filiação que estiver no
// cadastro naquele momento. A filiação é aplicada ANTES do resultado ser
// publicado — que é quando os pontos nascem, e portanto quando o retrato tem
// de ser tirado.
async function etapaPontuada(nomeAtleta, cpf, { filiacao = null, matricula = null, atletaExistente = null } = {}) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  const { event, competitionClass } = montado;
  await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  // Atleta que já existe se filia ANTES de se inscrever — que é a ordem real:
  // a federação é escolhida no cadastro e a inscrição a herda.
  if (atletaExistente && filiacao) await filiar(atletaExistente, filiacao, matricula);

  const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
    .send({ cpf, athlete: { fullName: nomeAtleta, sex: 'FEMALE' }, classIds: [competitionClass.id] });
  expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
  const athleteId = inscricao.body.registration.athlete.id;

  // Atleta nascido nesta inscrição: a filiação só pode ser aplicada depois que
  // ele passa a existir, e ainda assim antes de o resultado ser publicado.
  if (filiacao && !atletaExistente) await filiar(athleteId, filiacao, matricula);

  await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretor.auth()).send({});
  await transicionar(diretor, event.id, ['IN_JUDGING']);

  const recebido = await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: [{ athleteId, placing: 1 }] });
  expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

  const publicado = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });
  expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);

  return { event, athleteId, filiacao, matricula };
}

// Coloca o atleta numa filiação — é o cadastro que manda, não a inscrição.
async function filiar(athleteId, filiacao, matricula) {
  await comoAtor(diretor, tx => tx.athlete.update({
    where: { id: athleteId },
    data: { affiliationId: filiacao.id, affiliationNumber: matricula }
  }));
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretora' });
  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  expect(temporada.status, JSON.stringify(temporada.body)).toBe(201);
  seasonId = temporada.body.id;

  federacaoA = await criarFiliacao('NPC Mato Grosso', unico('NPCMT').toUpperCase());
  federacaoB = await criarFiliacao('NPC São Paulo', unico('NPCSP').toUpperCase());
});

describe('a filiação é gravada no ponto, e não lida do cadastro atual', () => {
  it('o ponto guarda entidade E matrícula do momento em que foi ganho', async () => {
    const cpf = cpfSeq();
    const primeira = await etapaPontuada('ATLETA MIGRANTE', cpf, { filiacao: federacaoA, matricula: '88281' });

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { athleteId: primeira.athleteId } }));
    expect(pontos).toHaveLength(1);
    expect(pontos[0].affiliationId, 'a entidade fica no ponto').toBe(federacaoA.id);
    expect(pontos[0].affiliationNumber, 'a matrícula também — uma sem a outra não identifica ninguém').toBe('88281');
  });

  it('trocar de federação NÃO reescreve os pontos já ganhos', async () => {
    const cpf = cpfSeq();
    const primeira = await etapaPontuada('ATLETA MIGRANTE', cpf, { filiacao: federacaoA, matricula: '88281' });

    // A TROCA — e uma nova etapa, já pela federação nova.
    const segunda = await etapaPontuada('ATLETA MIGRANTE', cpf, {
      filiacao: federacaoB, matricula: '99999', atletaExistente: primeira.athleteId
    });
    expect(segunda.athleteId, 'é o mesmo atleta — mesmo CPF').toBe(primeira.athleteId);

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({
      where: { athleteId: primeira.athleteId }, orderBy: { awardedAt: 'asc' }
    }));
    expect(pontos).toHaveLength(2);

    const porEvento = Object.fromEntries(pontos.map(ponto => [ponto.eventId, ponto]));
    expect(porEvento[primeira.event.id].affiliationId, 'o passado continua sendo da A').toBe(federacaoA.id);
    expect(porEvento[primeira.event.id].affiliationNumber).toBe('88281');
    expect(porEvento[segunda.event.id].affiliationId, 'o presente é da B').toBe(federacaoB.id);
    expect(porEvento[segunda.event.id].affiliationNumber).toBe('99999');
  });

  it('o histórico do atleta devolve a filiação de cada ponto', async () => {
    const cpf = cpfSeq();
    const etapa = await etapaPontuada('ATLETA COM FILIAÇÃO', cpf, { filiacao: federacaoA, matricula: '147986' });

    const historico = await api().get(`/api/v1/athletes/${etapa.athleteId}/ranking-points`)
      .set(diretor.auth()).query({ seasonId });
    expect(historico.status, JSON.stringify(historico.body)).toBe(200);

    const linhas = historico.body.items ?? historico.body;
    expect(linhas).toHaveLength(1);
    expect(linhas[0].affiliation?.id).toBe(federacaoA.id);
    expect(linhas[0].affiliation?.name).toBe('NPC Mato Grosso');
    expect(linhas[0].affiliationNumber).toBe('147986');
  });

  it('trocar de federação DEPOIS de inscrito não move os pontos daquele evento', async () => {
    // A inscrição congela a entidade pela qual o atleta ENTROU no evento. Uma
    // troca no meio do caminho vale da próxima etapa em diante — não retroage
    // sobre um evento já em curso.
    const cpf = cpfSeq();
    const primeira = await etapaPontuada('ATLETA CONSTANTE', cpf, { filiacao: federacaoA, matricula: '46576' });

    const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
    const { event, competitionClass } = montado;
    await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
      .send({ cpf, athlete: { fullName: 'ATLETA CONSTANTE', sex: 'FEMALE' }, classIds: [competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);

    // A TROCA acontece com a inscrição já feita.
    await filiar(primeira.athleteId, federacaoB, '99999');

    await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretor.auth()).send({});
    await transicionar(diretor, event.id, ['IN_JUDGING']);
    await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: [{ athleteId: primeira.athleteId, placing: 1 }] });
    await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
      .send({ note: 'Homologado' });

    const ponto = await comoAtor(diretor, tx => tx.rankingPoint.findFirst({
      where: { athleteId: primeira.athleteId, eventId: event.id }
    }));
    expect(ponto.affiliationId, 'vale a entidade da inscrição').toBe(federacaoA.id);
    // A matrícula não acompanha: ela é da federação B agora, e copiá-la para
    // um ponto da A produziria um registro que não existe em lugar nenhum.
    expect(ponto.affiliationNumber).toBeNull();
  });

  it('atleta sem filiação pontua igual — a filiação é registro, não requisito', async () => {
    const cpf = cpfSeq();
    const etapa = await etapaPontuada('ATLETA SEM FILIAÇÃO', cpf);

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { athleteId: etapa.athleteId } }));
    expect(pontos).toHaveLength(1);
    expect(pontos[0].points, 'o 1º lugar vale 5 com ou sem filiação').toBe(5);
    expect(pontos[0].affiliationId).toBeNull();
    expect(pontos[0].affiliationNumber).toBeNull();
  });
});
