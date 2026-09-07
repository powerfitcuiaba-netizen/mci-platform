import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular,
  criarEventoCompleto, transicionar, gerarCpf
} from './helpers.mjs';

// Fluxo completo do campeonato:
// cadastro → inscrição → check-in → pesagem → RECEPÇÃO do resultado → ranking.
//
// O julgamento não aparece aqui porque não acontece aqui: ele é externo. O que
// a plataforma faz é receber a colocação já decidida, versionar, publicar e
// pontuar.

let admin;
let diretor;
let operador;
let juizA;
let juizB;
let juizC;
let organizationId;

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

    // ------------------------------------------- recepção do resultado
    await transicionar(diretor, event.id, ['IN_JUDGING']);

    const atletasEmOrdem = [];
    for (const item of itens) {
      const inscricao = await prisma.registration.findUnique({ where: { id: item.registrationId } });
      atletasEmOrdem.push(inscricao.athleteId);
    }

    const recebido = await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: atletasEmOrdem.map((athleteId, indice) => ({ athleteId, placing: indice + 1 })) });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
    expect(recebido.body.status).toBe('DRAFT');
    expect(recebido.body.hasUnresolvedTie).toBe(false);
    // A colocação recebida é a colocação registrada: nada foi recalculado.
    expect(recebido.body.entries.map(e => e.placing)).toEqual([1, 2, 3]);

    // Reenviar o MESMO resultado dá o mesmo checksum — é assinatura do dado
    // recebido, não prova de apuração.
    const reenvio = await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: atletasEmOrdem.map((athleteId, indice) => ({ athleteId, placing: indice + 1 })) });
    expect(reenvio.body.checksum).toBe(recebido.body.checksum);

    // Antes de publicar, o resultado é restrito.
    const espiada = await api().get(`/api/v1/classes/${competitionClass.id}/result`);
    expect(espiada.status).toBe(404);

    const publicacao = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
      .send({ reason: 'Resultado oficial conferido pela comissão' });
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
    for (const esperada of ['EVENT_CREATE', 'EVENT_TRANSITION', 'REGISTRATION_CREATE', 'CHECKIN', 'WEIGHIN', 'RESULT_RECEIVED', 'RESULT_PUBLICATION', 'RANKING_UPDATE']) {
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

    const itens = await prisma.registrationItem.findMany({ where: { classId: competitionClass.id }, orderBy: { createdAt: 'asc' } });
    const atletas = [];
    for (const item of itens) {
      const inscricao = await prisma.registration.findUnique({ where: { id: item.registrationId } });
      atletas.push(inscricao.athleteId);
    }

    // O resultado externo chega EMPATADO e sem colocação definida. A
    // plataforma registra o empate como empate: desempatar por ordem de
    // chegada, id ou nome seria julgar, e é justamente o que o regulamento
    // proíbe.
    const recebido = await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
      .send({ entries: atletas.map(athleteId => ({ athleteId, status: 'TIE_UNRESOLVED' })) });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
    expect(recebido.body.hasUnresolvedTie).toBe(true);
    expect(recebido.body.entries.every(e => e.status === 'TIE_UNRESOLVED')).toBe(true);
    expect(recebido.body.entries.every(e => e.placing === null)).toBe(true);

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
