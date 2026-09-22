import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf
} from './helpers.mjs';

// ============================================================================
// A MENSAGEM DE ABERTURA DA FEDERAÇÃO AOS SEUS ATLETAS.
//
// Não é notificação e não é post: é um recado da organização para TODOS os
// seus atletas, que precisa ser visto antes de o atleta fazer outra coisa.
//
// O QUE ESTA SUÍTE TRANCA
//
//   * A VALIDADE É DO RECADO. Fora da janela ele não sai — sem depender de
//     alguém lembrar de apagar. Um aviso de setembro exibido em dezembro é
//     ruído.
//
//   * `showOnce` DECIDE NO SERVIDOR. O campo `deveExibir` vem pronto: a tela
//     não recalcula a regra, porque um segundo lugar decidindo quando mostrar
//     um recado oficial é um segundo lugar para ela divergir.
//
//   * NINGUÉM MARCA LEITURA PELO OUTRO. A política de INSERT exige que o
//     usuário da linha seja o da sessão. Numa federação "eu não fui avisado"
//     é disputa real, e fabricar a prova do contrário não pode ser possível.
//
//   * O RECADO É DA FEDERAÇÃO DELE. Atleta de outra organização não o vê,
//     nem por id.
// ============================================================================

let admin;
let diretor;
let atletaDaCasa;
let atletaDaVizinha;
let semCadastro;
let organizationId;
let vizinhaId;

const cpfSeq = (() => { let n = 335000000; return () => gerarCpf(n += 3359); })();

const ONTEM = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const ANTEONTEM = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
const AMANHA = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const DEPOIS_DE_AMANHA = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretor de eventos' });
  atletaDaCasa = await criarUsuario({ role: 'ATHLETE', name: 'Atleta da casa' });
  atletaDaVizinha = await criarUsuario({ role: 'ATHLETE', name: 'Atleta da vizinha' });
  semCadastro = await criarUsuario({ role: 'ATHLETE', name: 'Sem cadastro de atleta' });

  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;
  await vincular(organizationId, diretor, 'EVENT_DIRECTOR');

  const vizinha = await criarOrganizacao(admin, { name: unico('MCI Vizinha') });
  vizinhaId = vizinha.id;

  const daCasa = await api().post('/api/v1/athletes').set(admin.auth()).send({
    organizationId, fullName: 'QA ATLETA DA CASA', sex: 'FEMALE', cpf: cpfSeq(), userId: atletaDaCasa.id
  });
  expect(daCasa.status, JSON.stringify(daCasa.body).slice(0, 300)).toBe(201);

  const daVizinha = await api().post('/api/v1/athletes').set(admin.auth()).send({
    organizationId: vizinhaId, fullName: 'QA ATLETA DA VIZINHA', sex: 'MALE', cpf: cpfSeq(), userId: atletaDaVizinha.id
  });
  expect(daVizinha.status, JSON.stringify(daVizinha.body).slice(0, 300)).toBe(201);
});

const publicar = (corpo, ator = admin) => api().post('/api/v1/athlete-notices').set(ator.auth())
  .send({ organizationId, title: 'Inscrições abertas', body: 'A etapa de outubro está com inscrições abertas.', ...corpo });

const meusAvisos = ator => api().get('/api/v1/me/notices').set(ator.auth());
const marcarLido = (id, ator) => api().post(`/api/v1/me/notices/${id}/read`).set(ator.auth());
const listarAdmin = (ator = admin, params = '') =>
  api().get(`/api/v1/athlete-notices?organizationId=${organizationId}${params}`).set(ator.auth());

// ------------------------------------------------------------- publicação

describe('publicar', () => {
  it('quem tem athletes.manage publica, e o recado nasce ativo e de uma vez só', async () => {
    const resposta = await publicar({});
    expect(resposta.status, JSON.stringify(resposta.body).slice(0, 300)).toBe(201);
    expect(resposta.body.active).toBe(true);
    expect(resposta.body.showOnce).toBe(true);
    expect(resposta.body.createdBy.id).toBe(admin.id);
  });

  it('o diretor de eventos da organização também publica', async () => {
    expect((await publicar({}, diretor)).status).toBe(201);
  });

  it('o atleta não publica', async () => {
    expect((await publicar({}, atletaDaCasa)).status).toBe(403);
  });

  it('janela invertida é recusada com a razão, e não com erro genérico', async () => {
    const resposta = await publicar({ startsAt: AMANHA, endsAt: ONTEM });
    expect(resposta.status).toBe(422);
    expect(resposta.body.error?.code || resposta.body.code).toBe('NOTICE_WINDOW_INVALID');
  });

  it('título e corpo vazios não passam pela validação', async () => {
    expect((await publicar({ title: '' })).status).toBe(400);
    expect((await publicar({ body: '' })).status).toBe(400);
  });
});

// ------------------------------------------------------------ o destinatário

describe('quem recebe', () => {
  it('o atleta da federação recebe o recado dela', async () => {
    const aviso = (await publicar({})).body;

    const resposta = await meusAvisos(atletaDaCasa);
    expect(resposta.status).toBe(200);
    expect(resposta.body.items.map(item => item.id)).toEqual([aviso.id]);
    expect(resposta.body.items[0].deveExibir).toBe(true);
    expect(resposta.body.items[0].readAt).toBeNull();
    expect(resposta.body.items[0].organization.id).toBe(organizationId);
  });

  it('o atleta de OUTRA federação não recebe', async () => {
    await publicar({});
    const resposta = await meusAvisos(atletaDaVizinha);
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toEqual([]);
  });

  it('usuário sem cadastro de atleta nenhum recebe lista vazia, e não erro', async () => {
    await publicar({});
    const resposta = await meusAvisos(semCadastro);
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toEqual([]);
  });

  it('sem autenticação, 401', async () => {
    expect((await api().get('/api/v1/me/notices')).status).toBe(401);
  });
});

// ------------------------------------------------------------- a validade

describe('a validade é do recado', () => {
  it('recado que ainda não começou não sai', async () => {
    await publicar({ startsAt: AMANHA, endsAt: DEPOIS_DE_AMANHA });
    expect((await meusAvisos(atletaDaCasa)).body.items).toEqual([]);
  });

  it('recado vencido não sai — sem depender de faxina', async () => {
    await publicar({ startsAt: ANTEONTEM, endsAt: ONTEM });
    expect((await meusAvisos(atletaDaCasa)).body.items).toEqual([]);
  });

  it('recado dentro da janela sai', async () => {
    const aviso = (await publicar({ startsAt: ONTEM, endsAt: AMANHA })).body;
    expect((await meusAvisos(atletaDaCasa)).body.items.map(i => i.id)).toEqual([aviso.id]);
  });

  it('janela aberta dos dois lados vale desde já e até segunda ordem', async () => {
    const aviso = (await publicar({ startsAt: null, endsAt: null })).body;
    expect((await meusAvisos(atletaDaCasa)).body.items.map(i => i.id)).toEqual([aviso.id]);
  });

  it('desativado não sai, e continua existindo para quem administra', async () => {
    const aviso = (await publicar({})).body;
    expect((await api().patch(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth()).send({ active: false })).status).toBe(200);

    expect((await meusAvisos(atletaDaCasa)).body.items).toEqual([]);
    expect((await listarAdmin()).body.items.map(i => i.id)).toContain(aviso.id);
  });
});

// ----------------------------------------------------------- a leitura

describe('a leitura fecha o recado de uma vez só', () => {
  it('depois de lido, `deveExibir` vira falso mas o recado continua na lista', async () => {
    const aviso = (await publicar({ showOnce: true })).body;

    const leitura = await marcarLido(aviso.id, atletaDaCasa);
    expect(leitura.status).toBe(200);
    expect(leitura.body.jaEstavaLido).toBe(false);

    const depois = (await meusAvisos(atletaDaCasa)).body.items;
    expect(depois).toHaveLength(1);
    expect(depois[0].deveExibir).toBe(false);
    expect(depois[0].readAt).toBeTruthy();
  });

  it('com `showOnce: false`, ler não fecha — ele volta a aparecer', async () => {
    const aviso = (await publicar({ showOnce: false })).body;
    await marcarLido(aviso.id, atletaDaCasa);

    const depois = (await meusAvisos(atletaDaCasa)).body.items;
    expect(depois[0].deveExibir).toBe(true);
    expect(depois[0].readAt).toBeTruthy();
  });

  it('marcar duas vezes grava uma linha só, e a segunda diz que já estava lido', async () => {
    const aviso = (await publicar({})).body;

    expect((await marcarLido(aviso.id, atletaDaCasa)).body.jaEstavaLido).toBe(false);
    expect((await marcarLido(aviso.id, atletaDaCasa)).body.jaEstavaLido).toBe(true);

    const leituras = await comoAtor(admin, tx => tx.athleteNoticeRead.count({ where: { noticeId: aviso.id } }));
    expect(leituras).toBe(1);
  });

  it('duas marcações simultâneas continuam sendo uma leitura só', async () => {
    const aviso = (await publicar({})).body;

    const respostas = await Promise.all([
      marcarLido(aviso.id, atletaDaCasa),
      marcarLido(aviso.id, atletaDaCasa),
      marcarLido(aviso.id, atletaDaCasa)
    ]);
    expect(respostas.every(r => r.status === 200)).toBe(true);

    const leituras = await comoAtor(admin, tx => tx.athleteNoticeRead.count({ where: { noticeId: aviso.id } }));
    expect(leituras).toBe(1);
  });

  it('a leitura é de quem leu: o atleta de outra federação não marca o recado desta', async () => {
    const aviso = (await publicar({})).body;

    const resposta = await marcarLido(aviso.id, atletaDaVizinha);
    expect(resposta.status).toBe(404);

    const leituras = await comoAtor(admin, tx => tx.athleteNoticeRead.count({ where: { noticeId: aviso.id } }));
    expect(leituras).toBe(0);
  });

  it('a leitura de um atleta não vaza para o outro', async () => {
    const aviso = (await publicar({})).body;
    await marcarLido(aviso.id, atletaDaCasa);

    const outro = await criarUsuario({ role: 'ATHLETE', name: 'Outro atleta da casa' });
    await api().post('/api/v1/athletes').set(admin.auth()).send({
      organizationId, fullName: 'QA OUTRO DA CASA', sex: 'MALE', cpf: cpfSeq(), userId: outro.id
    });

    const dele = (await meusAvisos(outro)).body.items;
    expect(dele).toHaveLength(1);
    expect(dele[0].readAt).toBeNull();
    expect(dele[0].deveExibir).toBe(true);
  });
});

// ------------------------------------------------------------ administração

describe('administrar o recado', () => {
  it('a listagem administrativa conta quantas pessoas já leram', async () => {
    const aviso = (await publicar({})).body;
    await marcarLido(aviso.id, atletaDaCasa);

    const linha = (await listarAdmin()).body.items.find(item => item.id === aviso.id);
    expect(linha._count.reads).toBe(1);
  });

  it('o atleta não lê a lista administrativa da federação', async () => {
    await publicar({});
    expect((await listarAdmin(atletaDaCasa)).status).toBe(403);
  });

  it('apagar só passa enquanto ninguém leu; depois disso a recusa aponta a desativação', async () => {
    const aviso = (await publicar({})).body;

    await marcarLido(aviso.id, atletaDaCasa);
    const recusa = await api().delete(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth());
    expect(recusa.status).toBe(409);
    expect(recusa.body.error?.code || recusa.body.code).toBe('NOTICE_ALREADY_READ');
    expect(JSON.stringify(recusa.body)).toMatch(/[Dd]esative/);

    const outro = (await publicar({ title: 'Ainda não lido por ninguém' })).body;
    expect((await api().delete(`/api/v1/athlete-notices/${outro.id}`).set(admin.auth())).status).toBe(200);
  });

  it('a edição não troca o recado de federação', async () => {
    const aviso = (await publicar({})).body;
    const resposta = await api().patch(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth())
      .send({ organizationId: vizinhaId, title: 'Editado' });

    // `organizationId` está fora do schema de edição: o Zod o descarta e o
    // recado continua da mesma federação.
    expect(resposta.status).toBe(200);
    expect(resposta.body.organizationId).toBe(organizationId);
    expect(resposta.body.title).toBe('Editado');
  });
});

// ------------------------------------------------------------- auditoria

describe('publicar, editar e apagar deixam rastro', () => {
  it('as três ações têm nomes próprios na trilha', async () => {
    const aviso = (await publicar({})).body;
    await api().patch(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth()).send({ title: 'Corrigido' });
    await api().delete(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth());

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { entity: 'AthleteNotice', entityId: aviso.id },
      select: { action: true, userId: true, metadata: true }
    }));

    expect(trilha.map(l => l.action).sort()).toEqual([
      'ATHLETE_NOTICE_CREATE', 'ATHLETE_NOTICE_DELETE', 'ATHLETE_NOTICE_UPDATE'
    ]);
    expect(trilha.every(l => l.userId === admin.id)).toBe(true);
  });

  it('a edição registra quantas pessoas já tinham lido quando o texto mudou', async () => {
    const aviso = (await publicar({})).body;
    await marcarLido(aviso.id, atletaDaCasa);
    await api().patch(`/api/v1/athlete-notices/${aviso.id}`).set(admin.auth()).send({ body: 'Texto novo' });

    const edicao = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { entity: 'AthleteNotice', entityId: aviso.id, action: 'ATHLETE_NOTICE_UPDATE' },
      select: { metadata: true }
    }));
    expect(edicao.metadata.leiturasNoMomentoDaEdicao).toBe(1);
    expect(edicao.metadata.campos).toEqual(['body']);
  });
});

// ----------------------------------------------------- a trava é do banco

describe('o RLS recusa o que a aplicação nem oferece', () => {
  it('ninguém grava leitura em nome de outra pessoa — nem por caminho direto', async () => {
    const aviso = (await publicar({})).body;

    // O atleta da casa PODE ler o recado; o que ele não pode é dizer que
    // OUTRA pessoa leu. A política de INSERT exige `userId = sessão`.
    await expect(comoAtor(atletaDaCasa, tx => tx.athleteNoticeRead.create({
      data: { noticeId: aviso.id, userId: atletaDaVizinha.id }
    }))).rejects.toThrow();

    const leituras = await comoAtor(admin, tx => tx.athleteNoticeRead.count({ where: { noticeId: aviso.id } }));
    expect(leituras).toBe(0);
  });

  it('o recado de uma federação não é legível por atleta de outra, nem por id direto', async () => {
    const aviso = (await publicar({})).body;

    const visto = await comoAtor(atletaDaVizinha, tx => tx.athleteNotice.findUnique({ where: { id: aviso.id } }));
    expect(visto).toBeNull();
  });

  it('o atleta não escreve recado nenhum, nem para a própria federação', async () => {
    await expect(comoAtor(atletaDaCasa, tx => tx.athleteNotice.create({
      data: { organizationId, title: 'Recado forjado', body: 'Escrito por quem não pode' }
    }))).rejects.toThrow();
  });
});
