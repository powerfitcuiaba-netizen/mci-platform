import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { vincularPendentesDoAtleta } = require('../src/services/muscleWarService.js');

// ============================================================================
// A MATRÍCULA IDENTIFICA UMA PESSOA DENTRO DA FEDERAÇÃO.
//
// O PROBLEMA QUE ISTO FECHA, E POR QUE TRATÁ-LO NÃO BASTAVA
//
// O sistema aceitava dois cadastros com a mesma matrícula na mesma filiação, e
// o vínculo tardio reagia a isso: ao encontrar dois donos, recusava vincular e
// marcava CONFLITO para o operador decidir. A recusa estava certa. Chegava
// tarde.
//
// A sequência que quebrava: cadastra-se a primeira pessoa com NPC-123; naquele
// instante ela é dona única, o vínculo é inequívoco, o histórico vai para ela.
// Semanas depois cadastra-se a segunda com o mesmo número. Agora há dois
// donos — e o ponto já está somando no ranking do primeiro, por ORDEM DE
// CHEGADA, que é o que este projeto trata como regra absoluta a não quebrar.
// Marcar conflito nesse momento não desfaz o que já foi creditado.
//
// Então o estado deixou de ser possível. Matrícula repetida na mesma filiação
// não é dado difícil: é dado ERRADO — número digitado errado, mesma pessoa
// cadastrada duas vezes, ou número reaproveitado pela federação, que é decisão
// humana ANTES e não depois.
//
// DUAS BARREIRAS, DE PROPÓSITO: guarda no serviço, que devolve um erro
// legível, e índice único parcial no banco, que fecha a corrida entre dois
// cadastros simultâneos. A primeira explica; a segunda garante.
//
// E A DEFESA EM PROFUNDIDADE CONTINUA VIVA. A guarda de dois donos segue no
// vínculo tardio, para dado que entrou antes do índice existir — e é medida
// aqui, com o índice removido de propósito, porque proteção que não se mede
// deixa de valer no dia em que alguém a apaga.
// ============================================================================

const INDICE = 'Athlete_organizationId_affiliationId_affiliationNumber_key';

let admin, gerente, organizationId, npc, outraFiliacao, seasonId;

const csv = linhas => [
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento',
  ...linhas
].join('\n');

const importarEAplicar = async linhas => {
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('etapa') + '.csv',
    content: csv(linhas)
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
  return lote.body.import.id;
};

const criar = (dados, ator = admin) => api().post('/api/v1/athletes').set(ator.auth()).send({
  organizationId, sex: 'MALE', birthDate: '1995-03-10', ...dados
});

const noLedger = consulta => comoAtor(gerente, consulta);

const indiceExiste = async () => {
  const [linha] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = '${INDICE}'`);
  return linha.n === 1;
};

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
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }]
  });
});

// Rede de segurança do arquivo inteiro: um teste que remove o índice e falha
// antes de repô-lo deixaria a suíte inteira rodando sem a trava, e os testes
// seguintes passariam medindo um banco errado. Já aconteceu nesta sessão com
// um benchmark que trocou uma política e não a restaurou.
afterEach(async () => {
  if (!(await indiceExiste())) {
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${INDICE}" ON "Athlete"
       ("organizationId", "affiliationId", "affiliationNumber")
       WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL`);
    throw new Error('o índice de matrícula ficou ausente ao fim de um teste — reposto à força');
  }
});

describe('o segundo cadastro com a mesma matrícula é recusado', () => {
  it('recusa com código próprio, e o texto diz de quem é a matrícula', async () => {
    await criarAtleta(admin, organizationId, {
      fullName: 'PRIMEIRA PESSOA', cpf: gerarCpf(505050505),
      affiliationId: npc.id, affiliationNumber: 'NPC-1000'
    });

    const segunda = await criar({
      fullName: 'SEGUNDA PESSOA', cpf: gerarCpf(515151515),
      affiliationId: npc.id, affiliationNumber: 'NPC-1000'
    });

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('AFFILIATION_NUMBER_IN_USE');
    // O operador precisa saber COM QUEM conferir, senão a recusa vira enigma.
    expect(segunda.body.error.message).toContain('PRIMEIRA PESSOA');
    expect(segunda.body.error.message).toContain('NPC-1000');
  });

  it('a MESMA matrícula em OUTRA filiação é aceita — número é da federação', async () => {
    await criarAtleta(admin, organizationId, {
      fullName: 'DA NPC', cpf: gerarCpf(525252525),
      affiliationId: npc.id, affiliationNumber: 'MESMO-NUMERO'
    });

    const naOutra = await criar({
      fullName: 'DA IFBB', cpf: gerarCpf(535353535),
      affiliationId: outraFiliacao.id, affiliationNumber: 'MESMO-NUMERO'
    });
    expect(naOutra.status, JSON.stringify(naOutra.body).slice(0, 200)).toBe(201);
  });

  it('a mesma matrícula em OUTRA organização é aceita — a fronteira é o tenant', async () => {
    await criarAtleta(admin, organizationId, {
      fullName: 'DAQUI', cpf: gerarCpf(545454545),
      affiliationId: npc.id, affiliationNumber: 'NPC-2000'
    });

    const orgB = await criarOrganizacao(admin, { name: 'Federação Vizinha' });
    const npcDaB = (await api().post('/api/v1/affiliations').set(admin.auth())
      .send({ organizationId: orgB.id, name: 'NPC Vizinha', code: 'NPC' })).body;

    const daVizinha = await api().post('/api/v1/athletes').set(admin.auth()).send({
      organizationId: orgB.id, fullName: 'DE LA', cpf: gerarCpf(555555556),
      sex: 'MALE', birthDate: '1995-03-10',
      affiliationId: npcDaB.id, affiliationNumber: 'NPC-2000'
    });
    expect(daVizinha.status, JSON.stringify(daVizinha.body).slice(0, 200)).toBe(201);
  });

  it('vários atletas SEM matrícula continuam podendo existir', async () => {
    // A regra vale para quem tem filiação E número. Atleta sem filiação
    // registrada é a maioria, e todos têm o campo nulo.
    for (let i = 0; i < 3; i += 1) {
      const criado = await criar({
        fullName: `SEM MATRICULA ${i}`, cpf: gerarCpf(560000000 + i * 1111)
      });
      expect(criado.status, JSON.stringify(criado.body).slice(0, 200)).toBe(201);
    }
    expect(await noLedger(tx => tx.athlete.count({ where: { affiliationNumber: null } }))).toBe(3);
  });

  it('a EDIÇÃO também não pode mover a matrícula para uma já ocupada', async () => {
    await criarAtleta(admin, organizationId, {
      fullName: 'DONA DO NUMERO', cpf: gerarCpf(575757575),
      affiliationId: npc.id, affiliationNumber: 'NPC-3000'
    });
    const outra = await criarAtleta(admin, organizationId, {
      fullName: 'OUTRA PESSOA', cpf: gerarCpf(585858585),
      affiliationId: npc.id, affiliationNumber: 'NPC-3001'
    });

    const edicao = await api().patch(`/api/v1/athletes/${outra.id}`).set(admin.auth())
      .send({ affiliationNumber: 'NPC-3000' });
    expect(edicao.status).toBe(409);
    expect(edicao.body.error.code).toBe('AFFILIATION_NUMBER_IN_USE');
  });

  it('editar só a FILIAÇÃO, mantendo o número, também é conferido', async () => {
    // A conferência usa o estado RESULTANTE. Comparar só o que veio no corpo
    // deixaria esta forma passar: o número não mudou, mas o PAR mudou.
    await criarAtleta(admin, organizationId, {
      fullName: 'JA NA IFBB', cpf: gerarCpf(595959595),
      affiliationId: outraFiliacao.id, affiliationNumber: 'NUMERO-X'
    });
    const naNpc = await criarAtleta(admin, organizationId, {
      fullName: 'AINDA NA NPC', cpf: gerarCpf(606060606),
      affiliationId: npc.id, affiliationNumber: 'NUMERO-X'
    });

    const edicao = await api().patch(`/api/v1/athletes/${naNpc.id}`).set(admin.auth())
      .send({ affiliationId: outraFiliacao.id });
    expect(edicao.status).toBe(409);
  });

  it('editar o próprio atleta para a MESMA matrícula que já é dele é aceito', async () => {
    const atleta = await criarAtleta(admin, organizationId, {
      fullName: 'ELE MESMO', cpf: gerarCpf(616161616),
      affiliationId: npc.id, affiliationNumber: 'NPC-4000'
    });
    const edicao = await api().patch(`/api/v1/athletes/${atleta.id}`).set(admin.auth())
      .send({ affiliationNumber: 'NPC-4000', fullName: 'ELE MESMO CORRIGIDO' });
    expect(edicao.status, JSON.stringify(edicao.body).slice(0, 200)).toBe(200);
  });

  it('o BANCO fecha a corrida entre dois cadastros simultâneos', async () => {
    // A guarda do serviço confere ANTES de inserir: duas requisições podem
    // passar por ela ao mesmo tempo. Quem decide, aí, é o índice único.
    const respostas = await Promise.all(
      Array.from({ length: 8 }, (_, i) => criar({
        fullName: `CORRIDA ${i}`, cpf: gerarCpf(620000000 + i * 1111),
        affiliationId: npc.id, affiliationNumber: 'NPC-CORRIDA'
      }))
    );

    const criados = respostas.filter(r => r.status === 201);
    const recusados = respostas.filter(r => r.status === 409);

    expect(criados, 'exatamente um cadastro pode nascer').toHaveLength(1);
    expect(recusados, 'os demais têm de ser recusados, e não virar erro 500')
      .toHaveLength(respostas.length - 1);
    expect(respostas.filter(r => r.status >= 500), 'corrida não pode virar 500').toHaveLength(0);

    const donas = await noLedger(tx => tx.athlete.count({
      where: { organizationId, affiliationId: npc.id, affiliationNumber: 'NPC-CORRIDA' }
    }));
    expect(donas).toBe(1);
  }, 60_000);
});

describe('o cadastro pelo operador volta a encontrar o histórico', () => {
  it('criar o atleta já vincula o resultado que o esperava', async () => {
    await importarEAplicar(['HX-1,MARIA DA SILVA,NPC,NPC-7000,BIKINI,OPEN,1,Etapa Antiga']);

    const semDono = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: null } }));
    expect(semDono).toBe(1);

    // SEM chamar o vínculo na mão: é o `POST /athletes` puro.
    const atleta = await criarAtleta(admin, organizationId, {
      fullName: 'MARIA DA SILVA', cpf: gerarCpf(636363637),
      affiliationId: npc.id, affiliationNumber: 'NPC-7000'
    });

    const dela = await noLedger(tx => tx.rankingPoint.findMany({ where: { athleteId: atleta.id } }));
    expect(dela, 'o cadastro pelo operador tem de alcançar o histórico').toHaveLength(1);
    expect(dela[0].points).toBe(5);
  });

  it('e não cria ponto, resultado nem identidade nova', async () => {
    await importarEAplicar(['HX-2,JOANA SOUZA,NPC,NPC-7001,BIKINI,OPEN,2,Etapa Antiga']);

    const antes = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));

    await criarAtleta(admin, organizationId, {
      fullName: 'JOANA SOUZA', cpf: gerarCpf(646464646),
      affiliationId: npc.id, affiliationNumber: 'NPC-7001'
    });

    const depois = await noLedger(async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count(),
      identidades: await tx.externalAthlete.count(),
      soma: (await tx.rankingPoint.aggregate({ _sum: { points: true } }))._sum.points
    }));
    expect(depois).toEqual(antes);
  });
});

describe('dado LEGADO: a guarda de dois donos continua de pé', () => {
  it('com o índice ausente, o vínculo ainda se recusa a escolher', async () => {
    // O índice impede que a ambiguidade NASÇA. Ele não apaga a que já existe
    // num banco que rodou anos sem ele — e é para esse dado que a guarda do
    // vínculo continua existindo.
    //
    // Remover o índice aqui é a única forma honesta de medir esse caminho: com
    // ele no lugar, o cenário não se monta, e um teste que não monta o cenário
    // não prova nada. O `afterEach` deste arquivo confere que ele voltou.
    await importarEAplicar(['HX-3,PESSOA AMBIGUA,NPC,NPC-DUPLA,BIKINI,OPEN,1,Etapa Antiga']);

    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDICE}"`);
    let primeira;
    try {
      expect(await indiceExiste(), 'o índice tinha de estar fora para este cenário').toBe(false);

      primeira = await criarAtleta(admin, organizationId, {
        fullName: 'AMBIGUA UM', cpf: gerarCpf(656565656),
        affiliationId: npc.id, affiliationNumber: 'NPC-DUPLA'
      });
      // A segunda entra DIRETO no banco: o serviço a recusaria, e o que se
      // simula aqui é dado que já estava lá.
      await comoAtor(gerente, tx => tx.athlete.create({
        data: {
          organizationId, fullName: 'AMBIGUA DOIS', sex: 'FEMALE',
          affiliationId: npc.id, affiliationNumber: 'NPC-DUPLA'
        }
      }));

      const donas = await noLedger(tx => tx.athlete.count({
        where: { organizationId, affiliationId: npc.id, affiliationNumber: 'NPC-DUPLA' }
      }));
      expect(donas, 'o cenário legado precisa ter duas donas').toBe(2);

      const efeito = await comoAtor(gerente, () => vincularPendentesDoAtleta({
        ...primeira, organizationId, affiliationId: npc.id, affiliationNumber: 'NPC-DUPLA'
      }, { id: gerente.id }));

      // NÃO ESCOLHE. É o mutante 6, ainda morto.
      expect(efeito.vinculados, 'com dois donos, o vínculo não escolhe').toBe(0);
      expect(efeito.lancamentosVinculados).toBe(0);
    } finally {
      // O ÍNDICE SÓ VOLTA DEPOIS DE O DADO AMBÍGUO SAIR.
      //
      // Recriá-lo com as duas linhas ainda lá falha com "Duplicate keys
      // exist" — e falhar no `finally` deixaria a suíte inteira rodando sem a
      // trava, com os testes seguintes medindo um banco errado. É exatamente
      // o que aconteceu na primeira execução deste arquivo.
      //
      // Em produção esta limpeza é decisão humana: qual dos dois cadastros
      // fica. Aqui é descarte de fixture.
      await comoAtor(gerente, tx => tx.athlete.deleteMany({
        where: { organizationId, affiliationId: npc.id, affiliationNumber: 'NPC-DUPLA' }
      }));
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${INDICE}" ON "Athlete"
         ("organizationId", "affiliationId", "affiliationNumber")
         WHERE "affiliationId" IS NOT NULL AND "affiliationNumber" IS NOT NULL`);
    }

    expect(await indiceExiste(), 'o índice tem de voltar mesmo se o teste falhar').toBe(true);
  }, 60_000);
});
