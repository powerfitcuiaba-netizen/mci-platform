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
    // A LINHA DE BASE, e não o zero absoluto: `criarUsuario` nasce com papel
    // ATHLETE por padrão, então o próprio gerente do cenário já conta. Medir
    // contra zero acusaria o arreio de teste, e não o produto.
    const usuariosAntes = await prisma.user.count({ where: { role: 'ATHLETE' } });

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
    expect(await prisma.user.count({ where: { role: 'ATHLETE' } })).toBe(usuariosAntes);

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

    // O PRÓPRIO CADASTRO JÁ VINCULOU, e isso mudou nesta fase.
    //
    // A chamada manual continua logo abaixo, e continua sendo a que prova
    // idempotência — mas o UM vínculo efetivo já aconteceu na criação do
    // atleta. Cobrar `1` do retorno da chamada manual mediria a ordem em que
    // as coisas acontecem, e não o que o produto promete: que o lançamento da
    // Maria passe a ter dono, sem lançamento novo.
    const muscleWar = await import('../src/services/muscleWarService.js');
    const comDono = await noLedger(tx => tx.rankingPoint.count({ where: { athleteId: atleta.id } }));
    expect(comDono, 'o lançamento da Maria muda de dono').toBe(1);

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

// ============================================================================
// AS TRÊS GUARDAS QUE A MUTAÇÃO ENCONTROU SEM COBERTURA.
//
// Rodada de mutação nas proteções desta fase: 5 de 8 mutantes morreram. Estes
// três sobreviveram — o código estava certo, mas NADA o obrigava a estar. Um
// mutante vivo não é um teste que falhou: é a descoberta de que a proteção
// vale o que vale um comentário, porque ninguém a exercita.
//
// Os três são do mesmo tipo: caminhos em que o sistema poderia dar a carreira
// de uma pessoa a outra, em silêncio, e nenhuma revisão posterior desfaria —
// o ponto já estaria somando no ranking de quem não competiu.
// ============================================================================
describe('as guardas que impedem creditar resultado à pessoa errada', () => {
  it('SUGESTÃO POR NOME NÃO VIRA VÍNCULO, nem na hora de aplicar', async () => {
    // MUTANTE 1: trocar `item.athleteId` por
    // `item.athleteId ?? item.suggestedAthleteId` na criação do lançamento.
    //
    // A sugestão por nome existe para AVISAR o operador, e mora numa coluna
    // diferente de `athleteId` justamente para que nenhum caminho de aplicação
    // as confunda. Duas atletas chamadas "Ana Silva" existem; fundir as duas
    // num cadastro só apaga uma carreira.
    const outra = await criarAtleta(gerente, organizationId, {
      fullName: 'MARIA DA SILVA',
      cpf: CPF_DE_QUEM_SE_CADASTRA,
      affiliationId: filiacao.id,
      affiliationNumber: 'NPC-OUTRA-PESSOA'
    });

    // Linha SEM chave nenhuma — sem CPF, sem filiação, sem matrícula — e com o
    // mesmo nome. É o único caso em que a sugestão por nome é produzida.
    const lote = await importar(csv(['HX-S,MARIA DA SILVA,,,BIKINI,OPEN,1,Etapa Histórica']));
    const item = lote.body.items[0];
    expect(item.matchStatus).toBe('MATCH_PENDING');
    expect(item.suggestedAthleteId, 'o cenário precisa produzir a sugestão').toBe(outra.id);
    expect(item.athleteId ?? null, 'sugestão não é vínculo').toBeNull();

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const [ponto] = await noLedger(tx => tx.rankingPoint.findMany());
    // O LANÇAMENTO NASCE SEM DONO. Se a sugestão vazasse para cá, a outra
    // Maria — que não competiu esta etapa — levaria os 5 pontos.
    expect(ponto.athleteId, 'a sugestão por nome não pode virar dono do ponto').toBeNull();
    expect(ponto.externalAthleteId).not.toBeNull();

    const [externo] = await noLedger(tx => tx.externalResult.findMany());
    expect(externo.athleteId).toBeNull();
  });

  it('MATRÍCULA COM DOIS DONOS deixou de ser um estado possível', async () => {
    // MUTANTE 6: remover `homonimosDeMatricula === 0` do vínculo automático.
    //
    // Este teste montava duas atletas com a MESMA matrícula na MESMA filiação
    // e cobrava que o vínculo não escolhesse entre elas. A guarda continua no
    // código — e continua coberta, em `matricula-identifica-um.test.mjs`, com
    // dado legado simulado.
    //
    // O QUE MUDOU É QUE O CENÁRIO NÃO SE MONTA MAIS. Matrícula repetida na
    // mesma filiação virou estado IMPOSSÍVEL: há guarda no serviço e índice
    // único parcial no banco. A ambiguidade não é mais tratada; ela é
    // impedida, que é a proteção mais forte das duas.
    const lote = await importar(csv(['HX-D,PESSOA AMBIGUA,FED-MT,NPC-DUPLA,BIKINI,OPEN,1,Etapa Histórica']));
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    await criarAtleta(gerente, organizationId, {
      fullName: 'PESSOA AMBIGUA UM', cpf: gerarCpf(818181818),
      affiliationId: filiacao.id, affiliationNumber: 'NPC-DUPLA'
    });

    // A segunda é RECUSADA. Antes ela era aceita e a ambiguidade nascia aqui.
    const segunda = await api().post('/api/v1/athletes').set(gerente.auth()).send({
      organizationId, fullName: 'PESSOA AMBIGUA DOIS', cpf: gerarCpf(828282829),
      sex: 'FEMALE', birthDate: '1996-05-10',
      affiliationId: filiacao.id, affiliationNumber: 'NPC-DUPLA'
    });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('AFFILIATION_NUMBER_IN_USE');

    // E existe UMA dona da matrícula, não duas.
    const donas = await comoAtor(gerente, tx => tx.athlete.count({
      where: { organizationId, affiliationId: filiacao.id, affiliationNumber: 'NPC-DUPLA' }
    }));
    expect(donas).toBe(1);
  });

  it('RESULTADO QUE JÁ TEM DONO não se revincula pela porta da revisão', async () => {
    // MUTANTE 7: trocar `APPLIED && athleteId == null` por `APPLIED`.
    //
    // A porta da revisão existe para dar dono a quem não tem. Trocar o dono de
    // um resultado JÁ PUBLICADO é outra operação, com outra pergunta de
    // autorização — e sem a condição de nulo, qualquer revisor moveria
    // resultado publicado de uma atleta para outra sem deixar rastro de
    // correção.
    const dona = await criarAtleta(gerente, organizationId, {
      fullName: 'DONA LEGITIMA', cpf: gerarCpf(919191919),
      affiliationId: filiacao.id, affiliationNumber: 'NPC-2001'
    });

    const lote = await importar(csv(['HX-P,DONA LEGITIMA,FED-MT,NPC-2001,BIKINI,OPEN,1,Etapa Histórica']));
    const item = lote.body.items[0];
    expect(item.matchStatus, 'a linha precisa ser reconhecida').toBe('MATCHED');

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth());

    const antes = await noLedger(tx => tx.rankingPoint.findMany());
    expect(antes).toHaveLength(1);
    expect(antes[0].athleteId).toBe(dona.id);

    const intrusa = await criarAtleta(gerente, organizationId, {
      fullName: 'OUTRA PESSOA', cpf: gerarCpf(929292929),
      affiliationId: filiacao.id, affiliationNumber: 'NPC-2002'
    });

    const tentativa = await api().post(`/api/v1/musclewar/items/${item.id}/link`)
      .set(gerente.auth()).send({ athleteId: intrusa.id });

    expect(tentativa.status, JSON.stringify(tentativa.body)).toBe(422);
    expect(tentativa.body.error.code).toBe('ITEM_NOT_PENDING');

    // E o ponto continua de quem competiu.
    const depois = await noLedger(tx => tx.rankingPoint.findMany());
    expect(depois).toHaveLength(1);
    expect(depois[0].athleteId).toBe(dona.id);
    expect(depois[0].points).toBe(5);
  });
});
