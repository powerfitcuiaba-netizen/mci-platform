import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const muscleWar = require('../src/services/muscleWarService.js');
const { vincularPendentesDoAtleta, resolverIdentidadeDoAtleta } = muscleWar;

// ============================================================================
// AS DUAS CHAVES QUE VINCULAM, E A ORDEM ENTRE ELAS.
//
// A regra oficial: o resultado histórico existe antes do cadastro, e quando a
// pessoa se cadastra o sistema procura o histórico dela por CPF OU, na
// ausência do CPF, por filiação + matrícula. Nome nunca vincula.
//
// POR QUE A PRIORIDADE É PROTEÇÃO, E NÃO PREFERÊNCIA
//
// CPF identifica uma PESSOA. Matrícula identifica um REGISTRO dentro de uma
// federação — e registro troca de dono: uma federação reaproveita número,
// corrige cadastro, transfere titularidade. Quando as duas chaves discordam,
// deixar a matrícula desempatar entregaria a carreira de uma pessoa a outra,
// em silêncio, e nenhuma revisão posterior desfaria: o ponto já estaria
// somando no ranking de quem não competiu.
//
// DOIS FATOS DO PRODUTO QUE ESTE ARQUIVO NÃO PODE CONTORNAR
//
// 1. CPF É OBRIGATÓRIO NO CADASTRO DE ATLETA (`athleteCreate` exige 11 a 14
//    caracteres). "Atleta sem CPF" não é estado produzível pela porta da
//    frente, então o cenário que pede isso é medido onde ele EXISTE de
//    verdade: no arquivo, que frequentemente não traz CPF, e na ausência da
//    linha de `AthleteIdentity`, que é o estado após um apagamento por LGPD.
//
// 2. O PEDIDO DE CADASTRO EXIGE FILIAÇÃO + MATRÍCULA (`athleteRequestCreate`).
//    O atleta com CPF e SEM matrícula só existe pelo cadastro feito por
//    operador, e é por ele que esse cenário é medido.
//
// Inventar fixture para estado que o produto não produz seria medir uma regra
// que ninguém escreveu.
// ============================================================================

const CLASSES = [
  "Men's Bodybuilding - Novice",
  "Men's Classic Physique - Open Class A",
  "Women's Bikini - Open Class A",
  "Women's Wellness - Open Class B",
  "Men's Physique - Open Class B"
];

let admin, gerente, organizationId, npc, outraFiliacao, seasonId;

// O cabeçalho traz `cpf` porque é a chave desta fase. Arquivo oficial nem
// sempre traz — e é justamente por isso que a outra chave continua existindo.
const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,cpf,Placing';

const linha = ({ n = 1, classe = CLASSES[0], primeiro, ultimo, matricula = '', cpf = '', colocacao = 1 }) =>
  `${n},${classe},${primeiro},${ultimo},${matricula},${cpf},${colocacao}`;

const csv = linhas => [CABECALHO, ...linhas].join('\n');

const importar = (conteudo, extras = {}) => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
  content: conteudo, externalIdPrefix: unico('QA').toUpperCase(), defaultAffiliationCode: 'NPC', ...extras
});

const aplicar = importId =>
  api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()).send({});

const noLedger = consulta => comoAtor(gerente, consulta);

const itens = importId => noLedger(tx => tx.muscleWarImportItem.findMany({
  where: { importId }, orderBy: { rowNumber: 'asc' },
  select: {
    id: true, rowNumber: true, athleteId: true, matchStatus: true, matchedBy: true,
    reason: true, memberNumber: true, cpf: true, athleteName: true
  }
}));

// Importa e aplica num passo: é o estado em que o vínculo tardio opera de
// verdade — histórico JÁ no ledger, pontuando, sem dono.
async function historicoAplicado(linhas) {
  const lote = await importar(csv(linhas));
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  const aplicacao = await aplicar(lote.body.import.id);
  expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
  return lote.body.import.id;
}

// O MESMO ARQUIVO, AINDA NÃO APLICADO.
//
// Conflito só é MARCÁVEL em linha pendente: linha já aplicada não vira
// CONFLICT por decisão de projeto — o resultado está no ledger e o rótulo não
// o desfaria, só esconderia o impasse. Então os dois estados precisam de
// fixture próprio, e medir o motivo do conflito exige este aqui.
async function historicoPendente(linhas, extras = {}) {
  const lote = await importar(csv(linhas), extras);
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  return lote.body.import.id;
}

// Cadastro pela porta do operador: CPF obrigatório, filiação/matrícula
// opcionais. É o único caminho que produz atleta COM CPF e SEM matrícula.
async function cadastrarPorOperador({ nome, cpf, matricula = null, affiliationId = null }) {
  const atleta = await criarAtleta(admin, organizationId, {
    fullName: nome, cpf, sex: 'MALE', birthDate: '1995-03-10',
    ...(matricula ? { affiliationId: affiliationId ?? npc.id, affiliationNumber: matricula } : {})
  });
  return {
    ...atleta, organizationId,
    affiliationId: matricula ? (affiliationId ?? npc.id) : null,
    affiliationNumber: matricula
  };
}

const vincularComo = (atleta, ator = gerente) =>
  comoAtor(ator, () => vincularPendentesDoAtleta(atleta, { id: ator.id }));

// QUANTAS LINHAS FICARAM COM ESTE DONO — e não quantas uma chamada específica
// vinculou.
//
// A diferença passou a importar quando o próprio cadastro passou a disparar o
// vínculo: contar o retorno de uma chamada MANUAL feita depois mediria zero e
// chamaria de falha um sistema que já tinha feito o trabalho. O que o produto
// promete é o estado final — o histórico desta pessoa é dela —, e é o estado
// que se mede.
const linhasDe = athleteId =>
  noLedger(tx => tx.muscleWarImportItem.count({ where: { athleteId } }));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  npc = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body;
  outraFiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'IFBB Brasil', code: 'IFBB' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

// --------------------------------------------------------------------- A
describe('A — CPF e matrícula batem: vincula, e o CPF é quem responde', () => {
  it('vincula automaticamente, e `matchedBy` registra CPF', async () => {
    const cpf = gerarCpf(111111111);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'MARIA', ultimo: 'DA SILVA', matricula: 'NPC-12345', cpf, colocacao: 1 })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'MARIA DA SILVA', cpf, matricula: 'NPC-12345'
    });
    const efeito = await vincularComo(atleta);
    expect(efeito.vinculados).toBe(1);
    expect(efeito.conflitos).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId).toBe(atleta.id);
    // AS DUAS CHAVES BATEM, E QUEM RESPONDE É O CPF. Não é detalhe de
    // registro: é a ordem que protege o caso em que elas discordam, e ela
    // precisa estar em vigor também quando concordam — senão não está em vigor.
    expect(item.matchedBy).toBe('CPF');
    expect(item.reason).toContain('CPF');
  });
});

// --------------------------------------------------------------------- B
describe('B — atleta com CPF e SEM matrícula: o CPF alcança sozinho', () => {
  it('vincula por CPF um histórico que tem matrícula que o cadastro não tem', async () => {
    const cpf = gerarCpf(222222222);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'JOANA', ultimo: 'SOUZA', matricula: 'NPC-12345', cpf, colocacao: 2 })
    ]);

    // Sem matrícula. Pela chave antiga esta pessoa era inalcançável — o
    // histórico dela ficaria para sempre sem dono, e era exatamente o buraco
    // que esta fase fecha.
    const atleta = await cadastrarPorOperador({ nome: 'JOANA SOUZA', cpf });
    expect(atleta.affiliationNumber).toBeNull();

    expect((await vincularComo(atleta)).vinculados).toBe(1);

    const [item] = await itens(importId);
    expect(item.athleteId).toBe(atleta.id);
    expect(item.matchedBy).toBe('CPF');

    // E O PONTO GANHOU DONO — reconhecer sem creditar não resolve nada.
    const pontos = await noLedger(tx => tx.rankingPoint.findMany({ where: { athleteId: atleta.id } }));
    expect(pontos).toHaveLength(1);
    expect(pontos[0].points).toBe(4);
  });
});

// --------------------------------------------------------------------- C
describe('C — arquivo SEM CPF: filiação + matrícula continua alcançando', () => {
  it('vincula por filiação + matrícula quando o arquivo não traz CPF', async () => {
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'CARLA', ultimo: 'LIMA', matricula: 'NPC-77777', cpf: '', colocacao: 3 })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'CARLA LIMA', cpf: gerarCpf(333333333), matricula: 'NPC-77777'
    });
    expect((await vincularComo(atleta)).vinculados).toBe(1);
    const [item] = await itens(importId);
    expect(item.athleteId).toBe(atleta.id);
    expect(item.matchedBy).toBe('AFFILIATION_NUMBER');
    expect(item.reason).toContain('filiação + matrícula');
  });
});

// --------------------------------------------------------------------- D
describe('D — CPF divergente na mesma matrícula: a matrícula NÃO desempata', () => {
  it('não vincula e registra CONFLITO', async () => {
    const cpfDoArquivo = gerarCpf(444444444);
    const cpfDoCadastro = gerarCpf(555555555);
    expect(cpfDoArquivo).not.toBe(cpfDoCadastro);

    const importId = await historicoPendente([
      linha({ n: 1, primeiro: 'PAULO', ultimo: 'ROCHA', matricula: 'NPC-90001', cpf: cpfDoArquivo })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'PAULO ROCHA', cpf: cpfDoCadastro, matricula: 'NPC-90001'
    });
    // NÃO VINCULOU. A matrícula bate, o nome bate, e mesmo assim o sistema
    // para — porque os dois lados afirmam CPFs diferentes para a mesma pessoa.
    expect((await vincularComo(atleta)).vinculados).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId).toBeNull();
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toContain('CPF divergente');

    // E O MOTIVO NÃO CARREGA NENHUM DOS DOIS NÚMEROS: o texto circula em log
    // e em listagem; o dado fica na tela de revisão, com quem tem permissão.
    expect(item.reason).not.toContain(cpfDoArquivo);
    expect(item.reason).not.toContain(cpfDoCadastro);

    const pontos = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: atleta.id } }));
    expect(pontos, 'conflito não pode creditar ponto a ninguém').toBe(0);
  });

  it('linha JÁ APLICADA com CPF divergente segue sem dono, sem virar rótulo', async () => {
    const cpfDoArquivo = gerarCpf(446644664);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'PAULO', ultimo: 'ROCHA', matricula: 'NPC-90002', cpf: cpfDoArquivo })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'PAULO ROCHA', cpf: gerarCpf(557755775), matricula: 'NPC-90002'
    });
    await vincularComo(atleta);

    const [item] = await itens(importId);
    // O resultado está no ledger: marcá-lo CONFLICT não o desfaria, só
    // esconderia o impasse num rótulo. Sem dono é o estado honesto.
    expect(item.athleteId).toBeNull();
    expect(item.matchStatus).toBe('APPLIED');
  });
});

// --------------------------------------------------------------------- E
describe('E — mesmo nome, CPF diferente: nome não vincula nada', () => {
  it('a homônima não leva o resultado da outra', async () => {
    const cpfDaPrimeira = gerarCpf(666666666);
    const cpfDaSegunda = gerarCpf(777777777);

    const importId = await historicoAplicado([
      // As matrículas existem porque o identificador externo é DERIVADO delas
      // — sem Member Number a linha não tem identidade e o lote a rejeita. Elas
      // são diferentes de propósito: o que separa as duas ANA SILVA aqui é o
      // CPF, e é ele que o teste mede.
      linha({ n: 1, classe: CLASSES[2], primeiro: 'ANA', ultimo: 'SILVA', matricula: 'NPC-A1', cpf: cpfDaPrimeira, colocacao: 1 }),
      linha({ n: 2, classe: CLASSES[3], primeiro: 'ANA', ultimo: 'SILVA', matricula: 'NPC-A2', cpf: cpfDaSegunda, colocacao: 2 })
    ]);

    const primeira = await cadastrarPorOperador({ nome: 'ANA SILVA', cpf: cpfDaPrimeira });
    // UMA linha, e é a dela. A outra ANA SILVA continua sem dono, porque o
    // que as separa é o CPF e não o nome.
    expect((await vincularComo(primeira)).vinculados).toBe(1);

    const linhas = await itens(importId);
    const dela = linhas.filter(i => i.athleteId === primeira.id);
    expect(dela).toHaveLength(1);
    expect(dela[0].cpf).toBe(cpfDaPrimeira);
    expect(linhas.filter(i => i.athleteId === null)).toHaveLength(1);
  });

  it('nome idêntico e nenhuma chave em comum não vincula NADA', async () => {
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'BRUNO', ultimo: 'CARDOSO', matricula: 'NPC-55555', cpf: gerarCpf(888888888) })
    ]);

    // Mesmo nome, CPF diferente, matrícula diferente. Só o nome coincide.
    const impostor = await cadastrarPorOperador({
      nome: 'BRUNO CARDOSO', cpf: gerarCpf(999999999), matricula: 'NPC-00000'
    });
    expect((await vincularComo(impostor)).vinculados).toBe(0);
    const [item] = await itens(importId);
    expect(item.athleteId).toBeNull();
  });
});

// --------------------------------------------------------------------- F
describe('F — dois candidatos para a mesma identidade: conflito, nunca escolha', () => {
  it('matrícula com dois donos na organização não entrega o histórico a nenhum', async () => {
    // OS DOIS DONOS EXISTEM ANTES DO HISTÓRICO ENTRAR.
    //
    // A ordem é a regra sendo medida: com um dono só, a matrícula é chave
    // inequívoca e o cadastro leva o resultado — correto. A ambiguidade nasce
    // quando o SEGUNDO aparece. Importar antes de os dois existirem mediria o
    // caso fácil e chamaria de prova.
    const primeiro = await cadastrarPorOperador({
      nome: 'DOIS DONOS', cpf: gerarCpf(121212121), matricula: 'NPC-31313'
    });
    const segundo = await cadastrarPorOperador({
      nome: 'OUTRO NOME', cpf: gerarCpf(131313131), matricula: 'NPC-31313'
    });
    expect(segundo.id).not.toBe(primeiro.id);

    const importId = await historicoPendente([
      linha({ n: 1, primeiro: 'DOIS', ultimo: 'DONOS', matricula: 'NPC-31313', cpf: '' })
    ]);

    await vincularComo(primeiro);
    expect(await linhasDe(primeiro.id)).toBe(0);
    expect(await linhasDe(segundo.id)).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId).toBeNull();
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toContain('mais de um atleta');
  });

  it('o banco impede dois cadastros com o mesmo CPF na mesma organização', async () => {
    const cpf = gerarCpf(141414141);
    await cadastrarPorOperador({ nome: 'PRIMEIRA PESSOA', cpf });

    // Unicidade de (organização, CPF) em `AthleteIdentity`: a ambiguidade por
    // CPF não precisa de guarda no código porque o banco não a deixa existir.
    const repetido = await api().post('/api/v1/athletes').set(admin.auth()).send({
      organizationId, fullName: 'SEGUNDA PESSOA', cpf, sex: 'MALE', birthDate: '1990-01-01'
    });
    expect([409, 422]).toContain(repetido.status);

    const quantos = await noLedger(tx => tx.athleteIdentity.count({ where: { organizationId, cpf } }));
    expect(quantos).toBe(1);
  });
});

// --------------------------------------------------------------------- G
describe('G — sem nenhuma das duas chaves: permanece pendente', () => {
  it('cadastro sem CPF e sem matrícula não alcança linha nenhuma', async () => {
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'SEM', ultimo: 'CHAVE', matricula: 'NPC-24680', cpf: gerarCpf(151515151) })
    ]);

    const atleta = await cadastrarPorOperador({ nome: 'SEM CHAVE', cpf: gerarCpf(161616161) });

    // CPF É OBRIGATÓRIO NO CADASTRO, então "atleta sem CPF" só existe depois de
    // um apagamento — que é estado real, previsto pela LGPD. É ele que se mede
    // aqui, e não um fixture inventado.
    await noLedger(tx => tx.athleteIdentity.deleteMany({ where: { athleteId: atleta.id } }));

    const resolucao = await comoAtor(gerente, () => resolverIdentidadeDoAtleta(atleta));
    expect(resolucao.cpf).toBeNull();
    expect(resolucao.filiacao).toBeNull();
    expect(resolucao.candidatos).toEqual([]);

    expect((await vincularComo(atleta)).vinculados).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId, 'o histórico continua existindo, e continua sem dono').toBeNull();
    expect(item.matchStatus).toBe('APPLIED');
  });
});

// --------------------------------------------------------------------- H
describe('H — histórico já vinculado: nenhuma duplicação', () => {
  it('vincular de novo não cria linha, ponto nem identidade', async () => {
    const cpf = gerarCpf(171717171);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'JA', ultimo: 'VINCULADO', matricula: 'NPC-50505', cpf })
    ]);

    const atleta = await cadastrarPorOperador({ nome: 'JA VINCULADO', cpf, matricula: 'NPC-50505' });
    expect((await vincularComo(atleta)).vinculados).toBe(1);

    const antes = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));

    // Três vezes: a segunda e a terceira não podem ter efeito nenhum.
    for (let i = 0; i < 3; i += 1) {
      expect((await vincularComo(atleta)).vinculados).toBe(0);
    }

    const depois = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));

    expect(depois).toEqual(antes);
  });
});

// --------------------------------------------------------------- §5 / §13
describe('§5 o CPF nunca é procurado globalmente', () => {
  it('o MESMO CPF em duas organizações são duas identidades, e nenhuma alcança a outra', async () => {
    const cpf = gerarCpf(181818181);

    // Histórico na organização A.
    const importA = await historicoAplicado([
      linha({ n: 1, primeiro: 'PESSOA', ultimo: 'DA A', matricula: 'NPC-60606', cpf })
    ]);

    // Federação B, com o MESMO CPF cadastrado. É caso real: a mesma pessoa
    // pode competir por duas federações.
    const orgB = await criarOrganizacao(admin, { name: 'Federação Vizinha' });
    const gerenteB = await criarUsuario({ name: 'Gerente de B' });
    await vincular(orgB.id, gerenteB, 'RANKING_MANAGER');
    await vincular(orgB.id, gerenteB, 'REGISTRATION_OPERATOR');

    const atletaDeB = await criarAtleta(admin, orgB.id, {
      fullName: 'PESSOA DA A', cpf, sex: 'MALE', birthDate: '1995-03-10'
    });

    // O cadastro de B tenta alcançar o histórico de A, pelo mesmo CPF.
    const efeito = await comoAtor(gerenteB, () => vincularPendentesDoAtleta(
      { ...atletaDeB, organizationId: orgB.id, affiliationId: null, affiliationNumber: null },
      { id: gerenteB.id }
    ));

    expect(efeito.vinculados, 'CPF de B não pode alcançar histórico de A').toBe(0);

    const [item] = await itens(importA);
    expect(item.athleteId, 'o histórico de A não pode ter sido tocado por B').toBeNull();

    // A MESMA PESSOA, AGORA CADASTRADA EM A. O isolamento tem de barrar o
    // vizinho sem barrar o dono — e o cadastro dela em A entra só agora
    // justamente para que a asserção acima seja sobre B, e não sobre ordem.
    const atletaDeA = await cadastrarPorOperador({ nome: 'PESSOA DA A', cpf, matricula: 'NPC-60606' });
    expect((await vincularComo(atletaDeA)).vinculados).toBe(1);
    expect((await itens(importA))[0].athleteId).toBe(atletaDeA.id);

    // E as duas identidades cadastrais coexistem, cada uma na sua organização.
    const naA = await noLedger(tx => tx.athleteIdentity.count({ where: { organizationId, cpf } }));
    const naB = await comoAtor(gerenteB, tx => tx.athleteIdentity.count({ where: { organizationId: orgB.id, cpf } }));
    expect(naA).toBe(1);
    expect(naB).toBe(1);
  });

  it('a mesma MATRÍCULA em outra organização também não atravessa', async () => {
    const importA = await historicoAplicado([
      linha({ n: 1, primeiro: 'MATRICULA', ultimo: 'REPETIDA', matricula: 'NPC-70707', cpf: '' })
    ]);

    const orgB = await criarOrganizacao(admin, { name: 'Outra Federação' });
    const gerenteB = await criarUsuario({ name: 'Gerente de B2' });
    await vincular(orgB.id, gerenteB, 'RANKING_MANAGER');
    await vincular(orgB.id, gerenteB, 'REGISTRATION_OPERATOR');
    const filiacaoB = (await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId: orgB.id, name: 'NPC Vizinha', code: 'NPC' })).body;

    const atletaDeB = await criarAtleta(admin, orgB.id, {
      fullName: 'MATRICULA REPETIDA', cpf: gerarCpf(191919191), sex: 'MALE',
      birthDate: '1995-03-10', affiliationId: filiacaoB.id, affiliationNumber: 'NPC-70707'
    });

    const efeito = await comoAtor(gerenteB, () => vincularPendentesDoAtleta(
      { ...atletaDeB, organizationId: orgB.id, affiliationId: filiacaoB.id, affiliationNumber: 'NPC-70707' },
      { id: gerenteB.id }
    ));
    expect(efeito.vinculados).toBe(0);

    const [item] = await itens(importA);
    expect(item.athleteId).toBeNull();
  });

  it('filiação de OUTRA organização não é chave: a resolução a descarta', async () => {
    const atleta = await cadastrarPorOperador({
      nome: 'FILIACAO DE FORA', cpf: gerarCpf(202020202), matricula: 'NPC-80808'
    });

    const orgB = await criarOrganizacao(admin, { name: 'Terceira Federação' });
    const filiacaoDeB = (await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId: orgB.id, name: 'Externa', code: 'EXT' })).body;

    // A filiação apontada pertence a OUTRA organização. Ela não pode virar
    // chave de busca — seria ler dado de outro tenant para decidir neste.
    const resolucao = await comoAtor(gerente, () => resolverIdentidadeDoAtleta({
      ...atleta, affiliationId: filiacaoDeB.id, affiliationNumber: 'NPC-80808'
    }));
    expect(resolucao.filiacao).toBeNull();
  });

  it('CPF inexistente no histórico deixa tudo pendente', async () => {
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'NINGUEM', ultimo: 'CONHECE', matricula: 'NPC-11011', cpf: gerarCpf(212121212) })
    ]);

    const estranho = await cadastrarPorOperador({ nome: 'OUTRA PESSOA', cpf: gerarCpf(232323232) });
    expect((await vincularComo(estranho)).vinculados).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId).toBeNull();
  });
});

// ------------------------------------------------------------------- §9
describe('§9 o vínculo preserva a pontuação, número por número', () => {
  // Cada pessoa acumula um total diferente, montado com a tabela homologada:
  // 1º=5, 2º=4, 3º=3, 4º=2, 5º=1. Os totais pedidos — 1, 3, 5, 10 e 23 — são
  // compostos com colocações reais, em classes diferentes, porque duas
  // primeiras colocações na MESMA classe não é resultado, é erro de arquivo.
  const PERFIS = [
    { nome: 'UM PONTO', colocacoes: [5], total: 1 },
    { nome: 'TRES PONTOS', colocacoes: [3], total: 3 },
    { nome: 'CINCO PONTOS', colocacoes: [1], total: 5 },
    { nome: 'DEZ PONTOS', colocacoes: [1, 1], total: 10 },
    { nome: 'VINTE E TRES', colocacoes: [1, 1, 1, 2, 2], total: 23 }
  ];

  it('1, 3, 5, 10 e 23 pontos continuam exatamente os mesmos depois do vínculo', async () => {
    const cpfs = PERFIS.map((_, i) => gerarCpf(240000000 + i * 1111));
    const linhas = [];
    let n = 0;

    PERFIS.forEach((perfil, iPerfil) => {
      perfil.colocacoes.forEach((colocacao, iResultado) => {
        n += 1;
        linhas.push(linha({
          n,
          classe: CLASSES[iResultado % CLASSES.length],
          primeiro: perfil.nome.split(' ')[0],
          ultimo: `P${iPerfil}`,
          matricula: `NPC-9${iPerfil}${iResultado}`,
          cpf: cpfs[iPerfil],
          colocacao
        }));
      });
    });

    await historicoAplicado(linhas);

    // ANTES: todo mundo sem dono, com o total que a tabela manda.
    const somaPorCpf = async () => {
      const externos = await noLedger(tx => tx.externalAthlete.findMany({ select: { id: true } }));
      expect(externos.length).toBeGreaterThan(0);
      return (await noLedger(tx => tx.rankingPoint.aggregate({ _sum: { points: true } })))._sum.points;
    };
    const somaAntes = await somaPorCpf();
    expect(somaAntes).toBe(PERFIS.reduce((s, p) => s + p.total, 0));

    // Cada pessoa se cadastra e leva EXATAMENTE o total que já era dela.
    for (const [i, perfil] of PERFIS.entries()) {
      const atleta = await cadastrarPorOperador({ nome: perfil.nome, cpf: cpfs[i] });
      expect((await vincularComo(atleta)).vinculados,
        `${perfil.nome} devia vincular ${perfil.colocacoes.length} linha(s)`)
        .toBe(perfil.colocacoes.length);

      const dela = await noLedger(tx => tx.rankingPoint.aggregate({
        _sum: { points: true }, where: { athleteId: atleta.id }
      }));
      expect(dela._sum.points, `${perfil.nome} devia somar ${perfil.total}`).toBe(perfil.total);
    }

    // E O TOTAL DA TEMPORADA NÃO MUDOU. Vincular diz QUEM; não cria, não
    // recalcula, não soma.
    expect(await somaPorCpf()).toBe(somaAntes);
  }, 120_000);

  it('o vínculo não cria lançamento nem identidade nova', async () => {
    const cpf = gerarCpf(252525252);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'NADA', ultimo: 'NOVO', matricula: 'NPC-40404', cpf })
    ]);

    const antes = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      atletas: await tx.athlete.count()
    }));

    const atleta = await cadastrarPorOperador({ nome: 'NADA NOVO', cpf });
    await vincularComo(atleta);

    const depois = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      atletas: await tx.athlete.count()
    }));

    expect(depois.pontos).toBe(antes.pontos);
    expect(depois.externos).toBe(antes.externos);
    expect(depois.identidades).toBe(antes.identidades);
    // Um atleta a mais — o que acabou de se cadastrar. E nenhum criado pelo vínculo.
    expect(depois.atletas).toBe(antes.atletas + 1);
  });
});

// ------------------------------------------------------------------ §10
describe('§10 o ranking troca o nome da fonte pelo do cadastro, e nada mais', () => {
  it('uma linha antes, uma linha depois, mesma pontuação', async () => {
    const cpf = gerarCpf(262626262);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'RENATA', ultimo: 'DIAS', matricula: 'NPC-13579', cpf, colocacao: 1 })
    ]);

    const antes = await api().get('/api/v1/ranking').query({ seasonId });
    expect(antes.status).toBe(200);
    const linhasAntes = antes.body.items;
    expect(linhasAntes).toHaveLength(1);
    expect(linhasAntes[0].athlete.id, 'sem cadastro, sem perfil para abrir').toBeNull();
    expect(linhasAntes[0].athlete.fullName).toContain('RENATA');
    const pontosAntes = linhasAntes[0].totalPoints;

    const atleta = await cadastrarPorOperador({ nome: 'RENATA DIAS CADASTRO', cpf });
    await vincularComo(atleta);

    const depois = await api().get('/api/v1/ranking').query({ seasonId });
    expect(depois.status).toBe(200);

    // UMA LINHA. Não duas: o competidor externo e o cadastro são a mesma
    // pessoa, e o ranking precisa mostrar isso.
    expect(depois.body.items).toHaveLength(1);
    expect(depois.body.items[0].athlete.id).toBe(atleta.id);
    expect(depois.body.items[0].athlete.fullName).toBe('RENATA DIAS CADASTRO');
    expect(depois.body.items[0].totalPoints).toBe(pontosAntes);
  });

  it('o CPF não aparece no ranking público, em forma nenhuma', async () => {
    const cpf = gerarCpf(272727272);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'SIGILO', ultimo: 'TOTAL', matricula: 'NPC-86420', cpf })
    ]);
    const atleta = await cadastrarPorOperador({ nome: 'SIGILO TOTAL', cpf });
    await vincularComo(atleta);

    for (const rota of ['/api/v1/ranking', '/api/v1/ranking/super-overall',
      '/api/v1/ranking/teams', '/api/v1/ranking/companies']) {
      const r = await api().get(rota).query({ seasonId });
      expect(r.status, rota).toBe(200);
      const corpo = JSON.stringify(r.body);
      expect(corpo, `${rota} vazou o CPF`).not.toContain(cpf);
      // E nem em pedaços: os 9 primeiros dígitos também não podem sair.
      expect(corpo, `${rota} vazou parte do CPF`).not.toContain(cpf.slice(0, 9));
    }

    // A projeção pública não guarda CPF em coluna nenhuma.
    const projecao = await noLedger(tx => tx.publicRankingEntry.findMany({ where: { seasonId } }));
    expect(projecao.length).toBeGreaterThan(0);
    expect(JSON.stringify(projecao)).not.toContain(cpf);
  });

  it('a auditoria registra a CHAVE, nunca o número', async () => {
    const cpf = gerarCpf(282828282);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'AUDITADA', ultimo: 'POR CHAVE', matricula: 'NPC-97531', cpf })
    ]);
    const atleta = await cadastrarPorOperador({ nome: 'AUDITADA POR CHAVE', cpf });
    await vincularComo(atleta);

    const registros = await noLedger(tx => tx.auditLog.findMany({
      where: { action: 'RESULTADO_EXTERNAL_LINKED' }
    }));
    expect(registros.length).toBeGreaterThan(0);

    const tudo = JSON.stringify(registros);
    expect(tudo, 'audit log não pode carregar CPF').not.toContain(cpf);
    // Mas tem de dizer POR QUE vinculou — senão a auditoria não audita nada.
    expect(tudo).toContain('CPF');
    expect(tudo).toContain('AUTO_LINK_CPF');
  });
});

// ------------------------------------------------------------------- §8
describe('§8 concorrência: vinte aprovações, um vínculo', () => {
  it('vinte chamadas simultâneas por CPF produzem UM vínculo e nada mais', async () => {
    const cpf = gerarCpf(292929292);
    await historicoAplicado([
      // Matrícula no ARQUIVO (o identificador externo é derivado dela), e
      // nenhuma matrícula no CADASTRO: só o CPF alcança estas duas linhas.
      linha({ n: 1, classe: CLASSES[0], primeiro: 'CORRIDA', ultimo: 'POR CPF', matricula: 'NPC-C1', cpf, colocacao: 1 }),
      linha({ n: 2, classe: CLASSES[1], primeiro: 'CORRIDA', ultimo: 'POR CPF', matricula: 'NPC-C2', cpf, colocacao: 2 })
    ]);

    const antes = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));
    expect(antes.pontos).toBe(2);

    // O cadastro pelo operador NÃO dispara o vínculo (ver o bloco sobre as
    // portas): as vinte chamadas abaixo disputam de verdade as mesmas duas
    // linhas, que é o que este teste existe para medir.
    const atleta = await cadastrarPorOperador({ nome: 'CORRIDA POR CPF', cpf });
    expect(await linhasDe(atleta.id)).toBe(0);

    const respostas = await Promise.allSettled(
      Array.from({ length: 20 }, () => vincularComo(atleta))
    );

    const falhas = respostas.filter(r => r.status === 'rejected');
    expect(falhas.map(f => String(f.reason?.message ?? f.reason)),
      'corrida não pode virar exceção').toEqual([]);

    const efetivos = respostas.filter(r => r.status === 'fulfilled').map(r => r.value.vinculados);
    // As duas linhas desta pessoa, vinculadas UMA vez — por uma das vinte
    // chamadas. As outras dezenove contam zero, que é o que idempotência
    // significa: repetir não tem efeito.
    expect(efetivos.reduce((s, n) => s + n, 0)).toBe(2);
    expect(efetivos.filter(n => n > 0)).toHaveLength(1);

    const depois = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));
    expect(depois).toEqual(antes);

    const donos = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: atleta.id } }));
    expect(donos).toBe(2);
  }, 180_000);
});

// ------------------------------------------------------- a ordem em vigor
describe('a prioridade em vigor: o que o CPF vence e o que ele não vence', () => {
  it('filiação divergente NÃO desfaz o CPF — atleta troca de federação, pessoa não', async () => {
    const cpf = gerarCpf(313131313);

    // O arquivo é de uma etapa da IFBB; o cadastro hoje está na NPC. Pela
    // chave de matrícula isso seria divergência e viraria conflito. Pelo CPF
    // é a mesma pessoa, e é: gente muda de federação.
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'TROCOU', ultimo: 'DE FEDERACAO', matricula: 'IFBB-1234', cpf })
    ], { defaultAffiliationCode: 'IFBB' });

    const atleta = await cadastrarPorOperador({
      nome: 'TROCOU DE FEDERACAO', cpf, matricula: 'IFBB-1234', affiliationId: npc.id
    });

    expect((await vincularComo(atleta)).vinculados,
      'o CPF identifica a pessoa, e ela é a mesma').toBe(1);

    const [item] = await itens(importId);
    expect(item.matchedBy).toBe('CPF');
    expect(item.athleteId).toBe(atleta.id);
  });

  it('SEM CPF no arquivo, filiação divergente volta a ser conflito', async () => {
    // A mesma divergência, agora sem CPF para resolvê-la. Aqui a matrícula é
    // tudo o que existe, e ela sozinha não basta contra uma federação que não
    // confere.
    // O arquivo é de uma etapa da NPC; o cadastro está na IFBB. Mesma
    // matrícula, federações diferentes, e nenhum CPF para dizer quem é quem.
    const importId = await historicoPendente([
      linha({ n: 1, primeiro: 'SEM', ultimo: 'DESEMPATE', matricula: 'NPC-5678', cpf: '' })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'SEM DESEMPATE', cpf: gerarCpf(323232323),
      matricula: 'NPC-5678', affiliationId: outraFiliacao.id
    });

    expect((await vincularComo(atleta)).vinculados).toBe(0);

    const [item] = await itens(importId);
    expect(item.athleteId).toBeNull();
    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toContain('Filiação divergente');
  });

  it('a mesma linha alcançada pelas DUAS chaves conta uma vez só', async () => {
    const cpf = gerarCpf(343434343);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'DUAS', ultimo: 'CHAVES', matricula: 'NPC-20202', cpf })
    ]);

    const atleta = await cadastrarPorOperador({
      nome: 'DUAS CHAVES', cpf, matricula: 'NPC-20202'
    });

    const resolucao = await comoAtor(gerente, () => resolverIdentidadeDoAtleta(atleta));
    // UM candidato, não dois: a linha é a mesma, alcançada por dois caminhos.
    // Contá-la duas vezes faria o laço tentar vinculá-la duas vezes e o
    // segundo `updateMany` contar zero — funcionaria, e mentiria no número.
    expect(resolucao.candidatos).toHaveLength(1);
    expect(resolucao.candidatos[0].chave).toBe('CPF');

    expect((await vincularComo(atleta)).vinculados).toBe(1);
    const [item] = await itens(importId);
    expect(item.athleteId).toBe(atleta.id);
  });
});

// ------------------------------------------------------ o anônimo e o CPF
describe('o anônimo não alcança o CPF por caminho nenhum', () => {
  it('nem pelo ledger, nem pela identidade cadastral, nem pela projeção', async () => {
    const cpf = gerarCpf(353535353);
    await historicoAplicado([
      linha({ n: 1, primeiro: 'PRIVADA', ultimo: 'SEMPRE', matricula: 'NPC-30303', cpf })
    ]);
    const atleta = await cadastrarPorOperador({ nome: 'PRIVADA SEMPRE', cpf });
    await vincularComo(atleta);

    // `prisma` fora de `comoAtor` é o leitor SEM ator: é o que as políticas
    // enxergam quando ninguém está autenticado.
    expect(await prisma.athleteIdentity.count()).toBe(0);
    expect(await prisma.muscleWarImportItem.count()).toBe(0);
    expect(await prisma.externalResult.count()).toBe(0);
    expect(await prisma.rankingPoint.count()).toBe(0);
    expect(await prisma.externalAthlete.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);

    // E o ranking, que o anônimo LÊ, continua respondendo — sem o CPF.
    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(ranking.body)).not.toContain(cpf);
  });
});

// ------------------------------- a porta que o vínculo automático escuta
describe('por onde o vínculo automático é disparado', () => {
  it('a aprovação do pedido dispara sozinha, por CPF', async () => {
    const cpf = gerarCpf(373737373);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'PEDIU', ultimo: 'E FOI APROVADO', matricula: 'NPC-70002', cpf, colocacao: 2 })
    ]);

    const pessoa = await criarUsuario({ name: 'PEDIU E FOI APROVADO' });
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: 'PEDIU E FOI APROVADO', cpf, sex: 'MALE', birthDate: '1995-03-10',
      affiliationId: npc.id, affiliationNumber: 'NPC-70002'
    });
    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 300)).toBe(201);

    const aprovado = await api().post(`/api/v1/athlete-requests/${pedido.body.id}/approve`)
      .set(admin.auth()).send({});
    expect(aprovado.status, JSON.stringify(aprovado.body).slice(0, 300)).toBe(200);

    // NINGUÉM CHAMOU O VÍNCULO NA MÃO. A aprovação o disparou, e a chave que
    // respondeu foi o CPF.
    const [item] = await itens(importId);
    expect(item.athleteId).not.toBeNull();
    expect(item.matchedBy).toBe('CPF');
  });

  it('o cadastro feito pelo OPERADOR não dispara — e isso é lacuna conhecida', async () => {
    const cpf = gerarCpf(363636363);
    const importId = await historicoAplicado([
      linha({ n: 1, primeiro: 'CADASTRO', ultimo: 'PELO OPERADOR', matricula: 'NPC-70001', cpf })
    ]);

    // `POST /athletes` cria o atleta e NÃO procura o histórico dele. Quem entra
    // por aqui — o atleta antigo que a federação cadastra em lote, o que
    // perdeu o acesso, o que nunca usou o aplicativo — fica com o resultado no
    // ranking sem dono até alguém agir.
    //
    // ISTO ESTÁ MEDIDO E NÃO CORRIGIDO, DE PROPÓSITO. A correção óbvia —
    // disparar o vínculo na criação — foi implementada, medida, e REVERTIDA:
    // ela reprovou `historico-antes-do-cadastro > MATRÍCULA COM DOIS DONOS`.
    // O motivo é a regra que o projeto trata como absoluta: no instante da
    // criação a matrícula tem um dono só, o vínculo parece inequívoco e
    // acontece; o segundo dono aparece depois e o histórico já foi creditado.
    // Vínculo por ordem de chegada, que é o que nunca se pode fazer.
    //
    // O teste fica aqui fixando o comportamento REAL, para que a lacuna seja
    // visível e a decisão sobre ela seja de quem revisa — não uma surpresa.
    const atleta = await criarAtleta(admin, organizationId, {
      fullName: 'CADASTRO PELO OPERADOR', cpf, sex: 'MALE', birthDate: '1995-03-10'
    });

    expect(await linhasDe(atleta.id), 'o cadastro pelo operador não vincula sozinho').toBe(0);

    // E o vínculo continua disponível: chamado, ele funciona.
    await vincularComo(atleta);
    const [item] = await itens(importId);
    expect(item.athleteId).toBe(atleta.id);
    expect(item.matchedBy).toBe('CPF');
  });
});
