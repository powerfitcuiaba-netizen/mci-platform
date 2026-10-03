import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';
import {
  GAVETAS, assinaturaDoResultado, classificarResultado
} from '../scripts/diagnostico-identidade-do-atleta.js';

// ============================================================================
// CONSOLIDAÇÃO OPERACIONAL: QUANDO A MATRÍCULA CHEGA DEPOIS DO CADASTRO.
//
// A arquitetura de identidade não é o assunto deste arquivo. Ela já está
// provada em `identidade-por-matricula.test.mjs`: filiação + matrícula é a
// chave, o nome não é, e o escopo da filiação é respeitado.
//
// O assunto aqui é o DEFEITO OPERACIONAL que sobrou: existe um caminho pelo
// qual o atleta se torna identificável por filiação + matrícula e NADA
// reexecuta a consolidação. O histórico fica órfão, e a única saída passa a
// ser um clique humano numa tela de sugestões — exatamente o clique que a
// regra homologada diz ser desnecessário quando a identidade é inequívoca.
//
// O CAMINHO, nomeado:
//
//   1. o histórico é importado e aplicado com a matrícula (vira identidade
//      `AFF:{filiação}:{matrícula}`, sem dono, com os pontos no ledger);
//   2. o atleta é cadastrado SEM filiação/matrícula — ou com a matrícula
//      errada, que é o caso de digitação;
//   3. o operador CORRIGE a matrícula pelo perfil (`PATCH /athletes/:id`);
//   4. nada acontece.
//
// O passo 4 é o defeito. `vincularPendentesDoAtleta` roda na CRIAÇÃO do
// cadastro e na aprovação do autocadastro, e a edição não é nenhuma das duas.
//
// O QUE ESTE ARQUIVO NÃO PERMITE: que o conserto vire fusão por nome. Os
// testes negativos estão aqui junto, no mesmo arquivo, de propósito — quem
// mexer na consolidação vê na mesma tela o que ela tem de recusar.
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;
let outraFiliacao;

const noLedger = consulta => comoAtor(gerente, consulta);

const CABECALHO = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,evento';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

async function importarEAplicar(conteudo) {
  const criado = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv', content: conteudo
  });
  expect([200, 201], JSON.stringify(criado.body)).toContain(criado.status);
  const importId = criado.body.import?.id ?? criado.body.id;
  const aplicado = await api()
    .post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
  expect([200, 201], JSON.stringify(aplicado.body)).toContain(aplicado.status);
  return importId;
}

/** O retrato que o relatório ANTES/DEPOIS pede, para uma matrícula. */
async function retrato(matricula, affiliationId = filiacao.id) {
  const identidades = await noLedger(tx => tx.externalAthlete.findMany({
    where: { organizationId, affiliationId, affiliationNumber: matricula },
    select: { id: true, athleteId: true, displayName: true }
  }));
  const ids = identidades.map(i => i.id);
  const lancamentos = ids.length
    ? await noLedger(tx => tx.rankingPoint.findMany({
      where: { organizationId, externalAthleteId: { in: ids } },
      select: { id: true, athleteId: true, points: true, superOverallPoints: true }
    }))
    : [];
  const resultados = ids.length
    ? await noLedger(tx => tx.externalResult.findMany({
      where: { organizationId, externalAthleteId: { in: ids } },
      select: { id: true, athleteId: true, eventName: true, points: true }
    }))
    : [];
  return {
    identidades: identidades.length,
    comDono: identidades.filter(i => i.athleteId).length,
    donos: new Set(identidades.map(i => i.athleteId).filter(Boolean)),
    resultados: resultados.length,
    resultadosComDono: resultados.filter(r => r.athleteId).length,
    lancamentos: lancamentos.length,
    lancamentoIds: new Set(lancamentos.map(l => l.id)),
    lancamentosComDono: lancamentos.filter(l => l.athleteId).length,
    colocacao: lancamentos.reduce((t, l) => t + l.points, 0),
    overall: lancamentos.reduce((t, l) => t + l.superOverallPoints, 0)
  };
}

const corrigirMatricula = (athleteId, dados) => api()
  .patch(`/api/v1/athletes/${athleteId}`).set(gerente.auth()).send(dados);

beforeAll(async () => { await garantirCatalogo(); });

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Consolidação' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' })).body;
  outraFiliacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Paulista', code: 'FED-SP' })).body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  // Tabela de pontos EXISTENTE. Este arquivo não inventa regra esportiva.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }] });
});

// O histórico do Lucas, três grafias, uma matrícula. 240 pontos de colocação.
const HISTORICO_DO_LUCAS = () => csv([
  `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,80,Campeonato A`,
  `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,100,Campeonato B`,
  `r3,,LÚCAS GOUVÊIA LIMA,${filiacao.code},2932,MENS_BODYBUILDING,MASTER,3,60,Campeonato C`
]);

// ============================================================ o defeito
describe('a matrícula corrigida DEPOIS do cadastro', () => {
  it('cadastro SEM filiação, matrícula preenchida depois: consolida sozinho', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());

    const antes = await retrato('2932');
    expect(antes.identidades, 'uma identidade esportiva para a matrícula').toBe(1);
    expect(antes.comDono, 'e ela ainda não tem dono').toBe(0);
    expect(antes.lancamentos).toBe(3);
    expect(antes.colocacao).toBe(240);

    // O cadastro nasce SEM filiação — é o caso real de quem cadastra primeiro
    // e só depois recebe a carteirinha da federação.
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(606060606), sex: 'MALE'
    });
    expect(athlete.affiliationNumber ?? null).toBeNull();

    // Nada deve ter sido vinculado: sem matrícula, não há chave.
    expect((await retrato('2932')).comDono).toBe(0);

    // O OPERADOR CORRIGE A MATRÍCULA. É aqui que o atleta passa a ser
    // identificável — e é aqui que a consolidação tem de acontecer sozinha.
    const corrigido = await corrigirMatricula(athlete.id, {
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });
    expect(corrigido.status, JSON.stringify(corrigido.body)).toBe(200);

    const depois = await retrato('2932');
    expect(depois.identidades, 'nenhuma identidade nova foi criada').toBe(1);
    expect(depois.comDono, 'a identidade adotou o cadastro SEM clique humano').toBe(1);
    expect([...depois.donos]).toEqual([athlete.id]);
    expect(depois.resultadosComDono, 'os três resultados passaram a ter dono').toBe(3);
    expect(depois.lancamentos, 'NENHUM lançamento novo').toBe(3);
    expect(depois.lancamentosComDono).toBe(3);
    expect(depois.colocacao, 'a pontuação é a MESMA: 240').toBe(240);
    // Os MESMOS lançamentos, não outros com o mesmo total.
    expect([...depois.lancamentoIds].sort()).toEqual([...antes.lancamentoIds].sort());
  });

  it('matrícula digitada errada e depois corrigida: consolida na certa, não na errada', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());

    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(707070707), sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '2392'   // dígitos trocados
    });
    expect((await retrato('2932')).comDono, 'a matrícula errada não alcança nada').toBe(0);

    const corrigido = await corrigirMatricula(athlete.id, { affiliationNumber: '2932' });
    expect(corrigido.status, JSON.stringify(corrigido.body)).toBe(200);

    const depois = await retrato('2932');
    expect(depois.comDono).toBe(1);
    expect([...depois.donos]).toEqual([athlete.id]);
    expect(depois.colocacao).toBe(240);
    // E a matrícula errada não ficou com nada pendurado.
    expect((await retrato('2392')).identidades).toBe(0);
  });

  it('a edição é IDEMPOTENTE: repetir o mesmo PATCH não duplica nada', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(808080808), sex: 'MALE'
    });

    await corrigirMatricula(athlete.id, { affiliationId: filiacao.id, affiliationNumber: '2932' });
    const primeira = await retrato('2932');
    // Sem esta linha o teste passaria À TOA: duas execuções que não fazem nada
    // também produzem retratos idênticos. Idempotência é "repetir não muda o
    // efeito", e para isso é preciso ter havido efeito.
    expect(primeira.comDono, 'a primeira edição consolidou de fato').toBe(1);
    expect(primeira.colocacao).toBe(240);

    // De novo, o MESMO corpo. A regra pede que o segundo não produza efeito.
    const repetida = await corrigirMatricula(athlete.id, {
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });
    expect(repetida.status).toBe(200);

    const segunda = await retrato('2932');
    expect(segunda.identidades).toBe(primeira.identidades);
    expect(segunda.lancamentos).toBe(primeira.lancamentos);
    expect(segunda.colocacao).toBe(primeira.colocacao);
    expect(segunda.overall).toBe(primeira.overall);
    expect([...segunda.lancamentoIds].sort()).toEqual([...primeira.lancamentoIds].sort());
  });

  it('a adoção fica na auditoria, com a chave que decidiu', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(909090909), sex: 'MALE'
    });
    await corrigirMatricula(athlete.id, { affiliationId: filiacao.id, affiliationNumber: '2932' });

    const registros = await noLedger(tx => tx.auditLog.findMany({
      where: { organizationId, action: 'RESULTADO_EXTERNAL_LINKED' },
      select: { metadata: true, entity: true }
    }));
    expect(registros.length, 'a adoção foi registrada').toBeGreaterThan(0);
    const daIdentidade = registros.find(r => r.entity === 'ExternalAthlete');
    expect(daIdentidade, JSON.stringify(registros)).toBeTruthy();
    expect(daIdentidade.metadata.athleteId).toBe(athlete.id);
    expect(String(daIdentidade.metadata.affiliationNumber)).toBe('2932');
    expect(daIdentidade.metadata.affiliationId).toBe(filiacao.id);
  });
});

// ============================================================ o que ela RECUSA
describe('o conserto não pode virar fusão', () => {
  it('matrícula igual em filiação DIFERENTE: não consolida', async () => {
    // O histórico está na FED-MT. O cadastro vai para a FED-SP com o mesmo número.
    await importarEAplicar(HISTORICO_DO_LUCAS());
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Lima', cpf: gerarCpf(101010101), sex: 'MALE'
    });

    const corrigido = await corrigirMatricula(athlete.id, {
      affiliationId: outraFiliacao.id, affiliationNumber: '2932'
    });
    expect(corrigido.status).toBe(200);

    const naFedMt = await retrato('2932', filiacao.id);
    expect(naFedMt.comDono, 'a carreira da outra federação NÃO foi levada').toBe(0);
    expect(naFedMt.colocacao).toBe(240);
  });

  it('nome igual e matrícula diferente: não consolida', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Lima', cpf: gerarCpf(111111111), sex: 'MALE'
    });

    await corrigirMatricula(athlete.id, {
      affiliationId: filiacao.id, affiliationNumber: '9999'
    });

    expect((await retrato('2932')).comDono, 'nome igual não é chave').toBe(0);
  });

  it('resultado SEM matrícula não é adotado pela edição', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,80,Campeonato A`,
      `r2,,Lucas Lima,${filiacao.code},,MENS_BODYBUILDING,OPEN,1,100,Campeonato B`
    ]));

    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Lima', cpf: gerarCpf(121212121), sex: 'MALE'
    });
    await corrigirMatricula(athlete.id, {
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });

    // A linha com matrícula foi adotada; a sem matrícula continua órfã, e isso
    // é o comportamento correto: sem identificador, só evidência humana decide.
    expect((await retrato('2932')).comDono).toBe(1);

    const semMatricula = await noLedger(tx => tx.externalAthlete.findMany({
      where: { organizationId, affiliationNumber: null },
      select: { athleteId: true, displayName: true }
    }));
    expect(semMatricula).toHaveLength(1);
    expect(semMatricula[0].athleteId, 'a linha sem matrícula NÃO foi fundida').toBeNull();
  });

  it('a edição de OUTRA organização não alcança esta matrícula', async () => {
    await importarEAplicar(HISTORICO_DO_LUCAS());

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Outro Admin' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: 'Federação Vizinha' });
    const vizinho = await criarUsuario({ name: 'Gerente Vizinho' });
    await vincular(outraOrg.id, vizinho, 'RANKING_MANAGER');
    await vincular(outraOrg.id, vizinho, 'REGISTRATION_OPERATOR');

    const filiacaoVizinha = (await api().post('/api/v1/affiliations').set(outroAdmin.auth())
      .send({ organizationId: outraOrg.id, name: 'Federação Vizinha', code: 'FED-VZ' })).body;

    const intruso = await criarAtleta(vizinho, outraOrg.id, {
      fullName: 'Lucas Lima', cpf: gerarCpf(131313131), sex: 'MALE'
    });
    await api().patch(`/api/v1/athletes/${intruso.id}`).set(vizinho.auth())
      .send({ affiliationId: filiacaoVizinha.id, affiliationNumber: '2932' });

    const aqui = await retrato('2932');
    expect(aqui.comDono, 'a matrícula desta organização continua sem dono').toBe(0);
    expect(aqui.colocacao).toBe(240);
  });
});

// ============================================================ as seis gavetas
//
// O classificador é função PURA: a gaveta de um resultado sai dos dados dele,
// da identidade que o carrega e dos cadastros do PAR filiação + matrícula.
// Testar sem banco é de propósito — a regra tem de poder ser lida e conferida
// sem subir PostgreSQL.
describe('a classificação em seis gavetas', () => {
  const identidadeComMatricula = { id: 'ident-1', affiliationId: 'fed-mt', affiliationNumber: '2932', displayName: 'Lucas Lima' };
  const identidadeSemMatricula = { id: 'ident-2', affiliationId: null, affiliationNumber: null, displayName: 'Lucas Lima' };
  const cadastro = { id: 'atleta-1', affiliationId: 'fed-mt', affiliationNumber: '2932' };
  const resultado = (extra = {}) => ({
    id: 'res-1', eventName: 'Campeonato A', className: 'OPEN', placing: 1, athleteId: null, ...extra
  });

  it('CONSOLIDADO — o resultado aponta para o cadastro do par', () => {
    const { gaveta } = classificarResultado(resultado({ athleteId: 'atleta-1' }), {
      identidade: identidadeComMatricula, cadastrosDoPar: [cadastro]
    });
    expect(gaveta).toBe(GAVETAS.CONSOLIDADO);
  });

  it('VINCULÁVEL POR MATRÍCULA — um cadastro, um par, nenhum conflito', () => {
    const { gaveta } = classificarResultado(resultado(), {
      identidade: identidadeComMatricula, cadastrosDoPar: [cadastro]
    });
    expect(gaveta).toBe(GAVETAS.VINCULAVEL);
  });

  it('SEM MATRÍCULA — e isto vem ANTES de qualquer juízo sobre ambiguidade', () => {
    const { gaveta } = classificarResultado(resultado(), {
      identidade: identidadeSemMatricula, cadastrosDoPar: [cadastro, { id: 'atleta-2' }]
    });
    expect(gaveta).toBe(GAVETAS.SEM_MATRICULA);
  });

  it('AMBÍGUO — dois cadastros para o mesmo par', () => {
    const { gaveta } = classificarResultado(resultado(), {
      identidade: identidadeComMatricula,
      cadastrosDoPar: [cadastro, { id: 'atleta-2', affiliationId: 'fed-mt', affiliationNumber: '2932' }]
    });
    expect(gaveta).toBe(GAVETAS.AMBIGUO);
  });

  it('AMBÍGUO — o resultado já tem dono, e o dono não é o cadastro do par', () => {
    const { gaveta, porque } = classificarResultado(resultado({ athleteId: 'outro-atleta' }), {
      identidade: identidadeComMatricula, cadastrosDoPar: [cadastro]
    });
    expect(gaveta).toBe(GAVETAS.AMBIGUO);
    expect(porque).toMatch(/trocar dono/i);
  });

  it('DUPLICADO — a assinatura repetida vence todas as outras regras', () => {
    const assinaturas = new Set([assinaturaDoResultado(resultado())]);
    const { gaveta } = classificarResultado(resultado({ athleteId: 'atleta-1' }), {
      identidade: identidadeComMatricula, cadastrosDoPar: [cadastro], assinaturasRepetidas: assinaturas
    });
    expect(gaveta).toBe(GAVETAS.DUPLICADO);
  });

  it('OUTRO — histórico com matrícula e ainda sem cadastro nenhum', () => {
    const { gaveta, porque } = classificarResultado(resultado(), {
      identidade: identidadeComMatricula, cadastrosDoPar: []
    });
    expect(gaveta).toBe(GAVETAS.OUTRO);
    expect(porque).toMatch(/vincula sozinho/i);
  });

  it('OUTRO — resultado sem identidade esportiva', () => {
    const { gaveta } = classificarResultado(resultado(), { identidade: null });
    expect(gaveta).toBe(GAVETAS.OUTRO);
  });

  it('a assinatura não confunde evento diferente com o mesmo', () => {
    expect(assinaturaDoResultado({ eventName: ' campeonato a ', className: 'open', placing: 1 }))
      .toBe(assinaturaDoResultado({ eventName: 'CAMPEONATO A', className: 'OPEN', placing: 1 }));
    expect(assinaturaDoResultado({ eventName: 'Campeonato A', className: 'OPEN', placing: 1 }))
      .not.toBe(assinaturaDoResultado({ eventName: 'Campeonato B', className: 'OPEN', placing: 1 }));
  });
});

// ================================ os casos da homologação que faltavam cobrir
//
// Os outros estão em `identidade-por-matricula.test.mjs` e continuam valendo.
// Aqui ficam os três que a FASE FINAL nomeou e que não tinham teste próprio.
describe('os casos nomeados na FASE FINAL', () => {
  it('CASO 4 — cadastro EXISTENTE antes da importação: consolida automático', async () => {
    // A ordem inversa da do Lucas: a pessoa já está cadastrada, com matrícula,
    // e o campeonato antigo chega depois. Não pode exigir clique nenhum.
    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(141414141), sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });

    await importarEAplicar(HISTORICO_DO_LUCAS());

    const depois = await retrato('2932');
    expect(depois.identidades).toBe(1);
    expect(depois.comDono, 'a importação reconheceu o cadastro que já existia').toBe(1);
    expect([...depois.donos]).toEqual([athlete.id]);
    expect(depois.resultadosComDono).toBe(3);
    expect(depois.lancamentos).toBe(3);
    expect(depois.colocacao).toBe(240);
  });

  it('CASO 6 — sem matrícula, MAS com evidência inequívoca: o CPF resolve', async () => {
    // A evidência que existe no modelo e NÃO é o nome: o CPF declarado no
    // arquivo. Sem matrícula, o importador não monta identidade `AFF:` — e o
    // reconhecimento acontece pelo documento, que identifica a PESSOA.
    //
    // Este é o limite honesto do "evidência inequívoca" que a homologação pede:
    // o domínio tem CPF e matrícula. Nome não entra, e nada mais no registro
    // identifica alguém sem ambiguidade.
    const cpf = gerarCpf(151515151);
    await importarEAplicar(csv([
      `r1,${cpf},Lucas Lima,,,MENS_BODYBUILDING,OPEN,1,100,Campeonato A`
    ]));

    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf, sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });

    const resultados = await noLedger(tx => tx.externalResult.findMany({
      where: { organizationId }, select: { athleteId: true }
    }));
    expect(resultados).toHaveLength(1);
    expect(resultados[0].athleteId, 'o CPF reconheceu, sem matrícula e sem nome').toBe(athlete.id);
  });

  it('CASO 11 — Overall existente: a consolidação não o duplica', async () => {
    const CABECALHO_OVERALL = 'external_result_id,cpf,atleta,filiacao,matricula,categoria,classe,colocacao,pontos,overall,evento';
    await importarEAplicar([
      CABECALHO_OVERALL,
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,100,sim,Campeonato A`
    ].join('\n'));

    const antes = await retrato('2932');
    expect(antes.lancamentos).toBe(1);
    const overallAntes = antes.overall;

    const athlete = await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Gouveia Lima', cpf: gerarCpf(161616161), sex: 'MALE'
    });
    await corrigirMatricula(athlete.id, { affiliationId: filiacao.id, affiliationNumber: '2932' });

    const depois = await retrato('2932');
    expect(depois.lancamentos, 'nenhum lançamento novo').toBe(1);
    expect(depois.lancamentosComDono).toBe(1);
    expect(depois.colocacao, 'a colocação não mudou').toBe(antes.colocacao);
    expect(depois.overall, 'o Overall não foi duplicado nem recalculado').toBe(overallAntes);
    expect([...depois.lancamentoIds]).toEqual([...antes.lancamentoIds]);
  });
});
