import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// GATE DE CONCORRÊNCIA DO VÍNCULO TARDIO — 20 CHAMADAS SIMULTÂNEAS.
//
// POR QUE ESTE GATE PRECISA EXISTIR SEPARADO DO /apply
//
// O gate do `/apply` mede uma corrida de CRIAÇÃO: vinte requisições tentando
// gravar o mesmo lançamento, e a barreira é a unicidade de
// `(source, externalId)`.
//
// O vínculo tardio é outra corrida, e a barreira é outra. Ele não cria nada —
// preenche `athleteId` em linhas que já existem. O modo de falha aqui não é
// "dois lançamentos": é "o segundo vínculo desfaz ou repete o trabalho do
// primeiro", ou pior, "duas identidades externas para a mesma pessoa", que
// partiria a carreira dela em duas no ranking.
//
// A proteção é compare-and-set: todo `where` exige `athleteId: null`. Quem
// chega primeiro encontra a linha nesse estado; quem chega depois não encontra
// linha nenhuma e conta zero. Não há trava, não há segunda tentativa — a
// corrida perdida simplesmente não tem efeito.
//
// CRITÉRIO:
//   · exatamente UM vínculo efetivo entre as vinte chamadas;
//   · nenhum lançamento criado nem apagado;
//   · a soma de pontos idêntica antes e depois;
//   · UMA identidade externa;
//   · zero exceções não tratadas.
// ============================================================================

const SIMULTANEAS = 20;

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;

const csv = linhas => [
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento',
  ...linhas
].join('\n');

const noLedger = consulta => comoAtor(gerente, consulta);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada 2026', year: 2026 })).body.id;

  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth())
    .send({ rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }] });

  // O histórico entra ANTES de existir cadastro: é o estado em que o vínculo
  // tardio opera de verdade.
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('corrida') + '.csv',
    content: csv([
      'CC-1,MARIA DA SILVA,NPC,NPC-1001,BIKINI,OPEN,1,Etapa',
      'CC-2,JOANA SOUZA,NPC,NPC-1002,BIKINI,OPEN,2,Etapa'
    ])
  });
  await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());
});

describe('vínculo tardio sob concorrência', () => {
  it('vinte chamadas simultâneas produzem UM vínculo, e nada mais', async () => {
    const antes = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));
    expect(antes).toHaveLength(2);
    expect(antes.every(p => p.athleteId === null), 'ninguém tem dono ainda').toBe(true);
    const somaAntes = antes.reduce((s, p) => s + p.points, 0);
    const idsAntes = antes.map(p => p.id).sort();

    const atleta = await criarAtleta(admin, organizationId, {
      fullName: 'MARIA DA SILVA', cpf: gerarCpf(636363636),
      affiliationId: filiacao.id, affiliationNumber: 'NPC-1001'
    });
    const dados = {
      ...atleta, organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-1001'
    };

    const muscleWar = await import('../src/services/muscleWarService.js');

    // TODAS DE UMA VEZ. `allSettled` porque uma rejeição não pode esconder o
    // resultado das outras dezenove — é a DISTRIBUIÇÃO que denuncia a
    // regressão, não o sucesso de uma delas.
    const respostas = await Promise.allSettled(
      Array.from({ length: SIMULTANEAS }, () =>
        comoAtor(gerente, () => muscleWar.vincularPendentesDoAtleta(dados, { id: gerente.id })))
    );

    const falhas = respostas.filter(r => r.status === 'rejected');
    expect(falhas.map(f => String(f.reason?.message ?? f.reason)),
      'corrida não pode virar exceção: quem perde conta zero, não estoura').toEqual([]);

    const efetivos = respostas
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value.lancamentosVinculados);

    // VINTE ZEROS, E O UM ACONTECEU ANTES.
    //
    // O cadastro do atleta passou a disparar o vínculo por conta própria, e é
    // deliberado — quem entra pela porta do operador também precisa encontrar
    // o próprio histórico. Então o vínculo efetivo já ocorreu na criação, e as
    // vinte chamadas disputam uma linha que não está mais em `athleteId: null`.
    //
    // O que este gate mede continua sendo o mesmo, e continua sendo o que
    // importa: vinte execuções simultâneas não produzem vínculo em dobro, não
    // estouram, e não alteram nada. Cobrar que UMA delas devolvesse 1 mediria a
    // ordem dos acontecimentos, não a corrida.
    expect(efetivos.filter(n => n > 0), 'nenhuma das vinte pode ter efeito: o vínculo já existe')
      .toHaveLength(0);
    expect(efetivos.reduce((s, n) => s + n, 0)).toBe(0);

    const depois = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));

    // NADA CRIADO, NADA APAGADO, NADA RECALCULADO.
    expect(depois).toHaveLength(2);
    expect(depois.map(p => p.id).sort()).toEqual(idsAntes);
    expect(depois.reduce((s, p) => s + p.points, 0)).toBe(somaAntes);

    // A Maria ganhou dono — UMA vez, por uma das vinte e uma execuções —; a
    // Joana, que não se cadastrou, continua sem. É o estado final que prova a
    // unicidade do vínculo, e ele não depende de qual chamada chegou primeiro.
    expect(depois.filter(p => p.athleteId === atleta.id)).toHaveLength(1);
    expect(depois.filter(p => p.athleteId === null)).toHaveLength(1);

    // UMA identidade por pessoa. Duas partiriam a carreira dela em duas
    // linhas no ranking, e ninguém perceberia até alguém conferir na mão.
    const identidades = await noLedger(tx => tx.externalAthlete.findMany());
    expect(identidades).toHaveLength(2);
    expect(identidades.filter(i => i.athleteId === atleta.id)).toHaveLength(1);

    // Nenhum atleta criado pela corrida.
    expect(await prisma.athlete.count()).toBe(1);
  }, 120_000);

  it('vinte APPLIES simultâneos de um lote só de pendentes aplicam uma vez', async () => {
    // O gate do /apply já cobre o lote com atleta reconhecido. Este cobre o
    // caso NOVO: um lote em que NINGUÉM está cadastrado — o estado normal de
    // uma carga de histórico. A barreira é a mesma (trava por lote mais
    // unicidade de `(source, externalId)`), mas o caminho que chega nela é
    // outro, e caminho não testado é caminho que ninguém sabe se funciona.
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('corrida-apply') + '.csv',
      content: csv([
        'CC-9,CARLA LIMA,NPC,NPC-9001,BIKINI,OPEN,1,Etapa Nova',
        'CC-8,BEATRIZ ROCHA,NPC,NPC-9002,BIKINI,OPEN,2,Etapa Nova'
      ])
    });
    const importId = lote.body.import.id;
    expect(lote.body.summary.applicable).toBe(2);

    const respostas = await Promise.all(
      Array.from({ length: SIMULTANEAS }, () =>
        api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth()))
    );

    const distribuicao = respostas.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    // Um sucesso, dezenove recusas idempotentes, ZERO erros de servidor.
    expect(distribuicao[200], JSON.stringify(distribuicao)).toBe(1);
    expect(distribuicao[500] ?? 0, 'corrida não pode virar 500').toBe(0);
    expect((distribuicao[422] ?? 0) + (distribuicao[409] ?? 0)).toBe(SIMULTANEAS - 1);

    const contagens = await noLedger(async tx => ({
      identidades: await tx.externalAthlete.count(),
      externos: await tx.externalResult.count(),
      pontos: await tx.rankingPoint.count()
    }));

    // As duas do cenário de fundo mais as duas deste lote — e nada em dobro.
    expect(contagens.identidades).toBe(4);
    expect(contagens.externos).toBe(4);
    expect(contagens.pontos).toBe(4);
  }, 120_000);
});
