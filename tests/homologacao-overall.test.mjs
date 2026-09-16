import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 10 — HOMOLOGAÇÃO ADMINISTRATIVA DO OVERALL.
//
// A plataforma NÃO decide campeão Overall. Ela REGISTRA a decisão oficial de
// quem tem competência para tomá-la. Esta fase transforma essa frase numa
// operação administrativa completa: candidatos à vista, prévia do impacto,
// confirmação, conflito tratado e revogação auditada.
//
// O que a auditoria da 10.1 encontrou de errado no que já existia:
//
//   D1  declarar OUTRO atleta substituía o campeão em SILÊNCIO — um `update`
//       sem conflito. Trocar campeão homologado é decisão administrativa, não
//       efeito colateral de um POST repetido.
//   D2  `categoryId` não era conferido contra o evento. Um recorte de outro
//       campeonato era aceito e o erro que saía falava de classe absoluta —
//       mandando o operador procurar o problema no lugar errado.
//   D4  a unicidade `(eventId, categoryId)` NÃO protege o Overall do evento
//       inteiro: no PostgreSQL dois NULL são distintos, e dois títulos gerais
//       cabiam na mesma tabela.
//   D6  não havia como listar candidatos.
//   D5  não havia prévia: só se descobria o impacto depois de gravar.
//   D3  não havia revogação — só substituição silenciosa, que é a pior das
//       correções possíveis.
// ============================================================================

let admin, diretor, gerente, semPermissao, contaDeAtleta, orgId, seasonId;
let evento, classeOpen, classeNovice, classeMaster;

const cpfSeq = (() => { let n = 440000000; return () => gerarCpf(n += 6871); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

async function montarEvento({ org = null, dono = null, nome = 'Etapa de Homologação' } = {}) {
  const organizacao = org || orgId;
  const operador = dono || diretor;

  const ev = await api().post('/api/v1/events').set(operador.auth()).send({
    organizationId: organizacao, name: nome, slug: unico('ev'),
    startDate: '2026-11-20T12:00:00.000Z', seasonId: organizacao === orgId ? seasonId : undefined
  });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);

  const cat = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
  const eventCategory = await api().post(`/api/v1/events/${ev.body.id}/categories`)
    .set(operador.auth()).send({ categoryId: cat.id });

  const classes = {};
  for (const def of [
    { div: 'Absoluta', divCode: 'ABS', nome: 'Open', code: 'OPEN' },
    { div: 'Novatas', divCode: 'NOV', nome: 'Novice', code: 'NOVICE' },
    { div: 'Master', divCode: 'MST', nome: 'Master', code: 'MASTER' }
  ]) {
    const divisao = await api().post(`/api/v1/event-categories/${eventCategory.body.id}/divisions`)
      .set(operador.auth()).send({ name: def.div, code: def.divCode });
    const classe = await api().post(`/api/v1/divisions/${divisao.body.id}/classes`)
      .set(operador.auth()).send({ name: def.nome, code: def.code });
    expect(classe.status, JSON.stringify(classe.body)).toBe(201);
    classes[def.code] = classe.body;
  }

  return { event: ev.body, category: cat, classes, operador };
}

// Inscreve, faz check-in, recebe resultado e publica.
async function disputar(ev, classes, operador, colocacoes) {
  await transicionar(operador, ev.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const porAtleta = new Map();
  for (const [code, nomes] of Object.entries(colocacoes)) {
    for (const nome of nomes) {
      if (!porAtleta.has(nome)) porAtleta.set(nome, []);
      porAtleta.get(nome).push(classes[code].id);
    }
  }

  const inscritos = new Map();
  for (const [nome, classIds] of porAtleta) {
    const inscricao = await api().post(`/api/v1/events/${ev.id}/registrations`).set(operador.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.set(nome, {
      athleteId: inscricao.body.registration.athlete.id,
      registrationId: inscricao.body.registration.id
    });
  }

  await transicionar(operador, ev.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const { registrationId } of inscritos.values()) {
    await api().post(`/api/v1/registrations/${registrationId}/checkin`).set(operador.auth()).send({});
  }
  await transicionar(operador, ev.id, ['IN_JUDGING']);

  for (const [code, nomes] of Object.entries(colocacoes)) {
    const recebido = await api().post(`/api/v1/classes/${classes[code].id}/result`).set(operador.auth())
      .send({ entries: nomes.map((nome, i) => ({ athleteId: inscritos.get(nome).athleteId, placing: i + 1 })) });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
  }
  for (const code of Object.keys(colocacoes)) {
    await api().post(`/api/v1/classes/${classes[code].id}/result/publish`).set(operador.auth())
      .send({ note: 'Homologado' });
  }

  return inscritos;
}

const declarar = (ator, eventId, corpo) =>
  api().post(`/api/v1/events/${eventId}/overall`).set(ator.auth()).send(corpo);

const pontosDe = async nome => {
  const atleta = await comoAtor(diretor, tx => tx.athlete.findFirst({ where: { fullName: nome } }));
  return comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { athleteId: atleta.id } }));
};
const somar = (pontos, campo) => pontos.reduce((t, p) => t + p[campo], 0);

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  cpfPorNome = new Map();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretora' });
  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  semPermissao = await criarUsuario({ name: 'Operador de Check-in' });
  contaDeAtleta = await criarUsuario({ name: 'Conta de Atleta' });

  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');
  await vincular(orgId, gerente, 'RANKING_MANAGER');
  await vincular(orgId, semPermissao, 'CHECKIN_OPERATOR');

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;

  const montado = await montarEvento();
  evento = montado.event;
  classeOpen = montado.classes.OPEN;
  classeNovice = montado.classes.NOVICE;
  classeMaster = montado.classes.MASTER;
});

// ------------------------------------------------------------ AUTORIZAÇÃO --

describe('quem pode homologar', () => {
  it('TESTE 1 — operador com ranking.manage homologa', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A', 'ATLETA B'] });

    const resposta = await declarar(gerente, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
  });

  it('TESTE 2 — operador SEM ranking.manage não homologa', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    const resposta = await declarar(semPermissao, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect([403, 404]).toContain(resposta.status);
  });

  it('TESTE 3 — conta de atleta não homologa', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    const resposta = await declarar(contaDeAtleta, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect([401, 403, 404]).toContain(resposta.status);
  });
});

// ------------------------------------------------------- ELEGIBILIDADE -----

describe('só a Open/Absoluta homologa', () => {
  it('TESTE 4 + 9 — atleta sem participação absoluta é recusado', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['OUTRA'], NOVICE: ['SÓ NOVICE'], MASTER: ['SÓ NOVICE'] });

    const resposta = await declarar(diretor, evento.id, { athleteId: inscritos.get('SÓ NOVICE').athleteId });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(422);
    expect(resposta.body.error.code).toBe('OVERALL_REQUIRES_ABSOLUTE_CLASS');
  });

  it('TESTE 5 — atleta da absoluta é aceito', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    const resposta = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);
  });

  it('TESTE 6 — atleta que não disputou ESTE evento é recusado', async () => {
    await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    // Um segundo evento, com outro atleta.
    const outro = await montarEvento({ nome: 'Outra Etapa' });
    const deOutroEvento = await disputar(outro.event, outro.classes, diretor, { OPEN: ['ATLETA DE FORA'] });

    const resposta = await declarar(diretor, evento.id, { athleteId: deOutroEvento.get('ATLETA DE FORA').athleteId });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(422);
    expect(resposta.body.error.code).toBe('OVERALL_REQUIRES_ABSOLUTE_CLASS');
  });

  it('TESTE 8 — atleta inexistente é 404', async () => {
    const resposta = await declarar(diretor, evento.id, { athleteId: 'cmzzzzzzzzzzzzzzzzzzzzzzz' });
    expect(resposta.status).toBe(404);
    expect(resposta.body.error.code).toBe('ATHLETE_NOT_FOUND');
  });
});

// ------------------------------------------------ CATEGORIA E TENANT ------

describe('a categoria precisa ser DESTE evento, e o atleta DESTA casa', () => {
  it('TESTE 19 — categoryId de fora do evento é recusado com erro próprio', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    // Uma categoria do catálogo que NÃO foi incluída neste evento.
    const forasteira = await prisma.category.findFirst({ where: { code: { not: 'BIKINI' } } });

    const resposta = await declarar(diretor, evento.id, {
      athleteId: inscritos.get('ATLETA A').athleteId, categoryId: forasteira.id
    });

    expect(resposta.status, JSON.stringify(resposta.body)).toBe(422);
    // O erro tem de falar da CATEGORIA. Reaproveitar o erro de classe absoluta
    // manda o operador procurar o problema no lugar errado.
    expect(resposta.body.error.code).toBe('CATEGORY_NOT_IN_EVENT');
  });

  it('TESTE 7 + 17 — atleta e evento de OUTRA organização não são alcançáveis', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin de Fora' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: unico('Outra Federação') });
    const diretorDeFora = await criarUsuario({ name: 'Diretor de Fora' });
    await vincular(outraOrg.id, diretorDeFora, 'EVENT_DIRECTOR');
    await vincular(outraOrg.id, diretorDeFora, 'RANKING_MANAGER');

    const deFora = await montarEvento({ org: outraOrg.id, dono: diretorDeFora, nome: 'Etapa de Fora' });
    const inscritosDeFora = await disputar(deFora.event, deFora.classes, diretorDeFora, { OPEN: ['ATLETA DE FORA'] });

    // O diretor DAQUI tentando o evento DE LÁ.
    const cruzado = await declarar(diretor, deFora.event.id, {
      athleteId: inscritosDeFora.get('ATLETA DE FORA').athleteId
    });
    expect([403, 404]).toContain(cruzado.status);

    // E o atleta de lá no evento daqui.
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });
    expect(inscritos.size).toBeGreaterThan(0);

    // RLS esconde o atleta da outra casa deste ator: a resposta é 404, e não
    // uma versão reduzida. É proteção mais forte do que a checagem de
    // organização no serviço — que continua lá, como segunda camada, para o
    // caso de um ator cross-tenant enxergar a linha.
    const misturado = await declarar(diretor, evento.id, {
      athleteId: inscritosDeFora.get('ATLETA DE FORA').athleteId
    });
    expect([404, 422], JSON.stringify(misturado.body)).toContain(misturado.status);
    expect(['ATHLETE_NOT_FOUND', 'ATHLETE_OTHER_ORGANIZATION']).toContain(misturado.body.error.code);
  });
});

// -------------------------------------------- CONFLITO E IDEMPOTÊNCIA -----

describe('um Overall por recorte', () => {
  it('TESTE 11 — repetir a MESMA homologação é idempotente (1x, 2x, 3x)', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A', 'ATLETA B'] });
    const idA = inscritos.get('ATLETA A').athleteId;

    for (let i = 0; i < 3; i += 1) {
      const resposta = await declarar(diretor, evento.id, { athleteId: idA });
      expect([200, 201], `repetição ${i + 1}`).toContain(resposta.status);
    }

    const pontos = await pontosDe('ATLETA A');
    expect(somar(pontos, 'overallBonus'), 'três vezes, ainda +10').toBe(10);

    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.findMany({ where: { eventId: evento.id } }));
    expect(titulos, 'um título, não três').toHaveLength(1);
  });

  it('TESTE 10 — declarar OUTRO atleta no mesmo recorte é 409, não substituição', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A', 'ATLETA B'] });

    const primeiro = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect(primeiro.status).toBe(201);

    const segundo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA B').athleteId });
    expect(segundo.status, JSON.stringify(segundo.body)).toBe(409);
    expect(segundo.body.error.code).toBe('OVERALL_ALREADY_DECLARED');

    // O campeão homologado NÃO mudou, e o outro não ganhou bônus.
    expect(somar(await pontosDe('ATLETA A'), 'overallBonus')).toBe(10);
    expect(somar(await pontosDe('ATLETA B'), 'overallBonus')).toBe(0);
  });

  it('o banco recusa dois títulos gerais no mesmo evento', async () => {
    // A unicidade `(eventId, categoryId)` não protege o recorte NULO: no
    // PostgreSQL dois NULL são distintos. Sem índice parcial, dois títulos do
    // evento inteiro cabem na mesma tabela — e o serviço só enxerga um.
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A', 'ATLETA B'] });

    await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });

    await expect(comoAtor(admin, tx => tx.eventOverallTitle.create({
      data: { eventId: evento.id, athleteId: inscritos.get('ATLETA B').athleteId, categoryId: null }
    }))).rejects.toThrow();
  });
});

// ------------------------------------------------------- EFEITO NO PONTO --

describe('o que a homologação faz — e o que ela não faz', () => {
  it('TESTE 12 + 13 + 14 + 21 — cenário real: 5 + 4 + (3+10) = 22', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      {
        NOVICE: ['ATLETA A'],                        // 1º → 5
        MASTER: ['OUTRA M', 'ATLETA A'],             // 2º → 4
        OPEN: ['OPEN 1', 'OPEN 2', 'ATLETA A']       // 3º → 3
      });

    const antes = await pontosDe('ATLETA A');
    expect(somar(antes, 'points'), 'antes do Overall').toBe(12);

    const declarado = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect(declarado.status, JSON.stringify(declarado.body)).toBe(201);

    const depois = await pontosDe('ATLETA A');
    const porClasse = Object.fromEntries(await Promise.all(depois.map(async ponto => {
      const classe = await comoAtor(diretor, tx => tx.competitionClass.findUnique({ where: { id: ponto.classId } }));
      return [classe.code, ponto];
    })));

    expect(porClasse.NOVICE.points, 'Novice = 5, intocada').toBe(5);
    expect(porClasse.NOVICE.overallBonus).toBe(0);
    expect(porClasse.MASTER.points, 'Master = 4, intocada').toBe(4);
    expect(porClasse.MASTER.overallBonus).toBe(0);

    expect(porClasse.OPEN.placementPoints, 'a colocação NÃO foi alterada').toBe(3);
    expect(porClasse.OPEN.overallBonus).toBe(10);
    expect(porClasse.OPEN.points, '3 + 10').toBe(13);

    expect(somar(depois, 'points'), 'total = 22, nunca 15+14+13').toBe(22);
    expect(somar(depois, 'overallBonus'), '+10 uma única vez').toBe(10);
    expect(depois, 'nenhum ponto extra foi criado').toHaveLength(3);
  });

  it('TESTE 22 — a ordem de processamento não muda o resultado', async () => {
    const ORDENS = [
      { NOVICE: 1, MASTER: 2, OPEN: 3 },
      { OPEN: 1, NOVICE: 2, MASTER: 3 },
      { MASTER: 1, OPEN: 2, NOVICE: 3 }
    ];

    const totais = [];
    for (const ordem of ORDENS) {
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

      const montado = await montarEvento();
      const colocacoes = {};
      for (const code of Object.keys(ordem).sort((a, b) => ordem[a] - ordem[b])) {
        colocacoes[code] = code === 'OPEN'
          ? ['O1', 'O2', 'ATLETA A']
          : (code === 'MASTER' ? ['M1', 'ATLETA A'] : ['ATLETA A']);
      }

      const inscritos = await disputar(montado.event, montado.classes, diretor, colocacoes);
      await declarar(diretor, montado.event.id, { athleteId: inscritos.get('ATLETA A').athleteId });

      const pontos = await pontosDe('ATLETA A');
      totais.push({
        ordem: Object.keys(colocacoes).join('>'),
        colocacao: somar(pontos, 'placementPoints'),
        bonus: somar(pontos, 'overallBonus'),
        total: somar(pontos, 'points')
      });
    }

    for (const r of totais) {
      expect(r.colocacao, r.ordem).toBe(12);
      expect(r.bonus, r.ordem).toBe(10);
      expect(r.total, r.ordem).toBe(22);
    }
  });
});

// --------------------------------------------------------- CANDIDATOS -----

describe('a tela precisa de candidatos e de prévia', () => {
  it('lista SÓ as classes absolutas do evento, com os participantes', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['PRIMEIRA', 'SEGUNDA'], NOVICE: ['NOVATA'] });

    const resposta = await api().get(`/api/v1/events/${evento.id}/overall/candidates`).set(diretor.auth());
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);

    const codigos = resposta.body.items.map(grupo => grupo.competitionClass.code);
    expect(codigos, 'só a absoluta').toEqual(['OPEN']);

    const [grupo] = resposta.body.items;
    expect(grupo.candidates).toHaveLength(2);
    expect(grupo.candidates[0].placing, 'a colocação é fato, não sugestão').toBe(1);
    expect(grupo.candidates[0].athlete.fullName).toBe('PRIMEIRA');
    // A tela NÃO destaca vencedor: o campo que existiria para isso não existe.
    expect(grupo.candidates[0].isOverallChampion ?? false).toBe(false);
    expect(grupo.candidates[0].suggested).toBeUndefined();
    expect(inscritos.size).toBeGreaterThan(0);
  });

  it('os candidatos trazem matrícula e filiação, e NÃO trazem CPF nem contato', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['PRIMEIRA'] });

    const filiacao = await api().post('/api/v1/affiliations').set(diretor.auth())
      .send({ organizationId: orgId, name: 'NPC Mato Grosso', code: unico('NPCMT').toUpperCase() });
    await api().patch(`/api/v1/athletes/${inscritos.get('PRIMEIRA').athleteId}`).set(diretor.auth())
      .send({ affiliationId: filiacao.body.id, affiliationNumber: '88281' });

    const resposta = await api().get(`/api/v1/events/${evento.id}/overall/candidates`).set(diretor.auth());
    const candidato = resposta.body.items[0].candidates[0];

    expect(candidato.affiliationNumber).toBe('88281');
    expect(candidato.affiliation.name).toBe('NPC Mato Grosso');

    const corpo = JSON.stringify(resposta.body);
    expect(corpo).not.toContain(cpfDe('PRIMEIRA'));
    expect(corpo.toLowerCase()).not.toContain('"cpf"');
    expect(corpo.toLowerCase()).not.toContain('phone');
  });

  it('nem o SUPER_ADMIN homologa atleta de outra casa neste evento', async () => {
    // O caso que a RLS não cobre: um ator cross-tenant ENXERGA o atleta da
    // outra federação, então a checagem de organização no serviço é a única
    // barreira que resta. Sem este teste, remover essa checagem passava
    // despercebido — a suíte só exercitava atores que a RLS já barrava.
    await vincular(orgId, admin, 'RANKING_MANAGER');

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin de Fora' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: unico('Outra') });
    const diretorDeFora = await criarUsuario({ name: 'Diretor de Fora' });
    await vincular(outraOrg.id, diretorDeFora, 'EVENT_DIRECTOR');
    await vincular(outraOrg.id, diretorDeFora, 'RANKING_MANAGER');

    const deFora = await montarEvento({ org: outraOrg.id, dono: diretorDeFora, nome: 'Etapa de Fora' });
    const inscritosDeFora = await disputar(deFora.event, deFora.classes, diretorDeFora, { OPEN: ['ATLETA DE FORA'] });

    await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });

    const resposta = await declarar(admin, evento.id, {
      athleteId: inscritosDeFora.get('ATLETA DE FORA').athleteId
    });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(422);
    expect(resposta.body.error.code).toBe('ATHLETE_OTHER_ORGANIZATION');
  });

  it('operador de outra organização não lista candidatos daqui', async () => {
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin de Fora' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: unico('Outra') });
    const deFora = await criarUsuario({ name: 'Diretor de Fora' });
    await vincular(outraOrg.id, deFora, 'RANKING_MANAGER');

    const resposta = await api().get(`/api/v1/events/${evento.id}/overall/candidates`).set(deFora.auth());
    expect([403, 404]).toContain(resposta.status);
  });

  it('TESTE 17 (preview) — a prévia mostra o impacto SEM gravar nada', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { NOVICE: ['ATLETA A'], OPEN: ['O1', 'O2', 'ATLETA A'] });
    const idA = inscritos.get('ATLETA A').athleteId;

    const previa = await api().get(`/api/v1/events/${evento.id}/overall/preview`)
      .set(diretor.auth()).query({ athleteId: idA });
    expect(previa.status, JSON.stringify(previa.body)).toBe(200);

    expect(previa.body.athlete.id).toBe(idA);
    expect(previa.body.participation.placing).toBe(3);
    expect(previa.body.participation.placementPoints).toBe(3);
    expect(previa.body.overallBonus).toBe(10);
    expect(previa.body.participation.pointsAfter, '3 + 10').toBe(13);
    expect(previa.body.seasonImpact, 'o acumulado sobe 10').toBe(10);

    // E NADA foi gravado.
    const titulos = await comoAtor(diretor, tx => tx.eventOverallTitle.count({ where: { eventId: evento.id } }));
    expect(titulos, 'prévia não grava').toBe(0);
    expect(somar(await pontosDe('ATLETA A'), 'overallBonus')).toBe(0);
  });
});

// --------------------------------------------------------- REVOGAÇÃO ------

describe('correção: revogar é operação própria, e auditada', () => {
  it('TESTE 15 — revogar exige permissão', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });
    const titulo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });

    const semDireito = await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(semPermissao.auth()).send({ reason: 'tentativa indevida' });
    expect([403, 404]).toContain(semDireito.status);
  });

  it('revogar remove o bônus e preserva a colocação', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { NOVICE: ['ATLETA A'], OPEN: ['O1', 'O2', 'ATLETA A'] });
    const titulo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    expect(somar(await pontosDe('ATLETA A'), 'points')).toBe(18);

    const revogado = await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(diretor.auth()).send({ reason: 'Ata oficial corrigida pela organização' });
    expect(revogado.status, JSON.stringify(revogado.body)).toBe(200);

    const pontos = await pontosDe('ATLETA A');
    expect(somar(pontos, 'overallBonus'), 'o bônus saiu').toBe(0);
    expect(somar(pontos, 'placementPoints'), 'a colocação ficou').toBe(8);
    expect(somar(pontos, 'points')).toBe(8);
  });

  it('revogar exige motivo', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });
    const titulo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });

    const semMotivo = await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(diretor.auth()).send({});
    expect(semMotivo.status).toBe(400);
  });

  it('depois de revogar, o recorte aceita um novo campeão', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A', 'ATLETA B'] });
    const titulo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA A').athleteId });
    await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(diretor.auth()).send({ reason: 'Correção de ata' });

    const novo = await declarar(diretor, evento.id, { athleteId: inscritos.get('ATLETA B').athleteId });
    expect(novo.status, JSON.stringify(novo.body)).toBe(201);

    expect(somar(await pontosDe('ATLETA A'), 'overallBonus')).toBe(0);
    expect(somar(await pontosDe('ATLETA B'), 'overallBonus')).toBe(10);
  });
});

// ---------------------------------------------------------- AUDITORIA -----

describe('TESTE 16 — auditoria de toda alteração relevante', () => {
  it('declarar e revogar deixam rastro, sem dado pessoal', async () => {
    const inscritos = await disputar(evento, { OPEN: classeOpen, NOVICE: classeNovice, MASTER: classeMaster }, diretor,
      { OPEN: ['ATLETA A'] });
    const idA = inscritos.get('ATLETA A').athleteId;

    const titulo = await declarar(diretor, evento.id, { athleteId: idA });
    await api().delete(`/api/v1/events/${evento.id}/overall/${titulo.body.id}`)
      .set(diretor.auth()).send({ reason: 'Ata corrigida' });

    const trilha = await comoAtor(admin, tx => tx.auditLog.findMany({
      where: { action: { in: ['OVERALL_DECLARE', 'OVERALL_REVOKE'] } },
      orderBy: { createdAt: 'asc' }
    }));

    expect(trilha.map(l => l.action)).toEqual(['OVERALL_DECLARE', 'OVERALL_REVOKE']);

    const revogacao = trilha[1];
    expect(revogacao.metadata.athleteId).toBe(idA);
    expect(revogacao.metadata.reason).toBe('Ata corrigida');
    expect(revogacao.userId).toBe(diretor.id);

    const corpo = JSON.stringify(trilha);
    expect(corpo).not.toContain(cpfDe('ATLETA A'));
  });
});
