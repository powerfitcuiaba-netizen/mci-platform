import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';
import meService from '../src/services/meService.js';
import { withUserContext } from '../src/config/rlsSession.js';

// ============================================================================
// DESVINCULAR A CONTA DE UM ATLETA, SEM TOCAR NO HISTÓRICO.
//
// O CASO REAL QUE ORIGINOU ESTE ARQUIVO
//
// Um cadastro de teste foi feito em produção pelo fluxo de AUTOCADASTRO,
// enquanto a pessoa estava logada na CONTA ADMINISTRATIVA dela. O autocadastro
// grava `userId: pedido.userId` no atleta que cria — a conta que abriu o pedido
// —, e o resultado é que "Meu Histórico" da conta administrativa passou a
// mostrar o atleta e o histórico importado dele.
//
// `meService.atletaDoAtor` resolve o atleta da sessão por UMA chave:
//
//     prisma.athlete.findUnique({ where: { userId: actor.id } })
//
// Não por CPF, não por `AthleteIdentity`, não por nome. Então desfazer o
// vínculo é zerar UMA coluna — `Athlete.userId` — e nada mais.
//
// O QUE ESTE ARQUIVO TRAVA
//
// Que a operação seja CIRÚRGICA. O retrato do atleta e o retrato do ledger são
// comparados campo a campo, antes e depois, e a única diferença aceita é
// `Athlete.userId`. Nenhum `RankingPoint` pode mudar de valor, nascer ou
// desaparecer; `AthleteIdentity` — onde vive o CPF — não pode ser tocada; a
// filiação e a matrícula não podem se mover.
//
// NÃO EXISTE TELA para isso: varredura por `userId` em `adminAtleta.jsx` e
// `adminAtletas.jsx` não acha nada. A operação vive só na API, e é por isso que
// ela precisa de teste: é um caminho que ninguém exercita por acidente.
// ============================================================================

// O retrato do atleta. TODOS os campos que a operação poderia mover sem querer.
const CAMPOS_DO_ATLETA = Object.freeze({
  id: true,
  userId: true,
  organizationId: true,
  fullName: true,
  stageName: true,
  sex: true,
  birthDate: true,
  affiliationId: true,
  affiliationNumber: true,
  athleteNumber: true,
  teamId: true,
  coachId: true,
  gymId: true,
  status: true,
  proStatus: true,
  proSince: true,
  country: true,
  state: true,
  city: true,
  phone: true,
  email: true,
  photoKey: true,
  createdById: true,
  createdAt: true
});

// O retrato do ledger. Os mesmos campos do gate do Ipiranga.
const CAMPOS_DO_PONTO = Object.freeze({
  id: true,
  athleteId: true,
  externalAthleteId: true,
  points: true,
  placing: true,
  categoryId: true,
  catalogClassId: true,
  classId: true,
  eventId: true,
  seasonId: true,
  organizationId: true,
  externalResultId: true,
  placementPoints: true,
  overallBonus: true,
  adjustmentPoints: true,
  superOverallPoints: true,
  superOverallEligible: true,
  isOverallChampion: true,
  didNotShow: true,
  voidedAt: true,
  source: true,
  affiliationId: true,
  affiliationNumber: true
});

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
const MATRICULA = '2932';
const NOME = 'ATLETA DE TESTE QA';

const CONTATO = {
  password: 'senha-de-teste-123', birthDate: '1995-03-10',
  phone: '65999991234', whatsapp: '65988884321', postalCode: '78000000',
  addressLine: 'Rua de Teste', addressNumber: '100', state: 'MT', city: 'Cuiabá'
};

let admin;
let gerente;
let organizationId;
let seasonId;
let npc;
let atletaId;

const cadastrarPessoa = async nome => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

const retratoDoAtleta = () => comoAtor(admin, tx => tx.athlete.findUnique({
  where: { id: atletaId }, select: CAMPOS_DO_ATLETA
}));

const retratoDaIdentidade = () => comoAtor(admin, tx => tx.athleteIdentity.findUnique({
  where: { athleteId: atletaId },
  // O CPF ENTRA NO RETRATO, e é comparado, mas nunca impresso: a comparação é
  // de igualdade, e a mensagem de falha nomeia o CAMPO, não o valor.
  select: { athleteId: true, organizationId: true, cpf: true, createdAt: true }
}));

const retratoDoLedger = () => comoAtor(admin, tx => tx.rankingPoint.findMany({
  select: CAMPOS_DO_PONTO, orderBy: { id: 'asc' }
}));

/** As diferenças entre dois retratos, campo a campo. */
function diferencas(antes, depois) {
  const achados = [];
  for (const campo of Object.keys(antes)) {
    const a = antes[campo] instanceof Date ? antes[campo].toISOString() : antes[campo];
    const b = depois[campo] instanceof Date ? depois[campo].toISOString() : depois[campo];
    if (a !== b) achados.push({ campo, de: a, para: b });
  }
  return achados;
}

function diferencasDeLista(antes, depois) {
  const achados = [];
  const porId = new Map(depois.map(l => [l.id, l]));
  for (const linha of antes) {
    const nova = porId.get(linha.id);
    if (!nova) { achados.push({ id: linha.id, campo: '(linha desapareceu)' }); continue; }
    for (const d of diferencas(linha, nova)) achados.push({ id: linha.id, ...d });
  }
  for (const nova of depois) {
    if (!antes.some(l => l.id === nova.id)) achados.push({ id: nova.id, campo: '(linha nova)' });
  }
  return achados;
}

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  organizationId = (await criarOrganizacao(admin, {
    name: 'Federação Oficial', autocadastroAberto: true
  })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC - National Physique Committe', code: 'NPC', kind: 'ENTITY' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 }]
  });

  // O HISTÓRICO IMPORTADO, antes de o atleta existir — o estado do Ipiranga.
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
    content: [CABECALHO, `1,Women's Bikini - Open Class A,QA,DE TESTE,${MATRICULA},Brazil,25,1,90.0,1`].join('\n'),
    externalIdPrefix: 'IPIRANGA', defaultAffiliationCode: 'NPC'
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  const aplicado = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  expect(aplicado.status).toBe(200);

  // O CADASTRO PELO AUTOCADASTRO, feito pela conta do ADMIN — que é exatamente
  // o acidente que ocorreu em produção. `userId` do atleta nasce sendo a conta
  // que abriu o pedido.
  const pedido = await api().post('/api/v1/athlete-requests').set(admin.auth()).send({
    fullName: NOME, cpf: gerarCpf(880001), sex: 'FEMALE', birthDate: '1998-07-15',
    affiliationId: npc.id, affiliationNumber: MATRICULA
  });
  expect(pedido.status, JSON.stringify(pedido.body).slice(0, 400)).toBe(201);
  expect(pedido.body.conciliacao.estado, 'o histórico foi vinculado').toBe('VINCULADO');

  const criado = await comoAtor(admin, tx => tx.athlete.findFirst({
    where: { affiliationId: npc.id, affiliationNumber: MATRICULA }, select: { id: true, userId: true }
  }));
  atletaId = criado.id;

  // A LINHA DE BASE DO CENÁRIO. Sem ela, o teste mediria outra coisa.
  expect(criado.userId, 'o atleta nasceu ligado à conta administrativa').toBe(admin.id);
});

describe('o cenário reproduzido: a conta administrativa virou o atleta', () => {
  it('"Meu Histórico" do admin mostra o atleta e o histórico importado', async () => {
    const pelaRota = await api().get('/api/v1/me/history').set(admin.auth());
    expect(pelaRota.status).toBe(200);
    expect(pelaRota.body.athlete, 'o admin tem um atleta resolvido').toBeTruthy();
    expect(pelaRota.body.athlete.id).toBe(atletaId);
    expect(pelaRota.body.total, 'e o histórico importado está lá').toBeGreaterThan(0);
    expect(pelaRota.body.totals.points).toBeGreaterThan(0);

    // E pelo serviço, com o ator completo, para cobrir também a chamada direta.
    const pelaFuncao = await withUserContext(admin.id, () =>
      meService.history({ id: admin.id, name: admin.name, role: admin.role }, {}));
    expect(pelaFuncao.athlete.id).toBe(atletaId);
  });

  it('a resolução é por userId, e NÃO por nome, CPF ou identidade', async () => {
    // A PROVA DO MECANISMO. Um segundo usuário com o MESMO NOME do atleta e sem
    // vínculo nenhum não resolve atleta — se a chave fosse o nome, resolveria.
    //
    // A CHAMADA É PELA ROTA HTTP, e não por `meService` com um ator fabricado à
    // mão. Medi a diferença: um mutante que fazia `atletaDoAtor` casar por
    // `fullName: actor.name` SOBREVIVEU à versão anterior deste teste, porque o
    // objeto que eu montava não tinha `name` — e `undefined` num filtro do
    // Prisma é "ignore este critério". O mutante era neutralizado pela minha
    // fixture, não pela guarda do produto.
    //
    // Pela rota, `req.user` vem do middleware de autenticação, com os campos
    // reais. É o único jeito de o teste medir o que o produto faz.
    const outra = await cadastrarPessoa(NOME);

    const resposta = await api().get('/api/v1/me/history').set(outra.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete, 'nome igual não basta').toBeNull();
    expect(resposta.body.items).toEqual([]);
    expect(resposta.body.total).toBe(0);

    // CONTROLE: a mesma rota, com o token de quem ESTÁ vinculado, devolve o
    // atleta. Sem isto o zero acima poderia ser a rota quebrada.
    const doAdmin = await api().get('/api/v1/me/history').set(admin.auth());
    expect(doAdmin.status).toBe(200);
    expect(doAdmin.body.athlete?.id, 'controle: o vinculado resolve').toBe(atletaId);
  });

  it('a DEFESA É DUPLA: a RLS esconde o atleta de quem não é dono nem membro', async () => {
    // MEDIÇÃO, e não afirmação. Contada SEM filtro nenhum, pelo contexto de um
    // usuário que não é dono do atleta nem membro da organização, a linha do
    // atleta é INVISÍVEL — é a política `atleta_da_organizacao`:
    //
    //     USING ("userId" = mci_current_user_id() OR mci_member_of("organizationId"))
    //
    // Isso importa para entender o que protege o quê. Um mutante que fizesse
    // `atletaDoAtor` casar por NOME em vez de `userId` sobrevive para este
    // usuário — não porque o filtro esteja certo, mas porque a RLS não entrega
    // a linha. As duas camadas se somam, e o teste seguinte mede a que sobra.
    const estranha = await cadastrarPessoa(NOME);

    const visiveis = await withUserContext(estranha.id, () => prisma.athlete.count());
    expect(visiveis, 'para quem não é dono nem membro, o atleta não existe').toBe(0);

    const doDono = await withUserContext(admin.id, () => prisma.athlete.count());
    expect(doDono, 'controle: para o dono, existe').toBeGreaterThan(0);
  });

  it('e para quem É MEMBRO da federação, o nome ainda não resolve atleta', async () => {
    // AQUI A RLS NÃO PROTEGE MAIS: um operador da organização VÊ a linha do
    // atleta. O que impede "Meu Histórico" dele de mostrar o atleta alheio é
    // só o filtro por `userId` — e é isto que este teste mede.
    //
    // O nome do usuário é IGUAL ao `fullName` do atleta, de propósito: é o
    // cenário exato em que uma resolução por nome acertaria a linha errada.
    const operadorHomonimo = await criarUsuario({ name: NOME });
    await vincular(organizationId, operadorHomonimo, 'EVENT_DIRECTOR');

    const vistos = await withUserContext(operadorHomonimo.id, () => prisma.athlete.count());
    expect(vistos, 'o membro VÊ o atleta — a RLS não é o que protege aqui').toBeGreaterThan(0);

    const meu = await api().get('/api/v1/me/history').set(operadorHomonimo.auth());
    expect(meu.status).toBe(200);
    expect(meu.body.athlete, 'nome igual não faz dele o atleta').toBeNull();
    expect(meu.body.total).toBe(0);
  });
});

describe('PATCH /athletes/:id com userId: null', () => {
  it('desvincula a conta e SOMENTE Athlete.userId muda', async () => {
    const atletaAntes = await retratoDoAtleta();
    const identidadeAntes = await retratoDaIdentidade();
    const ledgerAntes = await retratoDoLedger();

    expect(atletaAntes.userId).toBe(admin.id);
    expect(ledgerAntes.length, 'há histórico no ledger').toBeGreaterThan(0);
    expect(identidadeAntes, 'a identidade existe').toBeTruthy();

    // A OPERAÇÃO, pela rota real — não por um UPDATE direto no banco.
    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth())
      .send({ userId: null });

    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);

    const atletaDepois = await retratoDoAtleta();
    const identidadeDepois = await retratoDaIdentidade();
    const ledgerDepois = await retratoDoLedger();

    // 1. A ÚNICA MUDANÇA PERMITIDA no atleta.
    const mudancasNoAtleta = diferencas(atletaAntes, atletaDepois);
    expect(
      mudancasNoAtleta.map(m => m.campo),
      `mudou além do esperado: ${JSON.stringify(mudancasNoAtleta)}`
    ).toEqual(['userId']);
    expect(mudancasNoAtleta[0].de).toBe(admin.id);
    expect(mudancasNoAtleta[0].para).toBeNull();

    // 2. Os campos que o enunciado do gate nomeia, um por um e explicitamente —
    //    redundante com a asserção acima de propósito: se alguém afrouxar o
    //    retrato, estas continuam de pé.
    expect(atletaDepois.id, 'Athlete.id').toBe(atletaAntes.id);
    expect(atletaDepois.fullName, 'fullName').toBe(atletaAntes.fullName);
    expect(atletaDepois.affiliationId, 'affiliationId').toBe(atletaAntes.affiliationId);
    expect(atletaDepois.affiliationNumber, 'affiliationNumber').toBe(MATRICULA);
    expect(atletaDepois.status, 'status').toBe('ACTIVE');
    expect(atletaDepois.organizationId, 'organizationId').toBe(atletaAntes.organizationId);
    expect(atletaDepois.photoKey, 'photoKey').toBe(atletaAntes.photoKey);

    // 3. A IDENTIDADE — o CPF — intocada. Comparação de igualdade; o valor não
    //    é impresso em nenhum caminho, nem em falha.
    expect(diferencas(identidadeAntes, identidadeDepois), 'AthleteIdentity mudou').toEqual([]);

    // 4. O LEDGER, campo a campo. Nada mudou, nada nasceu, nada desapareceu.
    expect(diferencasDeLista(ledgerAntes, ledgerDepois), 'o ledger se moveu').toEqual([]);
    expect(ledgerDepois.length, 'quantidade de RankingPoint').toBe(ledgerAntes.length);
    expect(
      ledgerDepois.reduce((t, l) => t + l.points, 0),
      'soma de pontos'
    ).toBe(ledgerAntes.reduce((t, l) => t + l.points, 0));

    // 5. O histórico continua sendo DO ATLETA — o vínculo do ledger é
    //    `athleteId`, e ele não foi tocado.
    expect(ledgerDepois.every(l => l.athleteId === atletaId)).toBe(true);
  });

  it('depois disso, atletaDoAtor devolve null para a conta administrativa', async () => {
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });

    // PELA ROTA, com o ator real do middleware — mesma razão do teste acima.
    const pelaRota = await api().get('/api/v1/me/history').set(admin.auth());
    expect(pelaRota.status).toBe(200);
    expect(pelaRota.body.athlete, '"Meu Histórico" do admin volta a ser vazio').toBeNull();
    expect(pelaRota.body.items).toEqual([]);
    expect(pelaRota.body.total).toBe(0);
    expect(pelaRota.body.totals).toEqual({ participations: 0, placementPoints: 0, overallBonus: 0, points: 0 });

    // E "Minha Filiação" também, porque usa o mesmo resolvedor.
    const filiacao = await withUserContext(admin.id, () => meService.affiliation(admin));
    expect(filiacao.athlete).toBeNull();
  });

  it('o atleta continua consultável pela administração, com o histórico inteiro', async () => {
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });

    const perfil = await api().get(`/api/v1/athletes/${atletaId}`).set(admin.auth());
    expect(perfil.status).toBe(200);
    // A resposta é `{ athlete, registrations, proHistory, results, rankings }`,
    // e não o atleta na raiz. Medi isso com um `undefined`: `status 200` sozinho
    // não prova que a tela recebeu o atleta.
    expect(perfil.body.athlete, JSON.stringify(Object.keys(perfil.body))).toBeTruthy();
    expect(perfil.body.athlete.fullName).toBe(NOME);
    expect(perfil.body.athlete.affiliation.code).toBe('NPC');
    expect(perfil.body.athlete.userId, 'e a conta aparece desvinculada').toBeNull();
    // O HISTÓRICO DO ATLETA vem nesta mesma resposta, em `rankings`.
    expect(perfil.body.rankings, 'o histórico do atleta segue na resposta').toBeTruthy();

    const lista = await api().get('/api/v1/athletes').query({ organizationId }).set(admin.auth());
    expect(lista.status).toBe(200);
    expect(lista.body.items.map(a => a.id)).toContain(atletaId);
  });

  it('a operação é idempotente: aplicar de novo não faz nada', async () => {
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });
    const depoisDaPrimeira = await retratoDoAtleta();
    const ledger = await retratoDoLedger();

    const segunda = await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth())
      .send({ userId: null });
    expect(segunda.status).toBe(200);

    expect(diferencas(depoisDaPrimeira, await retratoDoAtleta())).toEqual([]);
    expect(diferencasDeLista(ledger, await retratoDoLedger())).toEqual([]);
  });

  it('a conta CORRETA do atleta pode ser vinculada depois, ao MESMO atleta', async () => {
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });
    const ledgerAntes = await retratoDoLedger();

    const pessoa = await cadastrarPessoa('A CONTA CERTA');
    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth())
      .send({ userId: pessoa.id });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);

    // O atleta é o MESMO, e o histórico não se moveu.
    const depois = await retratoDoAtleta();
    expect(depois.id).toBe(atletaId);
    expect(depois.userId).toBe(pessoa.id);
    expect(diferencasDeLista(ledgerAntes, await retratoDoLedger())).toEqual([]);

    // E agora é a conta DELA que vê o histórico — pela rota real.
    const dela = await api().get('/api/v1/me/history').set(pessoa.auth());
    expect(dela.status).toBe(200);
    expect(dela.body.athlete.id).toBe(atletaId);
    expect(dela.body.total).toBeGreaterThan(0);

    const doAdmin = await api().get('/api/v1/me/history').set(admin.auth());
    expect(doAdmin.body.athlete, 'e a do admin continua vazia').toBeNull();
  });

  it('a auditoria registra a mudança, nomeando o campo', async () => {
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: null });

    const linha = await comoAtor(admin, tx => tx.auditLog.findFirst({
      where: { action: 'ATHLETE_UPDATE', entityId: atletaId },
      orderBy: { createdAt: 'desc' },
      // O campo é `userId`, não `actorId`: em `AuditLog` quem agiu é `userId`,
      // com `user` como relação nomeada "AuditActor". Medi isso com um erro de
      // validação do Prisma.
      select: { userId: true, userEmail: true, metadata: true }
    }));

    expect(linha, 'a operação foi auditada').toBeTruthy();
    expect(linha.userId).toBe(admin.id);
    expect(linha.metadata.fields).toContain('userId');
  });
});

describe('RBAC: quem pode desvincular', () => {
  it('o atleta dono NÃO consegue mexer no próprio userId', async () => {
    // `userId` está em `camposRestritos`: o dono tem o campo SILENCIOSAMENTE
    // descartado, e não um 403. O que importa é que o vínculo não se mexe.
    const pessoa = await cadastrarPessoa('DONO');
    await api().patch(`/api/v1/athletes/${atletaId}`).set(admin.auth()).send({ userId: pessoa.id });

    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(pessoa.auth())
      .send({ userId: null });

    const depois = await retratoDoAtleta();
    expect(depois.userId, 'o dono não desvinculou a si mesmo').toBe(pessoa.id);
    expect([200, 403]).toContain(r.status);
  });

  it('operador de OUTRA federação não alcança o atleta', async () => {
    const outraOrg = (await criarOrganizacao(admin, { name: 'Federação Vizinha' })).id;
    const vizinho = await criarUsuario({ name: 'Operador Vizinho' });
    await vincular(outraOrg, vizinho, 'EVENT_DIRECTOR');

    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(vizinho.auth())
      .send({ userId: null });

    expect([403, 404]).toContain(r.status);
    expect((await retratoDoAtleta()).userId, 'o vínculo não mudou').toBe(admin.id);
  });

  it('conta sem vínculo nenhum não alcança o atleta', async () => {
    const qualquer = await cadastrarPessoa('SEM VÍNCULO');
    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(qualquer.auth())
      .send({ userId: null });

    expect([401, 403, 404]).toContain(r.status);
    expect((await retratoDoAtleta()).userId).toBe(admin.id);
  });

  it('sem token, a rota recusa', async () => {
    const r = await api().patch(`/api/v1/athletes/${atletaId}`).send({ userId: null });
    expect(r.status).toBe(401);
    expect((await retratoDoAtleta()).userId).toBe(admin.id);
  });

  it('operador COM athletes.update na federação dona consegue', async () => {
    // O CONTROLE POSITIVO. Sem ele, os quatro testes acima mediriam a chance de
    // a rota recusar qualquer um — e não a permissão certa autorizando.
    const diretor = await criarUsuario({ name: 'Diretora da Casa' });
    await vincular(organizationId, diretor, 'EVENT_DIRECTOR');

    const r = await api().patch(`/api/v1/athletes/${atletaId}`).set(diretor.auth())
      .send({ userId: null });

    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect((await retratoDoAtleta()).userId).toBeNull();
  });
});
