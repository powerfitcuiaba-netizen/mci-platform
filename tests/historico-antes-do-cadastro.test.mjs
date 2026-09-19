import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarAtleta, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// O HISTÓRICO OFICIAL CHEGA ANTES DAS PESSOAS.
//
// O MCI é um sistema novo. Os campeonatos que ele precisa ranquear aconteceram
// ANTES de ele existir, e os atletas desses campeonatos não têm cadastro aqui —
// vão criá-lo aos poucos, ao longo de meses. Carregar o histórico só depois de
// cadastrar todo mundo é esperar por uma ordem que a realidade não vai seguir.
//
// Até esta fase isso era impossível por construção: `ExternalResult.athleteId` e
// `RankingPoint.athleteId` eram NOT NULL. A única forma de guardar um resultado
// era ter um cadastro para pendurá-lo — e a saída óbvia, criar o cadastro
// automaticamente, é a errada: inventa CPF, inventa usuário, e funde num perfil
// só as carreiras de duas pessoas que por acaso se chamam igual.
//
// A saída certa é separar QUEM COMPETIU SEGUNDO A FONTE — fato do campeonato —
// de QUEM É O USUÁRIO DO MCI — fato do cadastro. É o que `ExternalAthlete` faz.
//
// ESTE ARQUIVO É O CRITÉRIO DE ACEITE DA FASE, e mede o ciclo inteiro:
//
//   importar → aplicar SEM atleta nenhum → ranking com nome da fonte
//     → cadastrar o atleta → vincular → ranking com os MESMOS pontos
//     → vincular de novo → nada acontece
//
// A pergunta que ele responde não é "o código roda". É: os pontos sobrevivem
// ao cadastro, sem duplicar e sem sumir?
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;
let filiacao;

const CPF_DE_QUEM_SE_CADASTRA = gerarCpf(717171717);

// A coluna de matrícula é o que torna a linha ALCANÇÁVEL pelo vínculo tardio:
// a identidade externa é organização + filiação + matrícula. Sem ela o
// resultado entra no histórico do mesmo jeito, mas ninguém vem buscá-lo.
const csv = linhas => [
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento',
  ...linhas
].join('\n');

const importar = conteudo => api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
  organizationId, seasonId, sourceType: 'CSV', sourceRef: unico('historico') + '.csv', content: conteudo
});

// O ledger tem RLS de operador desde esta fase: `prisma` sem contexto é
// anônimo, e anônimo não o lê. Que o anônimo NÃO lê é asserção própria, mais
// abaixo — proteção não se prova no mesmo lugar em que se confere função.
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
    .send({ organizationId, name: 'Federação Mato-grossense', code: 'FED-MT' })).body;

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada Histórica 2026', year: 2026 })).body.id;

  // A TABELA HOMOLOGADA, e não uma inventada para o teste passar.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });
});

describe('o resultado histórico existe sem atleta cadastrado', () => {
  const ARQUIVO = csv([
    'HX-1,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa Histórica',
    'HX-2,JOANA SOUZA,FED-MT,NPC-1002,BIKINI,OPEN,2,Etapa Histórica',
    'HX-3,CARLA LIMA,FED-MT,NPC-1003,BIKINI,OPEN,3,Etapa Histórica'
  ]);

  it('aplica com ZERO atletas cadastrados, e continua com zero depois', async () => {
    expect(await prisma.athlete.count(), 'o cenário começa sem cadastro nenhum').toBe(0);

    const lote = await importar(ARQUIVO);
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);

    // TODAS pendentes: não há cadastro com que casar. Isso não é erro.
    expect(lote.body.summary.totalRecords).toBe(3);
    expect(lote.body.summary.recognized).toBe(0);
    expect(lote.body.summary.pending).toBe(3);
    expect(lote.body.summary.conflicts).toBe(0);
    expect(lote.body.summary.rejected).toBe(0);
    expect(lote.body.summary.duplicates).toBe(0);
    // O NÚMERO QUE MUDOU DE SIGNIFICADO NESTA FASE. Com a regra antiga isto
    // seria 0, e a tela diria "Aplicar 0 resultado(s)" para um arquivo em que
    // todas as três linhas estão perfeitas.
    expect(lote.body.summary.applicable).toBe(3);
    expect(lote.body.summary.pendingLink).toBe(3);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
      .set(gerente.auth());
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);
    expect(aplicacao.body.applied).toBe(3);

    // NENHUM ATLETA CRIADO. É a asserção que não pode ceder em hipótese
    // alguma: é ela que separa "carregar histórico" de "fabricar gente".
    expect(await prisma.athlete.count()).toBe(0);
    expect(await prisma.user.count({ where: { role: 'ATHLETE' } })).toBe(0);

    const identidades = await noLedger(tx => tx.externalAthlete.findMany({ orderBy: { identityKey: 'asc' } }));
    const externos = await noLedger(tx => tx.externalResult.findMany());
    const pontos = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));

    expect(identidades).toHaveLength(3);
    expect(externos).toHaveLength(3);
    expect(pontos).toHaveLength(3);

    // A identidade é filiação + matrícula, nunca nome.
    expect(identidades.map(i => i.identityKey))
      .toEqual(['NPC-1001', 'NPC-1002', 'NPC-1003'].map(m => `AFF:${filiacao.id}:${m}`));
    expect(identidades.every(i => i.athleteId === null), 'ninguém vinculado ainda').toBe(true);
    expect(identidades.map(i => i.displayName).sort())
      .toEqual(['CARLA LIMA', 'JOANA SOUZA', 'MARIA DA SILVA']);

    // Sem dono, COM organização: a tenancy deixou de ser deduzida do atleta.
    expect(externos.every(e => e.athleteId === null)).toBe(true);
    expect(externos.every(e => e.organizationId === organizationId)).toBe(true);
    expect(pontos.every(p => p.athleteId === null)).toBe(true);
    expect(pontos.every(p => p.organizationId === organizationId)).toBe(true);
    expect(pontos.every(p => p.externalAthleteId !== null)).toBe(true);

    // A REGRA HOMOLOGADA, aplicada pela colocação: 1º=5, 2º=4, 3º=3.
    expect(pontos.map(p => p.points)).toEqual([5, 4, 3]);
  });

  it('o ranking mostra o competidor sem cadastro, com o nome da fonte', async () => {
    const lote = await importar(ARQUIVO);
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.status).toBe(200);
    expect(ranking.body.items).toHaveLength(3);

    const primeira = ranking.body.items[0];
    expect(primeira.totalPoints).toBe(5);
    expect(primeira.athlete.fullName).toBe('MARIA DA SILVA');
    // `id` NULO é deliberado: nada pode montar link para um perfil que não
    // existe. `pendingLink` diz à tela que a pessoa está esperando cadastro —
    // não que houve erro.
    expect(primeira.athlete.id).toBeNull();
    expect(primeira.athlete.pendingLink).toBe(true);

    expect(ranking.body.items.map(l => l.totalPoints)).toEqual([5, 4, 3]);
    expect(ranking.body.items.map(l => l.position)).toEqual([1, 2, 3]);
  });
});

describe('o cadastro chega depois, e o histórico vai atrás dele', () => {
  // O ciclo completo do §9, medido ponto a ponto.
  it('vincular preserva os pontos exatos, sem lançamento novo', async () => {
    const lote = await importar(csv([
      'HX-1,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa Histórica',
      'HX-2,JOANA SOUZA,FED-MT,NPC-1002,BIKINI,OPEN,2,Etapa Histórica'
    ]));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const antes = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));
    const totalAntes = antes.reduce((soma, p) => soma + p.points, 0);
    const idsAntes = antes.map(p => p.id).sort();
    expect(totalAntes).toBe(9);

    // AGORA a pessoa se cadastra — com a MESMA filiação e a MESMA matrícula.
    // É o único par que autoriza o vínculo; nome não entra em nada disto.
    const atleta = await criarAtleta(gerente, organizationId, {
      fullName: 'MARIA DA SILVA',
      cpf: CPF_DE_QUEM_SE_CADASTRA,
      affiliationId: filiacao.id,
      affiliationNumber: 'NPC-1001'
    });

    const muscleWar = await import('../src/services/muscleWarService.js');
    const primeira = await comoAtor(gerente, () => muscleWar.vincularPendentesDoAtleta(
      { ...atleta, organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-1001' },
      { id: gerente.id }
    ));

    expect(primeira.lancamentosVinculados, 'o lançamento da Maria muda de dono').toBe(1);

    const depois = await noLedger(tx => tx.rankingPoint.findMany({ orderBy: { placing: 'asc' } }));

    // OS PONTOS SÃO OS MESMOS. Nenhum lançamento novo, nenhum apagado: os
    // mesmos ids, os mesmos valores. O vínculo preencheu um ponteiro.
    expect(depois).toHaveLength(2);
    expect(depois.map(p => p.id).sort()).toEqual(idsAntes);
    expect(depois.reduce((soma, p) => soma + p.points, 0)).toBe(totalAntes);
    expect(depois.map(p => p.points)).toEqual([5, 4]);

    const daMaria = depois.find(p => p.points === 5);
    expect(daMaria.athleteId).toBe(atleta.id);
    // A identidade externa CONTINUA existindo, agora apontando para o cadastro.
    expect(daMaria.externalAthleteId).not.toBeNull();

    // A Joana não se cadastrou: o resultado dela continua sem dono, intacto.
    expect(depois.find(p => p.points === 4).athleteId).toBeNull();

    // O ranking mostra as duas — uma com cadastro, outra sem — e uma vez cada.
    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items).toHaveLength(2);
    expect(ranking.body.items.map(l => l.totalPoints)).toEqual([5, 4]);
    expect(ranking.body.items[0].athlete.id).toBe(atleta.id);
    expect(ranking.body.items[1].athlete.id).toBeNull();

    // ---- E AGORA A SEGUNDA E A TERCEIRA EXECUÇÃO ----
    const segunda = await comoAtor(gerente, () => muscleWar.vincularPendentesDoAtleta(
      { ...atleta, organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-1001' },
      { id: gerente.id }
    ));
    const terceira = await comoAtor(gerente, () => muscleWar.vincularPendentesDoAtleta(
      { ...atleta, organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-1001' },
      { id: gerente.id }
    ));

    // ZERO ALTERAÇÕES. Não é uma trava contra repetição — é a repetição não
    // ter efeito, porque todo `where` exige `athleteId: null` e não há mais
    // linha nesse estado.
    expect(segunda.lancamentosVinculados).toBe(0);
    expect(terceira.lancamentosVinculados).toBe(0);

    const noFim = await noLedger(tx => tx.rankingPoint.findMany());
    expect(noFim).toHaveLength(2);
    expect(noFim.reduce((soma, p) => soma + p.points, 0)).toBe(totalAntes);

    const rankingNoFim = await api().get('/api/v1/ranking').query({ seasonId });
    expect(rankingNoFim.body.items).toHaveLength(2);
    expect(rankingNoFim.body.items.map(l => l.totalPoints)).toEqual([5, 4]);
  });

  it('matrícula de outra pessoa não traz o histórico junto', async () => {
    const lote = await importar(csv([
      'HX-9,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa Histórica'
    ]));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    // Mesmo NOME, matrícula DIFERENTE. Se o vínculo olhasse nome, esta pessoa
    // levaria a carreira da outra — e nenhuma revisão posterior desfaz isso,
    // porque o ponto já estaria somando no ranking de quem não competiu.
    const outra = await criarAtleta(gerente, organizationId, {
      fullName: 'MARIA DA SILVA',
      cpf: gerarCpf(828282828),
      affiliationId: filiacao.id,
      affiliationNumber: 'NPC-9999'
    });

    const muscleWar = await import('../src/services/muscleWarService.js');
    const resultado = await comoAtor(gerente, () => muscleWar.vincularPendentesDoAtleta(
      { ...outra, organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-9999' },
      { id: gerente.id }
    ));

    expect(resultado.lancamentosVinculados).toBe(0);
    const pontos = await noLedger(tx => tx.rankingPoint.findMany());
    expect(pontos[0].athleteId, 'o histórico continua sem dono').toBeNull();
  });
});

describe('aplicar é idempotente mesmo sem atleta nenhum', () => {
  it('três aplicações produzem um conjunto só', async () => {
    const lote = await importar(csv([
      'HX-1,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa Histórica',
      'HX-2,JOANA SOUZA,FED-MT,NPC-1002,BIKINI,OPEN,2,Etapa Histórica'
    ]));
    const importId = lote.body.import.id;

    const primeira = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
    expect(primeira.body.applied).toBe(2);

    const segunda = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());
    const terceira = await api().post(`/api/v1/musclewar/imports/${importId}/apply`).set(gerente.auth());

    // Sem candidato sobrando, a recusa é explícita — e não uma aplicação
    // silenciosa que não faz nada.
    expect(segunda.status).toBe(422);
    expect(segunda.body.error.code).toBe('NOTHING_TO_APPLY');
    expect(terceira.status).toBe(422);

    expect(await noLedger(tx => tx.externalAthlete.count())).toBe(2);
    expect(await noLedger(tx => tx.externalResult.count())).toBe(2);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(2);
    expect(await prisma.athlete.count()).toBe(0);
  });

  it('a mesma matrícula em duas linhas usa UMA identidade externa', async () => {
    // Duas participações da mesma pessoa no mesmo campeonato — categorias
    // diferentes. São dois resultados e UM competidor, e é a chave de
    // identidade que garante isso.
    const lote = await importar(csv([
      'HX-1,MARIA DA SILVA,FED-MT,NPC-1001,BIKINI,OPEN,1,Etapa Histórica',
      'HX-2,MARIA DA SILVA,FED-MT,NPC-1001,WELLNESS,OPEN,2,Etapa Histórica'
    ]));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    expect(await noLedger(tx => tx.externalAthlete.count())).toBe(1);
    expect(await noLedger(tx => tx.externalResult.count())).toBe(2);
    expect(await noLedger(tx => tx.rankingPoint.count())).toBe(2);

    // No ranking geral ela aparece uma vez por categoria, como qualquer
    // atleta com cadastro apareceria: o recorte é por categoria.
    const ranking = await api().get('/api/v1/ranking').query({ seasonId });
    expect(ranking.body.items.every(l => l.athlete.fullName === 'MARIA DA SILVA')).toBe(true);
  });
});
