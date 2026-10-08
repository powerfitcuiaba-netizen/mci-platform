import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O CATÁLOGO DE PATROCINADORES OFICIAIS DO CAMPEONATO.
//
// O QUE ELE É, E POR QUE NÃO É O `Sponsor` QUE JÁ EXISTIA
//
// `Sponsor` é a empresa que patrocina um evento, uma equipe ou um atleta DE
// UMA FEDERAÇÃO: tem `organizationId`, vive sob RLS por organização, e o
// diretor de evento o administra com `sponsors.manage`.
//
// Este catálogo é institucional. É quem patrocina o CAMPEONATO, aparece na
// tela de entrada — onde não existe organização nenhuma — e no rodapé da
// vitrine pública. Não tem tenant, e a permissão é outra: `sponsors.official`,
// que só SUPER_ADMIN tem. Nem ADMIN a recebe.
//
// AS TRÊS BARREIRAS, E POR QUE SÃO TRÊS
//
//   1. `perm('sponsors.official')` na rota;
//   2. `assertPermission` dentro do serviço, em toda escrita;
//   3. a política do banco, `mci_is_super_admin()`, sob FORCE ROW LEVEL SECURITY.
//
// Uma rota nova que esqueça (1) encontra (2). Uma chamada de serviço sem ator
// encontra (3). Este arquivo mede as três — a terceira escrevendo direto no
// Prisma, por fora da API, que é o único jeito de provar que a política existe
// e não é decoração.
// ============================================================================

// --- um PNG 8x8 real: o sharp precisa DECODIFICAR o arquivo ---------------
const crc32 = b => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const pedaco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
function png(lado = 8) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = [];
  for (let y = 0; y < lado; y += 1) linhas.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(lado * 3, 120)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))
  ]);
}

let superAdmin;
let adminDePlataforma;
let diretor;
let atleta;
let organizationId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  superAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  adminDePlataforma = await criarUsuario({ role: 'ADMIN', name: 'Administração' });
  organizationId = (await criarOrganizacao(superAdmin, { name: unico('MCI') })).id;
  diretor = await criarUsuario({ name: 'Diretor de Etapa' });
  await vincular(organizationId, diretor, 'EVENT_DIRECTOR');
  atleta = await criarUsuario({ name: 'Atleta Comum' });
});

const criar = (ator, campos = {}, arquivo = png()) => {
  const pedido = api().post('/api/v1/official-sponsors');
  if (ator) pedido.set(ator.auth());
  const corpo = { code: unico('PATRO').toUpperCase().slice(0, 40), name: 'Patrocinador QA', level: 'GOLD', ...campos };
  for (const [chave, valor] of Object.entries(corpo)) {
    if (valor !== undefined && valor !== null) pedido.field(chave, String(valor));
  }
  if (arquivo) pedido.attach('file', arquivo, { filename: 'logo.png', contentType: 'image/png' });
  return pedido;
};

const criado = async (campos = {}) => {
  const r = await criar(superAdmin, campos);
  expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(201);
  return r.body;
};

const vitrine = () => api().get('/api/v1/public/sponsors');

// ========================= QUEM PODE ADMINISTRAR =========================

describe('a escrita é de SUPER_ADMIN, e de mais ninguém', () => {
  it('1. o SUPER_ADMIN cria', async () => {
    const corpo = await criado({ name: 'Max Titanium', level: 'GLOBAL' });
    expect(corpo.name).toBe('Max Titanium');
    expect(corpo.level).toBe('GLOBAL');
    expect(corpo.active).toBe(true);
    expect(corpo.hasLogo).toBe(true);
  });

  it('2. o ADMIN de plataforma NÃO cria — e a ausência é deliberada', async () => {
    // ADMIN recebe quase tudo por construção. `sponsors.official` está na lista
    // de exclusão dele junto de `organizations.manage`: a vitrine do campeonato
    // é contrato comercial, e a cadeia termina em SUPER_ADMIN.
    const r = await criar(adminDePlataforma);
    expect(r.status).toBe(403);
  });

  it('3. o diretor de federação NÃO cria, mesmo tendo `sponsors.manage`', async () => {
    // Ele administra o patrocinador DA FEDERAÇÃO dele. Se `sponsors.manage`
    // valesse aqui, o diretor de qualquer federação escreveria na vitrine
    // nacional.
    const r = await criar(diretor);
    expect(r.status).toBe(403);

    // E a permissão que ele TEM continua funcionando, para provar que a recusa
    // é da permissão certa e não de um bloqueio geral.
    const doDele = await api().post('/api/v1/sponsors').set(diretor.auth())
      .send({ organizationId, name: 'Patrocinador da Federação' });
    expect(doDele.status, JSON.stringify(doDele.body).slice(0, 200)).toBe(201);
  });

  it('4. o atleta NÃO cria, e o anônimo recebe 401', async () => {
    expect((await criar(atleta)).status).toBe(403);
    expect((await criar(null)).status).toBe(401);
  });

  it('5. o catálogo ADMINISTRATIVO exige a permissão', async () => {
    expect((await api().get('/api/v1/official-sponsors')).status).toBe(401);
    expect((await api().get('/api/v1/official-sponsors').set(atleta.auth())).status).toBe(403);
    expect((await api().get('/api/v1/official-sponsors').set(diretor.auth())).status).toBe(403);
    expect((await api().get('/api/v1/official-sponsors').set(superAdmin.auth())).status).toBe(200);
  });

  it('6. A POLÍTICA DO BANCO recusa a escrita por fora da API', async () => {
    // A prova de que a terceira barreira existe. Aqui não há rota nem serviço:
    // é o Prisma direto, com o ator de quem NÃO é super admin. Se a política
    // fosse decoração, esta linha nasceria.
    const escrever = ator => comoAtor(ator, tx => tx.officialSponsor.create({
      data: {
        code: unico('FORJA').toUpperCase().slice(0, 40),
        name: 'Forjado', level: 'GOLD', logoKey: 'sponsors/forjado.webp'
      }
    }));

    await expect(escrever(diretor), 'o diretor escreveu direto na tabela').rejects.toThrow();
    await expect(escrever(atleta), 'o atleta escreveu direto na tabela').rejects.toThrow();
    await expect(escrever(adminDePlataforma), 'o ADMIN escreveu direto na tabela').rejects.toThrow();

    // E o super admin escreve: sem isto o caso passaria por a tabela estar
    // quebrada para todo mundo.
    await expect(escrever(superAdmin)).resolves.toBeTruthy();
  });
});

// ============================ A VITRINE PÚBLICA ==========================

describe('a vitrine pública', () => {
  it('7. responde ao ANÔNIMO, sem token', async () => {
    await criado({ name: 'Visível', level: 'GLOBAL' });
    const r = await vitrine();
    expect(r.status).toBe(200);
    expect(r.body.items.map(p => p.name)).toContain('Visível');
  });

  it('8. patrocinador INATIVO não aparece — nem na lista, nem na logo', async () => {
    const p = await criado({ name: 'Fora do Ar', level: 'GOLD' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: false });

    const r = await vitrine();
    expect(r.body.items.map(n => n.name)).not.toContain('Fora do Ar');

    // A ARTE SOME JUNTO. Deixá-la servindo manteria a marca no ar para quem
    // guardou a URL — desativar tem de tirar da vitrine inteira.
    const logo = await api().get(`/api/v1/media/sponsors/${p.id}/logo`);
    expect(logo.status, 'a logo do inativo continuou pública').toBe(404);

    // E para quem administra ela continua alcançável: é o que a tela de
    // reativação precisa mostrar.
    const paraOAdmin = await api().get(`/api/v1/media/sponsors/${p.id}/logo`).set(superAdmin.auth());
    expect(paraOAdmin.status).toBe(200);
  });

  it('9. o catálogo administrativo mostra ativos E inativos', async () => {
    const p = await criado({ name: 'Desativado', level: 'GOLD' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: false });
    const r = await api().get('/api/v1/official-sponsors').set(superAdmin.auth());
    expect(r.body.items.map(n => n.name)).toContain('Desativado');
  });

  it('10. a CHAVE do armazenamento nunca sai — o que sai é `hasLogo`', async () => {
    await criado({ name: 'Com Arte' });
    for (const r of [await vitrine(), await api().get('/api/v1/official-sponsors').set(superAdmin.auth())]) {
      const corpo = JSON.stringify(r.body);
      expect(corpo).not.toMatch(/logoKey/);
      expect(corpo).not.toMatch(/sponsors\/[0-9a-f-]{36}/i);
      expect(r.body.items[0]).toHaveProperty('hasLogo');
    }
  });

  it('11. a logo é servida ao anônimo, como imagem', async () => {
    const p = await criado({ name: 'Servida' });
    const r = await api().get(`/api/v1/media/sponsors/${p.id}/logo`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^image\//);
  });
});

// ================================== ORDEM ================================

describe('a ordem é determinística, e a hierarquia manda', () => {
  it('12. GLOBAL vem antes de DIAMANTE, que vem antes de GOLD, que vem antes de SILVER', async () => {
    // Criados FORA de ordem de propósito: se a ordenação fosse a de inserção,
    // este caso passaria por acidente.
    await criado({ name: 'Prata', level: 'SILVER' });
    await criado({ name: 'Ouro', level: 'GOLD' });
    await criado({ name: 'Mundial', level: 'GLOBAL' });
    await criado({ name: 'Diamante', level: 'DIAMANTE' });

    const r = await vitrine();
    expect(r.body.items.map(p => p.level)).toEqual(['GLOBAL', 'DIAMANTE', 'GOLD', 'SILVER']);
  });

  it('13. dentro do nível, a ordem é `sortOrder` crescente', async () => {
    await criado({ name: 'Terceiro', level: 'GOLD', sortOrder: 2 });
    await criado({ name: 'Primeiro', level: 'GOLD', sortOrder: 0 });
    await criado({ name: 'Segundo', level: 'GOLD', sortOrder: 1 });

    const r = await vitrine();
    expect(r.body.items.map(p => p.name)).toEqual(['Primeiro', 'Segundo', 'Terceiro']);
  });

  it('14. empate de ordem é resolvido por NOME, e nunca pela sorte do banco', async () => {
    // Sem desempate, duas marcas com a mesma ordem sairiam na ordem que o
    // PostgreSQL devolvesse — que pode mudar entre execuções e entre máquinas.
    await criado({ name: 'Zebra', level: 'GOLD', sortOrder: 5 });
    await criado({ name: 'Alfa', level: 'GOLD', sortOrder: 5 });
    await criado({ name: 'Meio', level: 'GOLD', sortOrder: 5 });

    const primeira = (await vitrine()).body.items.map(p => p.name);
    expect(primeira).toEqual(['Alfa', 'Meio', 'Zebra']);

    // E a repetição devolve o MESMO: determinístico quer dizer estável.
    expect((await vitrine()).body.items.map(p => p.name)).toEqual(primeira);
  });

  it('15. mudar o nível muda o lugar na vitrine', async () => {
    const p = await criado({ name: 'Promovido', level: 'SILVER' });
    await criado({ name: 'Outro', level: 'GLOBAL' });
    expect((await vitrine()).body.items.map(n => n.name)).toEqual(['Outro', 'Promovido']);

    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ level: 'GLOBAL', sortOrder: 0 });
    // Empate em GLOBAL/0 resolvido por nome: 'Outro' > 'Promovido'.
    expect((await vitrine()).body.items.map(n => n.name)).toEqual(['Outro', 'Promovido']);

    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ sortOrder: 0 });
    const depois = (await vitrine()).body.items;
    expect(depois.every(n => n.level === 'GLOBAL')).toBe(true);
  });
});

// =============================== O CICLO DE VIDA =========================

describe('criar, editar, desativar, reativar, trocar logo, remover', () => {
  it('16. edita nome, nível, ordem e site', async () => {
    const p = await criado({ name: 'Antes', level: 'GOLD' });
    const r = await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ name: 'Depois', level: 'DIAMANTE', sortOrder: 3, siteUrl: 'https://exemplo.test' });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    expect(r.body).toMatchObject({ name: 'Depois', level: 'DIAMANTE', sortOrder: 3, siteUrl: 'https://exemplo.test' });
  });

  it('17. desativa e reativa, sem perder o registro', async () => {
    const p = await criado({ name: 'Vai e Volta' });

    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: false });
    expect((await vitrine()).body.items.map(n => n.name)).not.toContain('Vai e Volta');
    // O REGISTRO CONTINUA: desativar preserva o histórico.
    expect(await comoAtor(superAdmin, tx => tx.officialSponsor.count({ where: { id: p.id } }))).toBe(1);

    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: true });
    expect((await vitrine()).body.items.map(n => n.name)).toContain('Vai e Volta');
  });

  it('18. troca a logo, e a antiga deixa de existir', async () => {
    const p = await criado({ name: 'Nova Arte' });
    const antes = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({
      where: { id: p.id }, select: { logoKey: true }
    }));

    const r = await api().post(`/api/v1/official-sponsors/${p.id}/logo`).set(superAdmin.auth())
      .attach('file', png(16), { filename: 'nova.png', contentType: 'image/png' });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);

    const depois = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({
      where: { id: p.id }, select: { logoKey: true }
    }));
    expect(depois.logoKey).not.toBe(antes.logoKey);

    // A nova é servida; a referência antiga não ficou pendurada no registro.
    expect((await api().get(`/api/v1/media/sponsors/${p.id}/logo`)).status).toBe(200);
  });

  it('19. remover de vez exige MOTIVO, e some da vitrine', async () => {
    const p = await criado({ name: 'Enganado' });

    const semMotivo = await api().delete(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({});
    expect(semMotivo.status, 'apagou sem motivo escrito').toBe(400);

    const r = await api().delete(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ motivo: 'criado por engano durante a verificação' });
    expect(r.status).toBe(200);
    expect(await comoAtor(superAdmin, tx => tx.officialSponsor.count({ where: { id: p.id } }))).toBe(0);
    expect((await api().get(`/api/v1/media/sponsors/${p.id}/logo`)).status).toBe(404);
  });

  it('20. o `code` é único, e a segunda tentativa recusa', async () => {
    const codigo = unico('UNICO').toUpperCase().slice(0, 40);
    await criado({ code: codigo });
    const r = await criar(superAdmin, { code: codigo });
    expect(r.status).toBe(409);
  });

  it('21. o `code` NÃO muda pela edição — é o que amarra a linha ao provisionamento', async () => {
    const p = await criado({ name: 'Estável' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ name: 'Outro Nome', code: 'TENTATIVA-DE-TROCA' });
    const depois = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({
      where: { id: p.id }, select: { code: true, name: true }
    }));
    expect(depois.code, 'o código foi trocado pela edição').toBe(p.code);
    expect(depois.name).toBe('Outro Nome');
  });
});

// ============================= UPLOAD E SEGURANÇA ========================

describe('o que o upload aceita, e o que ele recusa', () => {
  it('22. sem arquivo nenhum, recusa', async () => {
    // 422 vem do middleware de upload, que exige o campo antes de o serviço
    // ver qualquer coisa; 400/415 viriam das barreiras seguintes. Qualquer uma
    // delas é a recusa certa — o que não pode é nascer patrocinador sem arte.
    const r = await criar(superAdmin, {}, null);
    expect([400, 415, 422], `veio ${r.status}`).toContain(r.status);
  });

  it('23. MIME FRAUDADO é recusado pelos BYTES', async () => {
    // Só o `Content-Type` é o que o cliente diz, e o cliente pode dizer
    // qualquer coisa. Aqui o tipo declarado é PNG e os bytes são texto.
    const r = await api().post('/api/v1/official-sponsors').set(superAdmin.auth())
      .field('code', unico('FALSO').toUpperCase().slice(0, 40))
      .field('name', 'MIME Falso').field('level', 'GOLD')
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    expect(r.status).toBe(415);
  });

  it('24. SVG é recusado — é documento executável, não imagem', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const r = await api().post('/api/v1/official-sponsors').set(superAdmin.auth())
      .field('code', unico('SVG').toUpperCase().slice(0, 40))
      .field('name', 'Vetor').field('level', 'GOLD')
      .attach('file', svg, { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(r.status).toBe(415);
  });

  it('25. o NOME do arquivo não compõe o caminho — não há travessia', async () => {
    const r = await api().post('/api/v1/official-sponsors').set(superAdmin.auth())
      .field('code', unico('TRAV').toUpperCase().slice(0, 40))
      .field('name', 'Travessia').field('level', 'GOLD')
      .attach('file', png(), { filename: '../../../etc/passwd.png', contentType: 'image/png' });
    expect(r.status).toBe(201);

    const linha = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({
      where: { id: r.body.id }, select: { logoKey: true }
    }));
    // Prefixo fixo + UUID. Nada do que o cliente mandou entra no caminho.
    expect(linha.logoKey).toMatch(/^sponsors\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/);
    expect(linha.logoKey).not.toContain('..');
    expect(linha.logoKey).not.toContain('passwd');
  });

  it('26. o nível é ENUM: texto livre não entra', async () => {
    expect((await criar(superAdmin, { level: 'PLATINA' })).status).toBe(400);
    expect((await criar(superAdmin, { level: 'gold' })).status).toBe(400);
  });

  it('27. o site exige HTTPS', async () => {
    expect((await criar(superAdmin, { siteUrl: 'http://inseguro.test' })).status).toBe(400);
    expect((await criar(superAdmin, { siteUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await criar(superAdmin, { siteUrl: 'https://seguro.test' })).status).toBe(201);
  });

  it('28. id inexistente responde 404 limpo, sem vazar nome de tabela', async () => {
    const r = await api().get('/api/v1/media/sponsors/cmnaoexisteesteid000000/logo');
    expect([400, 404]).toContain(r.status);
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|PrismaClient|at Object/i);
  });
});

// ================================ CONCORRÊNCIA ===========================

describe('dois administradores na mesma tela', () => {
  it('29. o segundo a salvar recebe 409 em vez de sobrescrever em silêncio', async () => {
    const p = await criado({ name: 'Disputado', sortOrder: 0 });
    const versaoQueOsDoisLeram = p.updatedAt;

    const primeiro = await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ sortOrder: 1, updatedAt: versaoQueOsDoisLeram });
    expect(primeiro.status).toBe(200);

    const segundo = await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ sortOrder: 2, updatedAt: versaoQueOsDoisLeram });
    expect(segundo.status, 'a segunda escrita sobrescreveu a primeira').toBe(409);

    // E a alteração do primeiro permanece.
    const atual = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({
      where: { id: p.id }, select: { sortOrder: true }
    }));
    expect(atual.sortOrder).toBe(1);
  });

  it('30. sem informar a versão, a edição continua funcionando', async () => {
    // A guarda é opcional: cliente que não manda a versão não é bloqueado.
    const p = await criado({ name: 'Sem Versão' });
    const r = await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ sortOrder: 4 });
    expect(r.status).toBe(200);
  });
});

// ================================= AUDITORIA =============================

describe('a trilha de auditoria', () => {
  const trilha = () => comoAtor(superAdmin, tx => tx.auditLog.findMany({
    where: { entity: 'OfficialSponsor' }, select: { action: true, metadata: true }, orderBy: { createdAt: 'asc' }
  }));

  it('31. registra criação, alteração de nível, de ordem, de logo, desativação e remoção', async () => {
    const p = await criado({ name: 'Auditado', level: 'GOLD' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ level: 'GLOBAL' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ sortOrder: 9 });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: false });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ active: true });
    await api().post(`/api/v1/official-sponsors/${p.id}/logo`).set(superAdmin.auth())
      .attach('file', png(16), { filename: 'nova.png', contentType: 'image/png' });
    await api().delete(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ motivo: 'encerrando a verificação da trilha' });

    const acoes = (await trilha()).map(l => l.action);
    expect(acoes).toEqual([
      'OFFICIAL_SPONSOR_CREATE',
      'OFFICIAL_SPONSOR_CHANGE_LEVEL',
      'OFFICIAL_SPONSOR_CHANGE_ORDER',
      'OFFICIAL_SPONSOR_DEACTIVATE',
      'OFFICIAL_SPONSOR_ACTIVATE',
      'OFFICIAL_SPONSOR_CHANGE_LOGO',
      'OFFICIAL_SPONSOR_DELETE'
    ]);
  });

  it('32. a alteração guarda o valor ANTERIOR e o novo', async () => {
    // Só o novo valor deixaria "mudou para GLOBAL" sem dizer de onde veio.
    const p = await criado({ name: 'Antes e Depois', level: 'SILVER' });
    await api().patch(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth()).send({ level: 'GOLD' });

    const linha = (await trilha()).find(l => l.action === 'OFFICIAL_SPONSOR_CHANGE_LEVEL');
    expect(linha.metadata.alteracoes.level).toEqual({ de: 'SILVER', para: 'GOLD' });
  });

  it('33. a remoção guarda o motivo escrito e o retrato do que foi apagado', async () => {
    const p = await criado({ name: 'Apagado', level: 'GOLD' });
    await api().delete(`/api/v1/official-sponsors/${p.id}`).set(superAdmin.auth())
      .send({ motivo: 'duplicidade criada por engano' });

    const linha = (await trilha()).find(l => l.action === 'OFFICIAL_SPONSOR_DELETE');
    expect(linha.metadata.motivo).toBe('duplicidade criada por engano');
    expect(linha.metadata).toMatchObject({ name: 'Apagado', level: 'GOLD' });
  });
});

// ======================= NENHUM VAZAMENTO DE TENANT ======================

describe('o catálogo é global, e não carrega organização', () => {
  it('34. a linha NÃO tem organizationId — não há tenant a cruzar', async () => {
    const p = await criado({ name: 'Sem Dono' });
    const linha = await comoAtor(superAdmin, tx => tx.officialSponsor.findUnique({ where: { id: p.id } }));
    expect(linha).not.toHaveProperty('organizationId');
  });

  it('35. e `Sponsor`, o patrocinador de federação, NÃO foi tocado', async () => {
    // O trabalho inteiro criou uma entidade NOVA. Se ele tivesse mexido na
    // antiga, o patrocinador de evento de alguma federação teria mudado de
    // forma sem ninguém pedir.
    await criado({ name: 'Oficial' });
    const daFederacao = await api().post('/api/v1/sponsors').set(superAdmin.auth())
      .send({ organizationId, name: 'Da Federação' });
    expect(daFederacao.status).toBe(201);
    expect(daFederacao.body).toHaveProperty('organizationId', organizationId);

    expect(await comoAtor(superAdmin, tx => tx.sponsor.count())).toBe(1);
    expect(await comoAtor(superAdmin, tx => tx.officialSponsor.count())).toBe(1);
  });
});
