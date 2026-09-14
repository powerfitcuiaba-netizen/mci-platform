import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import fsp from 'node:fs/promises';
import storage from '../src/services/storageService.js';
import imagem from '../src/services/imagemService.js';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';

// ==========================================================================
// AUTOCADASTRO DE ATLETA — os dois bloqueios que a FASE 1 deixou abertos.
//
// BLOQUEIO 1: quem acaba de criar conta não tem vínculo com organização, e
// `GET /affiliations` é escopado ao vínculo. A lista voltava vazia SEMPRE e a
// fila ficava inalcançável para quem ela atende. A saída é uma vitrine
// própria, com exposição decidida pela federação — nunca pelo cliente.
//
// BLOQUEIO 2: `photoKey` era aceito pelo pedido, mas nenhuma rota o produzia.
//
// O que este arquivo trava:
//
//   1. a vitrine mostra SÓ o que a federação abriu, e só o mínimo;
//   2. abrir a vitrine não abre permissão nenhuma para quem a lê;
//   3. a foto sobe pelo servidor, validada por bytes, e a chave nunca vem do
//      cliente — não há travessia nem IDOR por troca de objectKey;
//   4. recusa e cancelamento não deixam arquivo órfão;
//   5. o fluxo inteiro, de conta nova a atleta aprovado com foto.
//
// NOTA SOBRE LEITURA DIRETA NO BANCO: `AthleteProfileRequest`, `Athlete`,
// `AthleteIdentity` e `AuditLog` estão sob RLS. Consultá-las com o cliente
// cru, fora de um contexto de ator, devolve NULO ou lista vazia — e uma
// asserção de "não existe atleta" passaria por engano, provando nada. Por
// isso toda leitura dessas tabelas aqui vai dentro de `comoAtor`.
// ==========================================================================

let admin;
let orgA;
let operadorA;
let filiacaoA;

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999991234', whatsapp: '65988884321', postalCode: '78000000',
  addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

const cadastrarPessoa = async (nome = 'Pessoa Nova') => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

const criarFiliacao = async (operador, organizationId, nome = 'NPC Brasil') => {
  const r = await api().post('/api/v1/affiliations').set(operador.auth())
    .send({ organizationId, name: nome, code: unico('npc').toUpperCase().slice(0, 12), kind: 'ENTITY', state: 'MT' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};

const abrirAutocadastro = (organizationId, aberto = true) =>
  api().post(`/api/v1/organizations/${organizationId}/self-registration`).set(admin.auth()).send({ open: aberto });

const pedir = (pessoa, corpo) => api().post('/api/v1/athlete-requests').set(pessoa.auth()).send(corpo);

const pedidoValido = (filiacao, semente) => ({
  fullName: 'Atleta Solicitante', cpf: gerarCpf(semente), sex: 'FEMALE',
  birthDate: '1998-07-15', affiliationId: filiacao.id, affiliationNumber: 'NPC-00123'
});

// ---- imagens de verdade, montadas byte a byte -----------------------------
// Um PNG 1x1 real: cabeçalho, IHDR, IDAT deflatado e IEND com CRC correto. O
// sharp precisa DECODIFICAR o arquivo, então um buffer com a assinatura certa
// e lixo atrás não serve — seria testar a peneira errada.
const crc32 = buffer => {
  let c = ~0;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
};

const pedacoPng = (tipo, dados) => {
  const comprimento = Buffer.alloc(4);
  comprimento.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([comprimento, corpo, crc]);
};

function pngValido(lado = 8) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;   // profundidade
  ihdr[9] = 2;   // RGB
  // Cada linha começa com o byte de filtro, seguido de `lado` pixels RGB.
  const linhas = [];
  for (let y = 0; y < lado; y += 1) linhas.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(lado * 3, 120)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedacoPng('IHDR', ihdr),
    pedacoPng('IDAT', zlib.deflateSync(Buffer.concat(linhas))),
    pedacoPng('IEND', Buffer.alloc(0))
  ]);
}

const enviarFoto = (pessoa, requestId, buffer, nome = 'foto.png', tipo = 'image/png') =>
  api().post(`/api/v1/athlete-requests/${requestId}/photo`).set(pessoa.auth())
    .attach('file', buffer, { filename: nome, contentType: tipo });

// A CHAVE não sai mais na resposta — é referência interna do armazenamento, e
// devolvê-la entregava a estrutura do bucket a quem chamasse a API. Quem
// precisa dela é o TESTE, para conferir o arquivo; então ele a lê do banco,
// que é de onde ela nunca deveria ter saído.
const chaveDoPedido = (ator, requestId) => comoAtor(ator, async () =>
  (await prisma.athleteProfileRequest.findUnique({ where: { id: requestId }, select: { photoKey: true } }))?.photoKey ?? null);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  orgA = await criarOrganizacao(admin, { name: 'Federação A' });
  operadorA = await criarUsuario({ name: 'Operadora A' });
  await vincular(orgA.id, operadorA, 'EVENT_DIRECTOR');
  filiacaoA = await criarFiliacao(operadorA, orgA.id);
});

// =================== BLOQUEIO 1 — VITRINE DE FILIAÇÕES ====================

describe('vitrine de filiações para autocadastro', () => {
  it('o padrão é FECHADO: a migration não tornou nenhuma federação descobrível', async () => {
    const r = await api().get('/api/v1/public/affiliations');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
  });

  // O bloqueio original, e a prova de que acabou.
  it('usuário recém-cadastrado consulta as filiações elegíveis e envia o pedido', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa();

    const vitrine = await api().get('/api/v1/public/affiliations').set(pessoa.auth());
    expect(vitrine.status).toBe(200);
    expect(vitrine.body.items).toHaveLength(1);
    expect(vitrine.body.items[0].id).toBe(filiacaoA.id);

    // Antes, `GET /affiliations` devolvia vazio para esta mesma pessoa — e
    // continua devolvendo, porque o escopo por vínculo não foi afrouxado.
    const escopada = await api().get('/api/v1/affiliations').set(pessoa.auth());
    expect(escopada.body.items).toHaveLength(0);

    const r = await pedir(pessoa, pedidoValido(filiacaoA, 1));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  // A tela manda parâmetros; a rota tem de aceitá-los. Sem este teste, o
  // contrato só era exercitado sem parâmetro nenhum — e a tela, que mandava
  // `limit=200`, levava 400 e mostrava lista vazia.
  it('aceita os parâmetros de paginação e busca dentro do teto público', async () => {
    await abrirAutocadastro(orgA.id);

    expect((await api().get('/api/v1/public/affiliations?limit=100')).status).toBe(200);
    expect((await api().get('/api/v1/public/affiliations?search=NPC')).status).toBe(200);

    // Acima do teto é recusado — e é por isso que a tela não pode mandar 200.
    expect((await api().get('/api/v1/public/affiliations?limit=200')).status).toBe(400);
  });

  it('a busca por nome e por código encontra a filiação', async () => {
    await abrirAutocadastro(orgA.id);
    const porNome = await api().get('/api/v1/public/affiliations?search=NPC');
    expect(porNome.body.items).toHaveLength(1);

    const semResultado = await api().get('/api/v1/public/affiliations?search=inexistente');
    expect(semResultado.body.items).toHaveLength(0);
  });

  it('filiação inativa não aparece', async () => {
    await abrirAutocadastro(orgA.id);
    await api().post(`/api/v1/affiliations/${filiacaoA.id}/deactivate`).set(operadorA.auth());

    const r = await api().get('/api/v1/public/affiliations');
    expect(r.body.items).toHaveLength(0);
  });

  it('organização inativa não aparece, mesmo com autocadastro aberto', async () => {
    await abrirAutocadastro(orgA.id);
    await prisma.organization.update({ where: { id: orgA.id }, data: { active: false } });

    const r = await api().get('/api/v1/public/affiliations');
    expect(r.body.items).toHaveLength(0);
  });

  it('fechar o autocadastro tira as filiações de circulação', async () => {
    await abrirAutocadastro(orgA.id);
    expect((await api().get('/api/v1/public/affiliations')).body.items).toHaveLength(1);

    await abrirAutocadastro(orgA.id, false);
    expect((await api().get('/api/v1/public/affiliations')).body.items).toHaveLength(0);
  });

  it('devolve o mínimo para escolher — e nada de dado interno', async () => {
    await abrirAutocadastro(orgA.id);
    const r = await api().get('/api/v1/public/affiliations');
    const item = r.body.items[0];

    expect(Object.keys(item).sort()).toEqual(['code', 'id', 'kind', 'name', 'organization', 'state']);
    expect(Object.keys(item.organization)).toEqual(['name']);

    // `organizationId` NÃO sai: a solicitação deriva a federação da filiação,
    // no servidor. Devolvê-lo aqui só serviria para alguém mandá-lo de volta.
    expect(item).not.toHaveProperty('organizationId');
    const texto = JSON.stringify(r.body);
    for (const proibido of ['cpf', 'email', 'members', 'memberships', 'passwordHash', '_count', 'createdAt']) {
      expect(texto, `a vitrine expôs ${proibido}`).not.toContain(proibido);
    }
  });

  it('a vitrine é somente leitura: não aceita escrita nem apagamento', async () => {
    for (const metodo of ['post', 'patch', 'put', 'delete']) {
      const r = await api()[metodo]('/api/v1/public/affiliations').send({ name: 'Invadida' });
      expect([404, 405], `${metodo} passou`).toContain(r.status);
    }
    expect(await prisma.affiliation.count()).toBe(1);
  });

  it('ler a vitrine NÃO concede permissão administrativa nenhuma', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa();
    await api().get('/api/v1/public/affiliations').set(pessoa.auth());

    expect((await api().get('/api/v1/athlete-requests').set(pessoa.auth())).status).toBe(403);
    expect((await api().get('/api/v1/admin/users').set(pessoa.auth())).status).toBe(403);
    expect((await api().post(`/api/v1/organizations/${orgA.id}/self-registration`).set(pessoa.auth()).send({ open: true })).status).toBe(403);
  });

  it('só quem administra organização abre ou fecha o autocadastro', async () => {
    // Nem o diretor de evento da própria federação: é decisão de quem
    // administra a organização, e fica em auditoria.
    const r = await api().post(`/api/v1/organizations/${orgA.id}/self-registration`).set(operadorA.auth()).send({ open: true });
    expect(r.status).toBe(403);
    expect((await prisma.organization.findUnique({ where: { id: orgA.id } })).selfRegistrationOpen).toBe(false);
  });

  it('abrir e fechar fica registrado em auditoria', async () => {
    await abrirAutocadastro(orgA.id);
    await abrirAutocadastro(orgA.id, false);

    const trilha = await comoAtor(admin, () => prisma.auditLog.findMany({
      where: { entity: 'Organization', entityId: orgA.id }, select: { action: true }
    }));
    const acoes = trilha.map(l => l.action);
    expect(acoes).toContain('ORGANIZATION_SELF_REGISTRATION_OPEN');
    expect(acoes).toContain('ORGANIZATION_SELF_REGISTRATION_CLOSE');
  });
});

describe('a vitrine não afrouxa a validação do pedido', () => {
  it('filiação de OUTRA federação é aceita e endereça o pedido àquela federação — não à minha', async () => {
    await abrirAutocadastro(orgA.id);
    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const operadorB = await criarUsuario({ name: 'Operador B' });
    await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');
    const filiacaoB = await criarFiliacao(operadorB, orgB.id);

    const pessoa = await cadastrarPessoa();
    const r = await pedir(pessoa, pedidoValido(filiacaoB, 2));
    expect(r.status).toBe(201);

    // A organização vem da FILIAÇÃO, e o pedido cai na fila da federação B.
    // A operadora A não o enxerga.
    expect(r.body.organizationId).toBe(orgB.id);
    const filaA = await api().get('/api/v1/athlete-requests').set(operadorA.auth());
    expect(filaA.body.items).toHaveLength(0);
  });

  it('organizationId forjado no corpo é ignorado', async () => {
    await abrirAutocadastro(orgA.id);
    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const pessoa = await cadastrarPessoa();

    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 3), organizationId: orgB.id });
    expect(r.status).toBe(201);
    expect(r.body.organizationId).toBe(orgA.id);
  });

  it('affiliationId inexistente continua recusado', async () => {
    const pessoa = await cadastrarPessoa();
    const r = await pedir(pessoa, { ...pedidoValido(filiacaoA, 4), affiliationId: 'cl00000000000000000000000' });
    expect(r.status).toBe(422);
  });

  it('filiação inativa continua recusada, mesmo tendo sido vista na vitrine', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa();
    await api().post(`/api/v1/affiliations/${filiacaoA.id}/deactivate`).set(operadorA.auth());

    const r = await pedir(pessoa, pedidoValido(filiacaoA, 5));
    expect(r.status).toBe(422);
  });
});

// ======================= BLOQUEIO 2 — FOTO DO PEDIDO ======================

describe('foto do pedido', () => {
  let pessoa;
  let pedido;

  beforeEach(async () => {
    await abrirAutocadastro(orgA.id);
    pessoa = await cadastrarPessoa('Com Foto');
    const r = await pedir(pessoa, pedidoValido(filiacaoA, 100));
    pedido = r.body;
  });

  it('o dono envia a foto, e ela é normalizada e guardada', async () => {
    const r = await enviarFoto(pessoa, pedido.id, pngValido());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // A RESPOSTA diz que há foto, sem dizer onde ela está.
    expect(r.body.hasPhoto).toBe(true);
    expect(r.body).not.toHaveProperty('photoKey');

    // A chave é sorteada pelo servidor e fica sob o escopo do pedido.
    expect(await chaveDoPedido(pessoa, pedido.id))
      .toMatch(new RegExp(`^athlete-requests/${pedido.id}/[0-9a-f-]{36}\\.webp$`));
  });

  it('sem autenticação não sobe nada', async () => {
    const r = await api().post(`/api/v1/athlete-requests/${pedido.id}/photo`)
      .attach('file', pngValido(), { filename: 'f.png', contentType: 'image/png' });
    expect([401, 403]).toContain(r.status);
  });

  it('outra pessoa não envia foto no pedido alheio — e recebe 404, não 403', async () => {
    const intruso = await cadastrarPessoa('Intruso');
    const r = await enviarFoto(intruso, pedido.id, pngValido());
    // 404 porque confirmar que o id existe já é informação.
    expect(r.status).toBe(404);
    expect((await comoAtor(pessoa, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }))).photoKey).toBeNull();
  });

  it('requestId inexistente ou de outro formato não alcança nada', async () => {
    expect((await enviarFoto(pessoa, 'cl00000000000000000000000', pngValido())).status).toBe(404);
    // Express normaliza o caminho antes de casar a rota: `../../` nunca chega ao
    // parâmetro, e a requisição morre em 400 ou 404 conforme o que sobra.
    expect([400, 404]).toContain((await enviarFoto(pessoa, '../../etc/passwd', pngValido())).status);
  });

  // MEDIDO: HTML e executável são recusados por DUAS camadas independentes —
  // a conferência de assinatura e o sharp, que não decodifica nenhum dos dois.
  // Este teste prova o RESULTADO (nada entra), não qual camada agiu; remover
  // só a conferência de assinatura não o faz falhar, porque o sharp ainda
  // barra. As duas camadas têm teste próprio logo abaixo.
  it('MIME mentiroso é recusado — e nada é gravado', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    const r = await enviarFoto(pessoa, pedido.id, html, 'foto.png', 'image/png');
    expect(r.status).toBe(415);
    expect((await comoAtor(pessoa, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }))).photoKey).toBeNull();
  });

  it('executável renomeado é recusado', async () => {
    const elf = Buffer.concat([Buffer.from([0x7F, 0x45, 0x4C, 0x46]), Buffer.alloc(2048, 1)]);
    expect((await enviarFoto(pessoa, pedido.id, elf, 'foto.png', 'image/png')).status).toBe(415);
  });

  it('SVG e PDF não entram na lista de foto', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
    expect((await enviarFoto(pessoa, pedido.id, svg, 'f.svg', 'image/svg+xml')).status).toBe(415);

    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'ascii'), Buffer.alloc(512, 32)]);
    expect((await enviarFoto(pessoa, pedido.id, pdf, 'f.pdf', 'application/pdf')).status).toBe(415);
  });

  it('arquivo acima do teto é recusado', async () => {
    const gigante = Buffer.concat([pngValido(), Buffer.alloc(12 * 1024 * 1024, 7)]);
    const r = await enviarFoto(pessoa, pedido.id, gigante);
    expect([400, 413, 415]).toContain(r.status);
  });

  it('trocar a foto apaga a anterior, sem deixar órfão', async () => {
    await enviarFoto(pessoa, pedido.id, pngValido());
    const primeira = await chaveDoPedido(pessoa, pedido.id);
    await enviarFoto(pessoa, pedido.id, pngValido(16));
    const segunda = await chaveDoPedido(pessoa, pedido.id);

    expect(segunda).not.toBe(primeira);
    expect(await storage.exists(primeira)).toBe(false);
    expect(await storage.exists(segunda)).toBe(true);
  });

  it('o dono remove a própria foto', async () => {
    await enviarFoto(pessoa, pedido.id, pngValido());
    const chave = await chaveDoPedido(pessoa, pedido.id);
    const r = await api().delete(`/api/v1/athlete-requests/${pedido.id}/photo`).set(pessoa.auth());
    expect(r.status).toBe(200);
    expect(r.body.hasPhoto).toBe(false);

    expect(await storage.exists(chave)).toBe(false);
  });

  it('pedido já decidido não aceita mais foto', async () => {
    await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(pessoa.auth());
    expect((await enviarFoto(pessoa, pedido.id, pngValido())).status).toBe(422);
  });
});

describe('entrega da foto', () => {
  let pessoa;
  let pedido;
  let chave;

  beforeEach(async () => {
    await abrirAutocadastro(orgA.id);
    pessoa = await cadastrarPessoa('Com Foto');
    pedido = (await pedir(pessoa, pedidoValido(filiacaoA, 200))).body;
    await enviarFoto(pessoa, pedido.id, pngValido());
    chave = await chaveDoPedido(pessoa, pedido.id);
  });

  it('o dono e o operador da federação veem a foto', async () => {
    for (const quem of [pessoa, operadorA]) {
      const r = await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(quem.auth());
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.headers['content-type']).toContain('image/webp');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('estranho e operador de OUTRA federação não veem', async () => {
    const estranho = await cadastrarPessoa('Estranho');
    expect([403, 404]).toContain((await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(estranho.auth())).status);

    const orgB = await criarOrganizacao(admin, { name: 'Federação B' });
    const operadorB = await criarUsuario({ name: 'Operador B' });
    await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');
    expect([403, 404]).toContain((await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(operadorB.auth())).status);
  });

  it('sem sessão não entrega', async () => {
    expect([401, 403]).toContain((await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`)).status);
  });

  // A chave NUNCA é parâmetro. Não existe rota que receba objectKey, e por
  // isso não há travessia nem IDOR por troca de chave — só por troca de id, e
  // o id é conferido.
  it('não existe caminho que aceite a chave do objeto', async () => {
    for (const tentativa of [chave, `../../${chave}`, '../../../etc/passwd']) {
      const r = await api().get(`/api/v1/media/athlete-requests/${encodeURIComponent(tentativa)}/photo`).set(pessoa.auth());
      expect([400, 404]).toContain(r.status);
    }
  });
});

// As camadas que barram arquivo falso, medidas SEPARADAMENTE.
//
// Os testes de rota acima provam que nada entra, mas não conseguem dizer qual
// camada agiu: conferência de assinatura e sharp recusam os mesmos arquivos.
// Isolá-las aqui é o que impede uma delas de ser removida em silêncio, com a
// suíte inteira continuando verde por causa da outra.
describe('camadas de recusa de imagem, isoladas', () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
  const elf = Buffer.concat([Buffer.from([0x7F, 0x45, 0x4C, 0x46]), Buffer.alloc(2048, 1)]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>', 'utf8');

  it('a conferência de assinatura recusa bytes que não são do tipo declarado', () => {
    expect(storage.motivoDeRecusaPorAssinatura('image/png', html)).toBeTruthy();
    expect(storage.motivoDeRecusaPorAssinatura('image/png', elf)).toBeTruthy();
    expect(storage.motivoDeRecusaPorAssinatura('image/jpeg', svg)).toBeTruthy();
    // E aceita o que é mesmo um PNG.
    expect(storage.motivoDeRecusaPorAssinatura('image/png', pngValido())).toBeNull();
  });

  it('o sharp recusa o que não decodifica como imagem', async () => {
    for (const [nome, buffer] of [['html', html], ['elf', elf], ['svg', svg]]) {
      await expect(
        imagem.normalizar({ buffer, mimeType: 'image/png' }, 'avatar'),
        `o sharp aceitou ${nome}`
      ).rejects.toMatchObject({ status: 415 });
    }
  });

  it('o tipo declarado fora da lista de avatar nem chega às camadas de bytes', () => {
    expect(storage.isAllowedAvatarMime('image/svg+xml')).toBe(false);
    expect(storage.isAllowedAvatarMime('application/pdf')).toBe(false);
    expect(storage.isAllowedAvatarMime('text/html')).toBe(false);
    expect(storage.isAllowedAvatarMime('image/png')).toBe(true);
    expect(storage.isAllowedAvatarMime('image/jpeg')).toBe(true);
    expect(storage.isAllowedAvatarMime('image/webp')).toBe(true);
  });
});

// Quem realmente barra o acesso ao pedido alheio é a RLS, não a conferência de
// dono na aplicação — MEDIDO: com a conferência removida, o intruso continua
// recebendo 404, porque a linha não existe para ele.
//
// A conferência da aplicação fica como segunda linha e para devolver 404 em
// vez de estourar mais adiante. Este teste trava a camada que de fato protege.
describe('a linha do pedido é invisível para quem não é dono nem operador', () => {
  it('a política de leitura esconde o pedido alheio no próprio banco', async () => {
    await abrirAutocadastro(orgA.id);
    const dono = await cadastrarPessoa('Dono');
    const intruso = await cadastrarPessoa('Intruso');
    const pedido = (await pedir(dono, pedidoValido(filiacaoA, 900))).body;

    const ve = async ator => Boolean(await comoAtor(
      ator, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id }, select: { id: true } })
    ));

    expect(await ve({ id: dono.id }), 'o dono não enxerga o próprio pedido').toBe(true);
    expect(await ve(operadorA), 'o operador da federação não enxerga a fila dele').toBe(true);
    expect(await ve({ id: intruso.id }), 'a RLS deixou o intruso enxergar pedido alheio').toBe(false);
  });
});

// ============================ FLUXO COMPLETO ==============================

describe('de conta nova a atleta aprovado', () => {
  it('fluxo inteiro: vitrine, pedido, foto, análise, aprovação e perfil oficial', async () => {
    await abrirAutocadastro(orgA.id);

    // 1. conta nova
    const pessoa = await cadastrarPessoa('Maria Solicitante');

    // 2. descobre as filiações elegíveis
    const vitrine = await api().get('/api/v1/public/affiliations').set(pessoa.auth());
    expect(vitrine.body.items.map(i => i.id)).toContain(filiacaoA.id);

    // 3. envia o pedido com CPF e número de registro
    const cpf = gerarCpf(987654321);
    const criado = await pedir(pessoa, { ...pedidoValido(filiacaoA, 0), cpf, affiliationNumber: 'NPC-77777' });
    expect(criado.status).toBe(201);
    const pedidoId = criado.body.id;

    // 4. envia a foto
    const comFoto = await enviarFoto(pessoa, pedidoId, pngValido(32));
    expect(comFoto.status).toBe(200);
    expect(comFoto.body.hasPhoto).toBe(true);
    const chaveDaFoto = await chaveDoPedido(pessoa, pedidoId);

    // 5. o operador vê o pedido na fila, SEM CPF na listagem
    const fila = await api().get('/api/v1/athlete-requests').set(operadorA.auth());
    expect(fila.body.items).toHaveLength(1);
    expect(JSON.stringify(fila.body)).not.toContain(cpf.replace(/\D/g, ''));

    // 6. abre para análise: aí sim o CPF, e a foto
    const analise = await api().get(`/api/v1/athlete-requests/${pedidoId}`).set(operadorA.auth());
    expect(analise.body.cpf).toBe(cpf.replace(/\D/g, ''));
    expect(analise.body.hasPhoto).toBe(true);
    expect(analise.body, 'a análise devolveu a chave do armazenamento').not.toHaveProperty('photoKey');
    expect((await api().get(`/api/v1/media/athlete-requests/${pedidoId}/photo`).set(operadorA.auth())).status).toBe(200);

    // 7. aprova
    const aprovado = await api().post(`/api/v1/athlete-requests/${pedidoId}/approve`).set(operadorA.auth()).send({});
    expect(aprovado.status, JSON.stringify(aprovado.body)).toBe(200);
    expect(aprovado.body.status).toBe('APPROVED');
    expect(aprovado.body.cpf).toBeUndefined();

    // 8. Athlete + AthleteIdentity nasceram, com a foto e o CPF no lugar certo
    const athleteId = aprovado.body.athleteId;
    const athlete = await comoAtor(operadorA, () => prisma.athlete.findUnique({ where: { id: athleteId } }));
    expect(athlete.fullName).toBe('Atleta Solicitante');
    expect(athlete.affiliationNumber).toBe('NPC-77777');
    expect(athlete.photoKey).toBe(chaveDaFoto);
    expect(athlete.userId).toBe(pessoa.id);

    const identidade = await comoAtor(operadorA, () => prisma.athleteIdentity.findFirst({ where: { athleteId } }));
    expect(identidade.cpf).toBe(cpf.replace(/\D/g, ''));

    // o CPF saiu do pedido: ele vive em AthleteIdentity agora
    expect((await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedidoId } }))).cpf).toBeNull();

    // 9. a foto do atleta é servida — a rota que faltava. `Athlete.photoKey`
    // era lido em sete lugares e NENHUMA rota o servia: a foto era gravada e
    // nunca aparecia.
    const fotoOficial = await api().get(`/api/v1/media/athletes/${athleteId}/photo`).set(pessoa.auth());
    expect(fotoOficial.status, JSON.stringify(fotoOficial.body)).toBe(200);
    expect(fotoOficial.headers['content-type']).toContain('image/webp');

    // E exige sessão. A foto foi enviada para a federação CONFERIR identidade;
    // servi-la a visitante anônimo seria publicar retrato de atleta por
    // decisão de quem escreveu a rota. Se a decisão de produto for publicar,
    // muda-se aqui e na lista de rotas públicas — de propósito.
    expect([401, 403]).toContain((await api().get(`/api/v1/media/athletes/${athleteId}/photo`)).status);
  });

  it('recusa: o pedido guarda o motivo, e a foto NÃO fica órfã', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa('Recusada');
    const pedidoId = (await pedir(pessoa, pedidoValido(filiacaoA, 555))).body.id;
    await enviarFoto(pessoa, pedidoId, pngValido());
    const chave = await chaveDoPedido(pessoa, pedidoId);

    expect(await storage.exists(chave)).toBe(true);

    const r = await api().post(`/api/v1/athlete-requests/${pedidoId}/reject`).set(operadorA.auth())
      .send({ reason: 'Número de registro não confere' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    expect(r.body.rejectionReason).toBe('Número de registro não confere');

    // A linha fica para histórico; o arquivo não.
    expect(await storage.exists(chave), 'a foto do pedido recusado continuou no armazenamento').toBe(false);
    const linha = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedidoId } }));
    expect(linha.photoKey).toBeNull();
    expect(linha.cpf).toBeNull();
    // `count` sem ator devolveria 0 mesmo com atleta criado: RLS esconde a
    // linha, e a asserção passaria provando nada.
    expect(await comoAtor(operadorA, () => prisma.athlete.count())).toBe(0);
  });

  it('cancelamento também não deixa arquivo para trás', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa('Desistente');
    const pedidoId = (await pedir(pessoa, pedidoValido(filiacaoA, 666))).body.id;
    await enviarFoto(pessoa, pedidoId, pngValido());
    const chave = await chaveDoPedido(pessoa, pedidoId);

    await api().post(`/api/v1/athlete-requests/${pedidoId}/cancel`).set(pessoa.auth());

    expect(await storage.exists(chave)).toBe(false);
  });
});

// ========================= FALHA DO ARMAZENAMENTO =========================
//
// O provedor pode falhar ou perder o objeto — R2 fora, credencial vencida,
// arquivo apagado por engano numa varredura. O que não pode acontecer é o
// BANCO ficar incoerente: um pedido apontando para arquivo inexistente
// servindo imagem quebrada, ou um objeto ainda alcançável depois de o pedido
// ter sido encerrado.
//
// A falha é provocada NO ARMAZENAMENTO DE VERDADE — apagando o objeto por
// fora — e não por injeção no módulo. Duas tentativas de injetar falharam e
// vale registrar por quê: `{ ...instancia }` não copia métodos de protótipo, e
// trocar o protótipo tampouco alcança a aplicação, porque ela roda no grafo
// CommonJS e o teste importa por ESM — são duas instâncias do mesmo módulo.
// Apagar o arquivo atravessa qualquer grafo.
describe('o armazenamento falha', () => {
  let pessoa;
  let pedido;
  let chave;

  beforeEach(async () => {
    await abrirAutocadastro(orgA.id);
    pessoa = await cadastrarPessoa('Com Falha');
    pedido = (await pedir(pessoa, pedidoValido(filiacaoA, 4242))).body;
    await enviarFoto(pessoa, pedido.id, pngValido());
    chave = await chaveDoPedido(pessoa, pedido.id);
    expect(await storage.exists(chave)).toBe(true);
  });

  it('objeto sumiu do armazenamento: a entrega responde 404, e não imagem quebrada', async () => {
    await storage.remove(chave);
    expect(await storage.exists(chave)).toBe(false);

    // A linha AINDA aponta para a chave — é exatamente o estado incoerente que
    // acontece quando alguém apaga o objeto por fora.
    expect(await chaveDoPedido(pessoa, pedido.id)).toBe(chave);

    for (const quem of [pessoa, operadorA]) {
      const r = await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(quem.auth());
      expect(r.status, 'faltando o arquivo, a entrega precisa ser 404 — não 500 nem stream quebrado').toBe(404);
    }
  });

  it('depois da falha, reenviar a foto conserta — e a chave antiga não volta', async () => {
    await storage.remove(chave);

    const nova = await enviarFoto(pessoa, pedido.id, pngValido(16));
    expect(nova.status).toBe(200);
    expect(nova.body.hasPhoto).toBe(true);

    const chaveNova = await chaveDoPedido(pessoa, pedido.id);
    expect(chaveNova).not.toBe(chave);
    expect(await storage.exists(chaveNova)).toBe(true);
    expect((await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(pessoa.auth())).status).toBe(200);
  });

  // O descarte na recusa vai falhar (o objeto já não existe). A decisão do
  // operador não pode ser desfeita por causa disso.
  it('recusa com objeto já ausente: a decisão vale e o banco fica coerente', async () => {
    await storage.remove(chave);

    const recusa = await api().post(`/api/v1/athlete-requests/${pedido.id}/reject`).set(operadorA.auth())
      .send({ reason: 'Documento ilegível' });

    expect(recusa.status, JSON.stringify(recusa.body)).toBe(200);
    expect(recusa.body.status).toBe('REJECTED');
    expect(recusa.body.hasPhoto).toBe(false);

    const linha = await comoAtor(operadorA, () => prisma.athleteProfileRequest.findUnique({ where: { id: pedido.id } }));
    expect(linha.photoKey, 'a linha continuou apontando para um objeto que não existe').toBeNull();
    expect(linha.cpf).toBeNull();
    expect(await comoAtor(operadorA, () => prisma.athlete.count())).toBe(0);
  });

  // Órfão de verdade: a linha deixa de apontar e o arquivo fica. Ninguém o
  // alcança, porque a entrega passa SEMPRE pela linha.
  it('objeto que sobra depois do encerramento fica inalcançável por qualquer um', async () => {
    await api().post(`/api/v1/athlete-requests/${pedido.id}/cancel`).set(pessoa.auth());

    // Recria o arquivo no lugar exato, simulando o descarte que não aconteceu.
    await storage.saveBuffer(chave, pngValido());
    expect(await storage.exists(chave)).toBe(true);

    const estranho = await cadastrarPessoa('Estranho');
    for (const quem of [pessoa, operadorA, estranho]) {
      const r = await api().get(`/api/v1/media/athlete-requests/${pedido.id}/photo`).set(quem.auth());
      expect([403, 404], 'um objeto órfão ficou alcançável pela API').toContain(r.status);
    }

    await storage.descartar(chave, { motivo: 'limpeza do teste' });
  });

  it('`descartar` nunca lança — nem no ausente, nem num erro real do provedor', async () => {
    // Ausente é o caso fácil: o provedor já devolve `false` em ENOENT.
    await expect(storage.descartar('athlete-requests/nao-existe/aaaa.webp')).resolves.toBe(false);

    // Erro REAL, e não simulado: apagar um DIRETÓRIO levanta EISDIR, que o
    // provedor deixa subir. É o comportamento que `descartar` tem de engolir —
    // quem a chama já terminou a operação de negócio e está coerente; lançar
    // aqui desfaria uma decisão já tomada.
    //
    // Vale registrar por que não é um dublê: a aplicação roda no grafo
    // CommonJS e o teste importa por ESM, então trocar o protótipo daqui não
    // alcança o provedor que o serviço usa. Um erro de verdade alcança.
    const chaveDeDiretorio = 'athlete-requests/eisdir-teste/pasta.webp';
    await fsp.mkdir(storage.resolveKey(chaveDeDiretorio), { recursive: true });
    try {
      await expect(storage.descartar(chaveDeDiretorio, { motivo: 'teste' })).resolves.toBe(false);
    } finally {
      await fsp.rm(storage.resolveKey(chaveDeDiretorio), { recursive: true, force: true });
    }
  });
});
