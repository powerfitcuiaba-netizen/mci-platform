import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular,
  criarEventoCompleto, transicionar, gerarCpf, unico
} from './helpers.mjs';

// Fluxo completo do campeonato:
// cadastro → inscrição → check-in → pesagem → julgamento → resultado → ranking.

let admin;
let diretor;
let operador;
let juizA;
let juizB;
let juizC;
let organizationId;

async function montarPainel(eventId, juizes) {
  const painel = await api().post(`/api/v1/events/${eventId}/panels`).set(diretor.auth()).send({ name: unico('painel') });
  expect(painel.status).toBe(201);

  for (const [indice, juiz] of juizes.entries()) {
    const resposta = await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretor.auth())
      .send({ judgeId: juiz.id, seat: indice + 1, role: indice === 0 ? 'HEAD' : 'JUDGE' });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
  }
  return painel.body;
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'Muscle Contest Brasil' });
  organizationId = org.id;

  diretor = await criarUsuario({ name: 'Diretor de Evento' });
  operador = await criarUsuario({ name: 'Operador' });
  juizA = await criarUsuario({ name: 'Juiz A' });
  juizB = await criarUsuario({ name: 'Juiz B' });
  juizC = await criarUsuario({ name: 'Juiz C' });

  await vincular(organizationId, diretor, 'EVENT_DIRECTOR');
  await vincular(organizationId, operador, 'REGISTRATION_OPERATOR');
  for (const juiz of [juizA, juizB, juizC]) await vincular(organizationId, juiz, 'JUDGE');
});

describe('fluxo completo do campeonato', () => {
  it('vai do cadastro ao ranking com dados reais em cada etapa', async () => {
    // ---------------------------------------------------------- temporada
    const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
      .send({ organizationId, name: 'Temporada 2026', year: 2026 });
    expect(temporada.status).toBe(201);

    const regras = await api().put(`/api/v1/seasons/${temporada.body.id}/points-rules`).set(diretor.auth())
      .send({ rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }] });
    expect(regras.status).toBe(200);

    // ------------------------------------------------------------- evento
    const { event, competitionClass } = await criarEventoCompleto(diretor, organizationId, { seasonId: temporada.body.id });
    expect(event.status).toBe('DRAFT');

    await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    // ---------------------------------------------------------- inscrições
    const cpfs = [gerarCpf(111111111), gerarCpf(222222222), gerarCpf(333333333)];
    const inscricoes = [];

    for (const [indice, cpf] of cpfs.entries()) {
      const resposta = await api().post(`/api/v1/events/${event.id}/registrations`).set(operador.auth()).send({
        cpf,
        athlete: { fullName: `Atleta ${indice + 1}`, sex: 'FEMALE', birthDate: '1997-03-04', state: 'MT', city: 'Cuiabá' },
        classIds: [competitionClass.id]
      });
      expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
      // Primeiro contato pelo CPF: o perfil é criado, não reconhecido.
      expect(resposta.body.athleteRecognized).toBe(false);
      inscricoes.push(resposta.body.registration);
    }

    // O mesmo CPF numa segunda inscrição reconhece o atleta em vez de duplicar.
    const segundoEvento = await criarEventoCompleto(diretor, organizationId, { categoryCode: 'WELLNESS' });
    await transicionar(diretor, segundoEvento.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const reconhecimento = await api().post(`/api/v1/events/${segundoEvento.event.id}/registrations`).set(operador.auth())
      .send({ cpf: cpfs[0], classIds: [segundoEvento.competitionClass.id] });
    expect(reconhecimento.status, JSON.stringify(reconhecimento.body)).toBe(201);
    expect(reconhecimento.body.athleteRecognized).toBe(true);
    expect(await prisma.athlete.count({ where: { organizationId } })).toBe(3);

    // ------------------------------------------------- check-in e pesagem
    await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);

    for (const inscricao of inscricoes) {
      const checkin = await api().post(`/api/v1/registrations/${inscricao.id}/checkin`).set(diretor.auth()).send({ device: 'tablet-01' });
      expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);

      const pesagem = await api().post(`/api/v1/registrations/${inscricao.id}/weighins`).set(diretor.auth())
        .send({ weightGrams: 58000, heightCm: 165 });
      expect(pesagem.status).toBe(201);
      expect(pesagem.body.weighIn.operatorId).toBe(diretor.id);
    }

    const painelCheckin = await api().get(`/api/v1/events/${event.id}/checkins`).set(diretor.auth());
    expect(painelCheckin.body.summary).toEqual({ total: 3, checkedIn: 3, pending: 0 });

    // ----------------------------------------------------- credenciamento
    const credencial = await api().post(`/api/v1/events/${event.id}/credentials`).set(diretor.auth())
      .send({ type: 'ATHLETE', holderName: 'Atleta 1', registrationId: inscricoes[0].id });
    expect(credencial.status).toBe(201);

    const leitura = await api().post(`/api/v1/events/${event.id}/credentials/scan`).set(diretor.auth())
      .send({ code: credencial.body.code, gate: 'Backstage' });
    expect(leitura.body.accepted).toBe(true);
    expect(leitura.body.credential.checkedIn).toBe(true);

    // ------------------------------------------------------ ordem de palco
    const bateria = await api().post(`/api/v1/events/${event.id}/batches`).set(diretor.auth())
      .send({ classId: competitionClass.id, name: 'Bateria 1' });
    expect(bateria.status).toBe(201);

    const itens = await prisma.registrationItem.findMany({ where: { classId: competitionClass.id }, orderBy: { createdAt: 'asc' } });

    const ordem = await api().put(`/api/v1/batches/${bateria.body.id}/order`).set(diretor.auth())
      .send({ items: itens.map((item, indice) => ({ registrationItemId: item.id, position: indice + 1 })) });
    expect(ordem.status).toBe(200);
    expect(ordem.body.orders).toHaveLength(3);

    // ----------------------------------------------------------- julgamento
    await transicionar(diretor, event.id, ['IN_JUDGING']);
    const painel = await montarPainel(event.id, [juizA, juizB, juizC]);

    const sessao = await api().post('/api/v1/judging-sessions').set(diretor.auth())
      .send({ classId: competitionClass.id, panelId: painel.id, round: 'FINALS' });
    expect(sessao.status, JSON.stringify(sessao.body)).toBe(201);

    const ficha = await api().get(`/api/v1/judging-sessions/${sessao.body.id}/sheet`).set(juizA.auth());
    expect(ficha.body.competitors).toHaveLength(3);

    // Três juízes concordam na ordem 1, 2, 3 — sem empate.
    for (const juiz of [juizA, juizB, juizC]) {
      const envio = await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juiz.auth()).send({
        placings: itens.map((item, indice) => ({ registrationItemId: item.id, placing: indice + 1 }))
      });
      expect(envio.status, JSON.stringify(envio.body)).toBe(200);
    }

    const fechamento = await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretor.auth());
    expect(fechamento.status, JSON.stringify(fechamento.body)).toBe(200);

    // ------------------------------------------------------------ resultado
    const apuracao = await api().post(`/api/v1/classes/${competitionClass.id}/result/calculate`).set(diretor.auth());
    expect(apuracao.status, JSON.stringify(apuracao.body)).toBe(200);
    expect(apuracao.body.status).toBe('DRAFT');
    expect(apuracao.body.hasUnresolvedTie).toBe(false);
    expect(apuracao.body.entries.map(e => e.placing)).toEqual([1, 2, 3]);
    expect(apuracao.body.entries[0].score).toBe(3);

    // Recalcular com a mesma entrada produz o mesmo checksum.
    const recalculo = await api().post(`/api/v1/classes/${competitionClass.id}/result/calculate`).set(diretor.auth());
    expect(recalculo.body.checksum).toBe(apuracao.body.checksum);

    // Antes de publicar, o resultado é restrito.
    const espiada = await api().get(`/api/v1/classes/${competitionClass.id}/result`);
    expect(espiada.status).toBe(404);

    const publicacao = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
      .send({ reason: 'Apuração conferida pela comissão' });
    expect(publicacao.status, JSON.stringify(publicacao.body)).toBe(200);
    expect(publicacao.body.result.status).toBe('PUBLISHED');
    expect(publicacao.body.ranking.awarded).toBe(3);

    // Publicado, é público.
    const publico = await api().get(`/api/v1/classes/${competitionClass.id}/result`);
    expect(publico.status).toBe(200);
    expect(publico.body.entries[0].athlete.fullName).toBe('Atleta 1');
    // Vitrine pública nunca traz CPF.
    expect(JSON.stringify(publico.body)).not.toContain(cpfs[0]);

    // -------------------------------------------------------------- ranking
    const ranking = await api().get('/api/v1/ranking').query({ seasonId: temporada.body.id });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items).toHaveLength(3);
    expect(ranking.body.items[0].totalPoints).toBe(100);
    expect(ranking.body.items[0].position).toBe(1);

    // Cada ponto aponta para a sua origem.
    const primeiroAtleta = ranking.body.items[0].athlete.id;
    const pontos = await api().get(`/api/v1/athletes/${primeiroAtleta}/ranking-points`).set(diretor.auth());
    expect(pontos.body.items[0].source).toBe('EVENT');
    expect(pontos.body.items[0].event.id).toBe(event.id);
    expect(pontos.body.items[0].points).toBe(100);

    // ------------------------------------------------------------ auditoria
    const trilha = await api().get('/api/v1/audit').set(admin.auth()).query({ limit: 200 });
    const acoes = new Set(trilha.body.items.map(item => item.action));
    for (const esperada of ['EVENT_CREATE', 'EVENT_TRANSITION', 'REGISTRATION_CREATE', 'CHECKIN', 'WEIGHIN', 'JUDGING_SCORE', 'JUDGING_CLOSE', 'RESULT_CALCULATION', 'RESULT_PUBLICATION', 'RANKING_UPDATE']) {
      expect(acoes.has(esperada), `auditoria sem ${esperada}`).toBe(true);
    }
  });

  it('empate não resolvido bloqueia a publicação e é destravado por correção versionada', async () => {
    const { event, competitionClass } = await criarEventoCompleto(diretor, organizationId);
    await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

    const inscricoes = [];
    for (const semente of [444444444, 555555555]) {
      const resposta = await api().post(`/api/v1/events/${event.id}/registrations`).set(operador.auth()).send({
        cpf: gerarCpf(semente),
        athlete: { fullName: `Empatada ${semente}`, sex: 'FEMALE', birthDate: '1995-01-01' },
        classIds: [competitionClass.id]
      });
      inscricoes.push(resposta.body.registration);
    }

    await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    for (const inscricao of inscricoes) {
      await api().post(`/api/v1/registrations/${inscricao.id}/checkin`).set(diretor.auth()).send({});
    }
    await transicionar(diretor, event.id, ['IN_JUDGING']);

    // Painel sem juiz-chefe e evento sem regra de desempate: o empate persiste.
    const painel = await api().post(`/api/v1/events/${event.id}/panels`).set(diretor.auth()).send({ name: 'Painel' });
    for (const [indice, juiz] of [juizA, juizB].entries()) {
      await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretor.auth()).send({ judgeId: juiz.id, seat: indice + 1 });
    }

    const sessao = await api().post('/api/v1/judging-sessions').set(diretor.auth())
      .send({ classId: competitionClass.id, panelId: painel.body.id, round: 'FINALS' });

    const itens = await prisma.registrationItem.findMany({ where: { classId: competitionClass.id }, orderBy: { createdAt: 'asc' } });

    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juizA.auth())
      .send({ placings: [{ registrationItemId: itens[0].id, placing: 1 }, { registrationItemId: itens[1].id, placing: 2 }] });
    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juizB.auth())
      .send({ placings: [{ registrationItemId: itens[0].id, placing: 2 }, { registrationItemId: itens[1].id, placing: 1 }] });

    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretor.auth());

    const apuracao = await api().post(`/api/v1/classes/${competitionClass.id}/result/calculate`).set(diretor.auth());
    expect(apuracao.body.hasUnresolvedTie).toBe(true);
    expect(apuracao.body.entries.every(e => e.status === 'TIE_UNRESOLVED')).toBe(true);
    expect(apuracao.body.entries.every(e => e.placing === null)).toBe(true);

    const publicacaoRecusada = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth()).send({});
    expect(publicacaoRecusada.status).toBe(422);
    expect(publicacaoRecusada.body.error.code).toBe('TIE_UNRESOLVED');

    // A comissão decide e a decisão fica versionada com motivo e autor.
    const correcao = await api().post(`/api/v1/classes/${competitionClass.id}/result/override`).set(admin.auth()).send({
      reason: 'Desempate decidido em reunião da comissão técnica',
      entries: [
        { registrationItemId: itens[0].id, placing: 1, status: 'RANKED' },
        { registrationItemId: itens[1].id, placing: 2, status: 'RANKED' }
      ]
    });
    expect(correcao.status, JSON.stringify(correcao.body)).toBe(200);
    expect(correcao.body.hasUnresolvedTie).toBe(false);
    expect(correcao.body.version).toBe(2);

    const versoes = await api().get(`/api/v1/classes/${competitionClass.id}/result/versions`).set(diretor.auth());
    expect(versoes.body.items).toHaveLength(2);
    expect(versoes.body.items[0].reason).toContain('comissão técnica');
    // A versão anterior continua íntegra.
    expect(versoes.body.items[1].snapshot.entries.every(e => e.status === 'TIE_UNRESOLVED')).toBe(true);

    const publicacao = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth()).send({});
    expect(publicacao.status).toBe(200);
  });
});
