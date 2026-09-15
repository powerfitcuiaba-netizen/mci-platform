import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';
import { pontuarResultado, TABELA_OFICIAL_COLOCACAO as TABELA, BONUS_OVERALL } from '../src/utils/rankingScoring.js';

// ============================================================================
// REGRA VIGENTE DO OVERALL — HOMOLOGADA PELO RESPONSÁVEL.
//
// A regra anterior (fase 11.4) dizia que o bônus de Overall somava no
// campeonato em QUALQUER classe, e que só o Super Overall anual era restrito à
// OPEN. Essa leitura está REVOGADA.
//
// A regra vigente:
//
//   o +10 é do campeão da OPEN/ABSOLUTA, e de mais ninguém.
//
// Nunca Novice, Masters, Junior, Teenage, True Novice, Special ou qualquer
// outra divisão. Nunca automático para quem vence uma classe. Nunca
// multiplicado pelo número de categorias disputadas: é UMA ocorrência por
// título.
//
// O Overall continua sendo FATO DECLARADO — o sistema não o descobre, não o
// apura e não o infere de colocação. Ele registra, com autoria, data e
// auditoria, o que a organização homologou.
//
// Este arquivo é a prova da regra vigente. tests/regulamento-11-4.test.mjs
// guarda a regra legada, marcada como tal.
// ============================================================================

let admin, diretor, orgId, seasonId;

const cpfSeq = (() => { let n = 920000000; return () => gerarCpf(n += 3313); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

// OPEN é a única classe elegível no catálogo homologado — e é justamente essa
// marca que identifica a absoluta. O motor nunca compara o texto "OPEN".
async function eventoComClasses(classes) {
  const evento = await api().post('/api/v1/events').set(diretor.auth()).send({
    organizationId: orgId, name: 'Etapa Overall', slug: unico('overall'),
    startDate: '2026-11-20T12:00:00.000Z', seasonId
  });
  expect(evento.status, JSON.stringify(evento.body)).toBe(201);

  const categoria = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
  const eventCategory = await api().post(`/api/v1/events/${evento.body.id}/categories`)
    .set(diretor.auth()).send({ categoryId: categoria.id });
  expect(eventCategory.status, JSON.stringify(eventCategory.body)).toBe(201);

  const montadas = [];
  for (const definicao of classes) {
    const division = await api().post(`/api/v1/event-categories/${eventCategory.body.id}/divisions`)
      .set(diretor.auth()).send({ name: definicao.division, code: definicao.divisionCode });
    const classe = await api().post(`/api/v1/divisions/${division.body.id}/classes`)
      .set(diretor.auth()).send({ name: definicao.name, code: definicao.code });
    expect(classe.status, JSON.stringify(classe.body)).toBe(201);

    // Absoluta marcada NA PRÓPRIA CLASSE, sem passar pelo catálogo: é o caso
    // do operador que cria uma classe absoluta nova, ainda não catalogada.
    if (definicao.elegivel) {
      await comoAtor(diretor, tx => tx.competitionClass.update({
        where: { id: classe.body.id }, data: { superOverallEligible: true }
      }));
    }

    montadas.push({ ...definicao, id: classe.body.id });
  }
  return { event: evento.body, category: categoria, classes: montadas };
}

async function disputar(evento, classes, { colocacoes, overall = null, ordemDeResultado = null, publicar = true }) {
  await transicionar(diretor, evento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const classesPorAtleta = new Map();
  for (const classe of classes) {
    for (const nome of colocacoes[classe.code] ?? []) {
      if (!classesPorAtleta.has(nome)) classesPorAtleta.set(nome, []);
      classesPorAtleta.get(nome).push(classe.id);
    }
  }

  const atletas = new Map();
  for (const [nome, classIds] of classesPorAtleta) {
    const inscricao = await api().post(`/api/v1/events/${evento.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    atletas.set(nome, {
      athleteId: inscricao.body.registration.athlete.id,
      registrationId: inscricao.body.registration.id
    });
  }

  await transicionar(diretor, evento.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const { registrationId } of atletas.values()) {
    await api().post(`/api/v1/registrations/${registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, evento.id, ['IN_JUDGING']);

  // A ORDEM em que as classes são recebidas e publicadas é um parâmetro do
  // teste: o resultado final não pode depender dela.
  const ordem = ordemDeResultado
    ? ordemDeResultado.map(code => classes.find(c => c.code === code))
    : classes;

  for (const classe of ordem) {
    const nomes = colocacoes[classe.code] ?? [];
    if (!nomes.length) continue;
    const recebido = await api().post(`/api/v1/classes/${classe.id}/result`).set(diretor.auth()).send({
      entries: nomes.map((nome, i) => ({ athleteId: atletas.get(nome).athleteId, placing: i + 1 }))
    });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
  }

  let declaracao = null;
  if (overall) {
    declaracao = await api().post(`/api/v1/events/${evento.id}/overall`).set(diretor.auth())
      .send({ athleteId: atletas.get(overall).athleteId });
  }

  if (publicar) {
    for (const classe of ordem) {
      if (!(colocacoes[classe.code] ?? []).length) continue;
      const publicado = await api().post(`/api/v1/classes/${classe.id}/result/publish`).set(diretor.auth())
        .send({ note: 'Homologado' });
      expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);
    }
  }

  return { atletas, declaracao };
}

const pontosDe = async nome => {
  const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: nome } }));
  return comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { athleteId: atleta.id }, orderBy: { placing: 'asc' } }));
};
const somar = (pontos, campo) => pontos.reduce((t, p) => t + p[campo], 0);

const TRES_CLASSES = [
  { division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' },
  { division: 'Novatas', divisionCode: 'NOV', name: 'Novice', code: 'NOVICE' },
  { division: 'Master', divisionCode: 'MST', name: 'Master', code: 'MASTER' }
];

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

// --------------------------------------------------------------- unidade ---

describe('o motor: o +10 exige a absoluta', () => {
  it('1º na absoluta com Overall = 5 + 10 = 15', () => {
    expect(pontuarResultado(1, TABELA, true, true))
      .toEqual({ placementPoints: 5, overallBonus: BONUS_OVERALL, points: 15, superOverallPoints: 15 });
  });

  it('1º em classe NÃO absoluta com Overall = 5, e não 15', () => {
    // A regra legada devolvia 15 aqui. REVOGADA.
    expect(pontuarResultado(1, TABELA, true, false))
      .toEqual({ placementPoints: 5, overallBonus: 0, points: 5, superOverallPoints: 0 });
  });

  it('a colocação continua valendo o mesmo em toda classe', () => {
    for (const elegivel of [true, false]) {
      expect(pontuarResultado(1, TABELA, false, elegivel).points).toBe(5);
      expect(pontuarResultado(2, TABELA, false, elegivel).points).toBe(4);
      expect(pontuarResultado(3, TABELA, false, elegivel).points).toBe(3);
      expect(pontuarResultado(4, TABELA, false, elegivel).points).toBe(2);
      expect(pontuarResultado(5, TABELA, false, elegivel).points).toBe(1);
      expect(pontuarResultado(6, TABELA, false, elegivel).points).toBe(0);
    }
  });
});

// ------------------------------------------------------ caminho real da API -

describe('A) três categorias SEM Overall: só as colocações', () => {
  it('1º · 2º · 1º = 5 + 4 + 5 = 14, sem bônus nenhum', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    await disputar(event, classes, {
      colocacoes: {
        OPEN: ['POLIVALENTE', 'R1'],
        NOVICE: ['R2', 'POLIVALENTE'],
        MASTER: ['POLIVALENTE', 'R3']
      }
    });

    const pontos = await pontosDe('POLIVALENTE');
    expect(pontos).toHaveLength(3);
    expect(somar(pontos, 'placementPoints')).toBe(14);
    expect(somar(pontos, 'overallBonus'), 'sem título, sem bônus').toBe(0);
    expect(somar(pontos, 'points')).toBe(14);
  });
});

describe('B) três categorias COM um Overall: +10 exatamente uma vez', () => {
  it('o bônus entra uma única vez, e na participação da absoluta', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    await disputar(event, classes, {
      colocacoes: {
        OPEN: ['CAMPEA', 'R1'],
        NOVICE: ['R2', 'CAMPEA'],
        MASTER: ['CAMPEA', 'R3']
      },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');
    expect(somar(pontos, 'placementPoints')).toBe(14);
    expect(somar(pontos, 'overallBonus'), 'UMA ocorrência por título').toBe(10);
    expect(somar(pontos, 'points')).toBe(24);

    const comBonus = pontos.filter(p => p.overallBonus > 0);
    expect(comBonus).toHaveLength(1);
    expect(comBonus[0].superOverallEligible, 'o bônus mora na absoluta').toBe(true);
  });

  it('as demais participações do campeão ficam com bônus ZERO', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    await disputar(event, classes, {
      colocacoes: { OPEN: ['CAMPEA'], NOVICE: ['CAMPEA'], MASTER: ['CAMPEA'] },
      overall: 'CAMPEA'
    });

    const pontos = await pontosDe('CAMPEA');
    const naoAbsolutas = pontos.filter(p => !p.superOverallEligible);
    expect(naoAbsolutas).toHaveLength(2);
    for (const ponto of naoAbsolutas) {
      expect(ponto.overallBonus, 'Novice e Master não recebem bônus').toBe(0);
      expect(ponto.isOverallChampion).toBe(false);
      expect(ponto.points).toBe(5);
    }
  });
});

describe('C) o Overall não pode ser declarado fora da absoluta', () => {
  it('atleta que não disputou a absoluta não recebe o título', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    const { declaracao } = await disputar(event, classes, {
      colocacoes: { OPEN: ['OUTRA'], NOVICE: ['SO_NOVICE'], MASTER: ['SO_NOVICE'] },
      overall: 'SO_NOVICE',
      publicar: false
    });

    expect(declaracao.status, JSON.stringify(declaracao.body)).toBe(422);
    expect(declaracao.body.error?.code || declaracao.body.code).toBe('OVERALL_REQUIRES_ABSOLUTE_CLASS');

    const titulos = await api().get(`/api/v1/events/${event.id}/overall`);
    expect(titulos.body.items ?? titulos.body, 'nada foi registrado').toHaveLength(0);
  });

  it('a recusa não deixa rastro de bônus em lugar nenhum', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    await disputar(event, classes, {
      colocacoes: { OPEN: ['OUTRA'], NOVICE: ['SO_NOVICE'] },
      overall: 'SO_NOVICE'
    });

    const pontos = await pontosDe('SO_NOVICE');
    expect(somar(pontos, 'overallBonus')).toBe(0);
    expect(pontos.every(p => !p.isOverallChampion)).toBe(true);
  });
});

describe('C2) a absoluta pode ser marcada na classe, sem passar pelo catálogo', () => {
  it('classe fora do catálogo, marcada como absoluta, dá título e bônus', async () => {
    // A resolução do que é a absoluta tem DUAS fontes: a marca na classe do
    // evento e o catálogo da organização. Declarar e pontuar têm de concordar
    // sobre isso — senão a plataforma aceita o título e depois não credita o
    // bônus, ou o contrário.
    const { event, classes } = await eventoComClasses([
      { division: 'Absoluta Nova', divisionCode: 'ABSNOVA', name: 'Absoluta', code: 'ABSOLUTA_X', elegivel: true },
      { division: 'Novatas', divisionCode: 'NOV', name: 'Novice', code: 'NOVICE' }
    ]);

    const { declaracao } = await disputar(event, classes, {
      colocacoes: { ABSOLUTA_X: ['CAMPEA', 'R1'], NOVICE: ['CAMPEA'] },
      overall: 'CAMPEA'
    });

    expect(declaracao.status, JSON.stringify(declaracao.body)).toBe(201);

    const pontos = await pontosDe('CAMPEA');
    const naAbsoluta = pontos.find(p => p.superOverallEligible);
    const naNovice = pontos.find(p => !p.superOverallEligible);

    expect(naAbsoluta.overallBonus, 'o bônus vai para a absoluta nova').toBe(10);
    expect(naAbsoluta.points).toBe(15);
    expect(naNovice.overallBonus).toBe(0);
    expect(somar(pontos, 'overallBonus')).toBe(10);
  });
});

describe('D) idempotência e independência de ordem', () => {
  it('declarar o mesmo título duas vezes não soma 20', async () => {
    const { event, classes } = await eventoComClasses(TRES_CLASSES);
    const { atletas } = await disputar(event, classes, {
      colocacoes: { OPEN: ['CAMPEA', 'R1'], NOVICE: ['CAMPEA'] },
      overall: 'CAMPEA'
    });

    const denovo = await api().post(`/api/v1/events/${event.id}/overall`).set(diretor.auth())
      .send({ athleteId: atletas.get('CAMPEA').athleteId });
    expect([200, 201]).toContain(denovo.status);

    const pontos = await pontosDe('CAMPEA');
    expect(somar(pontos, 'overallBonus')).toBe(10);
    expect(somar(pontos, 'points')).toBe(20); // 5 (OPEN) + 5 (NOVICE) + 10
  });

  it('a ordem em que as classes são processadas não muda o resultado', async () => {
    const colocacoes = {
      OPEN: ['CAMPEA', 'R1'],
      NOVICE: ['R2', 'CAMPEA'],
      MASTER: ['CAMPEA', 'R3']
    };

    const totais = [];
    for (const ordem of [['OPEN', 'NOVICE', 'MASTER'], ['MASTER', 'NOVICE', 'OPEN'], ['NOVICE', 'MASTER', 'OPEN']]) {
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
      seasonId = temporada.body.id;

      const { event, classes } = await eventoComClasses(TRES_CLASSES);
      await disputar(event, classes, { colocacoes, overall: 'CAMPEA', ordemDeResultado: ordem });

      const pontos = await pontosDe('CAMPEA');
      totais.push({
        ordem: ordem.join('>'),
        colocacao: somar(pontos, 'placementPoints'),
        bonus: somar(pontos, 'overallBonus'),
        total: somar(pontos, 'points'),
        portadora: pontos.find(p => p.overallBonus > 0)?.superOverallEligible ?? null
      });
    }

    for (const resultado of totais) {
      expect(resultado.colocacao, resultado.ordem).toBe(14);
      expect(resultado.bonus, resultado.ordem).toBe(10);
      expect(resultado.total, resultado.ordem).toBe(24);
      expect(resultado.portadora, resultado.ordem).toBe(true);
    }
  });
});
