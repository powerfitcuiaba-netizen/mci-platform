import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import sharp from 'sharp';
import { api, prisma, comoAtor, limparBanco, garantirCatalogo, criarUsuario } from './helpers.mjs';

// ==========================================================================
// Foto de perfil.
//
// `SocialProfile.avatarKey` existia no banco desde o início e era LIDO em todo
// lugar — no perfil, no autor da publicação, na lista de parceiros. Só que
// NADA no sistema escrevia: não havia rota de envio, de remoção nem de
// entrega. O campo nascia nulo e morria nulo, e a interface caía para sempre
// nas iniciais.
//
// A entrega segue a mesma regra que a API já aplicava ao expor `avatarKey`
// dentro de `profilePublic`: a foto faz parte do cartão de identificação do
// perfil e é visível a quem enxerga o perfil, inclusive quando ele é privado
// (é o conteúdo que o "privado" protege, não a identidade).
// ==========================================================================

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
// JPEG de VERDADE, gerado na hora. A primeira versão deste arquivo usava
// bytes inventados que só imitavam o cabeçalho — passavam na conferência de
// assinatura e eram recusados pelo processamento de imagem, com razão: não
// eram decodificáveis. Fixture falso vira falha falsa.
const jpegReal = () => sharp({ create: { width: 300, height: 300, channels: 3, background: '#7a1f2b' } })
  .jpeg().toBuffer();
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(32)]);

let ana;
let bruno;

beforeAll(() => garantirCatalogo());
beforeEach(async () => {
  await limparBanco();
  ana = await criarUsuario({ name: 'Ana Ribeiro' });
  bruno = await criarUsuario({ name: 'Bruno Alves' });
});

const enviarAvatar = (usuario, conteudo, opcoes) => api()
  .post('/api/v1/social/me/avatar').set(usuario.auth())
  .attach('file', conteudo, opcoes);

describe('enviar, trocar e remover a própria foto', () => {
  it('envia a foto e ela passa a aparecer no perfil', async () => {
    const envio = await enviarAvatar(ana, PNG, { filename: 'eu.png', contentType: 'image/png' });
    expect(envio.status, JSON.stringify(envio.body)).toBe(200);
    expect(envio.body.avatarKey).toBeTruthy();

    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    expect(perfil.body.avatarKey).toBe(envio.body.avatarKey);
  });

  it('a foto é servida de verdade, com o tipo correto', async () => {
    await enviarAvatar(ana, PNG, { filename: 'eu.png', contentType: 'image/png' });
    const perfil = await api().get('/api/v1/social/me').set(ana.auth());

    const arquivo = await api().get(`/api/v1/media/profiles/${perfil.body.id}/avatar`);
    expect(arquivo.status).toBe(200);
    // WebP, e não o PNG enviado: a foto é reencodada na entrada. O que
    // importa aqui é que ela VOLTA, com o tipo que foi guardado.
    expect(arquivo.headers['content-type']).toContain('image/webp');
    // Guarda contra o navegador adivinhar o tipo e executar o que não deve.
    expect(arquivo.headers['x-content-type-options']).toBe('nosniff');
  });

  it('trocar a foto APAGA o arquivo anterior — não deixa órfão no storage', async () => {
    const primeira = await enviarAvatar(ana, PNG, { filename: 'a.png', contentType: 'image/png' });
    const segunda = await enviarAvatar(ana, await jpegReal(), { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(segunda.status).toBe(200);
    expect(segunda.body.avatarKey).not.toBe(primeira.body.avatarKey);

    const storage = await import('../src/services/storageService.js');
    expect(await storage.default.exists(primeira.body.avatarKey), 'arquivo antigo ficou órfão').toBe(false);
    expect(await storage.default.exists(segunda.body.avatarKey)).toBe(true);
  });

  it('remover a foto limpa o campo e apaga o arquivo', async () => {
    const envio = await enviarAvatar(ana, PNG, { filename: 'eu.png', contentType: 'image/png' });
    const remocao = await api().delete('/api/v1/social/me/avatar').set(ana.auth());
    expect(remocao.status).toBe(200);
    expect(remocao.body.avatarKey).toBeNull();

    const storage = await import('../src/services/storageService.js');
    expect(await storage.default.exists(envio.body.avatarKey)).toBe(false);
  });

  it('remover sem ter foto não é erro', async () => {
    const remocao = await api().delete('/api/v1/social/me/avatar').set(ana.auth());
    expect(remocao.status).toBe(200);
    expect(remocao.body.avatarKey).toBeNull();
  });

  it('a troca fica registrada na auditoria', async () => {
    await enviarAvatar(ana, PNG, { filename: 'eu.png', contentType: 'image/png' });

    // A leitura precisa de ator: a política `auditoria_restrita` só entrega a
    // linha a administrador de plataforma ou a operador da organização. Contar
    // sem ator devolveria zero mesmo com o registro gravado — e foi exatamente
    // o que a primeira versão deste teste fez.
    const auditora = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Auditora' });
    const registros = await comoAtor(auditora.id, () =>
      prisma.auditLog.count({ where: { action: 'PROFILE_AVATAR_SET' } }));
    expect(registros).toBe(1);
  });
});

describe('segurança da foto de perfil', () => {
  it('sem autenticação não envia', async () => {
    const envio = await api().post('/api/v1/social/me/avatar')
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(envio.status).toBe(401);
  });

  it('sem autenticação não remove', async () => {
    const remocao = await api().delete('/api/v1/social/me/avatar');
    expect(remocao.status).toBe(401);
  });

  it('não existe rota para trocar a foto DE OUTRO usuário', async () => {
    const perfilDoBruno = await api().get('/api/v1/social/me').set(bruno.auth());

    // A rota é sempre "a minha": não recebe id de perfil. Tentar endereçar
    // outro perfil não pode existir como caminho.
    const tentativa = await api().post(`/api/v1/social/profiles/${perfilDoBruno.body.id}/avatar`)
      .set(ana.auth()).attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect([404, 405]).toContain(tentativa.status);

    // E mandar o id do outro como campo do formulário é ignorado.
    await api().post('/api/v1/social/me/avatar').set(ana.auth())
      .field('profileId', perfilDoBruno.body.id)
      .attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });

    const bruno2 = await api().get('/api/v1/social/me').set(bruno.auth());
    expect(bruno2.body.avatarKey, 'o avatar do Bruno foi alterado pela Ana').toBeNull();
  });

  it('HTML disfarçado de imagem é recusado', async () => {
    const envio = await enviarAvatar(ana, HTML, { filename: 'foto.png', contentType: 'image/png' });
    expect(envio.status).toBe(415);
  });

  it('vídeo não serve como foto de perfil', async () => {
    const envio = await enviarAvatar(ana, MP4, { filename: 'clip.mp4', contentType: 'video/mp4' });
    expect(envio.status).toBe(415);
  });

  it('pedir o avatar de um perfil que não tem foto responde 404, não 500', async () => {
    const perfil = await api().get('/api/v1/social/me').set(ana.auth());
    const arquivo = await api().get(`/api/v1/media/profiles/${perfil.body.id}/avatar`);
    expect(arquivo.status).toBe(404);
  });
});
