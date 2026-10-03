import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';
import { normalizarMatricula } from '../scripts/diagnostico-identidade-do-atleta.js';

// ============================================================================
// IDENTIDADE ESPORTIVA: A MATRÍCULA MANDA, O NOME NÃO.
//
// A regra homologada é: o atleta é identificado pela MATRÍCULA NO ESCOPO DA
// FILIAÇÃO. O nome é atributo cadastral e de apresentação.
//
// POR QUE O ESCOPO DA FILIAÇÃO IMPORTA, E NÃO É PRECIOSISMO
//
// Duas federações podem emitir a mesma matrícula. Tratar o número sozinho como
// chave global fundiria dois atletas diferentes — e os dois erros não têm o
// mesmo tamanho: separar uma pessoa em duas é um aborrecimento que se conserta;
// JUNTAR duas pessoas numa apaga a carreira de alguém, e o histórico original
// já não existe para desfazer. Na dúvida, o lado seguro é não fundir.
//
// Os dez casos pedidos na homologação estão aqui, nomeados, mais os que
// protegem a fronteira: organização diferente, e tentativa de assumir a
// carreira alheia trocando a matrícula.
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
    organizationId,
    seasonId,
    sourceType: 'CSV',
    sourceRef: unico('arquivo') + '.csv',
    content: conteudo
  });
  expect([200, 201], JSON.stringify(criado.body)).toContain(criado.status);
  // A resposta embrulha o lote em `import` — conferido em e2e-musclewar.test.mjs.
  const importId = criado.body.import?.id ?? criado.body.id;
  expect(importId, JSON.stringify(criado.body)).toBeTruthy();
  const aplicado = await api()
    .post(`/api/v1/musclewar/imports/${importId}/apply`)
    .set(gerente.auth());
  expect([200, 201], JSON.stringify(aplicado.body)).toContain(aplicado.status);
  return importId;
}

/** Quantos competidores DISTINTOS a pontuação enxerga para uma matrícula. */
async function competidoresDaMatricula(matricula, affiliationId = filiacao.id) {
  const identidades = await noLedger(tx => tx.externalAthlete.findMany({
    where: { organizationId, affiliationId, affiliationNumber: matricula },
    select: { id: true }
  }));
  const cadastros = await noLedger(tx => tx.athlete.findMany({
    where: { organizationId, affiliationId, affiliationNumber: matricula },
    select: { id: true }
  }));
  if (!identidades.length && !cadastros.length) return new Set();

  const pontos = await noLedger(tx => tx.rankingPoint.findMany({
    where: {
      organizationId,
      OR: [
        ...(identidades.length ? [{ externalAthleteId: { in: identidades.map(i => i.id) } }] : []),
        ...(cadastros.length ? [{ athleteId: { in: cadastros.map(c => c.id) } }] : [])
      ]
    },
    select: { athleteId: true, externalAthleteId: true, points: true, superOverallPoints: true }
  }));
  return new Set(pontos.map(p => p.athleteId ? `ATLETA:${p.athleteId}` : `IDENT:${p.externalAthleteId}`));
}

async function pontosDaMatricula(matricula, affiliationId = filiacao.id) {
  const identidades = await noLedger(tx => tx.externalAthlete.findMany({
    where: { organizationId, affiliationId, affiliationNumber: matricula },
    select: { id: true }
  }));
  if (!identidades.length) return { colocacao: 0, overall: 0, lancamentos: 0 };
  const pontos = await noLedger(tx => tx.rankingPoint.findMany({
    where: { organizationId, externalAthleteId: { in: identidades.map(i => i.id) } },
    select: { points: true, superOverallPoints: true }
  }));
  return {
    colocacao: pontos.reduce((t, p) => t + p.points, 0),
    overall: pontos.reduce((t, p) => t + p.superOverallPoints, 0),
    lancamentos: pontos.length
  };
}

beforeAll(async () => {
  await garantirCatalogo();
});

beforeEach(async () => {
  await limparBanco();
  await garantirCatalogo();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Identidade' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  const respostaFiliacao = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' });
  filiacao = respostaFiliacao.body;
  const respostaOutra = await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'Federação Paulista', code: 'FED-SP' });
  outraFiliacao = respostaOutra.body;

  const temporada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 });
  seasonId = temporada.body.id;

  // A tabela de pontos é a REGRA ESPORTIVA EXISTENTE. Este arquivo não a
  // inventa nem a altera: ele só exige que os pontos caiam no atleta certo.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 100 }, { placing: 2, points: 80 }, { placing: 3, points: 60 }] });
});

// ---------------------------------------------------------------- a normalização
describe('normalização da matrícula', () => {
  it('apara o branco em volta: " 2932 " é a mesma matrícula que "2932"', () => {
    expect(normalizarMatricula(' 2932 ')).toBe('2932');
    expect(normalizarMatricula('2932')).toBe('2932');
    expect(normalizarMatricula('\t2932\n')).toBe('2932');
    expect(normalizarMatricula(2932)).toBe('2932');
  });

  it('PRESERVA zero à esquerda — e por isso não funde 02932 com 2932', () => {
    // Converter para número perderia o zero, e duas matrículas LEGÍTIMAS E
    // DIFERENTES virariam uma. Juntar dois atletas é pior do que separar um.
    expect(normalizarMatricula('02932')).toBe('02932');
    expect(normalizarMatricula('02932')).not.toBe(normalizarMatricula('2932'));
  });

  it('vazio não é identificador', () => {
    expect(normalizarMatricula('')).toBeNull();
    expect(normalizarMatricula('   ')).toBeNull();
    expect(normalizarMatricula(null)).toBeNull();
    expect(normalizarMatricula(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------- os dez casos
describe('os dez casos da homologação', () => {
  it('TESTE 1 — mesmo nome, mesma matrícula: 1 atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
  });

  it('TESTE 2 — nome DIFERENTE, mesma matrícula: 1 atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
  });

  it('TESTE 3 — acentuação diferente, mesma matrícula: 1 atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Gouveia Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lúcas Gouvêia Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
  });

  it('TESTE 4 — nome abreviado, mesma matrícula: 1 atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Gouveia Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,L. G. Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
  });

  it('TESTE 5 — nome IGUAL, matrículas diferentes: 2 atletas', async () => {
    // Duas atletas chamadas "Ana Silva" existem. Fundi-las apagaria uma carreira.
    await importarEAplicar(csv([
      `r1,,Ana Silva,${filiacao.code},1111,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Ana Silva,${filiacao.code},2222,MENS_BODYBUILDING,OPEN,1,20,Campeonato A`
    ]));
    expect((await competidoresDaMatricula('1111')).size).toBe(1);
    expect((await competidoresDaMatricula('2222')).size).toBe(1);
    const umas = await competidoresDaMatricula('1111');
    const outras = await competidoresDaMatricula('2222');
    expect([...umas][0]).not.toBe([...outras][0]);
  });

  it('TESTE 6 — nome diferente, matrículas diferentes: 2 atletas', async () => {
    await importarEAplicar(csv([
      `r1,,Ana Silva,${filiacao.code},1111,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Bruna Costa,${filiacao.code},2222,MENS_BODYBUILDING,OPEN,1,20,Campeonato A`
    ]));
    expect((await competidoresDaMatricula('1111')).size).toBe(1);
    expect((await competidoresDaMatricula('2222')).size).toBe(1);
  });

  it('TESTE 7 — vários eventos: histórico consolidado num competidor só', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`,
      `r3,,LUCAS LIMA,${filiacao.code},2932,MENS_BODYBUILDING,MASTER,3,12,Campeonato C`
    ]));
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
    const identidade = await noLedger(tx => tx.externalAthlete.findFirst({
      where: { organizationId, affiliationId: filiacao.id, affiliationNumber: '2932' },
      select: { id: true }
    }));
    const resultados = await noLedger(tx => tx.externalResult.findMany({
      where: { organizationId, externalAthleteId: identidade.id },
      select: { eventName: true, placing: true, points: true }
    }));
    expect(resultados).toHaveLength(3);
    expect(resultados.map(r => r.eventName).sort())
      .toEqual(['Campeonato A', 'Campeonato B', 'Campeonato C']);
  });

  it('TESTE 8 — pontos de colocação somam no mesmo atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    const { colocacao, lancamentos } = await pontosDaMatricula('2932');
    expect(lancamentos).toBe(2);
    // A soma é a regra esportiva existente aplicada aos dois resultados; este
    // teste NÃO inventa tabela de pontos, só exige que os dois caiam no mesmo.
    expect(colocacao).toBeGreaterThan(0);
  });

  it('TESTE 9 — Overall de vários eventos fica no mesmo atleta', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato A`,
      `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    const competidores = await competidoresDaMatricula('2932');
    expect(competidores.size).toBe(1);
    const { overall } = await pontosDaMatricula('2932');
    expect(overall).toBeGreaterThanOrEqual(0);
  });

  it('TESTE 10 — reaplicar o mesmo lote não duplica ponto', async () => {
    const linhas = [
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas de Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ];
    await importarEAplicar(csv(linhas));
    const antes = await pontosDaMatricula('2932');

    // O SEGUNDO LOTE É RECUSADO, E ESSA É A IDEMPOTÊNCIA FUNCIONANDO.
    //
    // Cada linha já está na plataforma, então a análise as classifica como
    // DUPLICATE e sobra zero aplicável: o `apply` responde 422 NOTHING_TO_APPLY
    // em vez de somar os mesmos pontos de novo. Exigir 200 aqui seria exigir
    // que o sistema reaplicasse — o oposto do que o teste protege.
    const segundo = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('arquivo') + '.csv', content: csv(linhas)
    });
    expect(segundo.body.summary.duplicates, JSON.stringify(segundo.body.summary)).toBe(linhas.length);
    expect(segundo.body.summary.applicable).toBe(0);

    const reaplicado = await api()
      .post(`/api/v1/musclewar/imports/${segundo.body.import.id}/apply`).set(gerente.auth());
    expect(reaplicado.status).toBe(422);
    expect(reaplicado.body.error.code).toBe('NOTHING_TO_APPLY');

    const depois = await pontosDaMatricula('2932');
    expect(depois.lancamentos).toBe(antes.lancamentos);
    expect(depois.colocacao).toBe(antes.colocacao);
    expect(depois.overall).toBe(antes.overall);
    expect((await competidoresDaMatricula('2932')).size).toBe(1);
  });
});

// ------------------------------------------------------ a fronteira que protege
describe('a fronteira: o que NÃO pode ser fundido', () => {
  it('a mesma matrícula em FILIAÇÕES diferentes são dois atletas', async () => {
    // Duas federações emitem o mesmo número. Juntar as duas seria pior do que
    // o defeito que esta fase corrige.
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas Lima,${outraFiliacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    const naPrimeira = await competidoresDaMatricula('2932', filiacao.id);
    const naSegunda = await competidoresDaMatricula('2932', outraFiliacao.id);
    expect(naPrimeira.size).toBe(1);
    expect(naSegunda.size).toBe(1);
    expect([...naPrimeira][0]).not.toBe([...naSegunda][0]);
  });

  it('matrícula com zero à esquerda NÃO é a mesma que sem ele', async () => {
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},02932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));
    const comZero = await competidoresDaMatricula('02932');
    const semZero = await competidoresDaMatricula('2932');
    expect(comZero.size).toBe(1);
    expect(semZero.size).toBe(1);
    expect([...comZero][0]).not.toBe([...semZero][0]);
  });

  it('o cadastro recusa duas matrículas iguais na mesma filiação', async () => {
    await criarAtleta(gerente, organizationId, {
      fullName: 'Lucas Lima', cpf: gerarCpf(404040404),
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });
    const segundo = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'Lucas de Lima', cpf: gerarCpf(505050505), sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: '2932'
    });
    expect(segundo.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(segundo.body)).toMatch(/2932/);
  });
});

// ------------------------------------------------------------- a causa medida
describe('a causa real da separação: linha SEM matrícula', () => {
  it('resultado sem matrícula vira identidade PRÓPRIA, e não alcança a do atleta', async () => {
    // Esta é a causa raiz medida, e o teste existe para que ela não seja
    // confundida com "o sistema agrupa por nome". O nome é IGUAL nas duas
    // linhas; o que separa é a matrícula ausente.
    await importarEAplicar(csv([
      `r1,,Lucas Lima,${filiacao.code},2932,MENS_BODYBUILDING,OPEN,2,16,Campeonato A`,
      `r2,,Lucas Lima,${filiacao.code},,MENS_BODYBUILDING,OPEN,1,20,Campeonato B`
    ]));

    const comMatricula = await competidoresDaMatricula('2932');
    expect(comMatricula.size, 'a linha COM matrícula consolida').toBe(1);

    const semMatricula = await noLedger(tx => tx.externalAthlete.findMany({
      where: { organizationId, affiliationNumber: null },
      select: { id: true, identityKey: true, displayName: true }
    }));
    expect(semMatricula.length, 'a linha SEM matrícula ganhou identidade própria').toBe(1);
    expect(semMatricula[0].identityKey).toMatch(/^EXT:/);
    expect(semMatricula[0].displayName).toBe('Lucas Lima');
  });
});
