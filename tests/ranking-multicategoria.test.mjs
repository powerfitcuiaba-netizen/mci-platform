import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// ACÚMULO MULTICATEGORIA E BÔNUS OVERALL — A CONTA QUE O REGULAMENTO MANDA.
//
// A regra oficial pontua CADA PARTICIPAÇÃO de forma independente: um atleta
// que compete em três classes soma as três colocações (5 + 4 + 5 = 14). Isso
// o motor já fazia.
//
// O que este arquivo existe para provar é a outra metade da regra, que é uma
// RESTRIÇÃO e não uma soma:
//
//   o título Overall vale +10 UMA VEZ. Não é multiplicado pelo número de
//   participações do campeão, e não é concedido a quem não venceu a classe
//   absoluta (OPEN).
//
// Um bônus que se repete a cada classe inscrita premia quem se inscreve mais,
// não quem vence — e isso não é a regra homologada.
// ============================================================================

let admin, diretor, orgId, seasonId;

const cpfSeq = (() => { let n = 730000000; return () => gerarCpf(n += 6131); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

// Evento com VÁRIAS classes na mesma categoria — o cenário que o helper
// compartilhado não monta, e que é exatamente onde a regra se decide.
async function eventoComClasses(classes, { categoryCode = 'BIKINI' } = {}) {
  const evento = await api().post('/api/v1/events').set(diretor.auth()).send({
    organizationId: orgId, name: 'Etapa Multicategoria', slug: unico('multi'),
    startDate: '2026-11-20T12:00:00.000Z', seasonId
  });
  expect(evento.status, JSON.stringify(evento.body)).toBe(201);

  const categoria = await prisma.category.findUnique({ where: { code: categoryCode } });
  const eventCategory = await api().post(`/api/v1/events/${evento.body.id}/categories`)
    .set(diretor.auth()).send({ categoryId: categoria.id });
  expect(eventCategory.status, JSON.stringify(eventCategory.body)).toBe(201);

  const montadas = [];
  for (const definicao of classes) {
    const division = await api().post(`/api/v1/event-categories/${eventCategory.body.id}/divisions`)
      .set(diretor.auth()).send({ name: definicao.division, code: definicao.divisionCode });
    expect(division.status, JSON.stringify(division.body)).toBe(201);

    const classe = await api().post(`/api/v1/divisions/${division.body.id}/classes`)
      .set(diretor.auth()).send({ name: definicao.name, code: definicao.code });
    expect(classe.status, JSON.stringify(classe.body)).toBe(201);

    // Elegibilidade marcada NA CLASSE quando o teste precisa de duas
    // absolutas com códigos distintos: o catálogo da organização resolve por
    // código, e a marca da própria classe é a outra fonte que o motor já lê.
    if (definicao.elegivel) {
      await comoAtor(diretor, tx => tx.competitionClass.update({
        where: { id: classe.body.id }, data: { superOverallEligible: true }
      }));
    }

    montadas.push({ ...definicao, id: classe.body.id, divisionId: division.body.id });
  }

  return { event: evento.body, category: categoria, classes: montadas };
}

// Inscreve, faz check-in, recebe os resultados de fora e publica.
async function disputar(evento, classes, { colocacoes, overall = null, overallCategoryId }) {
  await transicionar(diretor, evento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  // Um atleta pode estar em mais de uma classe: a inscrição carrega todas.
  const classesPorAtleta = new Map();
  for (const classe of classes) {
    for (const nome of colocacoes[classe.code] ?? []) {
      if (!classesPorAtleta.has(nome)) classesPorAtleta.set(nome, []);
      classesPorAtleta.get(nome).push(classe.id);
    }
  }

  const atletaPorNome = new Map();
  for (const [nome, classIds] of classesPorAtleta) {
    const inscricao = await api().post(`/api/v1/events/${evento.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    atletaPorNome.set(nome, {
      athleteId: inscricao.body.registration.athlete.id,
      registrationId: inscricao.body.registration.id
    });
  }

  await transicionar(diretor, evento.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const { registrationId } of atletaPorNome.values()) {
    await api().post(`/api/v1/registrations/${registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, evento.id, ['IN_JUDGING']);

  for (const classe of classes) {
    const nomes = colocacoes[classe.code] ?? [];
    if (!nomes.length) continue;
    const recebido = await api().post(`/api/v1/classes/${classe.id}/result`).set(diretor.auth()).send({
      entries: nomes.map((nome, indice) => ({ athleteId: atletaPorNome.get(nome).athleteId, placing: indice + 1 }))
    });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
  }

  if (overall) {
    const corpo = { athleteId: atletaPorNome.get(overall).athleteId };
    if (overallCategoryId !== undefined) corpo.categoryId = overallCategoryId;
    const declarado = await api().post(`/api/v1/events/${evento.id}/overall`).set(diretor.auth()).send(corpo);
    expect(declarado.status, JSON.stringify(declarado.body)).toBe(201);
  }

  for (const classe of classes) {
    if (!(colocacoes[classe.code] ?? []).length) continue;
    const publicado = await api().post(`/api/v1/classes/${classe.id}/result/publish`).set(diretor.auth())
      .send({ note: 'Homologado' });
    expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);
  }

  return atletaPorNome;
}

const pontosDe = async nome => {
  const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: nome } }));
  return comoAtor(diretor, tx => tx.rankingPoint.findMany({
    where: { athleteId: atleta.id }, orderBy: { placing: 'asc' }
  }));
};

const somar = (pontos, campo) => pontos.reduce((total, ponto) => total + ponto[campo], 0);

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

describe('A) acúmulo: cada participação pontua de forma independente', () => {
  it('três classes, 1º · 2º · 1º = 5 + 4 + 5 = 14, em três linhas rastreáveis', async () => {
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Open', code: 'OPEN_166' },
      { division: 'Acima de 166cm', divisionCode: 'ACIMA166', name: 'Open', code: 'OPEN_ACIMA' }
    ]);

    await disputar(event, classes, {
      colocacoes: {
        OPEN: ['POLIVALENTE', 'RIVAL A'],
        OPEN_166: ['RIVAL B', 'POLIVALENTE'],
        OPEN_ACIMA: ['POLIVALENTE', 'RIVAL C']
      }
    });

    const pontos = await pontosDe('POLIVALENTE');
    expect(pontos, 'uma linha por participação — não uma linha somada').toHaveLength(3);
    expect(pontos.map(ponto => ponto.placementPoints).sort()).toEqual([4, 5, 5]);
    expect(somar(pontos, 'points')).toBe(14);

    // Cada parcela aponta para o resultado e a classe que a originaram.
    for (const ponto of pontos) {
      expect(ponto.resultId).toBeTruthy();
      expect(ponto.classId).toBeTruthy();
    }
    expect(new Set(pontos.map(ponto => ponto.classId)).size).toBe(3);
  });

  it('classe com um único atleta continua valendo 5 — não há quórum mínimo', async () => {
    const { event, classes } = await eventoComClasses([
      { division: 'Única', divisionCode: 'UNICA', name: 'Open', code: 'OPEN' }
    ]);

    await disputar(event, classes, { colocacoes: { OPEN: ['SOZINHA'] } });

    const pontos = await pontosDe('SOZINHA');
    expect(pontos).toHaveLength(1);
    expect(pontos[0].placementPoints).toBe(5);
    expect(pontos[0].points).toBe(5);
  });
});

describe('B) o bônus Overall vale UMA VEZ — não multiplica por participação', () => {
  it('campeão Overall inscrito em três classes recebe +10 uma única vez', async () => {
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Open', code: 'OPEN_166' },
      { division: 'Acima de 166cm', divisionCode: 'ACIMA166', name: 'Open', code: 'OPEN_ACIMA' }
    ]);

    await disputar(event, classes, {
      colocacoes: {
        OPEN: ['CAMPEA', 'RIVAL A'],
        OPEN_166: ['RIVAL B', 'CAMPEA'],
        OPEN_ACIMA: ['CAMPEA', 'RIVAL C']
      },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');

    // 5 + 4 + 5 = 14 de colocação, +10 de Overall, UMA vez. Nunca 14 + 30.
    expect(somar(pontos, 'placementPoints'), 'a colocação acumula').toBe(14);
    expect(somar(pontos, 'overallBonus'), 'o bônus NÃO acumula').toBe(10);
    expect(somar(pontos, 'points')).toBe(24);

    // E o bônus fica numa linha só: exatamente uma participação o carrega.
    const comBonus = pontos.filter(ponto => ponto.overallBonus > 0);
    expect(comBonus).toHaveLength(1);

    // O título é um só, e o contador de desempate precisa enxergar UM título.
    expect(pontos.filter(ponto => ponto.isOverallChampion)).toHaveLength(1);
  });

  it('o ranking agregado reflete o bônus uma vez só', async () => {
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Open', code: 'OPEN_166' }
    ]);

    await disputar(event, classes, {
      colocacoes: { OPEN: ['CAMPEA', 'RIVAL A'], OPEN_166: ['CAMPEA', 'RIVAL B'] },
      overall: 'CAMPEA'
    });

    const ranking = await api().get('/api/v1/ranking').query({ seasonId, limit: 10 });
    expect(ranking.status, JSON.stringify(ranking.body)).toBe(200);

    const linhas = ranking.body.items ?? ranking.body;
    const campea = linhas.find(linha => linha.athlete?.fullName === 'CAMPEA');
    // 5 + 5 + 10 = 20.
    expect(campea.totalPoints).toBe(20);
    expect(campea.overallWins, 'um título, não dois').toBe(1);
  });

  it('o bônus fica na participação ABSOLUTA (OPEN) — é onde o título é ganho', async () => {
    // Só OPEN é elegível ao Super Overall no catálogo homologado; as outras
    // classes pontuam no campeonato e não alimentam o anual.
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Master', code: 'MASTER' }
    ]);

    // A colocação na OPEN é PIOR que na MASTER de propósito: assim só o
    // critério de elegibilidade pode colocar o bônus na absoluta, e o teste
    // não passa por coincidência com o critério de colocação.
    await disputar(event, classes, {
      colocacoes: { OPEN: ['RIVAL A', 'CAMPEA'], MASTER: ['CAMPEA', 'RIVAL B'] },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');
    const porClasse = Object.fromEntries(await Promise.all(pontos.map(async ponto => {
      const classe = await comoAtor(diretor, tx => tx.competitionClass.findUnique({ where: { id: ponto.classId } }));
      return [classe.code, ponto];
    })));

    expect(porClasse.OPEN.overallBonus, 'o bônus mora na absoluta').toBe(10);
    expect(porClasse.OPEN.isOverallChampion).toBe(true);
    expect(porClasse.MASTER.overallBonus, 'a MASTER não carrega o bônus').toBe(0);
    expect(porClasse.MASTER.isOverallChampion).toBe(false);

    // E é por morar na OPEN que o bônus entra também no Super Overall anual:
    // 4 (2º) + 10 = 14 no anual, e 0 da MASTER, que não é elegível.
    expect(porClasse.OPEN.superOverallPoints).toBe(14);
    expect(porClasse.MASTER.superOverallPoints).toBe(0);
    expect(somar(pontos, 'superOverallPoints')).toBe(14);
    // No campeonato a conta é a soma cheia: 4 (OPEN) + 5 (MASTER) + 10.
    expect(somar(pontos, 'points')).toBe(19);
  });

  it('colocação fora da tabela não sobrevive quando o bônus muda de lugar', async () => {
    // A atleta é 6ª na MASTER (zero pontos) e 1ª na OPEN. A linha da MASTER só
    // existiria por causa de um bônus que pertence à OPEN — e não deve restar
    // uma linha de zero ponto no histórico.
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Master', code: 'MASTER' }
    ]);

    await disputar(event, classes, {
      colocacoes: {
        OPEN: ['CAMPEA'],
        MASTER: ['M1', 'M2', 'M3', 'M4', 'M5', 'CAMPEA']
      },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');
    expect(pontos, 'só a participação que pontua permanece').toHaveLength(1);
    expect(pontos[0].placing).toBe(1);
    expect(pontos[0].points).toBe(15);
    expect(pontos.every(ponto => ponto.points > 0)).toBe(true);
  });

  it('sem participação absoluta NÃO há bônus — e a declaração nem é aceita', async () => {
    // REGRA VIGENTE. Antes, o bônus caía na melhor colocação quando não havia
    // participação na absoluta. Agora não cai em lugar nenhum: o +10 é do
    // campeão da absoluta, então quem não a disputou não recebe o título —
    // a plataforma recusa a declaração na porta.
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Novice', code: 'NOVICE' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Master', code: 'MASTER' }
    ]);

    const atletas = await disputar(event, classes, {
      colocacoes: {
        NOVICE: ['N1', 'N2', 'CAMPEA'],
        MASTER: ['CAMPEA', 'M2']
      }
    });

    const declarado = await api().post(`/api/v1/events/${event.id}/overall`).set(diretor.auth())
      .send({ athleteId: atletas.get('CAMPEA').athleteId });
    expect(declarado.status, JSON.stringify(declarado.body)).toBe(422);
    expect(declarado.body.error.code).toBe('OVERALL_REQUIRES_ABSOLUTE_CLASS');

    const pontos = await pontosDe('CAMPEA');
    // 5 (1º na Master) + 3 (3º na Novice) = 8. A colocação não foi tocada.
    expect(somar(pontos, 'placementPoints')).toBe(8);
    expect(somar(pontos, 'overallBonus'), 'sem absoluta, sem bônus').toBe(0);
    expect(somar(pontos, 'points')).toBe(8);
    expect(somar(pontos, 'superOverallPoints')).toBe(0);
  });

  it('empate total na escolha do portador é resolvido por id — e nunca por ordem física', async () => {
    // Duas participações na ABSOLUTA (duas divisões de altura, ambas OPEN),
    // as duas com 1º lugar: o critério de elegibilidade e o de colocação não
    // separam. Sem uma chave estável, qual linha carrega o bônus passaria a
    // depender da ordem física das linhas no PostgreSQL — e um `pg_restore`
    // moveria o bônus de lugar.
    const { event, classes } = await eventoComClasses([
      { division: 'Até 160cm', divisionCode: 'ATE160', name: 'Open', code: 'OPEN' },
      { division: 'Até 166cm', divisionCode: 'ATE166', name: 'Open', code: 'OPEN_B', elegivel: true }
    ]);

    await disputar(event, classes, {
      colocacoes: { OPEN: ['CAMPEA', 'N2'], OPEN_B: ['CAMPEA', 'M2'] },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');
    expect(pontos).toHaveLength(2);

    const comBonus = pontos.filter(ponto => ponto.overallBonus > 0);
    expect(comBonus, 'exatamente uma linha carrega o bônus').toHaveLength(1);

    const menorId = [...pontos].map(ponto => ponto.id).sort()[0];
    expect(comBonus[0].id, 'a escolha é o menor id, byte a byte').toBe(menorId);
  });

  it('declarar o mesmo Overall duas vezes é idempotente — não soma 20', async () => {
    const { event, classes } = await eventoComClasses([
      { division: 'Única', divisionCode: 'UNICA', name: 'Open', code: 'OPEN' }
    ]);

    const atletas = await disputar(event, classes, {
      colocacoes: { OPEN: ['CAMPEA', 'RIVAL'] },
      overall: 'CAMPEA'
    });

    const denovo = await api().post(`/api/v1/events/${event.id}/overall`).set(diretor.auth())
      .send({ athleteId: atletas.get('CAMPEA').athleteId });
    expect([200, 201]).toContain(denovo.status);

    const pontos = await pontosDe('CAMPEA');
    expect(somar(pontos, 'overallBonus')).toBe(10);
    expect(somar(pontos, 'points')).toBe(15);
  });
});
