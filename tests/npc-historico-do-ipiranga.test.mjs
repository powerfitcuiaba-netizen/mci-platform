import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, comoAtor, unico, gerarCpf
} from './helpers.mjs';
import filiacaoOficial from '../src/services/officialAffiliationService.js';
import { withUserContext } from '../src/config/rlsSession.js';

// ============================================================================
// O HISTÓRICO IMPORTADO SOBREVIVE AO AUTOCADASTRO — GATE OBRIGATÓRIO.
//
// O CENÁRIO É O DO IPIRANGA: uma etapa importada e aplicada ANTES de qualquer
// atleta existir, com matrícula por competidor, `athleteId` nulo no ledger e a
// identidade em `ExternalAthlete`. Em produção são 191 linhas; aqui o formato e
// as chaves são os mesmos, o volume é o que cabe numa suíte.
//
// O QUE ESTE ARQUIVO TRAVA
//
// Depois de o atleta se autocadastrar pela NPC e a conciliação vincular, UM
// ÚNICO CAMPO pode ter mudado no ledger:
//
//     RankingPoint.athleteId : null -> Athlete.id
//
// Todo o resto — id, points, placing, categoryId, catalogClassId, seasonId,
// eventId, sourceKey, adjustmentPoints, overallBonus, superOverallPoints,
// didNotShow, voidedAt — precisa sair EXATAMENTE como entrou. A comparação é
// campo a campo, sobre o retrato inteiro, e não por amostragem: vincular não é
// repontuar, e o único jeito de provar isso é olhar tudo.
//
// NADA É REIMPORTADO, nenhum lançamento é criado, nenhum ponto é recalculado.
// ============================================================================

// Os campos do retrato. TODOS os que o enunciado do gate pede, mais os que
// carregam pontuação — se um deles se mover, o vínculo virou repontuação.
const CAMPOS = Object.freeze({
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
  source: true
});

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Country,Age,ClassIndex,Total Score,Placing';
const CLASSES = ["Women's Bikini - Open Class A", "Men's Physique - Open Class B"];
const LINHAS = 10;

// A matrícula da competidora que vai se cadastrar. Fixa, porque é a chave que a
// conciliação tem de encontrar.
const MATRICULA_ALVO = 'QA-100003';
const NOME_ALVO = 'QA4 DA SILVA';

function arquivoDaEtapa() {
  const linhas = [CABECALHO];
  for (let i = 0; i < LINHAS; i += 1) {
    linhas.push([
      i + 1, CLASSES[i % 2], `QA${i + 1}`, 'DA SILVA',
      `QA-${100000 + i}`, 'Brazil', 25, 1, '90.0', (Math.floor(i / 2) % 5) + 1
    ].join(','));
  }
  return linhas.join('\n');
}

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

const cadastrarPessoa = async nome => {
  const email = `${unico('pessoa')}@mci.test`;
  const r = await api().post('/api/v1/auth/register').send({ ...CONTATO, name: nome, email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.user.id, email, auth: () => ({ Authorization: `Bearer ${r.body.token}` }) };
};

/** O retrato do ledger inteiro, ordenado, para comparação campo a campo. */
const retrato = () => comoAtor(gerente, tx => tx.rankingPoint.findMany({
  select: CAMPOS, orderBy: { id: 'asc' }
}));

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Diretoria' });
  // FECHADO, como produção. O provisionamento é que abre.
  organizationId = (await criarOrganizacao(admin, {
    name: 'Federação Oficial', autocadastroAberto: false
  })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  // A ENTIDADE OFICIAL PELO PROVISIONAMENTO, e não por um INSERT de fixture: o
  // que está sob teste inclui a entidade ter nascido do caminho real.
  const provisionada = await withUserContext(admin.id, () =>
    filiacaoOficial.provisionar(organizationId, admin));
  expect(provisionada.estado).toBe(filiacaoOficial.ESTADOS.CORRETO);
  npc = { id: provisionada.affiliationId, code: provisionada.affiliationCode };

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  // A ETAPA, importada e APLICADA com a base de atletas vazia — o estado do
  // Ipiranga. `defaultAffiliationCode` amarra as matrículas à NPC, que é o que
  // torna a conciliação por filiação possível depois.
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('ipiranga') + '.csv',
    content: arquivoDaEtapa(), externalIdPrefix: 'IPIRANGA',
    defaultAffiliationCode: npc.code
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 400)).toBe(201);

  const aplicado = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
    .set(gerente.auth());
  expect(aplicado.status, JSON.stringify(aplicado.body).slice(0, 400)).toBe(200);
  expect(aplicado.body.applied).toBe(LINHAS);

  expect(await prisma.athlete.count(), 'nenhum atleta: é o estado do Ipiranga').toBe(0);
});

/**
 * Compara dois retratos e devolve as diferenças, campo a campo.
 *
 * Devolver a LISTA de diferenças, e não um booleano, é o que faz a reprovação
 * dizer ONDE — um `toEqual` sobre o retrato inteiro despejaria dez linhas de
 * JSON e mandaria procurar.
 */
function diferencas(antes, depois) {
  const achados = [];
  const porId = new Map(depois.map(l => [l.id, l]));

  for (const linha of antes) {
    const nova = porId.get(linha.id);
    if (!nova) { achados.push({ id: linha.id, campo: '(linha desapareceu)' }); continue; }
    for (const campo of Object.keys(CAMPOS)) {
      const a = linha[campo] instanceof Date ? linha[campo].toISOString() : linha[campo];
      const b = nova[campo] instanceof Date ? nova[campo].toISOString() : nova[campo];
      if (a !== b) achados.push({ id: linha.id, campo, de: a, para: b });
    }
  }

  for (const nova of depois) {
    if (!antes.some(l => l.id === nova.id)) achados.push({ id: nova.id, campo: '(linha nova)' });
  }

  return achados;
}

describe('conciliação por FILIAÇÃO: só athleteId muda', () => {
  it('o autocadastro pela NPC vincula o histórico e não toca em mais nada', async () => {
    const antes = await retrato();
    expect(antes.length, 'o ledger tem a etapa inteira').toBe(LINHAS);
    expect(antes.every(l => l.athleteId === null), 'todas sem dono, como o Ipiranga').toBe(true);

    const pessoa = await cadastrarPessoa(NOME_ALVO);
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: NOME_ALVO,
      cpf: gerarCpf(910001),
      sex: 'FEMALE',
      birthDate: '1998-07-15',
      affiliationId: npc.id,
      affiliationNumber: MATRICULA_ALVO
    });

    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 500)).toBe(201);
    expect(pedido.body.conciliacao.estado).toBe('VINCULADO');
    // SEM APROVAÇÃO HUMANA: ninguém assina.
    expect(pedido.body.reviewedById ?? null).toBeNull();

    const atleta = await comoAtor(gerente, tx => tx.athlete.findFirst({
      where: { affiliationId: npc.id, affiliationNumber: MATRICULA_ALVO },
      select: { id: true }
    }));
    expect(atleta, 'o atleta foi criado').toBeTruthy();

    const depois = await retrato();

    // O INVARIANTE DO GATE. Nenhuma linha some, nenhuma nasce.
    expect(depois.length, 'nenhum lançamento criado nem removido').toBe(LINHAS);

    const mudancas = diferencas(antes, depois);

    // SÓ `athleteId`, e só nas linhas da matrícula conciliada.
    for (const m of mudancas) {
      expect(m.campo, `mudou ${m.campo} de ${m.de} para ${m.para} em ${m.id}`).toBe('athleteId');
      expect(m.de, 'o campo só pode sair de nulo').toBeNull();
      expect(m.para).toBe(atleta.id);
    }

    expect(mudancas.length, 'o vínculo alcançou ao menos um lançamento').toBeGreaterThan(0);

    // E os lançamentos das OUTRAS competidoras continuam sem dono.
    const semDono = depois.filter(l => l.athleteId === null).length;
    expect(semDono).toBe(LINHAS - mudancas.length);
  });

  it('o histórico aparece em "Meu histórico", e a soma do ledger não se move', async () => {
    const antes = await retrato();
    const somaAntes = antes.reduce((t, l) => t + l.points, 0);
    expect(somaAntes, 'a etapa pontuou de verdade').toBeGreaterThan(0);

    const pessoa = await cadastrarPessoa(NOME_ALVO);
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: NOME_ALVO, cpf: gerarCpf(910002), sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: npc.id, affiliationNumber: MATRICULA_ALVO
    });
    expect(pedido.body.conciliacao.estado).toBe('VINCULADO');
    expect(pedido.body.conciliacao.vinculados).toBeGreaterThan(0);

    const meu = await api().get('/api/v1/me/history').set(pessoa.auth());
    expect(meu.status, JSON.stringify(meu.body).slice(0, 300)).toBe(200);

    // O CONTEÚDO, e não só o 200. Um endpoint que responde lista vazia com
    // status 200 passaria numa asserção de status e mentiria sobre o histórico.
    const itens = meu.body.items ?? meu.body.history ?? meu.body;
    const lista = Array.isArray(itens) ? itens : [];
    expect(lista.length, `"Meu histórico" veio vazio: ${JSON.stringify(meu.body).slice(0, 300)}`)
      .toBeGreaterThan(0);

    // VINCULAR NÃO É REPONTUAR. Se a soma do ledger mudar, mudou.
    const depois = await retrato();
    expect(depois.reduce((t, l) => t + l.points, 0)).toBe(somaAntes);
    expect(depois.length).toBe(antes.length);
  });
});

describe('a matrícula reconhecida no cadastro do operador', () => {
  it('criar o atleta com a matrícula do arquivo muda SÓ athleteId no ledger', async () => {
    // O RETRATO VEM ANTES DE CRIAR O ATLETA, e essa ordem é o teste.
    //
    // A primeira versão deste caso tirava o retrato DEPOIS, e por isso media
    // nada: a sonda mostrou que criar o atleta com uma matrícula presente no
    // ledger já vincula 1 lançamento na hora. Com o retrato depois, `antes` e
    // `depois` eram iguais por construção e o laço de comparação passava vazio.
    const antes = await retrato();
    expect(antes.every(l => l.athleteId === null)).toBe(true);

    const criado = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'ATLETA COM CPF', cpf: gerarCpf(920001), sex: 'FEMALE',
      birthDate: '1996-01-20', affiliationId: npc.id, affiliationNumber: 'QA-100005'
    });
    expect(criado.status, JSON.stringify(criado.body).slice(0, 300)).toBe(201);

    const depois = await retrato();
    const mudancas = diferencas(antes, depois);

    expect(mudancas.length, 'o reconhecimento alcançou ao menos um lançamento')
      .toBeGreaterThan(0);
    for (const m of mudancas) {
      expect(m.campo, `mudou ${m.campo}: ${m.de} -> ${m.para}`).toBe('athleteId');
      expect(m.de).toBeNull();
      expect(m.para).toBe(criado.body.id);
    }
  });
});

describe('colisão de identidade: recusa NEUTRA e ledger imóvel', () => {
  it('matrícula já em uso não conclui, não vaza o motivo, e não move o ledger', async () => {
    const dono = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'DONA DA MATRICULA', cpf: gerarCpf(930001), sex: 'FEMALE',
      birthDate: '1996-01-20', affiliationId: npc.id, affiliationNumber: 'QA-100007'
    });
    expect(dono.status).toBe(201);

    const antes = await retrato();

    const outra = await cadastrarPessoa('OUTRA PESSOA');
    const pedido = await api().post('/api/v1/athlete-requests').set(outra.auth()).send({
      fullName: 'OUTRA PESSOA',
      cpf: gerarCpf(930999),
      sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: npc.id,
      affiliationNumber: 'QA-100007'
    });

    expect(pedido.status).toBe(409);
    expect(pedido.body.error.code).toBe('REGISTRATION_NEEDS_REVIEW');

    // A RESPOSTA NÃO CONTA QUAL IDENTIFICADOR COLIDIU. Dita a quem se cadastra,
    // "matrícula já cadastrada" é um oráculo: confirma que aquele identificador
    // existe nesta federação.
    const corpo = JSON.stringify(pedido.body);
    expect(corpo).not.toMatch(/QA-100007/);
    expect(corpo).not.toMatch(/matrícula|CPF já|already/i);

    // E A CARREIRA NÃO TROCOU DE DONO.
    expect(diferencas(antes, await retrato())).toEqual([]);
  });

  it('CONTROLE: a MESMA requisição com matrícula livre conclui', async () => {
    // Sem este controle, o teste acima mede a chance de a requisição falhar por
    // qualquer motivo — foi assim que um teste desta base já passou pelo motivo
    // errado. Aqui a única diferença é a matrícula.
    const outra = await cadastrarPessoa('OUTRA PESSOA');
    const pedido = await api().post('/api/v1/athlete-requests').set(outra.auth()).send({
      fullName: 'OUTRA PESSOA',
      cpf: gerarCpf(930999),
      sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: npc.id,
      affiliationNumber: MATRICULA_ALVO
    });

    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 400)).toBe(201);
    expect(pedido.body.conciliacao.estado).toBe('VINCULADO');
  });
});
describe('nome sozinho NUNCA vincula', () => {
  it('mesmo nome, sem CPF coincidente e sem matrícula, não adota histórico', async () => {
    const antes = await retrato();

    const pessoa = await cadastrarPessoa(NOME_ALVO);
    const pedido = await api().post('/api/v1/athlete-requests').set(pessoa.auth()).send({
      fullName: NOME_ALVO,
      cpf: gerarCpf(940001),
      sex: 'FEMALE', birthDate: '1998-07-15',
      affiliationId: npc.id,
      // Matrícula que NÃO está no arquivo.
      affiliationNumber: 'NAO-EXISTE-9999'
    });

    expect(pedido.status, JSON.stringify(pedido.body).slice(0, 400)).toBe(201);
    // Cadastro concluído, histórico NÃO adotado: o nome não é chave.
    expect(pedido.body.conciliacao.estado).toBe('SEM_HISTORICO');

    const depois = await retrato();
    expect(diferencas(antes, depois), 'nenhum lançamento mudou de dono').toEqual([]);
  });
});
