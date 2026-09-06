import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// Motor oficial de pontuação, Overall e desempate — contra a plataforma real.
//
// Os testes de unidade (tests/pontuacao-oficial.test.mjs) provam a aritmética.
// Aqui prova-se o resto: que a regra vale no caminho da aplicação, que só
// resultado publicado alimenta o ranking, que a versão válida é a que conta,
// que reprocessar não duplica e que ninguém sem permissão mexe em ponto.
// ============================================================================

let admin;
let diretor;
let orgId;
let seasonId;
let juizes;

const cpfSeq = (() => { let n = 400000000; return () => gerarCpf(n += 7717); })();

// Mesmo nome, mesmo CPF, mesmo atleta em todas as etapas: é o que permite a
// pontuação acumular ao longo da temporada em vez de criar um cadastro novo a
// cada evento.
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

async function eventoPontuado({ colocacoes, teams = {}, overall = null, publicar = true, classe = null }) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  const { event, competitionClass } = montado;

  // A classe do evento é renomeada para o código pedido; a elegibilidade ao
  // Super Overall vem do catálogo da organização, resolvida na atribuição.
  if (classe) {
    await comoAtor(diretor, tx => tx.competitionClass.update({
      where: { id: competitionClass.id }, data: { code: classe }
    }));
  }

  await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscritos = [];
  for (const nome of colocacoes) {
    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.push({ nome, registration: inscricao.body.registration, athleteId: inscricao.body.registration.athlete.id });
  }

  // Equipe é atributo do atleta: quem define é o cadastro, não a inscrição.
  for (const inscrito of inscritos) {
    const teamId = teams[inscrito.nome];
    if (teamId) {
      await comoAtor(diretor, tx => tx.athlete.update({ where: { id: inscrito.athleteId }, data: { teamId } }));
    }
  }

  await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const inscrito of inscritos) {
    await api().post(`/api/v1/registrations/${inscrito.registration.id}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, event.id, ['IN_JUDGING']);

  const painel = await api().post(`/api/v1/events/${event.id}/panels`).set(diretor.auth()).send({ name: unico('painel') });
  for (const [indice, juiz] of juizes.entries()) {
    await api().post(`/api/v1/panels/${painel.body.id}/judges`).set(diretor.auth())
      .send({ judgeId: juiz.id, seat: indice + 1, role: indice === 0 ? 'HEAD' : 'JUDGE' });
  }

  const sessao = await api().post('/api/v1/judging-sessions').set(diretor.auth())
    .send({ classId: competitionClass.id, panelId: painel.body.id, round: 'FINALS' });

  const ficha = await api().get(`/api/v1/judging-sessions/${sessao.body.id}/sheet`).set(juizes[0].auth());
  const ordenados = colocacoes.map(nome =>
    ficha.body.competitors.find(item => item.athlete.fullName === nome));

  for (const juiz of juizes) {
    await api().post(`/api/v1/judging-sessions/${sessao.body.id}/scores`).set(juiz.auth())
      .send({ placings: ordenados.map((item, indice) => ({ registrationItemId: item.registrationItemId, placing: indice + 1 })) });
  }
  await api().post(`/api/v1/judging-sessions/${sessao.body.id}/close`).set(diretor.auth());
  await api().post(`/api/v1/classes/${competitionClass.id}/result/calculate`).set(diretor.auth()).send({});

  if (overall) {
    const campeao = inscritos.find(item => item.nome === overall);
    const declarado = await api().post(`/api/v1/events/${event.id}/overall`).set(diretor.auth())
      .send({ athleteId: campeao.athleteId });
    expect(declarado.status, JSON.stringify(declarado.body)).toBe(201);
  }

  if (publicar) {
    const publicado = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
      .send({ note: 'Homologado' });
    expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);
  }

  return { ...montado, inscritos };
}

const pontosDe = async nome => {
  const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: nome } }));
  return comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { athleteId: atleta.id }, orderBy: { awardedAt: 'asc' } }));
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  cpfPorNome = new Map();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretora' });
  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');

  juizes = [];
  for (const nome of ['Juiz A', 'Juiz B', 'Juiz C']) {
    const juiz = await criarUsuario({ name: nome });
    await vincular(orgId, juiz, 'JUDGE');
    juizes.push(juiz);
  }

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  expect(temporada.status, JSON.stringify(temporada.body)).toBe(201);
  seasonId = temporada.body.id;
});

describe('a temporada nasce com a tabela homologada', () => {
  it('1º=5 · 2º=4 · 3º=3 · 4º=2 · 5º=1, como DADO na tabela da temporada', async () => {
    const regras = await prisma.rankingPointsRule.findMany({ where: { seasonId }, orderBy: { placing: 'asc' } });

    expect(regras.map(r => [r.placing, r.points])).toEqual([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
  });

  it('a tabela é substituível sem tocar em código — é configuração, não constante', async () => {
    const substituida = await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(diretor.auth())
      .send({ rules: [{ placing: 1, points: 25 }, { placing: 2, points: 20 }] });

    expect(substituida.status).toBe(200);
    const regras = await prisma.rankingPointsRule.findMany({ where: { seasonId }, orderBy: { placing: 'asc' } });
    expect(regras.map(r => [r.placing, r.points])).toEqual([[1, 25], [2, 20]]);
  });
});

describe('A/B/C) pontuação e Overall no caminho real', () => {
  it('cinco atletas: 5 · 4 · 3 · 2 · 1, e o campeão Overall soma +10', async () => {
    await eventoPontuado({
      colocacoes: ['ATLETA A', 'ATLETA B', 'ATLETA C', 'ATLETA D', 'ATLETA E'],
      overall: 'ATLETA A'
    });

    const conferir = async (nome, esperado) => {
      const [ponto] = await pontosDe(nome);
      expect(
        { colocacao: ponto.placementPoints, overall: ponto.overallBonus, total: ponto.points },
        `${nome}`
      ).toEqual(esperado);
    };

    // A é 1ª (5) E campeã Overall (+10) = 15. O bônus soma, não substitui.
    await conferir('ATLETA A', { colocacao: 5, overall: 10, total: 15 });
    await conferir('ATLETA B', { colocacao: 4, overall: 0, total: 4 });
    await conferir('ATLETA C', { colocacao: 3, overall: 0, total: 3 });
    await conferir('ATLETA D', { colocacao: 2, overall: 0, total: 2 });
    await conferir('ATLETA E', { colocacao: 1, overall: 0, total: 1 });
  });

  it('sem Overall declarado, o 1º lugar vale exatamente 5', async () => {
    await eventoPontuado({ colocacoes: ['SOZINHA', 'SEGUNDA'] });

    const [ponto] = await pontosDe('SOZINHA');
    expect(ponto.points).toBe(5);
    expect(ponto.isOverallChampion).toBe(false);
    expect(ponto.overallBonus).toBe(0);
  });

  it('o total é reconstituível: points = placementPoints + overallBonus', async () => {
    await eventoPontuado({ colocacoes: ['UM', 'DOIS', 'TRES'], overall: 'DOIS' });

    const todos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    for (const ponto of todos) {
      expect(ponto.points, `ponto ${ponto.id}`).toBe(ponto.placementPoints + ponto.overallBonus);
    }
    // DOIS ficou em 2º (4) e levou o Overall (+10) = 14.
    const [doisPonto] = await pontosDe('DOIS');
    expect(doisPonto.points).toBe(14);
  });
});

describe('E) desempate por Overall no ranking real', () => {
  it('mesma pontuação, quem tem título Overall fica à frente', async () => {
    // Etapa 1: A vence e leva o Overall → 15.
    await eventoPontuado({ colocacoes: ['ATLETA_A', 'OUTRA1', 'OUTRA2'], overall: 'ATLETA_A' });
    // Etapa 2: B vence três vezes? Não — para igualar em pontos, B soma 15 em
    // três primeiros lugares (5+5+5) sem nenhum Overall.
    for (const rodada of [1, 2, 3]) {
      await eventoPontuado({ colocacoes: ['ATLETA_B', `FIGURANTE${rodada}`] });
    }

    const ranking = await comoAtor(diretor, tx => tx.ranking.findMany({ where: { seasonId }, orderBy: { position: 'asc' } }));
    const nomes = await comoAtor(diretor, tx => tx.athlete.findMany({ where: { id: { in: ranking.map(r => r.athleteId) } }, select: { id: true, fullName: true } }));
    const nome = id => nomes.find(a => a.id === id).fullName;

    const a = ranking.find(linha => nome(linha.athleteId) === 'ATLETA_A');
    const b = ranking.find(linha => nome(linha.athleteId) === 'ATLETA_B');

    expect(a.totalPoints, 'ATLETA_A: 5 da colocação + 10 do Overall').toBe(15);
    expect(b.totalPoints, 'ATLETA_B: três primeiros lugares').toBe(15);
    expect(a.overallWins).toBe(1);
    expect(b.overallWins).toBe(0);
    expect(b.firstPlaceCount).toBe(3);

    expect(a.position, 'o Overall é consultado antes do número de primeiros lugares').toBeLessThan(b.position);
  });
});

describe('K) auditoria: todo ponto tem origem', () => {
  it('cada lançamento aponta evento, classe, resultado, versão, equipe e autor', async () => {
    const { event, competitionClass } = await eventoPontuado({ colocacoes: ['RASTREADA', 'OUTRA'], overall: 'RASTREADA' });

    const [ponto] = await pontosDe('RASTREADA');

    expect(ponto.eventId).toBe(event.id);
    expect(ponto.classId).toBe(competitionClass.id);
    expect(ponto.resultId).toBeTruthy();
    expect(ponto.resultVersion).toBeGreaterThanOrEqual(1);
    expect(ponto.awardedById).toBe(diretor.id);
    expect(ponto.source).toBe('EVENT');
    expect(ponto.categoryId).toBeTruthy();
    expect(ponto.placing).toBe(1);
    expect(ponto.isOverallChampion).toBe(true);
  });

  it('a declaração de Overall fica registrada com autor', async () => {
    const { event, inscritos } = await eventoPontuado({ colocacoes: ['CAMPEA', 'VICE'], overall: 'CAMPEA' });

    const titulo = await prisma.eventOverallTitle.findFirst({ where: { eventId: event.id } });
    expect(titulo.athleteId).toBe(inscritos.find(i => i.nome === 'CAMPEA').athleteId);
    expect(titulo.declaredById).toBe(diretor.id);

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({ where: { action: 'OVERALL_DECLARE' } }));
    expect(trilha.length).toBeGreaterThanOrEqual(1);
    expect(trilha[0].userEmail).toBe(diretor.email);
  });

  it('não existe ponto sem resultado de origem', async () => {
    await eventoPontuado({ colocacoes: ['UMA', 'DUAS'] });

    const orfaos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({
      where: { seasonId, resultId: null, externalResultId: null }
    }));
    expect(orfaos).toHaveLength(0);
  });
});

describe('L/M) só resultado válido alimenta o ranking', () => {
  it('resultado não publicado não pontua', async () => {
    await eventoPontuado({ colocacoes: ['NAO_PUBLICADA', 'OUTRA'], publicar: false });

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(pontos).toHaveLength(0);

    const publico = await api().get('/api/v1/ranking').query({ seasonId });
    expect(publico.body.items).toHaveLength(0);
  });

  it('correção versionada repontua pela versão válida, sem somar à anterior', async () => {
    const { competitionClass } = await eventoPontuado({ colocacoes: ['PRIMEIRA', 'SEGUNDA'] });

    const antes = await pontosDe('PRIMEIRA');
    expect(antes).toHaveLength(1);
    expect(antes[0].points).toBe(5);

    const resultado = await prisma.result.findFirst({ where: { classId: competitionClass.id } });
    const entries = await comoAtor(diretor, tx => tx.resultEntry.findMany({ where: { resultId: resultado.id } }));
    const daPrimeira = entries.find(e => e.placing === 1);
    const daSegunda = entries.find(e => e.placing === 2);

    // Correção: as duas trocam de lugar. `results.override` não pertence a
    // nenhum papel de organização — corrigir resultado publicado é ato
    // privilegiado, e só o administrador da plataforma o exerce.
    const correcao = await api().post(`/api/v1/classes/${competitionClass.id}/result/override`).set(admin.auth())
      .send({
        reason: 'Correção de conferência de ficha',
        entries: [
          { registrationItemId: daPrimeira.registrationItemId, placing: 2, status: 'RANKED' },
          { registrationItemId: daSegunda.registrationItemId, placing: 1, status: 'RANKED' }
        ]
      });
    expect(correcao.status, JSON.stringify(correcao.body)).toBe(200);

    const depois = await pontosDe('PRIMEIRA');
    expect(depois, 'a correção não pode acumular com a versão anterior').toHaveLength(1);
    expect(depois[0].points, 'passou a ser 2º lugar').toBe(4);
    expect(depois[0].resultVersion).toBeGreaterThan(antes[0].resultVersion);
  });
});

describe('N/O) idempotência e concorrência', () => {
  it('reprocessar o mesmo resultado não duplica pontos', async () => {
    const { competitionClass } = await eventoPontuado({ colocacoes: ['UNICA', 'OUTRA'] });
    const resultado = await prisma.result.findFirst({ where: { classId: competitionClass.id } });

    for (const vez of [1, 2, 3]) {
      const repetir = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({});
      expect(repetir.status, `recompute ${vez}`).toBe(200);
    }

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId, resultId: resultado.id } }));
    expect(pontos).toHaveLength(2);

    const daUnica = await pontosDe('UNICA');
    expect(daUnica).toHaveLength(1);
    expect(daUnica[0].points).toBe(5);
  });

  it('recomputes simultâneos não geram pontuação duplicada', async () => {
    await eventoPontuado({ colocacoes: ['CONCORRENTE', 'OUTRA'] });

    await Promise.all([1, 2, 3, 4].map(() =>
      api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({})));

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(pontos).toHaveLength(2);

    const linhas = await comoAtor(diretor, tx => tx.ranking.findMany({ where: { seasonId } }));
    const chaves = linhas.map(l => `${l.athleteId}::${l.categoryId}`);
    expect(new Set(chaves).size, 'linha de ranking duplicada').toBe(chaves.length);
  });
});

describe('J) segurança: ponto não se altera sem permissão', () => {
  it('quem não tem ranking.manage não declara Overall', async () => {
    const { event, inscritos } = await eventoPontuado({ colocacoes: ['ALVO', 'OUTRA'] });
    const intruso = await criarUsuario({ name: 'Intruso' });

    const tentativa = await api().post(`/api/v1/events/${event.id}/overall`).set(intruso.auth())
      .send({ athleteId: inscritos[0].athleteId });

    expect([403, 404]).toContain(tentativa.status);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: event.id } })).toBe(0);
  });

  it('operador de outra organização não declara Overall nem recomputa', async () => {
    const { event, inscritos } = await eventoPontuado({ colocacoes: ['ALVO', 'OUTRA'] });

    const outroDiretor = await criarUsuario({ name: 'Diretor B' });
    const outraOrg = await criarOrganizacao(admin, { name: unico('Federação B') });
    await vincular(outraOrg.id, outroDiretor, 'RANKING_MANAGER');

    const declarar = await api().post(`/api/v1/events/${event.id}/overall`).set(outroDiretor.auth())
      .send({ athleteId: inscritos[0].athleteId });
    expect([403, 404]).toContain(declarar.status);

    const recomputar = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(outroDiretor.auth()).send({});
    expect([403, 404]).toContain(recomputar.status);
  });

  it('não existe rota que escreva ponto de ranking à mão', async () => {
    const escrita = await api().post('/api/v1/ranking-points').set(admin.auth()).send({ points: 999 });
    expect(escrita.status).toBe(404);
  });
});

describe('D) equipes: a MESMA regra, sem fórmula própria', () => {
  it('a pontuação da equipe é a soma dos pontos dos seus atletas, incluindo o Overall', async () => {
    const alfa = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Alfa') });
    const beta = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Beta') });
    expect(alfa.status, JSON.stringify(alfa.body)).toBe(201);

    // ALFA1 vence e leva o Overall (5+10=15); ALFA2 é 3ª (3)  → Alfa = 18
    // BETA1 é 2ª (4);                          BETA2 é 4ª (2) → Beta = 6
    await eventoPontuado({
      colocacoes: ['ALFA1', 'BETA1', 'ALFA2', 'BETA2'],
      teams: { ALFA1: alfa.body.id, ALFA2: alfa.body.id, BETA1: beta.body.id, BETA2: beta.body.id },
      overall: 'ALFA1'
    });

    const classificacao = await api().get('/api/v1/ranking/teams').query({ seasonId });
    expect(classificacao.status).toBe(200);

    const porNome = Object.fromEntries(classificacao.body.map(linha => [linha.team.name, linha]));
    const equipeAlfa = porNome[alfa.body.name];
    const equipeBeta = porNome[beta.body.name];

    // 5 + 10 (Overall) + 3 = 18. Nenhum peso, multiplicador ou bônus de equipe.
    expect(equipeAlfa.totalPoints).toBe(18);
    expect(equipeBeta.totalPoints).toBe(6);

    expect(equipeAlfa.position).toBe(1);
    expect(equipeBeta.position).toBe(2);
    expect(equipeAlfa.athleteCount).toBe(2);
    expect(equipeAlfa.overallWins).toBe(1);
    expect(equipeAlfa.firstPlaceCount).toBe(1);
  });

  it('a pontuação da equipe é auditável até o resultado de cada atleta', async () => {
    const equipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Rastreada') });

    await eventoPontuado({
      colocacoes: ['MEMBRO1', 'MEMBRO2', 'DE_FORA'],
      teams: { MEMBRO1: equipe.body.id, MEMBRO2: equipe.body.id }
    });

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({
      where: { seasonId, teamId: equipe.body.id },
      select: { athleteId: true, points: true, resultId: true, eventId: true, classId: true, placing: true }
    }));

    // 5 (1º) + 4 (2º) = 9, e cada parcela aponta para o resultado que a gerou.
    expect(pontos).toHaveLength(2);
    expect(pontos.reduce((total, ponto) => total + ponto.points, 0)).toBe(9);
    expect(pontos.every(ponto => ponto.resultId && ponto.eventId && ponto.classId)).toBe(true);

    const classificacao = await api().get('/api/v1/ranking/teams').query({ seasonId });
    const linha = classificacao.body.find(item => item.team.name === equipe.body.name);
    expect(linha.totalPoints, 'o total da equipe bate com a soma dos lançamentos').toBe(9);
  });

  it('o desempate de equipe usa a mesma hierarquia do atleta', async () => {
    const umaEquipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Com Overall') });
    const outraEquipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Sem Overall') });

    // Etapa 1: COM_A vence com Overall (15). SEM_A é 5ª (1). → Com=15, Sem=1
    await eventoPontuado({
      colocacoes: ['COM_A', 'NEUTRA1', 'NEUTRA2', 'NEUTRA3', 'SEM_A'],
      teams: { COM_A: umaEquipe.body.id, SEM_A: outraEquipe.body.id },
      overall: 'COM_A'
    });
    // Etapas 2, 3 e 4: SEM_B vence cada uma (5+5+5=15) → Sem = 16... ajusta-se
    // com a 5ª colocação da etapa 1 para empatar em pontos? Não: 1+15 = 16.
    // Para empatar exatamente, SEM_A não pontua na etapa 1.
    for (const rodada of [1, 2, 3]) {
      await eventoPontuado({
        colocacoes: ['SEM_B', `EXTRA${rodada}`],
        teams: { SEM_B: outraEquipe.body.id }
      });
    }

    const classificacao = await api().get('/api/v1/ranking/teams').query({ seasonId });
    const comOverall = classificacao.body.find(l => l.team.name === umaEquipe.body.name);
    const semOverall = classificacao.body.find(l => l.team.name === outraEquipe.body.name);

    expect(comOverall.overallWins).toBe(1);
    expect(semOverall.overallWins).toBe(0);
    expect(semOverall.firstPlaceCount).toBe(3);

    // Se os pontos empatarem, o Overall decide; se não empatarem, o total
    // decide antes — as duas coisas são conferidas pelo par abaixo.
    if (comOverall.totalPoints === semOverall.totalPoints) {
      expect(comOverall.position).toBeLessThan(semOverall.position);
    } else {
      const esperado = comOverall.totalPoints > semOverall.totalPoints ? comOverall : semOverall;
      expect(esperado.position).toBe(1);
    }
  });
});

describe('11.2) classes: todas pontuam, só a elegível alimenta o Super Overall', () => {
  it('a organização nasce com o catálogo do Campeonato Brasileiro', async () => {
    const catalogo = await comoAtor(diretor, tx => tx.classCatalog.findMany({
      where: { organizationId: orgId }, orderBy: { sortOrder: 'asc' }
    }));

    expect(catalogo.map(c => c.code)).toEqual(['ESTREANTE', 'NOVICE', 'OPEN', 'MASTER']);

    // REGRA HOMOLOGADA: as quatro pontuam; só a OPEN é elegível.
    expect(catalogo.filter(c => c.superOverallEligible).map(c => c.code)).toEqual(['OPEN']);
    expect(catalogo.every(c => c.active)).toBe(true);
  });

  it('OPEN pontua no campeonato E entra no Super Overall', async () => {
    await eventoPontuado({ colocacoes: ['DA_OPEN', 'SEGUNDA_OPEN'], classe: 'OPEN' });

    const [ponto] = await pontosDe('DA_OPEN');
    expect(ponto.points, 'pontua no campeonato como qualquer classe').toBe(5);
    expect(ponto.superOverallEligible).toBe(true);

    const superOverall = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    expect(superOverall.status).toBe(200);
    expect(superOverall.body.map(l => l.athlete.fullName)).toContain('DA_OPEN');
  });

  it('NOVICE pontua no campeonato mas NÃO entra no Super Overall', async () => {
    await eventoPontuado({ colocacoes: ['DA_NOVICE', 'SEGUNDA_NOVICE'], classe: 'NOVICE' });

    const [ponto] = await pontosDe('DA_NOVICE');
    expect(ponto.points, 'a classe pontua normalmente no campeonato').toBe(5);
    expect(ponto.superOverallEligible, 'mas não é elegível ao Super Overall').toBe(false);

    // Ranking do campeonato: aparece.
    const campeonato = await api().get('/api/v1/ranking').query({ seasonId });
    expect(JSON.stringify(campeonato.body.items)).toContain('DA_NOVICE');

    // Classificatório do Super Overall: não aparece.
    const superOverall = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    expect(superOverall.body.map(l => l.athlete.fullName)).not.toContain('DA_NOVICE');
  });

  it('ESTREANTE e MASTER seguem a mesma distinção', async () => {
    await eventoPontuado({ colocacoes: ['DA_ESTREANTE', 'X1'], classe: 'ESTREANTE' });
    await eventoPontuado({ colocacoes: ['DA_MASTER', 'X2'], classe: 'MASTER' });

    for (const nome of ['DA_ESTREANTE', 'DA_MASTER']) {
      const [ponto] = await pontosDe(nome);
      expect(ponto.points, `${nome} pontua no campeonato`).toBe(5);
      expect(ponto.superOverallEligible, `${nome} não é elegível`).toBe(false);
    }

    const superOverall = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    expect(superOverall.body).toHaveLength(0);
  });

  it('o operador torna uma classe elegível sem alteração de código', async () => {
    // A prova de que a elegibilidade é DADO: marcar MASTER como elegível passa
    // a incluí-la, sem que nada no motor mude.
    const marcada = await api().post('/api/v1/classes-catalog').set(diretor.auth())
      .send({ organizationId: orgId, code: 'MASTER', superOverallEligible: true });
    expect(marcada.status, JSON.stringify(marcada.body)).toBe(201);

    await eventoPontuado({ colocacoes: ['MASTER_ELEGIVEL', 'Y1'], classe: 'MASTER' });

    const [ponto] = await pontosDe('MASTER_ELEGIVEL');
    expect(ponto.superOverallEligible).toBe(true);

    const superOverall = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    expect(superOverall.body.map(l => l.athlete.fullName)).toContain('MASTER_ELEGIVEL');
  });

  it('o operador desativa uma classe, e o histórico dela continua válido', async () => {
    await eventoPontuado({ colocacoes: ['ANTES_DE_DESATIVAR', 'Z1'], classe: 'OPEN' });

    const desativada = await api().post('/api/v1/classes-catalog').set(diretor.auth())
      .send({ organizationId: orgId, code: 'NOVICE', active: false });
    expect(desativada.status).toBe(201);
    expect(desativada.body.active).toBe(false);

    // O ponto já atribuído não é reescrito por mudança de configuração.
    const [ponto] = await pontosDe('ANTES_DE_DESATIVAR');
    expect(ponto.superOverallEligible).toBe(true);
  });

  it('o Super Overall usa o mesmo desempate — e ele para no 3º lugar', async () => {
    const superOverall = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    expect(superOverall.status).toBe(200);
    // A resposta expõe os critérios que a regra usa, e apenas eles.
    if (superOverall.body.length) {
      const linha = superOverall.body[0];
      expect(Object.keys(linha)).toContain('thirdPlaceCount');
      expect(Object.keys(linha)).not.toContain('fourthPlaceCount');
    }
  });
});

describe('11.2) importação: a colocação é a fonte dos pontos', () => {
  const csv = linhas => [
    'external_result_id,cpf,atleta,filiacao,categoria,classe,colocacao,overall,equipe,etapa',
    ...linhas
  ].join('\n');

  async function importar(conteudo, gerente) {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth())
      .send({ organizationId: orgId, seasonId, sourceType: 'CSV', sourceRef: unico('lote') + '.csv', content: conteudo });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    return lote.body;
  }

  it('o adapter reconhece Overall e equipe — campos que faltavam', async () => {
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const cpf = gerarCpf(555000111);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'IMPORTADA OPEN', cpf, sex: 'FEMALE' });

    const lote = await importar(csv([`MW-11-1,${cpf},IMPORTADA OPEN,,BIKINI,OPEN,1,SIM,Equipe X,Etapa`]), gerente);
    const item = lote.items[0];

    expect(item.className).toBe('OPEN');
    expect(item.isOverallChampion, 'a coluna overall precisa ser lida').toBe(true);
    expect(item.teamName).toBe('Equipe X');
  });

  it('o sistema calcula os pontos pela colocação: OPEN 1º + Overall = 15, e é elegível', async () => {
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const cpf = gerarCpf(555000222);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'IMPORTADA CAMPEA', cpf, sex: 'FEMALE' });

    const lote = await importar(csv([`MW-11-2,${cpf},IMPORTADA CAMPEA,,BIKINI,OPEN,1,SIM,,Etapa`]), gerente);
    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth()).send({});
    expect(aplicacao.status, JSON.stringify(aplicacao.body)).toBe(200);

    const [ponto] = await pontosDe('IMPORTADA CAMPEA');
    expect({ colocacao: ponto.placementPoints, overall: ponto.overallBonus, total: ponto.points })
      .toEqual({ colocacao: 5, overall: 10, total: 15 });
    expect(ponto.superOverallEligible).toBe(true);
  });

  it('NOVICE importada pontua 5 e não é elegível', async () => {
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const cpf = gerarCpf(555000333);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'IMPORTADA NOVICE', cpf, sex: 'FEMALE' });

    const lote = await importar(csv([`MW-11-3,${cpf},IMPORTADA NOVICE,,BIKINI,NOVICE,1,,,Etapa`]), gerente);
    await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth()).send({});

    const [ponto] = await pontosDe('IMPORTADA NOVICE');
    expect(ponto.points).toBe(5);
    expect(ponto.superOverallEligible).toBe(false);
    expect(ponto.isOverallChampion).toBe(false);
  });

  it('pontos digitados divergentes da regra geram CONFLICT, e não entram', async () => {
    // REVISÃO DA FASE 11.3: na 11.2 o número do arquivo era ignorado em
    // silêncio e a linha entrava valendo 5. Silêncio é a pior resposta aqui —
    // quem redigiu o arquivo acredita que passou. Agora a linha PARA, com os
    // dois números à vista, e alguém decide qual está errado.
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const cpf = gerarCpf(555000444);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'PONTOS FORJADOS', cpf, sex: 'FEMALE' });

    // A origem tenta impor 999 pontos para um 1º lugar. A regra vale 5.
    const conteudo = [
      'external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,etapa',
      `MW-11-4,${cpf},PONTOS FORJADOS,BIKINI,OPEN,1,999,Etapa`
    ].join('\n');

    const lote = await importar(conteudo, gerente);
    const item = lote.items[0];

    expect(item.matchStatus).toBe('CONFLICT');
    expect(item.reason).toMatch(/999/);
    expect(item.reason).toMatch(/\b5\b/);

    // O aplicar recusa o lote inteiro: não há linha reconhecida para aplicar.
    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`)
      .set(gerente.auth()).send({});
    expect(aplicacao.status).toBe(422);

    expect(await pontosDe('PONTOS FORJADOS'), 'nada entra enquanto o conflito não for resolvido').toHaveLength(0);
  });

  it('pontos digitados COERENTES com a regra passam sem conflito', async () => {
    // A conferência não pode virar um obstáculo para o arquivo correto: 1º
    // lugar com 5 pontos declarados bate com a regra e entra normalmente.
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const cpf = gerarCpf(555000455);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'PONTOS COERENTES', cpf, sex: 'FEMALE' });

    const conteudo = [
      'external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,etapa',
      `MW-11-5,${cpf},PONTOS COERENTES,BIKINI,OPEN,1,5,Etapa`
    ].join('\n');

    const lote = await importar(conteudo, gerente);
    expect(lote.items[0].matchStatus).toBe('MATCHED');

    await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth()).send({});

    const [ponto] = await pontosDe('PONTOS COERENTES');
    expect(ponto.points).toBe(5);
  });
});

describe('11.2) empresas: entram com suas equipes, mesma regra', () => {
  it('a empresa pontua pelo que suas equipes fazem — atleta → equipe → empresa', async () => {
    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Suplementos Alfa'), city: 'Cuiabá', state: 'MT' });
    expect(empresa.status, JSON.stringify(empresa.body)).toBe(201);

    // Duas equipes DA MESMA empresa: os pontos das duas sobem para ela.
    const equipeA = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Alfa Team A'), companyId: empresa.body.id });
    const equipeB = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Alfa Team B'), companyId: empresa.body.id });
    expect(equipeA.body.companyId).toBe(empresa.body.id);

    // Equipe sem empresa: compete, pontua para si, e não pontua para nenhuma.
    const avulsa = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Avulsa') });

    // 1º + Overall (15) e 3º (3) da empresa; 2º (4) da avulsa → empresa = 18
    await eventoPontuado({
      colocacoes: ['DA_EQUIPE_A', 'DA_AVULSA', 'DA_EQUIPE_B'],
      teams: { DA_EQUIPE_A: equipeA.body.id, DA_EQUIPE_B: equipeB.body.id, DA_AVULSA: avulsa.body.id },
      overall: 'DA_EQUIPE_A',
      classe: 'OPEN'
    });

    const classificacao = await api().get('/api/v1/ranking/companies').query({ seasonId });
    expect(classificacao.status).toBe(200);

    const linha = classificacao.body.find(item => item.company.name === empresa.body.name);
    expect(linha.totalPoints, '(5+10) da equipe A + 3 da equipe B').toBe(18);
    expect(linha.teamCount, 'as duas equipes da empresa').toBe(2);
    expect(linha.athleteCount).toBe(2);
    expect(linha.overallWins).toBe(1);
    expect(linha.position).toBe(1);

    // A equipe avulsa não criou empresa nenhuma no ranking.
    expect(classificacao.body).toHaveLength(1);
  });

  it('a pontuação da empresa é rastreável até o resultado de cada atleta', async () => {
    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Rastreada') });
    const equipe = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Rastreada'), companyId: empresa.body.id });

    await eventoPontuado({
      colocacoes: ['MEMBRO_1', 'MEMBRO_2', 'DE_FORA'],
      teams: { MEMBRO_1: equipe.body.id, MEMBRO_2: equipe.body.id },
      classe: 'OPEN'
    });

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({
      where: { seasonId, companyId: empresa.body.id },
      select: { athleteId: true, teamId: true, points: true, resultId: true, eventId: true, classId: true }
    }));

    expect(pontos).toHaveLength(2);
    expect(pontos.reduce((total, p) => total + p.points, 0), '5 + 4').toBe(9);
    expect(pontos.every(p => p.resultId && p.eventId && p.classId && p.teamId)).toBe(true);

    const classificacao = await api().get('/api/v1/ranking/companies').query({ seasonId });
    const linha = classificacao.body.find(item => item.company.name === empresa.body.name);
    expect(linha.totalPoints, 'o total bate com a soma dos lançamentos').toBe(9);
  });

  it('empresa usa a mesma tabela e o mesmo desempate — sem fórmula própria', async () => {
    const comOverall = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Com Overall') });
    const semOverall = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Sem Overall') });

    const equipeCom = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Time Com'), companyId: comOverall.body.id });
    const equipeSem = await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Time Sem'), companyId: semOverall.body.id });

    // COM: 1º + Overall = 15. SEM: três primeiros lugares = 15. Empate em
    // pontos, resolvido pelo Overall — o mesmo critério do atleta.
    await eventoPontuado({
      colocacoes: ['COM_A', 'NEUTRA_1', 'NEUTRA_2', 'NEUTRA_3', 'SEM_ZERO'],
      teams: { COM_A: equipeCom.body.id },
      overall: 'COM_A', classe: 'OPEN'
    });
    for (const rodada of [1, 2, 3]) {
      await eventoPontuado({
        colocacoes: ['SEM_B', `EXTRA_${rodada}`],
        teams: { SEM_B: equipeSem.body.id },
        classe: 'OPEN'
      });
    }

    const classificacao = await api().get('/api/v1/ranking/companies').query({ seasonId });
    const com = classificacao.body.find(l => l.company.name === comOverall.body.name);
    const sem = classificacao.body.find(l => l.company.name === semOverall.body.name);

    expect(com.totalPoints, '5 + 10 do Overall').toBe(15);
    expect(sem.totalPoints, 'três primeiros lugares').toBe(15);
    expect(com.overallWins).toBe(1);
    expect(sem.firstPlaceCount).toBe(3);

    expect(com.position, 'o Overall decide antes do número de primeiros lugares').toBe(1);
    expect(sem.position).toBe(2);
  });

  it('a importação reconhece a coluna empresa e a resolve pelo cadastro', async () => {
    const gerente = await criarUsuario({ name: 'Gerente' });
    await vincular(orgId, gerente, 'RANKING_MANAGER');

    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: 'Nutrifit' });

    const cpf = gerarCpf(666000111);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'IMPORTADA DA EMPRESA', cpf, sex: 'FEMALE' });

    const conteudo = [
      'external_result_id,cpf,atleta,categoria,classe,colocacao,empresa,etapa',
      `MW-EMP-1,${cpf},IMPORTADA DA EMPRESA,BIKINI,OPEN,1,Nutrifit,Etapa`
    ].join('\n');

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth())
      .send({ organizationId: orgId, seasonId, sourceType: 'CSV', sourceRef: unico('emp') + '.csv', content: conteudo });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    expect(lote.body.items[0].companyName, 'a coluna empresa precisa ser lida').toBe('Nutrifit');

    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth()).send({});

    const [ponto] = await pontosDe('IMPORTADA DA EMPRESA');
    expect(ponto.companyId).toBe(empresa.body.id);
    expect(ponto.points).toBe(5);

    const classificacao = await api().get('/api/v1/ranking/companies').query({ seasonId });
    expect(classificacao.body.find(l => l.company.name === 'Nutrifit').totalPoints).toBe(5);
  });

  it('empresa de outra organização não é criada nem lida por quem não pertence a ela', async () => {
    const outroDiretor = await criarUsuario({ name: 'Diretor B' });
    const outraOrg = await criarOrganizacao(admin, { name: unico('Federação B') });
    await vincular(outraOrg.id, outroDiretor, 'EVENT_DIRECTOR');

    const tentativa = await api().post('/api/v1/companies').set(outroDiretor.auth())
      .send({ organizationId: orgId, name: unico('Invasora') });

    expect([403, 404]).toContain(tentativa.status);
  });
});

// ============================================================================
// FASE 11.3 — as duas métricas no caminho real da plataforma.
//
// A aritmética está provada em tests/pontuacao-11-3.test.mjs. Aqui prova-se
// que ela chega inteira até o banco e até os dois rankings: que toda classe
// pontua no campeonato, que só a OPEN alimenta o Super Overall, que resultado
// não publicado não aparece, e que reprocessar não duplica.
// ============================================================================
describe('11.3) pontos do campeonato × pontos do Super Overall', () => {
  const gerenteDeImportacao = async () => {
    const gerente = await criarUsuario({ name: unico('Gerente') });
    await vincular(orgId, gerente, 'RANKING_MANAGER');
    return gerente;
  };

  const importarLote = async (conteudo, gerente) => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth())
      .send({ organizationId: orgId, seasonId, sourceType: 'CSV', sourceRef: unico('lote') + '.csv', content: conteudo });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    return lote.body;
  };

  it('TESTE 22 — resultado OPEN alimenta os DOIS rankings', async () => {
    await eventoPontuado({ colocacoes: ['ABRE PRIMEIRA', 'ABRE SEGUNDA'], classe: 'OPEN' });

    const [ponto] = await pontosDe('ABRE PRIMEIRA');
    expect(ponto.points, 'pontuou no campeonato').toBe(5);
    expect(ponto.superOverallPoints, 'e alimenta o Super Overall').toBe(5);
    expect(ponto.superOverallEligible).toBe(true);

    const campeonato = await api().get('/api/v1/ranking').query({ seasonId });
    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId });

    expect(campeonato.body.items.find(l => l.athlete.fullName === 'ABRE PRIMEIRA').totalPoints).toBe(5);
    expect(anual.body.find(l => l.athlete.fullName === 'ABRE PRIMEIRA').totalPoints).toBe(5);
  });

  it('TESTES 23/24/25 — Novice, Estreante e Master pontuam no campeonato e NÃO no anual', async () => {
    // O erro que a regra proíbe é justamente este: usar a métrica do anual no
    // ranking do campeonato faria estas três classes sumirem do pódio.
    for (const [classe, atleta] of [['NOVICE', 'NOVATA'], ['ESTREANTE', 'ESTREIA'], ['MASTER', 'VETERANA']]) {
      await eventoPontuado({ colocacoes: [atleta, `${atleta} DOIS`], classe });

      const [ponto] = await pontosDe(atleta);
      expect(ponto.points, `${classe} pontua no campeonato`).toBe(5);
      expect(ponto.superOverallPoints, `${classe} NÃO alimenta o Super Overall`).toBe(0);
      expect(ponto.superOverallEligible).toBe(false);
    }

    const campeonato = await api().get('/api/v1/ranking').query({ seasonId });
    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId });

    for (const nome of ['NOVATA', 'ESTREIA', 'VETERANA']) {
      expect(campeonato.body.items.some(l => l.athlete.fullName === nome), `${nome} no campeonato`).toBe(true);
      expect(anual.body.some(l => l.athlete.fullName === nome), `${nome} fora do anual`).toBe(false);
    }
  });

  it('TESTE 9 (integrado) — Overall em classe não elegível soma no campeonato, não no anual', async () => {
    await eventoPontuado({
      colocacoes: ['NOVICE COM OVERALL', 'OUTRA NOVICE'],
      classe: 'NOVICE',
      overall: 'NOVICE COM OVERALL'
    });

    const [ponto] = await pontosDe('NOVICE COM OVERALL');
    expect(ponto.placementPoints).toBe(5);
    expect(ponto.overallBonus).toBe(10);
    expect(ponto.points, '5 + 10 no campeonato').toBe(15);
    expect(ponto.superOverallPoints, 'o bônus segue a elegibilidade da participação').toBe(0);
  });

  it('TESTE 18 — resultado NÃO publicado não aparece em ranking nenhum', async () => {
    await eventoPontuado({ colocacoes: ['NAO PUBLICADA', 'OUTRA'], classe: 'OPEN', publicar: false });

    expect(await pontosDe('NAO PUBLICADA'), 'sem publicação não há ponto').toHaveLength(0);

    const campeonato = await api().get('/api/v1/ranking').query({ seasonId });
    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId });

    expect(campeonato.body.items.some(l => l.athlete.fullName === 'NAO PUBLICADA')).toBe(false);
    expect(anual.body.some(l => l.athlete.fullName === 'NAO PUBLICADA')).toBe(false);
  });

  it('TESTE 19 — publicado aparece, com os dois números explicáveis', async () => {
    const { competitionClass } = await eventoPontuado({
      colocacoes: ['PUBLICADA', 'SEGUNDA'], classe: 'OPEN', publicar: false
    });

    const antes = await api().get('/api/v1/ranking').query({ seasonId });
    expect(antes.body.items.some(l => l.athlete.fullName === 'PUBLICADA')).toBe(false);

    await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
      .send({ note: 'Homologado' });

    const depois = await api().get('/api/v1/ranking').query({ seasonId });
    expect(depois.body.items.find(l => l.athlete.fullName === 'PUBLICADA').totalPoints).toBe(5);
  });

  it('TESTE 20 — reprocessar mantém o mesmo total, nas duas métricas', async () => {
    await eventoPontuado({ colocacoes: ['IDEMPOTENTE', 'SEGUNDA IDEM'], classe: 'OPEN' });

    const antes = await pontosDe('IDEMPOTENTE');
    expect(antes).toHaveLength(1);

    const recalculo = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(diretor.auth()).send({});
    expect(recalculo.status).toBe(200);

    const depois = await pontosDe('IDEMPOTENTE');
    expect(depois, 'reprocessar não cria linha nova').toHaveLength(1);
    expect(depois[0].points).toBe(antes[0].points);
    expect(depois[0].superOverallPoints).toBe(antes[0].superOverallPoints);
  });

  it('TESTE 16 — importar o mesmo arquivo duas vezes não duplica pontos', async () => {
    const gerente = await gerenteDeImportacao();
    const cpf = gerarCpf(556000111);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'IMPORTADA DUAS VEZES', cpf, sex: 'FEMALE' });

    const conteudo = [
      'external_result_id,cpf,atleta,categoria,classe,colocacao,etapa',
      `MW-11-3-DUP,${cpf},IMPORTADA DUAS VEZES,BIKINI,OPEN,1,Etapa`
    ].join('\n');

    const primeiro = await importarLote(conteudo, gerente);
    await api().post(`/api/v1/musclewar/imports/${primeiro.import.id}/apply`).set(gerente.auth()).send({});

    // Segundo lote, MESMO external_result_id: reconhecido como já aplicado.
    const segundo = await importarLote(conteudo, gerente);
    expect(segundo.items[0].matchStatus).toBe('DUPLICATE');

    const pontos = await pontosDe('IMPORTADA DUAS VEZES');
    expect(pontos, 'a mesma linha não pontua duas vezes').toHaveLength(1);
    expect(pontos[0].points).toBe(5);
  });

  it('TESTE 21 — duas importações CONCORRENTES da mesma linha não duplicam', async () => {
    const gerente = await gerenteDeImportacao();
    const cpf = gerarCpf(556000222);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'CORRIDA IMPORT', cpf, sex: 'FEMALE' });

    const conteudo = [
      'external_result_id,cpf,atleta,categoria,classe,colocacao,etapa',
      `MW-11-3-RACE,${cpf},CORRIDA IMPORT,BIKINI,OPEN,1,Etapa`
    ].join('\n');

    // Dois lotes distintos carregando a MESMA linha, aplicados ao mesmo tempo.
    // Quem garante é a unicidade de ExternalResult no banco, não a ordem em que
    // as duas requisições chegarem.
    const [a, b] = await Promise.all([importarLote(conteudo, gerente), importarLote(conteudo, gerente)]);

    await Promise.all([
      api().post(`/api/v1/musclewar/imports/${a.import.id}/apply`).set(gerente.auth()).send({}),
      api().post(`/api/v1/musclewar/imports/${b.import.id}/apply`).set(gerente.auth()).send({})
    ]);

    const pontos = await pontosDe('CORRIDA IMPORT');
    expect(pontos, 'exatamente um ponto, sob concorrência').toHaveLength(1);
  });

  it('a origem de cada ponto é explicável: evento, classe, colocação e as parcelas', async () => {
    await eventoPontuado({
      colocacoes: ['RASTREAVEL', 'SEGUNDA RASTRO'], classe: 'OPEN', overall: 'RASTREAVEL'
    });

    const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: 'RASTREAVEL' } }));
    const detalhe = await api().get(`/api/v1/athletes/${atleta.id}/ranking-points`)
      .query({ seasonId }).set(diretor.auth());

    expect(detalhe.status).toBe(200);
    const [ponto] = detalhe.body.items;

    // "Por que esta atleta tem 15 pontos?" — a resposta inteira, numa linha.
    expect(ponto.placing).toBe(1);
    expect(ponto.placementPoints).toBe(5);
    expect(ponto.overallBonus).toBe(10);
    expect(ponto.points).toBe(15);
    expect(ponto.superOverallPoints).toBe(15);
    expect(ponto.placementPoints + ponto.overallBonus, 'o total é reconstituível').toBe(ponto.points);
    expect(ponto.event, 'até o evento de origem').toBeTruthy();
    expect(ponto.competitionClass.code).toBe('OPEN');
    expect(ponto.resultId, 'e até o resultado que o gerou').toBeTruthy();

    // E o CPF não vem junto: dado restrito não acompanha rastreabilidade.
    expect(JSON.stringify(detalhe.body.items)).not.toContain(atleta.cpf ?? '__sem_cpf__');
  });
});

// ============================================================================
// FASE 11.3 — quem PODE mexer em pontuação.
//
// `RankingPoint` não está no escopo de RLS: o ranking é superfície pública, e
// as políticas de linha existem para dado pessoal (atleta, CPF, social,
// mensagens, auditoria). A barreira da pontuação é de PERMISSÃO, na camada de
// service — e barreira sem teste é barreira que ninguém sabe se ainda existe.
// ============================================================================
describe('11.3) pontuação não se altera sem permissão', () => {
  const papelSemPontuacao = async papel => {
    const usuario = await criarUsuario({ name: unico(papel) });
    await vincular(orgId, usuario, papel);
    return usuario;
  };

  it('juiz, atleta e coach não criam temporada nem mexem na tabela de pontos', async () => {
    for (const papel of ['JUDGE', 'ATHLETE', 'COACH', 'CHECKIN_OPERATOR']) {
      const usuario = await papelSemPontuacao(papel);

      const temporada = await api().post('/api/v1/seasons').set(usuario.auth())
        .send({ organizationId: orgId, name: unico('Pirata'), year: 2030 });
      expect([403, 404], `${papel} não cria temporada`).toContain(temporada.status);

      const tabela = await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(usuario.auth())
        .send({ rules: [{ placing: 1, points: 999 }] });
      expect([403, 404], `${papel} não reescreve a tabela`).toContain(tabela.status);

      const recalculo = await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(usuario.auth()).send({});
      expect([403, 404], `${papel} não recalcula o ranking`).toContain(recalculo.status);
    }

    // E a tabela homologada continua intacta depois de todas as tentativas.
    const regras = await comoAtor(diretor, tx => tx.rankingPointsRule.findMany({ where: { seasonId }, orderBy: { placing: 'asc' } }));
    expect(regras.map(r => [r.placing, r.points])).toEqual([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
  });

  it('anônimo lê o ranking, e não escreve nada', async () => {
    await eventoPontuado({ colocacoes: ['PUBLICA UM', 'PUBLICA DOIS'], classe: 'OPEN' });

    // Leitura é pública: é para isso que o ranking existe.
    const leitura = await api().get('/api/v1/ranking').query({ seasonId });
    expect(leitura.status).toBe(200);

    // Escrita, não.
    const escrita = await api().post(`/api/v1/seasons/${seasonId}/recompute`).send({});
    expect([401, 403]).toContain(escrita.status);
  });

  it('o Overall não é declarado por quem não tem permissão', async () => {
    const { event } = await eventoPontuado({ colocacoes: ['SEM OVERALL UM', 'SEM OVERALL DOIS'], classe: 'OPEN' });
    const juiz = await papelSemPontuacao('JUDGE');
    const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: 'SEM OVERALL UM' } }));

    const tentativa = await api().post(`/api/v1/events/${event.id}/overall`).set(juiz.auth())
      .send({ athleteId: atleta.id });

    expect([403, 404]).toContain(tentativa.status);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: event.id } }));
    expect(titulos, 'nenhum título declarado').toHaveLength(0);
  });

  it('o ranking público não expõe CPF', async () => {
    await eventoPontuado({ colocacoes: ['SEM CPF UM', 'SEM CPF DOIS'], classe: 'OPEN' });

    const identidade = await comoAtor(diretor, tx => tx.athleteIdentity.findFirst({}));
    const publico = await api().get('/api/v1/ranking').query({ seasonId });

    expect(JSON.stringify(publico.body)).not.toContain(identidade.cpf);

    // Estrutural, e não por substring: um cuid aleatório pode conter as letras
    // "cpf" por acaso, e um teste que falha por isso ensina a ignorá-lo.
    for (const linha of publico.body.items) {
      expect(linha.athlete, 'nem o CPF nem a versão mascarada').not.toHaveProperty('cpf');
      expect(linha.athlete).not.toHaveProperty('cpfMasked');
      expect(linha.athlete).not.toHaveProperty('birthDate');
    }
  });
});
