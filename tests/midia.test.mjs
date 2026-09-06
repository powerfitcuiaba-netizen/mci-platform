import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, criarAtleta, gerarCpf } from './helpers.mjs';

// Upload e download de mídia: o arquivo só chega ao storage depois da
// autorização, e a chave no banco não dá acesso a quem não pode ver o dono.

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

let ana;
let bruno;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
  bruno = await criarUsuario({ name: 'Bruno' });
});

describe('mídia de publicação', () => {
  it('anexa imagem ao próprio post e devolve o arquivo a quem pode ver', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Com foto' });

    const midia = await api()
      .post(`/api/v1/social/posts/${post.body.id}/media`)
      .set(ana.auth())
      .attach('file', PNG, { filename: 'pose.png', contentType: 'image/png' });

    expect(midia.status, JSON.stringify(midia.body)).toBe(201);
    expect(midia.body.kind).toBe('IMAGE');

    const download = await api().get(`/api/v1/media/posts/${midia.body.id}`).set(bruno.auth());
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('image/png');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });

  it('recusa anexar mídia em publicação de outro autor', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Meu post' });

    const midia = await api()
      .post(`/api/v1/social/posts/${post.body.id}/media`)
      .set(bruno.auth())
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });

    expect(midia.status).toBe(403);
  });

  it('recusa tipo de arquivo fora da lista de mídia', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Com anexo' });

    const midia = await api()
      .post(`/api/v1/social/posts/${post.body.id}/media`)
      .set(ana.auth())
      .attach('file', PDF, { filename: 'regulamento.pdf', contentType: 'application/pdf' });

    expect(midia.status).toBe(415);
  });

  it('mídia de publicação privada não é baixada por terceiro', async () => {
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'Privado', visibility: 'PRIVATE' });
    const midia = await api()
      .post(`/api/v1/social/posts/${post.body.id}/media`)
      .set(ana.auth())
      .attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });

    expect((await api().get(`/api/v1/media/posts/${midia.body.id}`).set(bruno.auth())).status).toBe(404);
    expect((await api().get(`/api/v1/media/posts/${midia.body.id}`)).status).toBe(404);
    expect((await api().get(`/api/v1/media/posts/${midia.body.id}`).set(ana.auth())).status).toBe(200);
  });
});

describe('mídia de mensagem', () => {
  it('envia e devolve mídia apenas a participante da conversa', async () => {
    const carla = await criarUsuario({ name: 'Carla' });

    const conversa = await api().post('/api/v1/messenger/conversations').set(ana.auth())
      .send({ kind: 'DIRECT', participantIds: [bruno.profileId] });

    const mensagem = await api()
      .post(`/api/v1/messenger/conversations/${conversa.body.id}/media`)
      .set(ana.auth())
      .attach('file', PNG, { filename: 'treino.png', contentType: 'image/png' });

    expect(mensagem.status, JSON.stringify(mensagem.body)).toBe(201);
    expect(mensagem.body.mediaKind).toBe('IMAGE');

    expect((await api().get(`/api/v1/messenger/messages/${mensagem.body.id}/media`).set(bruno.auth())).status).toBe(200);
    // Terceiro não baixa, nem sabe que existe.
    expect((await api().get(`/api/v1/messenger/messages/${mensagem.body.id}/media`).set(carla.auth())).status).toBe(404);
  });
});

describe('documentos de atleta', () => {
  it('documento é privado: só o dono e o operador da organização baixam', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
    const org = await criarOrganizacao(admin, { name: 'Federação' });

    const operador = await criarUsuario({ name: 'Operador' });
    await vincular(org.id, operador, 'REGISTRATION_OPERATOR');

    const atleta = await criarAtleta(operador, org.id, { fullName: 'Documentada', cpf: gerarCpf(151515151) });
    await prisma.athlete.update({ where: { id: atleta.id }, data: { userId: ana.id } });

    const documento = await api()
      .post(`/api/v1/athletes/${atleta.id}/documents`)
      .set(operador.auth())
      .field('kind', 'MEDICAL')
      .field('title', 'Atestado')
      .attach('file', PDF, { filename: 'atestado.pdf', contentType: 'application/pdf' });

    expect(documento.status, JSON.stringify(documento.body)).toBe(201);

    expect((await api().get(`/api/v1/documents/athlete/${documento.body.id}/download`).set(ana.auth())).status).toBe(200);
    expect((await api().get(`/api/v1/documents/athlete/${documento.body.id}/download`).set(operador.auth())).status).toBe(200);
    expect((await api().get(`/api/v1/documents/athlete/${documento.body.id}/download`).set(bruno.auth())).status).toBe(403);
    expect((await api().get(`/api/v1/documents/athlete/${documento.body.id}/download`)).status).toBe(401);
  });

  it('a listagem de documentos não vaza a chave de armazenamento', async () => {
    const admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
    const org = await criarOrganizacao(admin, { name: 'Federação' });
    const operador = await criarUsuario({ name: 'Operador' });
    await vincular(org.id, operador, 'REGISTRATION_OPERATOR');

    const atleta = await criarAtleta(operador, org.id, { fullName: 'Sigilosa', cpf: gerarCpf(141414141) });
    await api()
      .post(`/api/v1/athletes/${atleta.id}/documents`)
      .set(operador.auth())
      .attach('file', PDF, { filename: 'doc.pdf', contentType: 'application/pdf' });

    const lista = await api().get(`/api/v1/athletes/${atleta.id}/documents`).set(operador.auth());
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(JSON.stringify(lista.body)).not.toContain('storageKey');
  });
});

describe('stories', () => {
  it('publica story, lista para quem segue e expira por consulta', async () => {
    const handleAna = (await prisma.socialProfile.findUnique({ where: { userId: ana.id } })).handle;
    await api().post(`/api/v1/social/profiles/${handleAna}/follow`).set(bruno.auth());

    const story = await api()
      .post('/api/v1/social/stories')
      .set(ana.auth())
      .field('caption', 'Shape de hoje')
      .attach('file', PNG, { filename: 'story.png', contentType: 'image/png' });

    expect(story.status, JSON.stringify(story.body)).toBe(201);

    const listaBruno = await api().get('/api/v1/social/stories').set(bruno.auth());
    expect(listaBruno.body.items).toHaveLength(1);
    expect(listaBruno.body.items[0].items[0].seen).toBe(false);

    // Quem não segue não recebe o story na lista.
    const carla = await criarUsuario({ name: 'Carla' });
    expect((await api().get('/api/v1/social/stories').set(carla.auth())).body.items).toHaveLength(0);
    expect((await api().get(`/api/v1/media/stories/${story.body.id}`).set(carla.auth())).status).toBe(403);

    // Marcar como visto muda a lista de quem já viu.
    expect((await api().post(`/api/v1/social/stories/${story.body.id}/view`).set(bruno.auth())).status).toBe(200);
    expect((await api().get('/api/v1/social/stories').set(bruno.auth())).body.items[0].items[0].seen).toBe(true);

    // Expiração é aplicada na consulta: vencido não aparece nem baixa.
    await prisma.story.update({ where: { id: story.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await api().get('/api/v1/social/stories').set(bruno.auth())).body.items).toHaveLength(0);
    expect((await api().get(`/api/v1/media/stories/${story.body.id}`).set(ana.auth())).status).toBe(404);
  });
});
