import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico
} from './helpers.mjs';

// ============================================================================
// SUPERFÍCIE PÚBLICA — autenticar-se nunca pode entregar MENOS.
//
// O ranking do campeonato, o Super Overall, os recortes e o resultado
// PUBLICADO são públicos: qualquer visitante os vê sem token. A regra que
// estes testes travam é a que faltava — quem está autenticado e NÃO é membro
// da organização precisa receber exatamente o mesmo que o visitante anônimo.
//
// O que acontecia antes, medido contra a API real: `atleta_leitura` libera a
// leitura quando `mci_current_user_id() IS NULL`, ou seja, para o anônimo.
// Quem tem token e não é membro não é anônimo, então a linha do atleta some.
// Como `athlete` é relação OBRIGATÓRIA nessas consultas, o Prisma estourava:
//
//   /ranking?seasonId=X   anônimo 200 · atleta logado 500
//   /classes/:id/result   anônimo 200 · atleta logado 500
//   /events/:id/overall   anônimo 200 · atleta logado 500
//
// E, pior porque silencioso, o Super Overall devolvia 200 com o pódio inteiro
// de nomes em branco, e a home devolvia ranking VAZIO para quem tinha token.
//
// Nenhum teste pegava isso: TODOS os testes de ranking chamavam as rotas sem
// `.set(...auth())`. O buraco de cobertura tinha exatamente o tamanho do
// defeito.
// ============================================================================

let admin;
let diretora;      // dona da federação A
let forasteira;    // diretora da federação B — token válido, outra organização
let curiosa;       // atleta comum, sem organização nenhuma
let orgId;
let seasonId;
let eventId;
let classId;

const cpfSeq = (() => { let n = 820000000; return () => gerarCpf(n += 7717); })();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretora = await criarUsuario({ name: 'Diretora A' });
  forasteira = await criarUsuario({ name: 'Diretora B' });
  curiosa = await criarUsuario({ name: 'Atleta Curiosa' });

  const orgA = await criarOrganizacao(admin, { name: unico('Federação A') });
  orgId = orgA.id;
  await vincular(orgId, diretora, 'EVENT_DIRECTOR');
  await vincular(orgId, diretora, 'RANKING_MANAGER');

  const orgB = await criarOrganizacao(admin, { name: unico('Federação B') });
  await vincular(orgB.id, forasteira, 'EVENT_DIRECTOR');
  await vincular(orgB.id, forasteira, 'RANKING_MANAGER');

  const temporada = await api().post('/api/v1/seasons').set(diretora.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  expect(temporada.status, JSON.stringify(temporada.body)).toBe(201);
  seasonId = temporada.body.id;

  const montado = await criarEventoCompleto(diretora, orgId, { seasonId });
  eventId = montado.event.id;
  classId = montado.competitionClass.id;

  await transicionar(diretora, eventId, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const nomes = ['Ana Prado', 'Bruna Lima', 'Carla Souza'];
  const inscritos = [];
  for (const nome of nomes) {
    const inscricao = await api().post(`/api/v1/events/${eventId}/registrations`).set(diretora.auth())
      .send({ cpf: cpfSeq(), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [classId] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.push(inscricao.body.registration);
  }

  await transicionar(diretora, eventId, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const inscricao of inscritos) {
    await api().post(`/api/v1/registrations/${inscricao.id}/checkin`).set(diretora.auth()).send({});
  }
  await transicionar(diretora, eventId, ['IN_JUDGING']);

  const recebido = await api().post(`/api/v1/classes/${classId}/result`).set(diretora.auth())
    .send({ entries: inscritos.map((inscricao, i) => ({ athleteId: inscricao.athlete.id, placing: i + 1 })) });
  expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

  const overall = await api().post(`/api/v1/events/${eventId}/overall`).set(diretora.auth())
    .send({ athleteId: inscritos[0].athlete.id });
  expect(overall.status, JSON.stringify(overall.body)).toBe(201);

  const publicado = await api().post(`/api/v1/classes/${classId}/result/publish`).set(diretora.auth())
    .send({ note: 'Homologado' });
  expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);
});

const rotasPublicas = () => [
  ['ranking do campeonato', `/api/v1/ranking?seasonId=${seasonId}`],
  ['ranking sem temporada (a home)', '/api/v1/ranking?limit=10'],
  ['Super Overall', `/api/v1/ranking/super-overall?seasonId=${seasonId}`],
  ['recorte por classe', `/api/v1/ranking/by?seasonId=${seasonId}&classId=${classId}`],
  ['recorte por evento', `/api/v1/ranking/by?seasonId=${seasonId}&eventId=${eventId}`],
  ['ranking de equipes', `/api/v1/ranking/teams?seasonId=${seasonId}`],
  ['ranking de empresas', `/api/v1/ranking/companies?seasonId=${seasonId}`],
  ['resultado publicado da classe', `/api/v1/classes/${classId}/result`],
  ['resultados do evento', `/api/v1/events/${eventId}/results`],
  ['títulos Overall do evento', `/api/v1/events/${eventId}/overall`]
];

describe('quem se autentica recebe o MESMO que o visitante anônimo', () => {
  for (const forasteiroDe of ['diretora de OUTRA federação', 'atleta sem organização']) {
    it(`${forasteiroDe}: resposta idêntica à anônima em toda rota pública`, async () => {
      const ator = forasteiroDe.startsWith('diretora') ? () => forasteira : () => curiosa;

      for (const [nome, rota] of rotasPublicas()) {
        const anonimo = await api().get(rota);
        const logado = await api().get(rota).set(ator().auth());

        expect(logado.status, `${nome}: 5xx para quem tem token — ${JSON.stringify(logado.body).slice(0, 300)}`)
          .toBeLessThan(500);
        expect(logado.status, `${nome}: status diferente do anônimo`).toBe(anonimo.status);
        expect(logado.body, `${nome}: corpo diferente do anônimo`).toEqual(anonimo.body);
      }
    });
  }

  it('o pódio do Super Overall sai COM nome para quem está autenticado', async () => {
    const rota = `/api/v1/ranking/super-overall?seasonId=${seasonId}`;
    const anonimo = await api().get(rota);
    const logado = await api().get(rota).set(curiosa.auth());

    const nomes = corpo => (Array.isArray(corpo) ? corpo : corpo.items ?? []).map(linha => linha.athlete?.fullName ?? null);

    expect(nomes(anonimo.body).length, 'o cenário precisa ter pódio, senão o teste não prova nada').toBeGreaterThan(0);
    expect(nomes(logado.body), 'nome em branco é o sintoma silencioso do mesmo defeito').toEqual(nomes(anonimo.body));
    expect(nomes(logado.body).every(nome => typeof nome === 'string' && nome.length > 0)).toBe(true);
  });

  it('a home traz o ranking da temporada aberta mesmo para quem não tem organização', async () => {
    const anonimo = await api().get('/api/v1/ranking?limit=10');
    const logado = await api().get('/api/v1/ranking?limit=10').set(curiosa.auth());

    expect(anonimo.body.items.length, 'sem linhas o teste não prova nada').toBeGreaterThan(0);
    expect(logado.body.items.length, 'ranking vazio só para quem tem token era o defeito').toBe(anonimo.body.items.length);
    expect(logado.body.season?.id).toBe(anonimo.body.season?.id);
  });
});

describe('a correção não abriu nada — o que era privado continua privado', () => {
  it('o atleta individual continua invisível para a federação vizinha', async () => {
    const inscritos = await api().get(`/api/v1/events/${eventId}/registrations`).set(diretora.auth());
    const athleteId = inscritos.body.items[0].athlete.id;

    const dona = await api().get(`/api/v1/athletes/${athleteId}`).set(diretora.auth());
    expect(dona.status, 'a dona da federação vê o próprio atleta').toBe(200);

    for (const [quem, ator] of [['diretora de outra federação', forasteira], ['atleta comum', curiosa]]) {
      const tentativa = await api().get(`/api/v1/athletes/${athleteId}`).set(ator.auth());
      expect([403, 404], `${quem} não pode abrir a ficha do atleta — veio ${tentativa.status}`)
        .toContain(tentativa.status);
    }
  });

  it('resultado NÃO publicado continua invisível fora da organização — e visível para quem opera', async () => {
    // Segunda classe, resultado recebido e NÃO publicado.
    const outro = await criarEventoCompleto(diretora, orgId, { seasonId });
    await transicionar(diretora, outro.event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
    const inscricao = await api().post(`/api/v1/events/${outro.event.id}/registrations`).set(diretora.auth())
      .send({ cpf: cpfSeq(), athlete: { fullName: 'Dora Neves', sex: 'FEMALE' }, classIds: [outro.competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    await transicionar(diretora, outro.event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(diretora.auth()).send({});
    await transicionar(diretora, outro.event.id, ['IN_JUDGING']);
    const recebido = await api().post(`/api/v1/classes/${outro.competitionClass.id}/result`).set(diretora.auth())
      .send({ entries: [{ athleteId: inscricao.body.registration.athlete.id, placing: 1 }] });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

    const rota = `/api/v1/classes/${outro.competitionClass.id}/result`;

    // Esta é a metade que a correção quase quebrou: quem opera lê o próprio
    // rascunho, e para isso precisa continuar lendo pelo cliente da REQUISIÇÃO.
    const operadora = await api().get(rota).set(diretora.auth());
    expect(operadora.status, 'quem opera precisa ver o próprio rascunho').toBe(200);
    expect(operadora.body.status).not.toBe('PUBLISHED');

    for (const [quem, ator] of [['anônimo', null], ['outra federação', forasteira], ['atleta comum', curiosa]]) {
      const req = api().get(rota);
      const resposta = await (ator ? req.set(ator.auth()) : req);
      expect(resposta.status, `rascunho não pode vazar para ${quem} — veio ${resposta.status}`).toBe(404);
    }
  });

  it('id inexistente responde 404, e nenhum 500 publica o código do Prisma', async () => {
    const alvo = await criarUsuario({ name: 'Pessoa Solta' });

    // Organização inexistente: ia até o INSERT e voltava violação de chave
    // estrangeira — 500 com {"code":"P2003"} no corpo — enquanto o usuário
    // inexistente, na MESMA rota, já respondia 404.
    const orgFantasma = await api().post('/api/v1/organizations/cmtvzzzzzzzzzzzzzzzzzzzz/members')
      .set(admin.auth()).send({ userId: alvo.id, role: 'EVENT_DIRECTOR' });

    expect(orgFantasma.status, JSON.stringify(orgFantasma.body)).toBe(404);
    expect(orgFantasma.body.error.code).toBe('ORGANIZATION_NOT_FOUND');

    const usuarioFantasma = await api().post(`/api/v1/organizations/${orgId}/members`)
      .set(admin.auth()).send({ userId: 'cmtvyyyyyyyyyyyyyyyyyyyy', role: 'EVENT_DIRECTOR' });

    expect(usuarioFantasma.status).toBe(404);
    expect(usuarioFantasma.body.error.code).toBe('USER_NOT_FOUND');

    // A resposta de erro não entrega a taxonomia da persistência.
    for (const resposta of [orgFantasma, usuarioFantasma]) {
      expect(resposta.body.error.code, 'código do Prisma não pode sair na resposta')
        .not.toMatch(/^P\d{4}$/);
    }
  });

  it('a lista de resultados do evento esconde o rascunho de fora e mostra para quem opera', async () => {
    const publicados = await api().get(`/api/v1/events/${eventId}/results`);
    const daOperadora = await api().get(`/api/v1/events/${eventId}/results`).set(diretora.auth());

    expect(publicados.body.items ?? publicados.body).toHaveLength(1);
    expect(daOperadora.status).toBe(200);
  });
});
