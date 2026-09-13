import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';

// ==========================================================================
// Normalização de imagem na entrada.
//
// Tudo aqui é medido com imagem de verdade, gerada na hora: o que entra é
// decodificado e conferido, não presumido pelo nome do arquivo.
// ==========================================================================

const jpegGrande = () => sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#8b1e2d' } })
  .jpeg({ quality: 90 }).toBuffer();

// EXIF dizendo "gire 90°": os pixels estão deitados, a etiqueta manda pôr em
// pé. Quem ignora a etiqueta mostra a foto virada.
const jpegDeitadoComEtiqueta = () => sharp({ create: { width: 1200, height: 600, channels: 3, background: '#1e6b8b' } })
  .withMetadata({ orientation: 6 })
  .jpeg().toBuffer();

const jpegComGps = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#2d8b1e' } })
  .withMetadata({ exif: { IFD0: { Copyright: 'MCI' }, GPS: { GPSLatitudeRef: 'S' } } })
  .jpeg().toBuffer();

let ana;

beforeAll(() => garantirCatalogo());
beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
});

const enviarAvatar = (conteudo, nome = 'foto.jpg') => api()
  .post('/api/v1/social/me/avatar').set(ana.auth())
  .attach('file', conteudo, { filename: nome, contentType: 'image/jpeg' });

const anexarNoPost = async (conteudo, nome = 'foto.jpg') => {
  const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'treino' });
  return api().post(`/api/v1/social/posts/${post.body.id}/media`).set(ana.auth())
    .attach('file', conteudo, { filename: nome, contentType: 'image/jpeg' });
};

const baixarAvatar = async perfilId => {
  const resposta = await api().get(`/api/v1/media/profiles/${perfilId}/avatar`).buffer(true).parse((res, cb) => {
    const pedacos = [];
    res.on('data', p => pedacos.push(p));
    res.on('end', () => cb(null, Buffer.concat(pedacos)));
  });
  return resposta;
};

describe('foto de perfil é recortada e encolhida', () => {
  it('4000x3000 vira um quadrado de 512, em WebP', async () => {
    const envio = await enviarAvatar(await jpegGrande());
    expect(envio.status, JSON.stringify(envio.body)).toBe(200);
    expect(envio.body.avatarKey.endsWith('.webp'), envio.body.avatarKey).toBe(true);

    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    const arquivo = await baixarAvatar(perfil.body.id);
    const meta = await sharp(arquivo.body).metadata();

    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(512);
  });

  it('o arquivo guardado é MUITO menor que o original', async () => {
    const original = await jpegGrande();
    await enviarAvatar(original);
    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    const arquivo = await baixarAvatar(perfil.body.id);

    expect(arquivo.body.length).toBeLessThan(original.length / 4);
  });

  it('imagem menor que o teto NÃO é esticada', async () => {
    const pequena = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#444' } }).jpeg().toBuffer();
    await enviarAvatar(pequena);
    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    const meta = await sharp((await baixarAvatar(perfil.body.id)).body).metadata();

    // Ampliar não cria detalhe — só peso e borrão.
    expect(meta.width).toBe(120);
  });
});

describe('mídia de publicação', () => {
  it('respeita a etiqueta de orientação do EXIF: a foto deitada vira em pé', async () => {
    const resposta = await anexarNoPost(await jpegDeitadoComEtiqueta());
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const midia = await prisma.postMedia.findUnique({ where: { id: resposta.body.id } });
    // 1200x600 com "gire 90°" tem de sair 600x1200. Se a etiqueta fosse
    // ignorada, sairia 1200x600 e a foto apareceria deitada na tela.
    expect({ largura: midia.width, altura: midia.height }).toEqual({ largura: 600, altura: 1200 });
  });

  it('grava largura e altura — a tela precisa delas para reservar o espaço', async () => {
    const resposta = await anexarNoPost(await jpegGrande());
    const midia = await prisma.postMedia.findUnique({ where: { id: resposta.body.id } });

    expect(midia.width).toBe(2048);
    expect(midia.height).toBe(1536);
    expect(midia.mimeType).toBe('image/webp');
  });

  it('o metadado não viaja junto — GPS numa foto de academia é o endereço de alguém', async () => {
    const resposta = await anexarNoPost(await jpegComGps());
    const midia = await prisma.postMedia.findUnique({ where: { id: resposta.body.id } });

    const arquivo = await api().get(`/api/v1/media/posts/${midia.id}`).set(ana.auth()).buffer(true).parse((res, cb) => {
      const pedacos = [];
      res.on('data', p => pedacos.push(p));
      res.on('end', () => cb(null, Buffer.concat(pedacos)));
    });
    const meta = await sharp(arquivo.body).metadata();
    expect(meta.exif, 'o EXIF sobreviveu ao processamento').toBeUndefined();
  });
});

describe('o que NÃO é processado, de propósito', () => {
  it('GIF passa intacto — converter mataria a animação, que é o motivo do GIF', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 0x21)]);
    const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'gif' });
    const resposta = await api().post(`/api/v1/social/posts/${post.body.id}/media`).set(ana.auth())
      .attach('file', gif, { filename: 'anim.gif', contentType: 'image/gif' });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.mimeType).toBe('image/gif');
    expect(resposta.body.storageKey.endsWith('.gif')).toBe(true);
  });
});
