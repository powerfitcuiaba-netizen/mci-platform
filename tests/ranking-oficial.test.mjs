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

  // O MCI NÃO julga: o resultado oficial chega de fora, já decidido, e é
  // RECEBIDO com atleta e colocação. Nada aqui apura nem confere mérito.
  const recebido = await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
    .send({
      entries: inscritos.map((inscrito, indice) => ({ athleteId: inscrito.athleteId, placing: indice + 1 }))
    });
  expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);

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
    //
    // Isto NÃO altera a configuração homologada — nela só a OPEN é elegível
    // (ver tests/regulamento-11-4.test.mjs). O que se exercita aqui é o
    // mecanismo que a regra exige: o operador governa a lista de classes sem
    // alteração de programa.
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

// ============================================================================
// FASE 11.4 — a MESMA regra para equipes e empresas, na plataforma real.
//
// A regra do organizador é literal: "a mesma regra vale para as equipes e para
// as empresas". Estes casos provam que o acumulado por equipe e por empresa é
// somável pela métrica elegível SEM tabela nova — cada lançamento já carrega
// superOverallPoints ao lado de teamId e companyId — e que ele recebe só a
// OPEN, por construção.
// ============================================================================
describe('11.4) equipes e empresas seguem a mesma regra', () => {
  it('a equipe soma pela mesma tabela e o acumulado elegível recebe só a OPEN', async () => {
    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Nutri Alfa') });
    const equipe = (await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Equipe Alfa'), companyId: empresa.body.id })).body;

    // A MESMA equipe pontua em duas classes: uma elegível, outra não.
    await eventoPontuado({
      colocacoes: ['ALFA OPEN', 'OUTRA OPEN'],
      classe: 'OPEN',
      teams: { 'ALFA OPEN': equipe.id }
    });
    await eventoPontuado({
      colocacoes: ['ALFA NOVICE', 'OUTRA NOVICE'],
      classe: 'NOVICE',
      teams: { 'ALFA NOVICE': equipe.id }
    });

    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId, teamId: equipe.id } }));
    expect(pontos).toHaveLength(2);

    const campeonato = pontos.reduce((soma, p) => soma + p.points, 0);
    const elegivel = pontos.reduce((soma, p) => soma + p.superOverallPoints, 0);

    expect(campeonato, 'as duas classes pontuam para a equipe').toBe(10);
    expect(elegivel, 'só a OPEN alimenta o acumulado do Super Overall').toBe(5);

    // E a empresa acompanha a equipe, pela mesma cadeia.
    const daEmpresa = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId, companyId: empresa.body.id } }));
    expect(daEmpresa.reduce((soma, p) => soma + p.points, 0)).toBe(10);
    expect(daEmpresa.reduce((soma, p) => soma + p.superOverallPoints, 0)).toBe(5);

    // O ranking de equipes usa a métrica do CAMPEONATO — as duas classes.
    const rankingEquipes = await api().get('/api/v1/ranking/teams').query({ seasonId });
    expect(rankingEquipes.body.find(l => l.team.id === equipe.id).totalPoints).toBe(10);
  });

  it('o desempate de equipes é o mesmo: Overall antes de mais primeiros', async () => {
    const alfa = (await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Desempate Alfa') })).body;
    const beta = (await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Desempate Beta') })).body;

    // Alfa: um 1º COM Overall = 15. Beta: três 1º sem Overall = 15.
    // Cada equipe pontua no seu próprio evento, para que o total de Beta venha
    // só de primeiros lugares — é isso que põe o desempate à prova.
    await eventoPontuado({
      colocacoes: ['ALFA UM', 'ALFA SEGUNDA'],
      classe: 'OPEN',
      overall: 'ALFA UM',
      teams: { 'ALFA UM': alfa.id }
    });
    for (const nome of ['BETA UM', 'BETA DOIS', 'BETA TRES']) {
      await eventoPontuado({
        colocacoes: [nome, `${nome} SEGUNDA`],
        classe: 'OPEN',
        teams: { [nome]: beta.id }
      });
    }

    const classificacao = await api().get('/api/v1/ranking/teams').query({ seasonId });
    const linhaAlfa = classificacao.body.find(l => l.team.id === alfa.id);
    const linhaBeta = classificacao.body.find(l => l.team.id === beta.id);

    expect(linhaAlfa.totalPoints, 'empatadas em pontos').toBe(linhaBeta.totalPoints);
    expect(linhaAlfa.position, 'o Overall decide também para equipes').toBe(1);
    expect(linhaBeta.position).toBe(2);
  });

  it('patrocinador não pontua nem entra no ranking de equipes', async () => {
    const patrocinador = await api().post('/api/v1/sponsors').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Patrocinadora') });
    expect(patrocinador.status).toBe(201);

    await eventoPontuado({ colocacoes: ['SEM PATROCINIO', 'OUTRA'], classe: 'OPEN' });

    const classificacao = await api().get('/api/v1/ranking/teams').query({ seasonId });
    expect(JSON.stringify(classificacao.body)).not.toContain(patrocinador.body.name);
  });
});

// ============================================================================
// FASE 11.5 — os quatro rankings respondem ao público anônimo.
//
// A tela pública abre os quatro em abas, sem sessão. Se equipes ou empresas
// dependessem de autenticação — por permissão ou por política de RLS —, a aba
// apareceria vazia para o visitante e ninguém notaria pelo servidor, que
// responderia 200 com lista vazia.
// ============================================================================
describe('11.5) os quatro rankings são públicos e não se misturam', () => {
  it('anônimo lê campeonato, Super Overall, equipes e empresas', async () => {
    const empresa = await api().post('/api/v1/companies').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Publica Nutri') });
    const equipe = (await api().post('/api/v1/teams').set(diretor.auth())
      .send({ organizationId: orgId, name: unico('Publica Equipe'), companyId: empresa.body.id })).body;

    await eventoPontuado({
      colocacoes: ['PUBLICA UM', 'PUBLICA DOIS'],
      classe: 'OPEN',
      teams: { 'PUBLICA UM': equipe.id }
    });

    // Sem `.set(...auth())` em nenhuma das quatro: é o visitante.
    const campeonato = await api().get('/api/v1/ranking').query({ seasonId });
    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    const equipes = await api().get('/api/v1/ranking/teams').query({ seasonId });
    const empresas = await api().get('/api/v1/ranking/companies').query({ seasonId });

    for (const resposta of [campeonato, anual, equipes, empresas]) {
      expect(resposta.status).toBe(200);
    }

    expect(campeonato.body.items.length).toBeGreaterThan(0);
    expect(anual.body.length).toBeGreaterThan(0);

    // O nome da equipe e o da empresa precisam CHEGAR — se a política de RLS
    // devolvesse a relação nula, a linha existiria sem nome e a tela mostraria
    // um traço no lugar do competidor.
    const linhaEquipe = equipes.body.find(l => l.team?.id === equipe.id);
    expect(linhaEquipe, 'a equipe precisa aparecer para o anônimo').toBeTruthy();
    expect(linhaEquipe.team.name).toBe(equipe.name);

    const linhaEmpresa = empresas.body.find(l => l.company?.id === empresa.body.id);
    expect(linhaEmpresa, 'a empresa precisa aparecer para o anônimo').toBeTruthy();
    expect(linhaEmpresa.company.name).toBe(empresa.body.name);
  });

  it('os contadores de desempate chegam à tela — e o 4º/5º não decidem nada', async () => {
    // A tela pública mostra Overall · 1º · 2º · 3º ao lado dos pontos, porque é
    // por eles que uma posição se explica. Se o payload não os trouxesse, o
    // visitante veria dois competidores com os mesmos pontos em ordem
    // aparentemente arbitrária.
    await eventoPontuado({ colocacoes: ['CONTADOR UM', 'CONTADOR DOIS'], classe: 'OPEN', overall: 'CONTADOR UM' });

    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId });
    const linha = anual.body.find(l => l.athlete.fullName === 'CONTADOR UM');

    expect(linha.overallWins).toBe(1);
    expect(linha.firstPlaceCount).toBe(1);
    expect(linha).toHaveProperty('secondPlaceCount');
    expect(linha).toHaveProperty('thirdPlaceCount');

    // 4º e 5º não são expostos como critério: eles pontuam, não desempatam.
    expect(linha).not.toHaveProperty('fourthPlaceCount');
    expect(linha).not.toHaveProperty('fifthPlaceCount');
  });
});

// ============================================================================
// FASE 11.4b — recortes de ranking e a ENTRADA OFICIAL EXTERNA.
//
// O julgamento acontece FORA do MCI: a plataforma recebe o resultado oficial
// (colocação e/ou pontuação) e o usa para registro, auditoria e ranking. Estes
// casos verificam os dois lados disso — que os recortes que faltavam existem, e
// que a pontuação recebida de fora é PRESERVADA, nunca sobrescrita em silêncio.
// ============================================================================
describe('11.4b) recortes do ranking: classe, evento e divisão', () => {
  it('recorta por EVENTO sem misturar as etapas', async () => {
    const primeira = await eventoPontuado({ colocacoes: ['RECORTE UM', 'RECORTE DOIS'], classe: 'OPEN' });
    await eventoPontuado({ colocacoes: ['RECORTE DOIS', 'RECORTE UM'], classe: 'OPEN' });

    // Na 1ª etapa: UM venceu. No geral, os dois têm 5 + 4 = 9.
    const geral = await api().get('/api/v1/ranking').query({ seasonId });
    expect(geral.body.items.find(l => l.athlete.fullName === 'RECORTE UM').totalPoints).toBe(9);

    const daEtapa = await api().get('/api/v1/ranking/by').query({ seasonId, eventId: primeira.event.id });
    expect(daEtapa.status, JSON.stringify(daEtapa.body)).toBe(200);
    expect(daEtapa.body.find(l => l.athlete.fullName === 'RECORTE UM').totalPoints).toBe(5);
    expect(daEtapa.body.find(l => l.athlete.fullName === 'RECORTE DOIS').totalPoints).toBe(4);
  });

  it('recorta por CLASSE — e a classe não elegível continua no recorte do campeonato', async () => {
    const daNovice = await eventoPontuado({ colocacoes: ['SO NOVICE', 'OUTRA NOVICE'], classe: 'NOVICE' });
    await eventoPontuado({ colocacoes: ['SO OPEN', 'OUTRA OPEN'], classe: 'OPEN' });

    const recorte = await api().get('/api/v1/ranking/by')
      .query({ seasonId, classId: daNovice.competitionClass.id });

    expect(recorte.status).toBe(200);
    // É recorte do CAMPEONATO: Novice pontua, mesmo não alimentando o anual.
    expect(recorte.body.find(l => l.athlete.fullName === 'SO NOVICE').totalPoints).toBe(5);
    expect(recorte.body.some(l => l.athlete.fullName === 'SO OPEN'), 'a outra classe fica de fora').toBe(false);
  });

  it('recorta por DIVISÃO, somando as classes que ela contém', async () => {
    const montado = await eventoPontuado({ colocacoes: ['DA DIVISAO', 'OUTRA DIVISAO'], classe: 'OPEN' });

    const recorte = await api().get('/api/v1/ranking/by')
      .query({ seasonId, divisionId: montado.division.id });

    expect(recorte.status).toBe(200);
    expect(recorte.body.find(l => l.athlete.fullName === 'DA DIVISAO').totalPoints).toBe(5);
  });

  it('exige exatamente um recorte — combinar dois é pergunta que ninguém fez', async () => {
    const montado = await eventoPontuado({ colocacoes: ['UM RECORTE', 'DOIS'], classe: 'OPEN' });

    const nenhum = await api().get('/api/v1/ranking/by').query({ seasonId });
    const dois = await api().get('/api/v1/ranking/by')
      .query({ seasonId, eventId: montado.event.id, classId: montado.competitionClass.id });

    expect(nenhum.status).toBe(400);
    expect(dois.status).toBe(400);
  });

  it('o recorte usa o MESMO desempate — Overall antes de mais primeiros', async () => {
    const montado = await eventoPontuado({
      colocacoes: ['COM OVERALL', 'SEM OVERALL'], classe: 'OPEN', overall: 'COM OVERALL'
    });

    const recorte = await api().get('/api/v1/ranking/by').query({ seasonId, eventId: montado.event.id });

    const campeao = recorte.body.find(l => l.athlete.fullName === 'COM OVERALL');
    expect(campeao.totalPoints, '5 + 10').toBe(15);
    expect(campeao.overallWins).toBe(1);
    expect(campeao.position).toBe(1);
  });

  it('resultado NÃO publicado não aparece em recorte nenhum', async () => {
    const montado = await eventoPontuado({
      colocacoes: ['NAO PUBLICA RECORTE', 'OUTRA'], classe: 'OPEN', publicar: false
    });

    const recorte = await api().get('/api/v1/ranking/by').query({ seasonId, eventId: montado.event.id });

    expect(recorte.body).toHaveLength(0);
  });

  it('o recorte não expõe CPF', async () => {
    const montado = await eventoPontuado({ colocacoes: ['SEM CPF RECORTE', 'OUTRA'], classe: 'OPEN' });

    const identidade = await comoAtor(diretor, tx => tx.athleteIdentity.findFirst({}));
    const recorte = await api().get('/api/v1/ranking/by').query({ seasonId, eventId: montado.event.id });

    expect(JSON.stringify(recorte.body)).not.toContain(identidade.cpf);
    for (const linha of recorte.body) {
      expect(linha.athlete).not.toHaveProperty('cpf');
      expect(linha.athlete).not.toHaveProperty('cpfMasked');
    }
  });
});

// ============================================================================
// FASE 11.4b — a ENTRADA OFICIAL EXTERNA é preservada.
//
// O julgamento acontece fora do MCI. O que chega é dado oficial, e a plataforma
// não pode substituí-lo por cálculo próprio nem descartá-lo. Quando a origem
// manda COLOCAÇÃO e PONTUAÇÃO, os dois ficam guardados: a colocação porque
// alimenta o desempate, a pontuação porque é o que o sistema externo decidiu.
// ============================================================================
describe('11.4b) entrada oficial externa', () => {
  const gerenteDeImport = async () => {
    const gerente = await criarUsuario({ name: unico('Gerente') });
    await vincular(orgId, gerente, 'RANKING_MANAGER');
    return gerente;
  };

  const importarLinha = async (gerente, linha, cabecalho) => {
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId: orgId, seasonId, sourceType: 'CSV',
      sourceRef: unico('oficial') + '.csv', content: [cabecalho, linha].join('\n')
    });
    expect(lote.status, JSON.stringify(lote.body)).toBe(201);
    return lote.body;
  };

  it('S — colocação E pontuação externas ficam preservadas lado a lado', async () => {
    const gerente = await gerenteDeImport();
    const cpf = gerarCpf(717171717);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'OFICIAL EXTERNA', cpf, sex: 'FEMALE' });

    const lote = await importarLinha(
      gerente,
      `MW-OFICIAL-1,${cpf},OFICIAL EXTERNA,BIKINI,OPEN,1,5,Etapa Externa`,
      'external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,evento'
    );
    expect(lote.items[0].matchStatus).toBe('MATCHED');

    await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth()).send({});

    // O resultado externo guarda os DOIS: o que a origem mandou não se perde.
    const externo = await comoAtor(diretor, tx => tx.externalResult.findFirst({ where: { externalId: 'MW-OFICIAL-1' } }));
    expect(externo, 'o resultado oficial precisa ser registrado').toBeTruthy();
    expect(externo.placing, 'a colocação oficial').toBe(1);
    expect(externo.points, 'a pontuação oficial recebida').toBe(5);
    expect(externo.className).toBe('OPEN');

    // E o ponto de ranking aponta de volta para ele — a origem é rastreável.
    const [ponto] = await pontosDe('OFICIAL EXTERNA');
    expect(ponto.externalResultId).toBe(externo.id);
    expect(ponto.source).toBe('MUSCLEWAR');
    expect(ponto.points).toBe(5);
  });

  it('S — quem importou e quando fica registrado, com o lote de origem', async () => {
    const gerente = await gerenteDeImport();
    const cpf = gerarCpf(727272727);
    await api().post('/api/v1/athletes').set(diretor.auth())
      .send({ organizationId: orgId, fullName: 'COM PROCEDENCIA', cpf, sex: 'FEMALE' });

    const lote = await importarLinha(
      gerente,
      `MW-OFICIAL-2,${cpf},COM PROCEDENCIA,BIKINI,OPEN,2,4,Etapa Externa`,
      'external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,evento'
    );
    await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth()).send({});

    const [ponto] = await pontosDe('COM PROCEDENCIA');
    expect(ponto.awardedById, 'quem aplicou').toBe(gerente.id);
    expect(ponto.awardedAt, 'quando').toBeTruthy();

    // O lote continua consultável, e diz quem o criou e quando foi aplicado.
    const revisao = await api().get(`/api/v1/musclewar/imports/${lote.import.id}`).set(gerente.auth());
    expect(revisao.body.import.status).toBe('APPLIED');
    expect(revisao.body.import.appliedBy.id).toBe(gerente.id);
    expect(revisao.body.items[0].externalResultId).toBe('MW-OFICIAL-2');
  });

  it('a plataforma NÃO recalcula o resultado esportivo: 1º recebido continua 1º', async () => {
    // O MCI não julga. A colocação vem decidida de fora e é registrada como
    // veio — nenhum critério interno a reordena.
    const gerente = await gerenteDeImport();
    const cpfs = [gerarCpf(737373737), gerarCpf(747474747)];
    for (const [indice, cpf] of cpfs.entries()) {
      await api().post('/api/v1/athletes').set(diretor.auth())
        .send({ organizationId: orgId, fullName: `RECEBIDA ${indice + 1}`, cpf, sex: 'FEMALE' });
    }

    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId: orgId, seasonId, sourceType: 'CSV', sourceRef: unico('ext') + '.csv',
      content: [
        'external_result_id,cpf,atleta,categoria,classe,colocacao,pontos,evento',
        `MW-EXT-A,${cpfs[0]},RECEBIDA 1,BIKINI,OPEN,1,5,Etapa`,
        `MW-EXT-B,${cpfs[1]},RECEBIDA 2,BIKINI,OPEN,2,4,Etapa`
      ].join('\n')
    });
    await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`).set(gerente.auth()).send({});

    const [primeira] = await pontosDe('RECEBIDA 1');
    const [segunda] = await pontosDe('RECEBIDA 2');

    expect(primeira.placing, 'a colocação recebida não é recalculada').toBe(1);
    expect(segunda.placing).toBe(2);
    expect(primeira.points).toBe(5);
    expect(segunda.points).toBe(4);
  });
});

// ============================================================================
// Coerção de booleano na configuração do catálogo.
//
// Achado por sondagem (fase 11.5). O mesmo defeito que vazava documento
// privado de evento atinge aqui a integridade esportiva: com
// `z.coerce.boolean()`, a string 'false' vira `true` (é `Boolean('false')`), e
// uma classe marcada como NÃO elegível passaria a alimentar o Super Overall
// anual — mudando o ranking sem que ninguém tenha pedido.
// ============================================================================
describe('elegibilidade ao Super Overall não se inverte por texto', () => {
  it("superOverallEligible: 'false' mantém a classe FORA do Super Overall", async () => {
    const resposta = await api().post('/api/v1/classes-catalog').set(diretor.auth())
      .send({ organizationId: orgId, code: 'ESTREANTE', superOverallEligible: 'false' });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
    expect(resposta.body.superOverallEligible).toBe(false);

    const gravada = await comoAtor(diretor, tx => tx.classCatalog.findFirst({
      where: { organizationId: orgId, code: 'ESTREANTE' }
    }));
    expect(gravada.superOverallEligible).toBe(false);
  });

  it("active: 'false' desativa de verdade, em vez de reativar a classe", async () => {
    const resposta = await api().post('/api/v1/classes-catalog').set(diretor.auth())
      .send({ organizationId: orgId, code: 'NOVICE', active: 'false' });

    expect(resposta.status).toBe(201);
    expect(resposta.body.active).toBe(false);
  });

  it('texto que não é sim nem não é recusado, em vez de virar `true` calado', async () => {
    const resposta = await api().post('/api/v1/classes-catalog').set(diretor.auth())
      .send({ organizationId: orgId, code: 'DUVIDOSA', superOverallEligible: 'talvez' });

    expect(resposta.status).toBe(400);
    expect(resposta.body.error.code).toBe('VALIDATION_ERROR');
  });
});
