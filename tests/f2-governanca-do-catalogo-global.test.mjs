import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';
import { can } from '../src/utils/permissions.js';

// ==========================================================================
// F2 — QUEM PODE ESCREVER NO CATÁLOGO GLOBAL.
//
// O achado do T1 dizia: `Category` e `Coach` não têm `organizationId`, logo o
// caso cross-tenant não se aplica e a guarda é só a permissão — e essa
// permissão está com `EVENT_DIRECTOR`, que é papel DE FEDERAÇÃO. Um diretor
// de qualquer federação grava no catálogo que vale para todas.
//
// A auditoria parou em "risco de governança". Esta fase mediu o que o risco
// ALCANÇA, e o alcance é maior do que estava escrito: não é poluição de
// lista, é a guarda do importador.
//
// `muscleWarService.js:406` recusa a linha cuja categoria não está no
// catálogo — `Categoria desconhecida no MCI`. A guarda pergunta ao catálogo.
// Quem escreve no catálogo escolhe a resposta. Então o diretor de uma
// federação podia CRIAR a categoria e, com isso, fazer o importador aceitar
// resultado num recorte que a Muscle Contest nunca homologou.
//
// É a diferença entre "aparece uma categoria estranha na lista" e "entra
// ponto no ledger oficial por uma porta que a homologação não abriu".
//
// A DECISÃO, E POR QUE ELA NÃO É SIMÉTRICA
//
// As duas tabelas são globais, mas por motivos opostos, e a medição mostra
// isso:
//
//   `Category` é global porque o catálogo é OFICIAL. São onze categorias,
//   provisionadas por migration
//   (`20260922210000_catalogo_oficial_de_categorias`), fixadas por
//   `tests/catalogo-oficial-de-categorias.test.mjs` e anunciadas ao público
//   como "onze categorias oficiais". Dar `organizationId` a ela fragmentaria
//   o catálogo nacional por federação — isso seria inventar estrutura
//   esportiva. Então quem gerencia é a plataforma, e só ela. É o mesmo
//   desenho que `results.override` já tem, pelo mesmo motivo: corrigir prova
//   oficial divulgada é da plataforma, não de quem conduz a etapa.
//
//   `Coach` é global porque um técnico atende atletas de várias federações —
//   está escrito em `partnerService.js`, e é anterior a esta fase. Aqui a
//   lista compartilhada NÃO é defeito, é o modelo. O que era defeito é uma
//   coisa só: `coachCreate` aceita `userId`, `Coach.userId` é UNIQUE, e
//   nenhuma política nem serviço deriva autorização de `Coach` (medido: zero
//   helper `mci_` cita coach, zero policy cita coach). Ou seja, vincular não
//   dá poder a ninguém — mas OCUPA o vínculo único daquele usuário, e o
//   ocupante pode ser o operador de outra federação. Quem chegar depois não
//   consegue mais cadastrar o técnico.
//
// Então: `categories.manage` sai do papel de federação; `coaches.manage`
// fica, e o que sai é a capacidade de um ator não-plataforma vincular o
// cadastro de técnico a uma CONTA. Cada metade tem a medição que a sustenta.
//
// O QUE ESTA SUÍTE NÃO FAZ
//
// Não fecha o catálogo para leitura: categoria e técnico continuam visíveis
// para todos, que é o desenho. Não cria `organizationId` em tabela nenhuma.
// Não mexe em RLS. Não toca em `athletes.update`, que é como o operador
// ATRIBUI um técnico já cadastrado a um atleta — isso continua sendo dele.
// ==========================================================================

const CABECALHO = 'Athlete #,Class,Category,First Name,Last Name,Member Number,Placing';
const CLASSE_OFICIAL = "Men's Bodybuilding - Open Middleweight";

// O CATÁLOGO OFICIAL SOBREVIVE À LIMPEZA — e isso mordeu este teste antes de
// morder ninguém em produção.
//
// `Category` NÃO está em `TABELAS` de `helpers.mjs`: o catálogo é
// pré-requisito de domínio e não é truncado entre testes. A primeira versão
// desta suíte usava um código FIXO e, na segunda execução, recebeu 409 em vez
// de 201 — a categoria que a federação criou na execução anterior ainda
// estava lá.
//
// Foi a medição mais direta do achado: a poluição do catálogo NÃO é
// transitória. Ela sobrevive ao que apaga todo o resto. Por isso o código é
// único por execução, e cada teste começa removendo o que não é oficial.
const CODIGOS_OFICIAIS = Object.freeze([
  'MENS_BODYBUILDING', 'MENS_PHYSIQUE', 'CLASSIC_PHYSIQUE', 'BODYBUILDING_212',
  'WOMENS_BODYBUILDING', 'WOMENS_PHYSIQUE', 'WELLNESS', 'BIKINI', 'FITNESS',
  'FIGURE', 'FITMODEL'
]);

let CODIGO_INVENTADO;

let plataforma, diretorA, diretorB, orgA, orgB, filiacao, season, evento, alvo;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  // Nada de categoria QA sobrando de execução anterior. `limparBanco` já
  // truncou tudo que referencia `Category`, então a remoção é segura.
  await prisma.category.deleteMany({ where: { code: { notIn: CODIGOS_OFICIAIS } } });
  CODIGO_INVENTADO = `INVENTADA_PELA_FEDERACAO_${unico('f2').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

  plataforma = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin F2' });
  orgA = (await criarOrganizacao(plataforma, { name: 'Federacao A F2' })).id;
  orgB = (await criarOrganizacao(plataforma, { name: 'Federacao B F2' })).id;

  // Diretor de evento em A. É o ator do achado: tem papel de federação, não
  // de plataforma.
  diretorA = await criarUsuario({ name: 'Diretor A F2' });
  for (const papel of ['EVENT_DIRECTOR', 'RANKING_MANAGER', 'REGISTRATION_OPERATOR']) {
    await vincular(orgA, diretorA, papel);
  }

  // Diretor de evento em B. Serve para medir o efeito CRUZADO: o que ele
  // escreve alcança a federação A.
  diretorB = await criarUsuario({ name: 'Diretor B F2' });
  await vincular(orgB, diretorB, 'EVENT_DIRECTOR');

  // Uma conta qualquer da plataforma, para medir o vínculo de técnico.
  alvo = await criarUsuario({ name: 'Conta Alvo F2' });

  filiacao = (await api().post('/api/v1/affiliations').set(plataforma.auth())
    .send({ organizationId: orgA, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(plataforma.auth())
    .send({ organizationId: orgA, name: 'Temporada F2', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(plataforma.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  evento = (await api().post('/api/v1/events').set(diretorA.auth()).send({
    organizationId: orgA, name: 'Etapa F2', slug: unico('ev-f2'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;
});

const criarCategoria = (ator, corpo) =>
  api().post('/api/v1/categories').set(ator.auth()).send(corpo);

const criarTecnico = (ator, corpo) =>
  api().post('/api/v1/coaches').set(ator.auth()).send(corpo);

const criarAtleta = (matricula, semente) => comoAtor(diretorA, tx => tx.athlete.create({
  data: {
    organizationId: orgA, fullName: 'ATLETA F2', sex: 'MALE',
    affiliationId: filiacao.id, affiliationNumber: matricula,
    identity: { create: { organizationId: orgA, cpf: gerarCpf(semente) } }
  }
}));

// O lote entra pelo caminho real do importador, com o diretor de A — que é
// quem tem `musclewar.import` naquela federação.
const criarLote = linhas => api().post('/api/v1/musclewar/imports').set(diretorA.auth()).send({
  organizationId: orgA, seasonId: season, eventId: evento.id, sourceType: 'CSV',
  sourceRef: unico('etapa-f2') + '.csv', content: [CABECALHO, ...linhas].join('\n'),
  externalIdPrefix: unico('F2').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
  defaultAffiliationCode: 'NPC'
});

const previa = loteId =>
  api().get(`/api/v1/musclewar/imports/${loteId}`).set(diretorA.auth()).query({ limit: 500 });

const aplicar = loteId =>
  api().post(`/api/v1/musclewar/imports/${loteId}/apply`).set(diretorA.auth()).send({});

const pontosNoLedger = () => comoAtor(plataforma, tx => tx.rankingPoint.findMany({
  select: { id: true, categoryId: true, placing: true, points: true }
}));

// ==========================================================================
// A METADE DO CATÁLOGO OFICIAL
// ==========================================================================
describe('catálogo oficial de categorias — escrever nele é ato de plataforma', () => {
  it('o diretor de evento é recusado com 403, e não com 400 de validação', async () => {
    const r = await criarCategoria(diretorA, { code: CODIGO_INVENTADO, name: 'Inventada', sex: 'MALE' });

    // 403 e não 400: um 400 significaria que o corpo foi reprovado antes da
    // autorização, e aí o teste mediria o Zod, não a guarda. O corpo é
    // válido de propósito.
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  }, 60_000);

  it('nem o diretor de OUTRA federação alcança o catálogo da plataforma', async () => {
    const r = await criarCategoria(diretorB, { code: CODIGO_INVENTADO, name: 'Inventada', sex: 'MALE' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
  }, 60_000);

  it('nada foi gravado: o catálogo continua com as onze categorias oficiais', async () => {
    await criarCategoria(diretorA, { code: CODIGO_INVENTADO, name: 'Inventada', sex: 'MALE' });

    const inventada = await prisma.category.findUnique({ where: { code: CODIGO_INVENTADO } });
    expect(inventada, 'a categoria inventada entrou no catálogo').toBeNull();

    // Controle POSITIVO do número: se a contagem mudasse por outro motivo, o
    // teste acima passaria por acidente.
    const total = await prisma.category.count();
    expect(total, 'o catálogo oficial deixou de ter onze categorias').toBe(11);
  }, 60_000);

  it('a plataforma continua conseguindo gerenciar o catálogo — a rota não morreu', async () => {
    const codigo = `QA_F2_${Date.now().toString(36).toUpperCase()}`;
    const r = await criarCategoria(plataforma, { code: codigo, name: 'Categoria QA', sex: 'FEMALE' });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.code).toBe(codigo);

    // E o ADMIN de plataforma também, que é o outro papel de plataforma.
    const admin = await criarUsuario({ role: 'ADMIN', name: 'Admin Plataforma F2' });
    const segunda = await criarCategoria(admin, { code: `${codigo}_2`, name: 'Categoria QA 2', sex: 'MALE' });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
  }, 60_000);

  it('o atleta autenticado também é recusado — a base autenticada não gerencia catálogo', async () => {
    const atleta = await criarUsuario({ name: 'Atleta F2' });
    await vincular(orgA, atleta, 'ATHLETE');
    const r = await criarCategoria(atleta, { code: CODIGO_INVENTADO, name: 'Inventada', sex: 'MALE' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
  }, 60_000);

  it('sem sessão é 401, e não 403 — a rota não ficou aberta', async () => {
    const r = await api().post('/api/v1/categories')
      .send({ code: CODIGO_INVENTADO, name: 'Inventada', sex: 'MALE' });
    expect(r.status).toBe(401);
  }, 60_000);
});

// ==========================================================================
// A CONSEQUÊNCIA ESPORTIVA — O QUE O ACHADO ALCANÇAVA DE VERDADE
//
// Este é o teste que justifica a fase. Ele percorre o importador inteiro, do
// CSV ao ledger, e mede se a federação consegue transformar "categoria
// desconhecida" em "categoria conhecida".
// ==========================================================================
describe('a guarda do importador não é mais contornável pela federação', () => {
  it('a federação não consegue transformar categoria desconhecida em conhecida', async () => {
    await criarAtleta('88291', 9101);

    // PASSO 1 — a federação tenta cadastrar o recorte que ela quer usar.
    const criacao = await criarCategoria(diretorA, {
      code: CODIGO_INVENTADO, name: 'Categoria Inventada', sex: 'MALE'
    });
    expect(criacao.status, 'a federação escreveu no catálogo oficial').toBe(403);

    // PASSO 2 — o mesmo lote que ela usaria. A guarda tem de recusar.
    const lote = (await criarLote([
      `1,${CLASSE_OFICIAL},${CODIGO_INVENTADO},Atleta,Sobrenome,88291,1`
    ])).body.import;

    const r = await previa(lote.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.summary.conflicts, 'a linha deixou de ser conflito').toBe(1);
    expect(r.body.summary.recognized, 'a linha ficou pronta para aplicar').toBe(0);
    expect(r.body.items[0].reason).toContain(CODIGO_INVENTADO);
    expect(r.body.items[0].reason).toMatch(/categoria/i);

    // PASSO 3 — e não entra ponto nenhum no ledger oficial.
    const aplicacao = await aplicar(lote.id);
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(422);
    expect(aplicacao.body.error.code).toBe('NOTHING_TO_APPLY');
    expect(await pontosNoLedger(), 'entrou ponto por categoria não homologada').toHaveLength(0);
  }, 120_000);

  it('controle positivo: com categoria OFICIAL o mesmo lote entra normalmente', async () => {
    // Sem este controle, o teste acima passaria mesmo que o importador
    // estivesse quebrado para tudo.
    await criarAtleta('88292', 9102);

    const lote = (await criarLote([
      `1,${CLASSE_OFICIAL},MENS_BODYBUILDING,Atleta,Sobrenome,88292,1`
    ])).body.import;

    const r = await previa(lote.id);
    expect(r.body.summary.conflicts, 'categoria oficial virou conflito').toBe(0);
    expect(r.body.summary.recognized).toBe(1);

    expect((await aplicar(lote.id)).body.applied).toBe(1);

    const pontos = await pontosNoLedger();
    expect(pontos).toHaveLength(1);
    expect(pontos[0].categoryId, 'ponto entrou sem recorte de categoria').not.toBeNull();
    expect(pontos[0].points).toBe(5);
  }, 120_000);

  it('quando a PLATAFORMA homologa o recorte, o importador passa a aceitá-lo', async () => {
    // A correção não trancou o caminho: ela mudou quem tem a chave. Sem este
    // teste, "recusa sempre" passaria por correção.
    await criarAtleta('88293', 9103);
    const codigo = `QA_F2_OK_${Date.now().toString(36).toUpperCase()}`;

    expect((await criarCategoria(plataforma, { code: codigo, name: 'Recorte QA', sex: 'MALE' })).status).toBe(201);

    const lote = (await criarLote([
      `1,${CLASSE_OFICIAL},${codigo},Atleta,Sobrenome,88293,1`
    ])).body.import;

    const r = await previa(lote.id);
    expect(r.body.summary.conflicts, JSON.stringify(r.body.items?.[0])).toBe(0);
    expect(r.body.summary.recognized).toBe(1);
    expect((await aplicar(lote.id)).body.applied).toBe(1);
  }, 120_000);
});

// ==========================================================================
// A METADE DO TÉCNICO
//
// Aqui o limite é diferente: a rota CONTINUA sendo do operador. O que sai é
// vincular o cadastro a uma conta da plataforma.
// ==========================================================================
describe('cadastro de técnico — global por desenho, com o vínculo de conta reservado', () => {
  it('o diretor de evento continua cadastrando técnico: a capacidade não foi retirada', async () => {
    const r = await criarTecnico(diretorA, { name: 'Treinador Fulano', city: 'Cuiaba', state: 'MT' });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.name).toBe('Treinador Fulano');
    expect(r.body.userId, 'técnico sem conta nasce sem vínculo').toBeNull();
  }, 60_000);

  it('o diretor de evento NÃO vincula o cadastro a uma conta da plataforma', async () => {
    const r = await criarTecnico(diretorA, { name: 'Treinador Fulano', userId: alvo.id });

    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    // A mensagem tem de dizer o que fazer, senão o operador reabre a mesma
    // dúvida no suporte.
    expect(r.body.error.message).toMatch(/conta/i);
  }, 60_000);

  it('a recusa do vínculo não grava técnico nenhum — nem sem o vínculo', async () => {
    await criarTecnico(diretorA, { name: 'Treinador Fulano', userId: alvo.id });

    const tecnicos = await prisma.coach.findMany({ where: { name: 'Treinador Fulano' } });
    expect(tecnicos, 'gravou o técnico e só ignorou o vínculo').toHaveLength(0);
  }, 60_000);

  it('o vínculo único de uma conta não pode ser ocupado pela federação de fora', async () => {
    // Era o efeito cruzado medido: `Coach.userId` é UNIQUE. Se o diretor de B
    // ocupasse o vínculo da conta, ninguém mais cadastraria aquele técnico —
    // nem a plataforma, nem a federação dele.
    expect((await criarTecnico(diretorB, { name: 'Treinador de B', userId: alvo.id })).status).toBe(403);

    // E a plataforma continua conseguindo fazer o vínculo legítimo.
    const r = await criarTecnico(plataforma, { name: 'Treinador Oficial', userId: alvo.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.userId).toBe(alvo.id);
  }, 60_000);

  it('o conflito de vínculo duplicado continua sendo 409, e não 500', async () => {
    expect((await criarTecnico(plataforma, { name: 'Treinador Um', userId: alvo.id })).status).toBe(201);

    const segunda = await criarTecnico(plataforma, { name: 'Treinador Dois', userId: alvo.id });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body.error.code).toBe('COACH_EXISTS');
  }, 60_000);

  it('a conta inexistente continua sendo 404 para quem pode vincular', async () => {
    const r = await criarTecnico(plataforma, { name: 'Treinador X', userId: 'ckzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error.code).toBe('USER_NOT_FOUND');
  }, 60_000);

  it('a rota não é oráculo de existência de conta: id inexistente também dá 403 para quem não pode vincular', async () => {
    // A ORDEM DAS DUAS CONFERÊNCIAS É O TESTE.
    //
    // Se a busca do usuário vier antes da permissão, a rota responde 404 para
    // id que NÃO existe e 403 para id que existe — e aí qualquer diretor de
    // federação enumera contas da plataforma uma por uma, sem nunca conseguir
    // criar nada. As duas respostas têm de ser indistinguíveis.
    const existente = await criarTecnico(diretorA, { name: 'Sonda A', userId: alvo.id });
    const inexistente = await criarTecnico(diretorA, { name: 'Sonda B', userId: 'ckzzzzzzzzzzzzzzzzzzzzzzz' });

    expect(inexistente.status, 'id inexistente vazou como 404').toBe(existente.status);
    expect(inexistente.body.error.code).toBe(existente.body.error.code);
    expect(existente.status).toBe(403);
  }, 60_000);

  it('o atleta autenticado não cadastra técnico', async () => {
    const atleta = await criarUsuario({ name: 'Atleta Coach F2' });
    await vincular(orgA, atleta, 'ATHLETE');
    expect((await criarTecnico(atleta, { name: 'Treinador Qualquer' })).status).toBe(403);
  }, 60_000);

  it('o técnico cadastrado por uma federação segue visível para as outras — isso é o modelo', async () => {
    // Prova negativa deliberada: a correção NÃO deu escopo de organização ao
    // técnico. Se alguém der, este teste falha e a decisão volta à mesa.
    expect((await criarTecnico(diretorB, { name: 'Treinador Compartilhado' })).status).toBe(201);

    const lista = await api().get('/api/v1/coaches').set(diretorA.auth()).query({ search: 'Compartilhado' });
    expect(lista.status).toBe(200);
    expect(lista.body.items.map(c => c.name)).toContain('Treinador Compartilhado');
  }, 60_000);
});

// ==========================================================================
// A MATRIZ DE PERMISSÕES, FIXADA CONTRA REVERSÃO SILENCIOSA
// ==========================================================================
describe('a matriz de permissões registra a decisão', () => {
  const usuario = role => ({ id: 'u1', role, memberships: [] });

  it('`categories.manage` é de plataforma, e de nenhum papel de federação', () => {

    expect(can(usuario('SUPER_ADMIN'), 'categories.manage')).toBe(true);
    expect(can(usuario('ADMIN'), 'categories.manage')).toBe(true);

    for (const papel of ['EVENT_DIRECTOR', 'EVENT_COORDINATOR', 'RANKING_MANAGER',
      'REGISTRATION_OPERATOR', 'RESULTS_OPERATOR', 'JUDGE_COORDINATOR', 'STAFF', 'ATHLETE']) {
      expect(can(usuario(papel), 'categories.manage'), papel).toBe(false);
    }
  });

  it('`coaches.manage` continua com o diretor do evento — não foi retirada', () => {
    // A metade do técnico NÃO se resolve na matriz, e este teste existe para
    // que ninguém "complete a correção" retirando a permissão sem decidir.
    expect(can(usuario('EVENT_DIRECTOR'), 'coaches.manage')).toBe(true);
  });

  it('`categories.read` continua na base autenticada — a leitura não foi fechada', () => {
    expect(can({ id: 'u1', role: 'ATHLETE', memberships: [] }, 'categories.read')).toBe(true);
  });
});
