import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf, criarAtleta, criarEventoCompleto
} from './helpers.mjs';

// ==========================================================================
// REFERÊNCIA INTERNA DE ARMAZENAMENTO NÃO SAI EM RESPOSTA.
//
// `photoKey`, `avatarKey` e `storageKey` são CAMINHOS DENTRO DO BUCKET. Eles
// não servem a nenhum cliente — toda mídia é buscada por rota com id da
// entidade, que decide quem pode vê-la. Devolvê-los entregava a estrutura
// interna do armazenamento a qualquer visitante da vitrine pública.
//
// Este arquivo é uma peneira: varre a resposta INTEIRA, em qualquer
// profundidade, procurando nome de campo proibido e valor com cara de chave.
// Uma rota nova que volte a devolver a chave quebra aqui, e não em produção.
// ==========================================================================

const CAMPOS_PROIBIDOS = [
  'photoKey', 'avatarKey', 'coverKey', 'storageKey', 'objectKey', 'storagePath',
  'bucket', 'r2Key', 's3Key', 'signedUrl', 'presignedUrl', 'endpoint',
  'accessKey', 'accessKeyId', 'secretAccessKey', 'secret'
];

// Valores que denunciam credencial ou endereço interno de armazenamento,
// mesmo sob nome de campo inocente.
const VALOR_SUSPEITO = [
  [/\bAKIA[0-9A-Z]{12,}/, 'chave de acesso AWS'],
  [/X-Amz-Signature=/i, 'URL assinada S3'],
  [/[a-z0-9.-]+\.r2\.cloudflarestorage\.com/i, 'endpoint R2'],
  [/[a-z0-9.-]*\.s3[.-][a-z0-9-]*\.amazonaws\.com/i, 'endpoint S3']
];

// Uma chave tem a forma `escopo/uuid.ext` — é o que `storage.buildKey` monta.
// Procurar o FORMATO pega o caso em que alguém renomeia o campo e continua
// devolvendo a chave.
const PARECE_CHAVE = /[a-z0-9-]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}/i;

function acharVazamento(valor, caminho = '$') {
  if (valor === null || valor === undefined) return null;

  if (typeof valor === 'string') {
    if (PARECE_CHAVE.test(valor)) return `${caminho} tem cara de chave de armazenamento: ${valor}`;
    for (const [padrao, oque] of VALOR_SUSPEITO) {
      if (padrao.test(valor)) return `${caminho} contém ${oque}: ${valor.slice(0, 60)}`;
    }
    return null;
  }
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = acharVazamento(valor[i], `${caminho}[${i}]`);
      if (achado) return achado;
    }
    return null;
  }
  if (typeof valor === 'object') {
    for (const [chave, dentro] of Object.entries(valor)) {
      if (CAMPOS_PROIBIDOS.includes(chave)) return `${caminho}.${chave} é campo proibido`;
      const achado = acharVazamento(dentro, `${caminho}.${chave}`);
      if (achado) return achado;
    }
  }
  return null;
}

const semVazamento = (resposta, rota) => {
  const achado = acharVazamento(resposta.body);
  expect(achado, `${rota} vazou referência de armazenamento — ${achado}`).toBeNull();
};

// --- um PNG real, para as fotos existirem de verdade -----------------------
const crc32 = b => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const pedaco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
function png(lado = 8) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = []; for (let y = 0; y < lado; y += 1) linhas.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(lado * 3, 90)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))]);
}

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10', phone: '65999991234', whatsapp: '65988884321',
  postalCode: '78000000', addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

let admin; let org; let operador; let filiacao; let pessoa; let atleta;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  org = await criarOrganizacao(admin, { name: 'Federação Vitrine' });
  operador = await criarUsuario({ name: 'Operadora' });
  await vincular(org.id, operador, 'EVENT_DIRECTOR');
  await prisma.organization.update({ where: { id: org.id }, data: { selfRegistrationOpen: true } });

  filiacao = (await api().post('/api/v1/affiliations').set(operador.auth())
    .send({ organizationId: org.id, name: 'NPC Brasil', code: unico('npc').toUpperCase().slice(0, 12), kind: 'ENTITY', state: 'MT' })).body;

  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: 'Pessoa Vitrine', email: `${unico('p')}@mci.test` });
  pessoa = { id: r.body.user.id, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };

  // Um atleta COM foto, para a vitrine ter o que vazar se voltar a vazar.
  atleta = await criarAtleta(operador, org.id, { fullName: 'Atleta Com Foto', cpf: gerarCpf(4242) });
  await comoAtor(operador, () => prisma.athlete.update({
    where: { id: atleta.id }, data: { photoKey: 'athletes/11111111-2222-3333-4444-555555555555.webp' }
  }));
});

describe('vitrine pública', () => {
  it('nenhuma rota pública devolve referência de armazenamento', async () => {
    const rotas = [
      '/api/v1/public/summary',
      '/api/v1/public/events',
      '/api/v1/public/athletes',
      `/api/v1/public/athletes/${atleta.id}`,
      '/api/v1/public/affiliations'
    ];

    for (const rota of rotas) {
      const r = await api().get(rota);
      expect([200, 404], `${rota} respondeu ${r.status}`).toContain(r.status);
      semVazamento(r, rota);
    }
  });

  // A prova de que o teste enxerga o atleta certo: se ele não aparecesse, a
  // varredura acima passaria sem examinar nada.
  it('o atleta COM foto realmente aparece na vitrine — o teste não passa no vazio', async () => {
    const r = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('Atleta Com Foto');
    // E o booleano substitui a chave: a tela continua sabendo que há foto.
    expect(r.body.athlete.hasPhoto).toBe(true);
    expect(r.body.athlete).not.toHaveProperty('photoKey');
  });
});

describe('rotas autenticadas', () => {
  it('a solicitação de atleta não devolve a chave, e diz que há foto', async () => {
    const criado = await api().post('/api/v1/athlete-requests').set(pessoa.auth())
      .send({ fullName: 'Solicitante', cpf: gerarCpf(77), sex: 'FEMALE', affiliationId: filiacao.id, affiliationNumber: 'NPC-1' });
    expect(criado.status).toBe(201);
    semVazamento(criado, 'POST /athlete-requests');
    expect(criado.body.hasPhoto).toBe(false);

    const comFoto = await api().post(`/api/v1/athlete-requests/${criado.body.id}/photo`).set(pessoa.auth())
      .attach('file', png(), { filename: 'f.png', contentType: 'image/png' });
    expect(comFoto.status).toBe(200);
    semVazamento(comFoto, 'POST /athlete-requests/:id/photo');
    expect(comFoto.body.hasPhoto, 'a tela precisa saber que existe foto').toBe(true);

    for (const [rota, auth] of [
      ['/api/v1/athlete-requests/me', pessoa.auth()],
      ['/api/v1/athlete-requests', operador.auth()],
      [`/api/v1/athlete-requests/${criado.body.id}`, operador.auth()]
    ]) {
      const r = await api().get(rota).set(auth);
      expect(r.status, rota).toBe(200);
      semVazamento(r, rota);
    }
  });

  it('a análise do operador mostra CPF e "tem foto", mas nunca a chave', async () => {
    const criado = await api().post('/api/v1/athlete-requests').set(pessoa.auth())
      .send({ fullName: 'Solicitante', cpf: gerarCpf(88), sex: 'MALE', affiliationId: filiacao.id, affiliationNumber: 'NPC-2' });
    await api().post(`/api/v1/athlete-requests/${criado.body.id}/photo`).set(pessoa.auth())
      .attach('file', png(), { filename: 'f.png', contentType: 'image/png' });

    const analise = await api().get(`/api/v1/athlete-requests/${criado.body.id}`).set(operador.auth());
    expect(analise.body.cpf, 'o operador precisa do CPF para conferir').toBeTruthy();
    expect(analise.body.hasPhoto).toBe(true);
    expect(analise.body).not.toHaveProperty('photoKey');
    semVazamento(analise, 'GET /athlete-requests/:id');
  });

  // Uma publicação COM MÍDIA — sem ela, o feed volta sem `media` e a varredura
  // passa sem examinar o caminho que mais importa aqui. Medido: a mutação que
  // devolvia `storageKey` da mídia sobrevivia enquanto não havia mídia nenhuma.
  it('publicação com mídia não devolve a chave do arquivo', async () => {
    const post = await api().post('/api/v1/social/posts').set(pessoa.auth()).send({ content: 'Com foto' });
    expect(post.status, JSON.stringify(post.body)).toBe(201);

    const midia = await api().post(`/api/v1/social/posts/${post.body.id}/media`).set(pessoa.auth())
      .attach('file', png(), { filename: 'p.png', contentType: 'image/png' });
    expect(midia.status, JSON.stringify(midia.body)).toBe(201);
    semVazamento(midia, 'POST /social/posts/:id/media');

    const detalhe = await api().get(`/api/v1/social/posts/${post.body.id}`).set(pessoa.auth());
    expect(detalhe.status).toBe(200);
    // A mídia PRECISA estar lá — senão a varredura não examina nada.
    expect(detalhe.body.media.length, 'a publicação veio sem mídia: o teste não provaria nada').toBeGreaterThan(0);
    expect(detalhe.body.media[0].id).toBeTruthy();
    semVazamento(detalhe, 'GET /social/posts/:id');

    const feed = await api().get('/api/v1/social/feed').set(pessoa.auth());
    expect(JSON.stringify(feed.body), 'a publicação com mídia não apareceu no feed').toContain(post.body.id);
    semVazamento(feed, 'GET /social/feed');
  });

  // Mensagem COM MÍDIA, pela mesma razão da publicação: sem ela, a varredura
  // não examina o caminho. Medido — a mutação sobrevivia enquanto a conversa
  // não tinha anexo nenhum.
  it('mensagem com mídia não devolve a chave do arquivo', async () => {
    const outro = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: 'Outra Pessoa', email: `${unico('p')}@mci.test` });
    const outroAuth = () => ({ Authorization: `Bearer ${outro.body.token}` });

    const perfilOutro = await api().get('/api/v1/social/me').set(outroAuth());
    const conversa = await api().post('/api/v1/messenger/conversations').set(pessoa.auth())
      .send({ kind: 'DIRECT', participantIds: [perfilOutro.body.id] });
    expect(conversa.status, JSON.stringify(conversa.body)).toBe(201);

    const envio = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/media`).set(pessoa.auth())
      .attach('file', png(), { filename: 'm.png', contentType: 'image/png' });
    expect(envio.status, JSON.stringify(envio.body)).toBe(201);
    semVazamento(envio, 'POST /messenger/conversations/:id/media');
    expect(envio.body.hasMedia, 'a tela precisa saber que há anexo').toBe(true);

    const mensagens = await api().get(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(pessoa.auth());
    expect(mensagens.status).toBe(200);
    expect(mensagens.body.items.some(m => m.hasMedia), 'a conversa veio sem anexo: o teste não provaria nada').toBe(true);
    semVazamento(mensagens, 'GET /messenger/conversations/:id/messages');
  });

  // RISCO A da FASE 1.2: publicação COM MÍDIA compartilhada DENTRO de uma
  // mensagem. É o caminho de terceira ordem — post → mídia → compartilhamento
  // → mensagem → resposta — e era o único que continuava sem cobertura de
  // mutação, porque nenhum dublê chegava até lá.
  it('publicação com mídia compartilhada em mensagem não devolve chave nenhuma', async () => {
    const outro = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: 'Outra Pessoa', email: `${unico('p')}@mci.test` });
    const outroAuth = () => ({ Authorization: `Bearer ${outro.body.token}` });
    const perfilOutro = await api().get('/api/v1/social/me').set(outroAuth());

    // 1. publicação com mídia
    const post = await api().post('/api/v1/social/posts').set(pessoa.auth()).send({ content: 'Para compartilhar' });
    expect(post.status).toBe(201);
    const midia = await api().post(`/api/v1/social/posts/${post.body.id}/media`).set(pessoa.auth())
      .attach('file', png(), { filename: 'p.png', contentType: 'image/png' });
    expect(midia.status).toBe(201);

    // 2. conversa e 3. compartilhamento da publicação dentro dela
    const conversa = await api().post('/api/v1/messenger/conversations').set(pessoa.auth())
      .send({ kind: 'DIRECT', participantIds: [perfilOutro.body.id] });
    expect(conversa.status, JSON.stringify(conversa.body)).toBe(201);

    const envio = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(pessoa.auth())
      .send({ body: 'olha isto', sharedPostId: post.body.id });
    expect(envio.status, JSON.stringify(envio.body)).toBe(201);
    semVazamento(envio, 'POST /messenger/conversations/:id/messages (compartilhando post)');

    // 4. a mídia compartilhada PRECISA estar na resposta — senão o teste não
    // examina o caminho que veio cobrir.
    expect(envio.body.sharedPost, 'a publicação compartilhada não voltou').toBeTruthy();
    expect(envio.body.sharedPost.media.length, 'a mídia compartilhada não voltou: o teste não provaria nada').toBeGreaterThan(0);

    // 5. e na leitura da conversa, pelos DOIS lados
    for (const [quem, auth] of [['remetente', pessoa.auth()], ['destinatário', outroAuth()]]) {
      const lista = await api().get(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(auth);
      expect(lista.status, quem).toBe(200);
      const comPost = lista.body.items.find(m => m.sharedPost);
      expect(comPost, `${quem} não recebeu a publicação compartilhada`).toBeTruthy();
      expect(comPost.sharedPost.media.length).toBeGreaterThan(0);
      semVazamento(lista, `GET /messenger/conversations/:id/messages (${quem})`);
    }

    // 6. e o perfil compartilhado, que carrega o avatar
    const comPerfil = await api().post(`/api/v1/messenger/conversations/${conversa.body.id}/messages`).set(pessoa.auth())
      .send({ body: 'e este perfil', sharedProfileId: perfilOutro.body.id });
    expect(comPerfil.status).toBe(201);
    expect(comPerfil.body.sharedProfile, 'o perfil compartilhado não voltou').toBeTruthy();
    semVazamento(comPerfil, 'POST /messenger (compartilhando perfil)');
  });

  it('atletas, perfil social e busca não devolvem chave', async () => {
    const rotas = [
      ['/api/v1/athletes', operador.auth()],
      [`/api/v1/athletes/${atleta.id}`, operador.auth()],
      ['/api/v1/social/me', pessoa.auth()],
      ['/api/v1/social/feed', pessoa.auth()],
      ['/api/v1/search?q=Atleta', operador.auth()]
    ];
    for (const [rota, auth] of rotas) {
      const r = await api().get(rota).set(auth);
      expect([200, 404], `${rota} respondeu ${r.status}`).toContain(r.status);
      semVazamento(r, rota);
    }
  });
});

describe('a peneira funciona', () => {
  // Um teste que nunca acusa nada não prova nada. Estes dois confirmam que a
  // varredura enxerga o vazamento quando ele existe.
  it('acusa campo proibido em qualquer profundidade', () => {
    expect(acharVazamento({ items: [{ athlete: { photoKey: 'x' } }] })).toMatch(/photoKey/);
    expect(acharVazamento({ a: { b: { c: { avatarKey: null } } } })).toMatch(/avatarKey/);
    expect(acharVazamento({ media: [{ storageKey: 'y' }] })).toMatch(/storageKey/);
  });

  it('acusa valor com FORMATO de chave, mesmo sob nome inocente', () => {
    const disfarcado = { foto: 'athlete-requests/11111111-2222-3333-4444-555555555555.webp' };
    expect(acharVazamento(disfarcado)).toMatch(/cara de chave/);
  });

  it('não acusa resposta limpa', () => {
    expect(acharVazamento({ id: 'abc', hasPhoto: true, items: [{ nome: 'Maria', url: '/media/athletes/abc/photo' }] })).toBeNull();
  });
});

// ==========================================================================
// VARREDURA AMPLA — FASE 1.3, seção 5.
//
// Percorre TODAS as superfícies que devolvem dado ao cliente, incluindo as
// operacionais (palco, pesagem, credenciamento) e as de erro. O objetivo não é
// repetir os testes acima: é garantir que uma rota que ninguém lembrou de
// auditar também está limpa.
// ==========================================================================
describe('varredura ampla de superfícies', () => {
  it('rotas operacionais e de competição não devolvem referência de armazenamento', async () => {
    const evento = await criarEventoCompleto(operador, org.id);

    // Uma conta LIGADA a um atleta, para o painel entrar no ramo com atleta.
    const dono = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: 'Dono do Atleta', email: `${unico('p')}@mci.test` });
    const comAtleta = { auth: () => ({ Authorization: `Bearer ${dono.body.token}` }) };
    await comoAtor(operador, () => prisma.athlete.update({ where: { id: atleta.id }, data: { userId: dono.body.user.id } }));

    const rotas = [
      ['/api/v1/events', operador.auth()],
      [`/api/v1/events/${evento.event.id}`, operador.auth()],
      [`/api/v1/events/${evento.event.id}/registrations`, operador.auth()],
      [`/api/v1/events/${evento.event.id}/checkins`, operador.auth()],
      [`/api/v1/events/${evento.event.id}/credentials`, operador.auth()],
      [`/api/v1/events/${evento.event.id}/batches`, operador.auth()],
      [`/api/v1/events/${evento.event.id}/results`, operador.auth()],
      ['/api/v1/ranking', operador.auth()],
      ['/api/v1/ranking/teams', operador.auth()],
      ['/api/v1/ranking/companies', operador.auth()],
      ['/api/v1/athletes/pro', operador.auth()],
      ['/api/v1/teams', operador.auth()],
      ['/api/v1/coaches', operador.auth()],
      ['/api/v1/gyms', operador.auth()],
      ['/api/v1/brands', operador.auth()],
      ['/api/v1/sponsors', operador.auth()],
      ['/api/v1/companies', operador.auth()],
      ['/api/v1/messenger/conversations', pessoa.auth()],
      ['/api/v1/communities', pessoa.auth()],
      ['/api/v1/notifications', pessoa.auth()],
      ['/api/v1/social/saved', pessoa.auth()],
      ['/api/v1/social/stories', pessoa.auth()],
      ['/api/v1/dashboard/summary', operador.auth()],
      ['/api/v1/dashboard/athlete', pessoa.auth()],
      // O painel tem DOIS ramos — com e sem atleta vinculado — e cada um monta
      // a resposta por conta própria. Medido: mutar só um deles não fazia o
      // teste falhar, porque a varredura percorria apenas o outro.
      ['/api/v1/dashboard/athlete', comAtleta.auth()],
      ['/api/v1/audit', admin.auth()],
      ['/api/v1/organizations', operador.auth()],
      ['/api/v1/affiliations', operador.auth()],
      ['/api/v1/categories', operador.auth()]
    ];

    let examinadas = 0;
    for (const [rota, auth] of rotas) {
      const r = await api().get(rota).set(auth);
      expect([200, 403, 404], `${rota} respondeu ${r.status}`).toContain(r.status);
      if (r.status === 200) { semVazamento(r, rota); examinadas += 1; }
    }
    // Se quase nada respondesse 200, a varredura não teria examinado nada.
    expect(examinadas, 'poucas rotas responderam 200: a varredura não provaria nada').toBeGreaterThan(20);
  });

  // Mensagem de erro é a superfície mais esquecida — e a que mais entrega
  // caminho interno quando o servidor devolve stack trace.
  it('respostas de ERRO não vazam chave, caminho de disco nem stack trace', async () => {
    const tentativas = [
      ['get', '/api/v1/media/athlete-requests/cl00000000000000000000000/photo', pessoa.auth()],
      ['get', '/api/v1/media/athletes/cl00000000000000000000000/photo', pessoa.auth()],
      ['get', '/api/v1/media/profiles/cl00000000000000000000000/avatar', pessoa.auth()],
      ['get', '/api/v1/documents/athlete/cl00000000000000000000000/download', operador.auth()],
      ['get', '/api/v1/athletes/cl00000000000000000000000', operador.auth()],
      ['post', '/api/v1/athlete-requests', pessoa.auth()]
    ];

    for (const [metodo, rota, auth] of tentativas) {
      const r = await api()[metodo](rota).set(auth).send({});
      expect(r.status).toBeGreaterThanOrEqual(400);
      semVazamento(r, `${metodo.toUpperCase()} ${rota}`);

      const texto = JSON.stringify(r.body);
      expect(texto, 'a resposta de erro trouxe stack trace').not.toMatch(/at\s+\w+\s+\(/);
      expect(texto, 'a resposta de erro trouxe caminho de disco').not.toMatch(/\/(home|var|usr|root)\//);
      expect(texto).not.toMatch(/node_modules/);
      expect(texto).not.toMatch(/prisma\./i);
    }
  });
});
