import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, criarEventoCompleto, transicionar,
  gerarCpf, unico, comoAtor, pedirPerfilDeAtleta } from './helpers.mjs';
import storage from '../src/services/storageService.js';

// ============================================================================
// PRIVACIDADE DA VITRINE — O QUE O ANÔNIMO ALCANÇA, E O QUE ELE NÃO ALCANÇA.
//
// POR QUE ESTE ARQUIVO EXISTE
//
// A foto do atleta passou a ser pública e o invólucro do frontend passou a
// deixar o visitante entrar sem sessão. Duas aberturas na mesma rodada, as
// duas sobre a MESMA pessoa física. A pergunta deixou de ser "o ranking está
// certo?" e passou a ser "o que mais saiu junto?".
//
// A classificação do escopo (§52) é a régua:
//
//   PÚBLICO     nome, nome esportivo, cidade/estado, equipe, filiação,
//               categoria, colocação, pontos, títulos, foto de competição
//   RESTRITO    CPF, telefone, e-mail, data de nascimento, endereço
//   ADMIN       auditoria, papéis, importações, pedidos de cadastro
//
// Este arquivo mede as três faixas pelas rotas que o visitante de fato chama,
// e mede o IDOR de cada rota de mídia que a rodada tocou.
//
// O ACHADO QUE ELE FECHA
//
// `POST /athlete-requests` aceitava `photoKey` no corpo. Medido nesta máquina,
// antes da correção: um pedido criado com
// `photoKey: 'athletes/documento-de-outra-pessoa.pdf'` guardava a string, a
// conclusão automática a copiava para `Athlete.photoKey`, e
// `GET /media/athletes/:id/photo` — agora ANÔNIMA — passava a servir aquele
// objeto. Quem escolhia o caminho dentro do bucket era o cliente.
//
// A travessia de diretório já era barrada no provedor, então nada FORA da raiz
// era alcançável. O que era alcançável era qualquer objeto DENTRO dela cuja
// chave se conhecesse, publicado por uma rota aberta. O caso 11 trava a porta
// e o caso 13 prova que a barreira do provedor continua de pé.
//
// O QUE ESTE ARQUIVO NÃO MEDE, E POR QUÊ
//
// Chave de armazenamento em corpo de resposta: já é peneirada em qualquer
// profundidade por `tests/vazamento-de-storage.test.mjs`. Projeção do ranking
// público: `tests/gate-superficie-publica.test.mjs`. Repetir aqui só duplicaria
// a mesma asserção em dois lugares que podem divergir.
// ============================================================================

// Dado RESTRITO que existe no banco e não pode sair por rota pública nenhuma.
// Os valores são fixos de propósito: a peneira procura o VALOR, não o nome do
// campo. Um `select` novo que renomeie a coluna e continue devolvendo o número
// quebra aqui do mesmo jeito.
const TELEFONE = '65999990001';
const EMAIL_PESSOAL = 'contato.restrito@mci.test';
const NASCIMENTO = '1991-02-03';
const CEP = '78000123';
const LOGRADOURO = 'Rua Reservada';

const CAMPOS_RESTRITOS = [
  'cpf', 'cpfMasked', 'phone', 'whatsapp', 'email', 'birthDate',
  'postalCode', 'addressLine', 'addressNumber', 'passwordHash',
  // Administrativo: nada disso tem leitor na vitrine.
  'createdById', 'reviewedById', 'userId', 'auditLog',
  'affiliationNumber', 'identity'
];

// `organizationId` NÃO ESTÁ NA LISTA, e a ausência foi medida: a rota pública
// do resultado da classe devolve `event.organizationId`, e ela é a federação
// DONA do evento — fato público, já exposto como objeto `organization` na
// página da etapa. Proibi-la aqui só produziria falso positivo.
//
// O que o atleta pode carregar é outra conversa: ali a lista é FECHADA, porque
// `Athlete` é a entidade que guarda pessoa física. É o que a peneira abaixo
// mede.
const CAMPOS_DO_ATLETA_NA_VITRINE = [
  'id', 'fullName', 'stageName', 'sex', 'country', 'state', 'city',
  'hasPhoto', 'athleteNumber', 'proStatus', 'proSince',
  'team', 'coach', 'gym', 'affiliation', 'createdAt',
  // `socialProfile` só vem na página do atleta, e é a rede social da
  // plataforma: handle, nome de exibição, bio e `isPrivate`. A regra de
  // `isPrivate` é do produto social e vale igual em `socialService`: ela
  // esconde o CONTEÚDO (publicações), não a existência do perfil.
  'socialProfile'
];

/**
 * Acha qualquer objeto com CARA de atleta e confere o conjunto de chaves.
 *
 * Procura pela forma, e não pelo nome do campo que o contém: `athlete`,
 * `items[].athlete`, `entries[].athlete` e um atleta solto na raiz caem todos
 * na mesma peneira. Um `include` novo que puxe a linha crua do Prisma quebra
 * aqui, inclusive quando o campo novo ainda não tem nome proibido.
 */
function acharCampoNovoNoAtleta(valor, caminho = '$') {
  if (valor === null || typeof valor !== 'object') return null;
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = acharCampoNovoNoAtleta(valor[i], `${caminho}[${i}]`);
      if (achado) return achado;
    }
    return null;
  }
  const temCaraDeAtleta = typeof valor.fullName === 'string'
    && Object.prototype.hasOwnProperty.call(valor, 'hasPhoto')
    && Object.prototype.hasOwnProperty.call(valor, 'proStatus');
  if (temCaraDeAtleta) {
    const estranho = Object.keys(valor).find(k => !CAMPOS_DO_ATLETA_NA_VITRINE.includes(k));
    if (estranho) return `${caminho}.${estranho} é campo de atleta fora da lista da vitrine`;
  }
  for (const [chave, dentro] of Object.entries(valor)) {
    const achado = acharCampoNovoNoAtleta(dentro, `${caminho}.${chave}`);
    if (achado) return achado;
  }
  return null;
}

/**
 * Varre a resposta INTEIRA, em qualquer profundidade, procurando nome de campo
 * restrito e valor restrito literal.
 *
 * Devolve a primeira ocorrência com o caminho, porque "vazou algo" não ajuda
 * ninguém a consertar: o que ajuda é "$.items[3].athlete.phone".
 */
function acharRestrito(valor, proibidos, valores, caminho = '$') {
  if (valor === null || valor === undefined) return null;

  if (typeof valor === 'string') {
    for (const [procurado, oque] of valores) {
      if (valor.includes(procurado)) return `${caminho} contém ${oque}: ${valor.slice(0, 80)}`;
    }
    return null;
  }
  if (Array.isArray(valor)) {
    for (let i = 0; i < valor.length; i += 1) {
      const achado = acharRestrito(valor[i], proibidos, valores, `${caminho}[${i}]`);
      if (achado) return achado;
    }
    return null;
  }
  if (typeof valor === 'object') {
    for (const [chave, dentro] of Object.entries(valor)) {
      if (proibidos.includes(chave)) return `${caminho}.${chave} é campo restrito`;
      const achado = acharRestrito(dentro, proibidos, valores, `${caminho}.${chave}`);
      if (achado) return achado;
    }
  }
  return null;
}

let admin;
let orgA;
let orgB;
let operadorA;
let operadorB;
let filiacaoA;
let atleta;
let cpfDoAtleta;

// Valores literais que não podem aparecer. Montado no `beforeEach` porque o
// CPF é sorteado por execução.
let VALORES_RESTRITOS;

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999992222', whatsapp: '65988883333', postalCode: '78000000',
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

const abrirAutocadastro = (organizationId) =>
  api().post(`/api/v1/organizations/${organizationId}/self-registration`).set(admin.auth()).send({ open: true });

// --- um PNG 8x8 real: o sharp precisa DECODIFICAR o arquivo ----------------
const crc32 = b => { let c = ~0; for (const x of b) { c ^= x; for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
const pedaco = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const b = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); return Buffer.concat([l, b, c]); };
function png(lado = 8) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4); ihdr[8] = 8; ihdr[9] = 2;
  const linhas = []; for (let y = 0; y < lado; y += 1) linhas.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(lado * 3, 90)]));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), pedaco('IEND', Buffer.alloc(0))]);
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });

  orgA = await criarOrganizacao(admin, { name: unico('Federação A') });
  operadorA = await criarUsuario({ name: 'Operadora A' });
  await vincular(orgA.id, operadorA, 'EVENT_DIRECTOR');
  filiacaoA = await criarFiliacao(operadorA, orgA.id);

  orgB = await criarOrganizacao(admin, { name: unico('Federação B') });
  operadorB = await criarUsuario({ name: 'Operador B' });
  await vincular(orgB.id, operadorB, 'EVENT_DIRECTOR');

  cpfDoAtleta = gerarCpf(760000001);
  atleta = await criarAtleta(operadorA, orgA.id, {
    fullName: 'Atleta Da Vitrine', stageName: 'Vitrine', cpf: cpfDoAtleta,
    birthDate: NASCIMENTO, phone: TELEFONE, email: EMAIL_PESSOAL, state: 'MT', city: 'Cuiabá'
  });

  VALORES_RESTRITOS = [
    [cpfDoAtleta, 'o CPF formatado do atleta'],
    [cpfDoAtleta.replace(/\D/g, ''), 'o CPF em dígitos do atleta'],
    [TELEFONE, 'o telefone do atleta'],
    [EMAIL_PESSOAL, 'o e-mail do atleta'],
    [CEP, 'o CEP'],
    [LOGRADOURO, 'o logradouro']
  ];
});

const semRestrito = (resposta, rota) => {
  const achado = acharRestrito(resposta.body, CAMPOS_RESTRITOS, VALORES_RESTRITOS);
  expect(achado, `${rota} entregou dado restrito — ${achado}`).toBeNull();
  const novoNoAtleta = acharCampoNovoNoAtleta(resposta.body);
  expect(novoNoAtleta, `${rota} — ${novoNoAtleta}`).toBeNull();
};

// ====================== O QUE A VITRINE DE FATO PUBLICA ====================

describe('a vitrine pública entrega o esportivo e nada além', () => {
  it('1. o perfil do atleta abre ao ANÔNIMO e traz nome, foto e dado esportivo', async () => {
    const r = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);

    // O que o visitante PRECISA ver — se qualquer um destes sair, a vitrine
    // deixou de existir e o teste de privacidade estaria passando no vazio.
    expect(r.body.athlete.fullName).toBe('Atleta Da Vitrine');
    expect(r.body.athlete.stageName).toBe('Vitrine');
    expect(r.body.athlete.city).toBe('Cuiabá');
    expect(r.body.athlete.state).toBe('MT');
    expect(r.body.athlete).toHaveProperty('hasPhoto');
    expect(r.body).toHaveProperty('results');
    expect(r.body).toHaveProperty('rankings');
    expect(r.body).toHaveProperty('titles');
  });

  it('2. o MESMO corpo não traz CPF, telefone, e-mail, nascimento nem endereço', async () => {
    const r = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(r.status).toBe(200);
    semRestrito(r, 'GET /public/athletes/:id');
  });

  it('3. o CPF existe no banco — a ausência na resposta é filtro, não vazio', async () => {
    const identidade = await comoAtor(operadorA, () => prisma.athleteIdentity.findFirst({
      where: { athleteId: atleta.id }, select: { cpf: true }
    }));
    expect(identidade?.cpf, 'o atleta foi criado sem identidade e o caso 2 passaria por acidente').toBeTruthy();
    expect(identidade.cpf).toBe(cpfDoAtleta.replace(/\D/g, ''));
  });

  it('4. a LISTA pública de atletas não traz dado restrito', async () => {
    const r = await api().get('/api/v1/public/athletes?limit=50');
    expect(r.status).toBe(200);
    expect(r.body.items.some(a => a.id === atleta.id), 'o atleta não entrou na lista').toBe(true);
    semRestrito(r, 'GET /public/athletes');
  });

  it('5. a BUSCA pública por nome acha o atleta e continua sem dado restrito', async () => {
    const r = await api().get('/api/v1/public/athletes?search=Vitrine');
    expect(r.status).toBe(200);
    expect(r.body.items.map(a => a.id)).toContain(atleta.id);
    semRestrito(r, 'GET /public/athletes?search=nome');
  });

  it('6. a busca pública por CPF NÃO encontra o atleta', async () => {
    // A regra é absoluta no escopo: CPF não aparece em busca pública. Não
    // basta não devolvê-lo — ele não pode nem servir de chave de consulta,
    // senão a vitrine vira um confirmador de documento: quem tem o número
    // descobre a quem ele pertence.
    for (const forma of [cpfDoAtleta, cpfDoAtleta.replace(/\D/g, '')]) {
      const r = await api().get(`/api/v1/public/athletes?search=${encodeURIComponent(forma)}`);
      expect(r.status).toBe(200);
      expect(r.body.items.map(a => a.id), `buscar por "${forma}" alcançou o atleta`).not.toContain(atleta.id);
    }
  });

  it('7. a página pública do evento, com resultado publicado, não traz dado restrito', async () => {
    const montado = await criarEventoCompleto(operadorA, orgA.id, { categoryCode: 'BIKINI' });
    const eventId = montado.event.id;
    const classId = montado.competitionClass.id;

    await transicionar(operadorA, eventId, ['PLANNED', 'REGISTRATIONS_OPEN']);
    const inscricao = await api().post(`/api/v1/events/${eventId}/registrations`).set(operadorA.auth())
      .send({ cpf: cpfDoAtleta, classIds: [classId] });
    expect(inscricao.status, JSON.stringify(inscricao.body).slice(0, 300)).toBe(201);

    await transicionar(operadorA, eventId, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
    await api().post(`/api/v1/registrations/${inscricao.body.registration.id}/checkin`).set(operadorA.auth()).send({});
    await transicionar(operadorA, eventId, ['IN_JUDGING']);

    const recebido = await api().post(`/api/v1/classes/${classId}/result`).set(operadorA.auth())
      .send({ entries: [{ athleteId: atleta.id, placing: 1 }] });
    expect(recebido.status, JSON.stringify(recebido.body).slice(0, 300)).toBe(200);
    const publicado = await api().post(`/api/v1/classes/${classId}/result/publish`).set(operadorA.auth())
      .send({ note: 'Homologado' });
    expect(publicado.status, JSON.stringify(publicado.body).slice(0, 300)).toBe(200);

    // A inscrição é feita POR CPF: o atleta inscrito é o mesmo do `beforeEach`,
    // então o resultado publicado carrega a pessoa cujos dados restritos a
    // peneira procura. Sem isso o caso passaria medindo um evento vazio.
    for (const rota of [
      `/api/v1/public/events/${montado.event.slug}`,
      `/api/v1/events/${eventId}/results`,
      `/api/v1/classes/${classId}/result`,
      `/api/v1/public/athletes/${atleta.id}`
    ]) {
      const r = await api().get(rota);
      expect(r.status, `${rota} devolveu ${r.status}`).toBe(200);
      semRestrito(r, `GET ${rota} (anônimo)`);
    }

    // E o perfil do atleta agora mostra o resultado — a vitrine não está vazia.
    const perfil = await api().get(`/api/v1/public/athletes/${atleta.id}`);
    expect(perfil.body.results.length, 'o resultado publicado não apareceu no perfil').toBeGreaterThan(0);
  });

  it('8. a home pública e a lista de campeonatos não trazem dado restrito', async () => {
    for (const rota of ['/api/v1/public/summary', '/api/v1/public/events', '/api/v1/public/affiliations']) {
      const r = await api().get(`${rota}`);
      expect(r.status, `${rota} devolveu ${r.status}`).toBe(200);
      semRestrito(r, `GET ${rota}`);
    }
  });

  it('9. id inexistente responde 404 limpo, sem vazar nome de tabela nem stack', async () => {
    const r = await api().get('/api/v1/public/athletes/cmnaoexisteestaid0000000');
    expect([400, 404], `veio ${r.status}`).toContain(r.status);
    const corpo = JSON.stringify(r.body);
    expect(corpo).not.toMatch(/prisma|PrismaClient|at Object|\.js:\d+/i);
  });
});

// ============================ IDOR DE MÍDIA ===============================

describe('IDOR nas rotas de mídia que a rodada abriu', () => {
  it('10. a foto do PEDIDO de cadastro continua fechada ao anônimo e a terceiros', async () => {
    await abrirAutocadastro(orgA.id);
    const dona = await cadastrarPessoa('Dona Do Pedido');
    const outra = await cadastrarPessoa('Terceira Curiosa');

    const pedido = await pedirPerfilDeAtleta(dona, {
      fullName: 'Solicitante Com Foto', cpf: gerarCpf(760000002), sex: 'FEMALE',
      birthDate: '1998-07-15', affiliationId: filiacaoA.id, affiliationNumber: 'NPC-00777'
    });
    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 300)).toBe(201);

    const envio = await api().post(`/api/v1/athlete-requests/${pedido.body.id}/photo`)
      .set(dona.auth()).attach('file', png(), { filename: 'foto.png', contentType: 'image/png' });
    expect(envio.status, JSON.stringify(envio.body).slice(0, 300)).toBe(200);

    const anonimo = await api().get(`/api/v1/media/athlete-requests/${pedido.body.id}/photo`);
    expect(anonimo.status, 'a foto do PEDIDO ficou aberta ao anônimo').toBe(401);

    const terceira = await api().get(`/api/v1/media/athlete-requests/${pedido.body.id}/photo`).set(outra.auth());
    expect([403, 404], `terceira recebeu ${terceira.status}`).toContain(terceira.status);

    // E a dona alcança a própria: a porta fechou para fora, não para dentro.
    const daDona = await api().get(`/api/v1/media/athlete-requests/${pedido.body.id}/photo`).set(dona.auth());
    expect(daDona.status).toBe(200);
  });

  it('11. `photoKey` enviado pelo CLIENTE não é gravado em lugar nenhum', async () => {
    await abrirAutocadastro(orgA.id);
    const pessoa = await cadastrarPessoa('Tentativa De Plantio');
    const plantada = 'athletes/documento-de-outra-pessoa.pdf';

    const pedido = await pedirPerfilDeAtleta(pessoa, {
      fullName: 'Plantio', cpf: gerarCpf(760000003), sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: filiacaoA.id, affiliationNumber: 'NPC-00888',
      photoKey: plantada
    });
    // O Zod DESCARTA chave não declarada: o pedido é aceito e a chave morre na
    // porta. Recusar com 400 seria igualmente defensável, mas aceitar e ignorar
    // não quebra cliente antigo — e o que importa é o que foi GRAVADO.
    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 300)).toBe(201);

    const linha = await comoAtor(admin, () => prisma.athleteProfileRequest.findUnique({
      where: { id: pedido.body.id }, select: { photoKey: true, athleteId: true }
    }));
    // A MEDIDA MUDOU DE "É NULA" PARA "NÃO É A DELE", e o que se prova é o
    // mesmo. A foto passou a ser obrigatória e a vir na mesma requisição, então
    // o pedido nasce COM chave — só que montada pelo SERVIDOR, por
    // `storage.buildKey`, que higieniza o escopo e sorteia o nome. Exigir nulo
    // agora mediria a obrigatoriedade da foto, e não o plantio.
    expect(linha.photoKey, 'o cliente escolheu o caminho dentro do bucket').not.toBe(plantada);
    expect(linha.photoKey, 'a chave gravada não tem a forma que o servidor constrói')
      .toMatch(/^athlete-requests\/[a-z0-9]+\/[0-9a-f-]{36}\.(webp|png|jpg|jpeg)$/);

    // E a plantada não alcançou o atleta pela conclusão automática.
    expect(linha.athleteId, 'a conclusão automática não criou o atleta e o caso mediria o nada').toBeTruthy();
    const noAtleta = await comoAtor(operadorA, () => prisma.athlete.findUnique({
      where: { id: linha.athleteId }, select: { photoKey: true }
    }));
    expect(noAtleta.photoKey, 'a chave plantada chegou ao cadastro do atleta').not.toBe(plantada);

    // A rota pública serve a foto REAL — a que o servidor gravou —, e nunca o
    // objeto plantado. O 404 de antes media um atleta sem foto; agora ele tem
    // uma, e o que importa é de quem é a chave que a serve.
    const r = await api().get(`/api/v1/media/athletes/${linha.athleteId}/photo`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/^image\//);
  });

  it('12. a chave que o fluxo legítimo grava é montada pelo SERVIDOR', async () => {
    await abrirAutocadastro(orgA.id);
    const dona = await cadastrarPessoa('Dona Legítima');
    const pedido = await pedirPerfilDeAtleta(dona, {
      fullName: 'Legítima', cpf: gerarCpf(760000004), sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: filiacaoA.id, affiliationNumber: 'NPC-00999'
    });
    expect(pedido.status).toBe(201);
    await api().post(`/api/v1/athlete-requests/${pedido.body.id}/photo`)
      .set(dona.auth()).attach('file', png(), { filename: 'foto.png', contentType: 'image/png' });

    const linha = await comoAtor(admin, () => prisma.athleteProfileRequest.findUnique({
      where: { id: pedido.body.id }, select: { photoKey: true, athleteId: true }
    }));
    // Prefixo fixo do pedido + UUID + extensão do que o sharp produziu. Nada
    // do que o cliente mandou (nome do arquivo incluído) compõe o caminho.
    expect(linha.photoKey).toMatch(
      new RegExp(`^athlete-requests/${linha.athleteId ? '[a-z0-9]+' : '[a-z0-9]+'}/[0-9a-f-]{36}\\.[a-z0-9]{2,5}$`)
    );
    expect(linha.photoKey).not.toContain('foto.png');

    // E a propagação levou a MESMA chave ao atleta — um objeto, dois ponteiros.
    const noAtleta = await comoAtor(operadorA, () => prisma.athlete.findUnique({
      where: { id: linha.athleteId }, select: { photoKey: true }
    }));
    expect(noAtleta.photoKey).toBe(linha.photoKey);
  });

  it('13. o provedor de armazenamento recusa chave que sobe na hierarquia', async () => {
    // Última barreira, e ela é do PROVEDOR — não da validação de entrada. Vale
    // mesmo para chave que chegue por um caminho que ninguém previu.
    for (const chave of ['../../etc/passwd', '/etc/passwd', 'athletes/../../../etc/passwd', '..']) {
      expect(() => storage.resolveKey(chave), `o provedor aceitou "${chave}"`).toThrow();
    }
    // E aceita a chave bem formada, senão o caso acima passaria por acidente.
    expect(() => storage.resolveKey('athletes/11111111-2222-3333-4444-555555555555.webp')).not.toThrow();
  });

  it('14. trocar o id na foto do atleta só alcança foto de atleta', async () => {
    await abrirAutocadastro(orgA.id);
    const dona = await cadastrarPessoa('Dona Do Documento');
    const pedido = await pedirPerfilDeAtleta(dona, {
      fullName: 'Documento', cpf: gerarCpf(760000005), sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: filiacaoA.id, affiliationNumber: 'NPC-01111'
    });
    expect(pedido.status).toBe(201);
    await api().post(`/api/v1/athlete-requests/${pedido.body.id}/photo`)
      .set(dona.auth()).attach('file', png(), { filename: 'foto.png', contentType: 'image/png' });

    // O id do PEDIDO na rota do ATLETA não encontra atleta nenhum. A rota lê
    // `Athlete` por id; não há parâmetro por onde passar caminho de objeto.
    const r = await api().get(`/api/v1/media/athletes/${pedido.body.id}/photo`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('PHOTO_NOT_FOUND');
  });

  it('15. a foto do atleta de OUTRA federação abre — é pública de propósito', async () => {
    // Registrado como DECISÃO, não como achado: a foto do atleta aprovado é
    // pública, e federação não é fronteira de privacidade para ela — a mesma
    // pessoa já aparece com nome, equipe e colocação no ranking nacional.
    const atletaB = await criarAtleta(operadorB, orgB.id, {
      fullName: 'Atleta Da Outra', cpf: gerarCpf(760000006)
    });
    await comoAtor(operadorB, tx => tx.athlete.update({
      where: { id: atletaB.id }, data: { photoKey: 'athletes/da-outra.webp' }
    }));

    const r = await api().get(`/api/v1/media/athletes/${atletaB.id}/photo`);
    // 404 de ARQUIVO: a chave existe no cadastro e o objeto não existe neste
    // armazenamento de teste. O que importa é não ser 401 nem 403.
    expect([200, 404], `veio ${r.status}`).toContain(r.status);
    expect([401, 403], 'a rota voltou a pedir sessão').not.toContain(r.status);
  });
});

// ==================== ROTA ADMINISTRATIVA SEM LOGIN =======================

describe('o anônimo não alcança superfície administrativa', () => {
  const FECHADAS = [
    ['GET', '/api/v1/athlete-requests'],
    ['GET', '/api/v1/audit'],
    ['GET', '/api/v1/admin/users'],
    ['GET', '/api/v1/organizations'],
    ['GET', '/api/v1/athletes'],
    ['GET', '/api/v1/musclewar/imports/qualquer'],
    ['GET', '/api/v1/auth/me'],
    ['GET', '/api/v1/me/cadastro']
  ];

  for (const [metodo, rota] of FECHADAS) {
    it(`16. ${metodo} ${rota} sem sessão responde 401`, async () => {
      const r = await api()[metodo.toLowerCase()](rota);
      expect(r.status, `${rota} devolveu ${r.status}`).toBe(401);
      expect(JSON.stringify(r.body)).not.toMatch(/prisma|at Object|\.js:\d+/i);
    });
  }

  it('17. a correção de filiação exige sessão E permissão', async () => {
    const corpo = { novaMatricula: '2932', novaEntidade: 'NPC', motivo: 'tentativa de correcao sem direito' };
    const rota = '/api/v1/musclewar/items/cmitemqualquer000000000/affiliation/fix';

    const anonimo = await api().post(rota).send(corpo);
    expect(anonimo.status, 'a correção de filiação ficou aberta ao anônimo').toBe(401);

    const pessoa = await cadastrarPessoa('Sem Permissão');
    const semPermissao = await api().post(rota).set(pessoa.auth()).send(corpo);
    // 403 por permissão ou 404 porque o item não existe — as duas negam. O que
    // não pode acontecer é 200.
    expect([403, 404, 422], `veio ${semPermissao.status}`).toContain(semPermissao.status);
  });
});
