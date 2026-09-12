import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { api, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';

// ==========================================================================
// O tipo do arquivo tem de vir dos BYTES, não do rótulo.
//
// O `mimeType` que a lista de tipos aceitos consultava vinha de
// `info.mimeType` do multipart — ou seja, do que o CLIENTE declara. Dizer
// "image/png" e enviar um HTML, um SVG ou um executável passava pela lista
// fechada sem nenhum obstáculo.
//
// Isto NÃO era XSS armazenado: a entrega já manda `X-Content-Type-Options:
// nosniff` com o Content-Type declarado, então o navegador se recusa a
// interpretar o HTML. O que havia era ausência da barreira em si — bytes
// arbitrários entrando no armazenamento sob rótulo de imagem, e o usuário
// vendo imagem quebrada em vez de um erro no envio.
// ==========================================================================

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 0x41)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x42)]);

let ana;

beforeAll(() => garantirCatalogo());
beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana' });
});

const anexar = async (conteudo, { filename, contentType }) => {
  const post = await api().post('/api/v1/social/posts').set(ana.auth()).send({ content: 'teste' });
  return api()
    .post(`/api/v1/social/posts/${post.body.id}/media`)
    .set(ana.auth())
    .attach('file', conteudo, { filename, contentType });
};

describe('o rótulo declarado pelo cliente não basta', () => {
  it('HTML disfarçado de PNG é recusado', async () => {
    const resposta = await anexar(HTML, { filename: 'foto.png', contentType: 'image/png' });
    expect(resposta.status).toBe(415);
    expect(resposta.body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('SVG disfarçado de PNG é recusado — SVG carrega script', async () => {
    const resposta = await anexar(SVG, { filename: 'vetor.png', contentType: 'image/png' });
    expect(resposta.status).toBe(415);
  });

  it('executável ELF disfarçado de JPEG é recusado', async () => {
    const resposta = await anexar(ELF, { filename: 'foto.jpg', contentType: 'image/jpeg' });
    expect(resposta.status).toBe(415);
  });

  it('arquivo ZIP disfarçado de WebP é recusado', async () => {
    const resposta = await anexar(ZIP, { filename: 'album.webp', contentType: 'image/webp' });
    expect(resposta.status).toBe(415);
  });

  it('trocar a EXTENSÃO não muda nada: o que vale são os bytes', async () => {
    const resposta = await anexar(HTML, { filename: 'foto.jpeg', contentType: 'image/jpeg' });
    expect(resposta.status).toBe(415);
  });

  it('e a imagem de verdade continua passando', async () => {
    const resposta = await anexar(PNG, { filename: 'pose.png', contentType: 'image/png' });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
  });
});
