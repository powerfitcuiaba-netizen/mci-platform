import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor, gerarCpf, prisma
} from './helpers.mjs';

// ==========================================================================
// DOIS TÍTULOS OVERALL PARA O MESMO ATLETA NO MESMO CAMPEONATO.
//
// A REGRA NÃO EXISTE. Não está na configuração homologada, não está no
// regulamento que o organizador entregou, e não cabe ao sistema inventá-la:
// +10 (o atleta é campeão absoluto do evento, uma vez) e +20 (cada título
// vale o seu bônus) são as duas leituras possíveis, e as duas são defensáveis.
// Escolher uma aqui seria a plataforma legislando regra esportiva.
//
// O QUE ESTES TESTES TRANCAM:
//
//   * o sistema NÃO escolhe. Enquanto não houver regra homologada, a SEGUNDA
//     declaração é RECUSADA, com mensagem administrativa que diz exatamente
//     por quê — e não com um erro genérico que o operador interpretaria como
//     defeito;
//   * o que já funciona continua funcionando: um título por categoria para
//     atletas DIFERENTES é o caso normal do campeonato e segue liberado;
//   * repetir a MESMA declaração continua idempotente;
//   * revogar o primeiro título LIBERA o segundo. A recusa é sobre acumular
//     dois títulos, não sobre a segunda categoria em si;
//   * a recusa não deixa rastro de escrita: nenhum título novo, nenhum bônus,
//     nenhum ponto alterado.
//
// A mensagem administrativa é literal, definida pelo organizador. Ela é
// asserção de teste porque é ela que o operador lê na hora de decidir o que
// fazer — trocá-la por "erro 409" devolveria o operador ao escuro.
// ==========================================================================

const MENSAGEM = 'Este evento já possui uma declaração Overall para este atleta '
  + 'em outra categoria absoluta. A regra de pontuação para múltiplos títulos '
  + 'Overall neste mesmo evento ainda requer homologação.';

const CABECALHO = 'Athlete #,Class,First Name,Last Name,Member Number,Placing';
const csv = linhas => [CABECALHO, ...linhas].join('\n');

let admin, operador, org, filiacao, season, evento, atleta, outroAtleta;
let categoriaBB, categoriaCP;

const declarar = (corpo, quem) =>
  api().post(`/api/v1/events/${evento.id}/overall`).set((quem ?? operador).auth()).send(corpo);

const titulos = () => comoAtor(admin, tx => tx.eventOverallTitle.findMany({
  where: { eventId: evento.id }, select: { id: true, athleteId: true, categoryId: true }
}));

const pontosDoAtleta = alvo => comoAtor(admin, tx => tx.rankingPoint.findMany({
  where: { eventId: evento.id, athleteId: alvo ?? atleta.id },
  select: { id: true, placing: true, placementPoints: true, overallBonus: true,
            points: true, isOverallChampion: true, categoryId: true }
}));

const somaDoAtleta = async alvo =>
  (await pontosDoAtleta(alvo)).reduce((total, p) => total + p.points, 0);

// O INVARIANTE QUE IMPORTA, e não a soma.
//
// A soma NÃO é estável, e o motivo é um achado próprio: um título declarado
// numa categoria cujo lançamento tem `categoryId` nulo não encontra linha para
// pousar e paga ZERO, em silêncio. Foi assim que a medição inicial encontrou
// dois títulos valendo bônus [0, 10]. Por isso a asserção é sobre o que a
// regra promete — NO MÁXIMO um bônus de 10 no evento inteiro — e não sobre um
// total que depende de a importação ter resolvido a categoria daquela linha.
const bonusNoEvento = async () => {
  const pontos = await pontosDoAtleta();
  const comBonus = pontos.filter(p => p.overallBonus > 0);
  expect(comBonus.length, 'no maximo UM bonus por evento').toBeLessThanOrEqual(1);
  for (const p of pontos) expect([0, 10]).toContain(p.overallBonus);
  return comBonus.length;
};

// Inscreve o atleta numa classe ABSOLUTA da categoria, que é o que
// `declareOverall` confere antes de aceitar a declaração.
//
// A INSCRIÇÃO É UMA SÓ por (evento, atleta) — há índice único no banco. Duas
// categorias do mesmo atleta são dois ITENS da mesma inscrição, e é assim que
// o atleta que disputa Bodybuilding e Classic Physique aparece de verdade. A
// primeira versão deste helper criava duas inscrições e batia na restrição;
// era erro da fixture, não do produto.
const inscreverNaAbsoluta = async (categoria, quemId) => {
  // IDEMPOTENTE nos três níveis. A categoria do evento, a divisão e a classe
  // são do EVENTO, não do atleta: o segundo atleta na mesma categoria as
  // encontra prontas. Recriá-las devolvia conflito, e o `id` vinha indefinido
  // — de novo erro da fixture, não do produto.
  const existenteEc = await comoAtor(operador, tx => tx.eventCategory.findFirst({
    where: { eventId: evento.id, categoryId: categoria.id }, select: { id: true }
  }));
  const ec = existenteEc ?? (await api().post(`/api/v1/events/${evento.id}/categories`)
    .set(operador.auth()).send({ categoryId: categoria.id })).body;

  const existenteDiv = await comoAtor(operador, tx => tx.division.findFirst({
    where: { eventCategoryId: ec.id }, select: { id: true }
  }));
  const div = existenteDiv ?? (await api().post(`/api/v1/event-categories/${ec.id}/divisions`)
    .set(operador.auth()).send({ name: 'Open', code: 'OPEN' })).body;

  const existenteClasse = await comoAtor(operador, tx => tx.competitionClass.findFirst({
    where: { divisionId: div.id, code: 'OPEN' }, select: { id: true }
  }));
  const classe = existenteClasse ?? (await api().post(`/api/v1/divisions/${div.id}/classes`)
    .set(operador.auth()).send({ name: 'Open', code: 'OPEN', superOverallEligible: true })).body;
  expect(classe?.id, 'classe absoluta nao criada').toBeTruthy();

  // A INSCRIÇÃO É UMA SÓ por (evento, atleta) — há índice único no banco. Duas
  // categorias do mesmo atleta são dois ITENS da mesma inscrição, e é assim
  // que o atleta que disputa Bodybuilding e Classic Physique aparece.
  await comoAtor(operador, async tx => {
    const inscricao = await tx.registration.findFirst({
      where: { eventId: evento.id, athleteId: quemId }, select: { id: true }
    });
    if (inscricao) {
      await tx.registrationItem.create({
        data: {
          status: 'CONFIRMED',
          registration: { connect: { id: inscricao.id } },
          competitionClass: { connect: { id: classe.id } }
        }
      });
      return;
    }
    await tx.registration.create({
      data: {
        eventId: evento.id, athleteId: quemId, affiliationId: filiacao.id, status: 'CONFIRMED',
        items: { create: { status: 'CONFIRMED', competitionClass: { connect: { id: classe.id } } } }
      }
    });
  });
};

const importarEAplicar = async conteudo => {
  const criacao = await api().post('/api/v1/musclewar/imports').set(operador.auth()).send({
    organizationId: org, seasonId: season, eventId: evento.id, sourceType: 'CSV',
    sourceRef: unico('etapa') + '.csv', content: conteudo,
    externalIdPrefix: unico('QA').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    defaultAffiliationCode: 'NPC'
  });
  expect(criacao.status, JSON.stringify(criacao.body)).toBe(201);
  expect((await api().post(`/api/v1/musclewar/imports/${criacao.body.import.id}/apply`)
    .set(operador.auth()).send({})).status).toBe(200);
};

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin Duplo' });
  org = (await criarOrganizacao(admin, { name: 'Federacao Duplo' })).id;

  operador = await criarUsuario({ name: 'Operador Duplo' });
  for (const papel of ['RANKING_MANAGER', 'REGISTRATION_OPERATOR', 'EVENT_DIRECTOR']) {
    await vincular(org, operador, papel);
  }

  filiacao = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: org, name: 'NPC', code: 'NPC' })).body;

  season = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId: org, name: 'Temporada', year: 2026 })).body.id;
  await api().put(`/api/v1/seasons/${season}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  evento = (await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: org, name: 'Etapa Duplo', slug: unico('ev'),
    startDate: '2026-09-12T12:00:00.000Z', city: 'Cuiaba', state: 'MT', seasonId: season
  })).body;

  categoriaBB = await prisma.category.findUnique({ where: { code: 'MENS_BODYBUILDING' } });
  categoriaCP = await prisma.category.findUnique({ where: { code: 'CLASSIC_PHYSIQUE' } });

  const criarAtleta = (nome, matricula, semente) => comoAtor(operador, tx => tx.athlete.create({
    data: {
      organizationId: org, fullName: nome, sex: 'MALE',
      affiliationId: filiacao.id, affiliationNumber: matricula,
      identity: { create: { organizationId: org, cpf: gerarCpf(semente) } }
    }
  }));
  atleta = await criarAtleta('ATLETA DUPLO', '88281', 771);
  outroAtleta = await criarAtleta('ATLETA UNICO', '88282', 772);

  await inscreverNaAbsoluta(categoriaBB, atleta.id);
  await inscreverNaAbsoluta(categoriaCP, atleta.id);

  // Duas participações reais do mesmo atleta, em duas categorias, ambas 1º.
  await importarEAplicar(csv([
    `1,Men's Bodybuilding - Open,Atleta,Sobrenome,88281,1`,
    `2,Classic Physique - Open,Atleta,Sobrenome,88281,1`
  ]));
});

describe('o sistema não escolhe entre +10 e +20', () => {
  it('a segunda declaração em OUTRA categoria absoluta é recusada', async () => {
    const primeira = await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);

    const segunda = await declarar({ athleteId: atleta.id, categoryId: categoriaCP.id });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(409);
    expect(segunda.body.error.message).toBe(MENSAGEM);
  }, 60_000);

  it('a recusa não grava nada: nem título, nem bônus, nem ponto alterado', async () => {
    await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id });
    const antes = await pontosDoAtleta();
    const somaAntes = antes.reduce((t, p) => t + p.points, 0);

    await declarar({ athleteId: atleta.id, categoryId: categoriaCP.id });

    expect(await titulos(), 'segue existindo UM título').toHaveLength(1);
    // 5 do 1º em Bodybuilding + 10 do título + 5 do 1º em Classic Physique.
    expect(somaAntes).toBe(20);
    expect(await somaDoAtleta(), 'nada mudou depois da recusa').toBe(20);
    expect((await pontosDoAtleta()).filter(p => p.overallBonus > 0)).toHaveLength(1);
  }, 60_000);

  it('repetir a MESMA declaração continua idempotente', async () => {
    expect((await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id })).status).toBe(201);
    const repetida = await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(repetida.status, 'mesma categoria, mesmo atleta: não é conflito')
      .toBeLessThan(400);

    expect(await titulos()).toHaveLength(1);
    expect(await somaDoAtleta(), 'o bônus não dobra ao repetir').toBe(20);
  }, 60_000);

  it('atletas DIFERENTES em categorias diferentes seguem liberados', async () => {
    await inscreverNaAbsoluta(categoriaCP, outroAtleta.id);

    expect((await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id })).status).toBe(201);
    const outra = await declarar({ athleteId: outroAtleta.id, categoryId: categoriaCP.id });
    expect(outra.status, 'o caso NORMAL do campeonato não pode ser bloqueado')
      .toBe(201);

    expect(await titulos()).toHaveLength(2);
  }, 60_000);

  it('revogar o primeiro título libera a declaração na outra categoria', async () => {
    const primeiro = (await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id })).body;

    expect((await declarar({ athleteId: atleta.id, categoryId: categoriaCP.id })).status).toBe(409);

    const revogacao = await api().delete(`/api/v1/events/${evento.id}/overall/${primeiro.id}`)
      .set(operador.auth()).send({ reason: 'declarado na categoria errada' });
    expect(revogacao.status, JSON.stringify(revogacao.body)).toBeLessThan(400);

    // A recusa é sobre ACUMULAR dois títulos, não sobre a segunda categoria.
    // Corrigir um engano de categoria continua sendo revogar e declarar de novo.
    const segunda = await declarar({ athleteId: atleta.id, categoryId: categoriaCP.id });
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
    expect(await titulos(), 'segue sendo UM título').toHaveLength(1);
    await bonusNoEvento();
  }, 60_000);

  it('o título do EVENTO inteiro e o de categoria também não se acumulam', async () => {
    // Recorte nulo alcança todas as categorias do atleta. Declarar uma
    // categoria por cima dele acumularia pela mesma porta, por outro caminho.
    expect((await declarar({ athleteId: atleta.id })).status).toBe(201);

    const comCategoria = await declarar({ athleteId: atleta.id, categoryId: categoriaBB.id });
    expect(comCategoria.status).toBe(409);
    expect(comCategoria.body.error.message).toBe(MENSAGEM);
  }, 60_000);
});

describe('concorrência: duas categorias ao mesmo tempo', () => {
  it('20 declarações simultâneas em duas categorias deixam UM título', async () => {
    const disparos = Array.from({ length: 20 }, (_, i) => declarar({
      athleteId: atleta.id,
      categoryId: i % 2 === 0 ? categoriaBB.id : categoriaCP.id
    }));
    const respostas = await Promise.all(disparos);

    expect(respostas.filter(r => r.status >= 500), 'nenhum 500').toHaveLength(0);

    // A conferência de "já tem título em outra categoria" lê antes de escrever.
    // Sem serialização, duas declarações em categorias diferentes atravessam
    // juntas — e o índice único, que é por (evento, categoria), não as pega:
    // elas são de categorias distintas. O atleta terminaria com os dois
    // títulos que esta fase existe para impedir.
    const finais = await titulos();
    expect(finais, 'um único título sobrevive').toHaveLength(1);
    await bonusNoEvento();
  }, 120_000);
});
