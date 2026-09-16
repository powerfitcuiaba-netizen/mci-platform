import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 9 — MINHA FILIAÇÃO E MEU HISTÓRICO.
//
// O atleta precisa ver a própria filiação e a própria carreira. Hoje não vê:
// `GET /athletes/:id/ranking-points` exige `ranking.read` COM VÍNCULO na
// organização, e atleta não é membro da federação — membership é para
// operadores. A rota responde 403/404 para o dono dos próprios pontos.
//
// A correção NÃO é afrouxar aquela rota. É criar superfície onde o atleta
// vem do TOKEN e não da URL:
//
//   GET /me/affiliation
//   GET /me/history
//
// Sem id no caminho não existe IDOR a testar — não há o que manipular. Os
// testes abaixo provam isso pelo negativo: as rotas que TÊM id continuam
// recusando o atleta de fora, e nenhum parâmetro de cliente troca a identidade
// de quem responde.
//
// O outro gate desta fase é a IMUTABILIDADE HISTÓRICA: trocar de federação não
// pode reescrever o passado. Ele já foi implementado na gravação do ponto; aqui
// ele é provado ponta a ponta, pela leitura que o atleta faz.
// ============================================================================

let admin, diretor, orgId, seasonId, fedA, fedB;
let contaDoAtleta, contaDoOutro;

const cpfSeq = (() => { let n = 330000000; return () => gerarCpf(n += 7919); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

// Uma etapa com as classes pedidas, e as colocações informadas por classe.
async function etapa({ nome = 'Etapa', classes, colocacoes, overall = null }) {
  const evento = await api().post('/api/v1/events').set(diretor.auth()).send({
    organizationId: orgId, name: nome, slug: unico('ev'),
    startDate: '2026-11-20T12:00:00.000Z', seasonId
  });
  expect(evento.status, JSON.stringify(evento.body)).toBe(201);

  const categoria = await prisma.category.findUnique({ where: { code: 'BIKINI' } });
  const eventCategory = await api().post(`/api/v1/events/${evento.body.id}/categories`)
    .set(diretor.auth()).send({ categoryId: categoria.id });

  const montadas = [];
  for (const definicao of classes) {
    const division = await api().post(`/api/v1/event-categories/${eventCategory.body.id}/divisions`)
      .set(diretor.auth()).send({ name: definicao.division, code: definicao.divisionCode });
    const classe = await api().post(`/api/v1/divisions/${division.body.id}/classes`)
      .set(diretor.auth()).send({ name: definicao.name, code: definicao.code });
    expect(classe.status, JSON.stringify(classe.body)).toBe(201);
    montadas.push({ ...definicao, id: classe.body.id });
  }

  await transicionar(diretor, evento.body.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const classesPorAtleta = new Map();
  for (const classe of montadas) {
    for (const quem of colocacoes[classe.code] ?? []) {
      if (!classesPorAtleta.has(quem)) classesPorAtleta.set(quem, []);
      classesPorAtleta.get(quem).push(classe.id);
    }
  }

  const inscritos = new Map();
  for (const [quem, classIds] of classesPorAtleta) {
    const inscricao = await api().post(`/api/v1/events/${evento.body.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(quem), athlete: { fullName: quem, sex: 'FEMALE' }, classIds });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.set(quem, {
      athleteId: inscricao.body.registration.athlete.id,
      registrationId: inscricao.body.registration.id
    });
  }

  await transicionar(diretor, evento.body.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const { registrationId } of inscritos.values()) {
    await api().post(`/api/v1/registrations/${registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, evento.body.id, ['IN_JUDGING']);

  for (const classe of montadas) {
    const nomes = colocacoes[classe.code] ?? [];
    if (!nomes.length) continue;
    const recebido = await api().post(`/api/v1/classes/${classe.id}/result`).set(diretor.auth())
      .send({ entries: nomes.map((quem, i) => ({ athleteId: inscritos.get(quem).athleteId, placing: i + 1 })) });
    expect(recebido.status, JSON.stringify(recebido.body)).toBe(200);
  }

  if (overall) {
    const declarado = await api().post(`/api/v1/events/${evento.body.id}/overall`).set(diretor.auth())
      .send({ athleteId: inscritos.get(overall).athleteId });
    expect(declarado.status, JSON.stringify(declarado.body)).toBe(201);
  }

  for (const classe of montadas) {
    if (!(colocacoes[classe.code] ?? []).length) continue;
    await api().post(`/api/v1/classes/${classe.id}/result/publish`).set(diretor.auth()).send({ note: 'Homologado' });
  }

  return { event: evento.body, classes: montadas, inscritos };
}

const filiar = (athleteId, filiacao, matricula) =>
  api().patch(`/api/v1/athletes/${athleteId}`).set(diretor.auth())
    .send({ affiliationId: filiacao.id, affiliationNumber: matricula });

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

  fedA = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: orgId, name: 'NPC Mato Grosso', code: 'NPC-MT' })).body;
  fedB = (await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId: orgId, name: 'NPC São Paulo', code: 'NPC-SP' })).body;

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;

  contaDoAtleta = await criarUsuario({ name: 'Conta da Atleta' });
  contaDoOutro = await criarUsuario({ name: 'Conta do Outro' });
});

// Liga a conta de usuário ao perfil de atleta criado pela inscrição.
async function ligarConta(athleteId, conta) {
  const resposta = await api().patch(`/api/v1/athletes/${athleteId}`).set(diretor.auth())
    .send({ userId: conta.id });
  expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
}

// ------------------------------------------------------- MINHA FILIAÇÃO ----

describe('MINHA FILIAÇÃO — derivada do token, nunca do cliente', () => {
  it('o atleta vê a própria entidade, matrícula e organização', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await filiar(id, fedA, '88281');
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/affiliation').set(contaDoAtleta.auth());
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);

    expect(resposta.body.affiliation.name).toBe('NPC Mato Grosso');
    expect(resposta.body.affiliation.code).toBe('NPC-MT');
    expect(resposta.body.affiliationNumber).toBe('88281');
    expect(resposta.body.organization.id).toBe(orgId);
    expect(resposta.body.athlete.id).toBe(id);
  });

  it('nenhum parâmetro do cliente troca de quem é a filiação devolvida', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA', 'ATLETA OUTRA'] }
    });
    const meu = inscritos.get('ATLETA DONA').athleteId;
    const alheio = inscritos.get('ATLETA OUTRA').athleteId;
    await filiar(meu, fedA, '88281');
    await filiar(alheio, fedB, '99999');
    await ligarConta(meu, contaDoAtleta);

    // Toda manipulação que um cliente poderia tentar, de uma vez.
    const resposta = await api().get('/api/v1/me/affiliation').set(contaDoAtleta.auth())
      .query({ athleteId: alheio, organizationId: orgId, affiliationId: fedB.id, affiliationNumber: '99999' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete.id, 'continua sendo o dono do token').toBe(meu);
    expect(resposta.body.affiliationNumber).toBe('88281');
    expect(JSON.stringify(resposta.body)).not.toContain('99999');
  });

  it('usuário sem perfil de atleta recebe resposta explícita, não erro', async () => {
    const resposta = await api().get('/api/v1/me/affiliation').set(contaDoAtleta.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.athlete).toBeNull();
    expect(resposta.body.affiliation).toBeNull();
  });

  it('sem token não há filiação nenhuma', async () => {
    const resposta = await api().get('/api/v1/me/affiliation');
    expect(resposta.status).toBe(401);
  });

  it('o atleta NÃO troca a própria filiação por PATCH', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await filiar(id, fedA, '88281');
    await ligarConta(id, contaDoAtleta);

    const tentativa = await api().patch(`/api/v1/athletes/${id}`).set(contaDoAtleta.auth())
      .send({ affiliationId: fedB.id, affiliationNumber: '99999' });
    expect([200, 403]).toContain(tentativa.status);

    const depois = await comoAtor(diretor, tx => tx.athlete.findUnique({ where: { id } }));
    expect(depois.affiliationId, 'a filiação não mudou').toBe(fedA.id);
    expect(depois.affiliationNumber).toBe('88281');
  });
});

// -------------------------------------------------------- MEU HISTÓRICO ----

describe('MEU HISTÓRICO — a carreira inteira, do próprio dono', () => {
  it('três participações no mesmo campeonato aparecem as três', async () => {
    const { inscritos } = await etapa({
      nome: 'Etapa Multicategoria',
      classes: [
        { division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' },
        { division: 'Novatas', divisionCode: 'NOV', name: 'Novice', code: 'NOVICE' },
        { division: 'Master', divisionCode: 'MST', name: 'Master', code: 'MASTER' }
      ],
      colocacoes: {
        OPEN: ['ATLETA DONA', 'R1'],
        NOVICE: ['R2', 'ATLETA DONA'],
        MASTER: ['ATLETA DONA', 'R3']
      }
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await filiar(id, fedA, '88281');
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth());
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);

    expect(resposta.body.items, 'uma linha por participação').toHaveLength(3);
    expect(resposta.body.totals.placementPoints).toBe(14);
    expect(resposta.body.totals.overallBonus).toBe(0);
    expect(resposta.body.totals.points).toBe(14);
  });

  it('cada linha traz campeonato, classe, colocação e as parcelas separadas', async () => {
    const { inscritos } = await etapa({
      nome: 'Etapa Explicada',
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA', 'R1'] },
      overall: 'ATLETA DONA'
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await filiar(id, fedA, '88281');
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth());
    const [linha] = resposta.body.items;

    expect(linha.event.name).toBe('Etapa Explicada');
    expect(linha.competitionClass.code).toBe('OPEN');
    expect(linha.placing).toBe(1);
    expect(linha.placementPoints, 'a colocação vale 5, e não 15').toBe(5);
    expect(linha.overallBonus).toBe(10);
    expect(linha.points).toBe(15);
    expect(linha.isOverallChampion).toBe(true);
  });

  it('o Overall aparece SÓ na participação absoluta, e uma vez só', async () => {
    const { inscritos } = await etapa({
      classes: [
        { division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' },
        { division: 'Novatas', divisionCode: 'NOV', name: 'Novice', code: 'NOVICE' }
      ],
      colocacoes: { OPEN: ['ATLETA DONA'], NOVICE: ['ATLETA DONA'] },
      overall: 'ATLETA DONA'
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth());
    const porClasse = Object.fromEntries(resposta.body.items.map(l => [l.competitionClass.code, l]));

    expect(porClasse.OPEN.overallBonus).toBe(10);
    expect(porClasse.NOVICE.overallBonus, 'Novice não recebe bônus').toBe(0);
    expect(porClasse.NOVICE.isOverallChampion).toBe(false);
    expect(resposta.body.totals.overallBonus, '+10 uma única vez').toBe(10);
  });

  it('o TOP 5 público NÃO corta o histórico individual', async () => {
    // Sete participações: mais do que o teto público.
    const classes = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'].map((code, i) => ({
      division: `Div ${i}`, divisionCode: `D${i}`, name: 'Open', code
    }));
    const colocacoes = Object.fromEntries(classes.map(c => [c.code, ['ATLETA DONA', `R${c.code}`]]));

    const { inscritos } = await etapa({ nome: 'Etapa Longa', classes, colocacoes });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth()).query({ limit: 50 });
    expect(resposta.body.items, 'as sete, não cinco').toHaveLength(7);
    expect(resposta.body.publicView, 'histórico não é vista pública').toBeUndefined();
  });

  it('o histórico pagina, e o total é do conjunto e não da página', async () => {
    const classes = ['C1', 'C2', 'C3', 'C4', 'C5'].map((code, i) => ({
      division: `Div ${i}`, divisionCode: `D${i}`, name: 'Open', code
    }));
    const colocacoes = Object.fromEntries(classes.map(c => [c.code, ['ATLETA DONA']]));

    const { inscritos } = await etapa({ classes, colocacoes });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await ligarConta(id, contaDoAtleta);

    const primeira = await api().get('/api/v1/me/history').set(contaDoAtleta.auth()).query({ limit: 2 });
    expect(primeira.body.items).toHaveLength(2);
    expect(primeira.body.total, 'o total é das cinco').toBe(5);
    expect(primeira.body.nextCursor).toBeTruthy();

    // Os totais são do CONJUNTO, não da página. Uma página de duas linhas que
    // reportasse o total de duas seria o mesmo defeito que a paginação da
    // FASE 2.4 corrigiu na operação: tamanho de página disfarçado de tamanho
    // do conjunto.
    expect(primeira.body.totals.participations, 'totais são das cinco').toBe(5);
    expect(primeira.body.totals.placementPoints).toBe(25);
    expect(primeira.body.totals.points).toBe(25);

    const paginaDeUma = await api().get('/api/v1/me/history').set(contaDoAtleta.auth()).query({ limit: 1 });
    expect(paginaDeUma.body.items).toHaveLength(1);
    expect(paginaDeUma.body.totals.points, 'uma linha na página, cinco no total').toBe(25);
    expect(paginaDeUma.body.totals.participations).toBe(5);

    const segunda = await api().get('/api/v1/me/history').set(contaDoAtleta.auth())
      .query({ limit: 2, cursor: primeira.body.nextCursor });
    expect(segunda.body.items).toHaveLength(2);
    const ids = new Set([...primeira.body.items, ...segunda.body.items].map(l => l.id));
    expect(ids.size, 'páginas não repetem linha').toBe(4);
  });

  it('o histórico NÃO carrega CPF nem contato', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });
    const id = inscritos.get('ATLETA DONA').athleteId;
    await ligarConta(id, contaDoAtleta);

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth());
    const corpo = JSON.stringify(resposta.body);
    expect(corpo).not.toContain(cpfDe('ATLETA DONA'));
    expect(corpo.toLowerCase()).not.toContain('"cpf"');
    expect(corpo.toLowerCase()).not.toContain('phone');
  });
});

// ------------------------------------- IMUTABILIDADE HISTÓRICA (GATE) ------

describe('ATHLETE CHANGES AFFILIATION — HISTORICAL IMMUTABILITY', () => {
  it('trocar de federação não reescreve o resultado antigo', async () => {
    // ANO 1 — Federação A, matrícula X.
    const ano1 = await etapa({
      nome: 'Etapa Ano 1',
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA MIGRANTE', 'R1'] }
    });
    const id = ano1.inscritos.get('ATLETA MIGRANTE').athleteId;

    // A filiação entra ANTES da publicação do ano 2, como na vida real.
    await filiar(id, fedA, 'X-88281');
    await ligarConta(id, contaDoAtleta);

    // Repontuar o ano 1 para que ele carregue a filiação vigente à época.
    const ano1b = await etapa({
      nome: 'Etapa Ano 1 — segunda',
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA MIGRANTE'] }
    });
    expect(ano1b.inscritos.get('ATLETA MIGRANTE').athleteId).toBe(id);

    // ANO 2 — a TROCA, e um resultado novo.
    await filiar(id, fedB, 'Y-99999');
    await etapa({
      nome: 'Etapa Ano 2',
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA MIGRANTE'] }
    });

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth()).query({ limit: 50 });
    const porEvento = Object.fromEntries(resposta.body.items.map(l => [l.event.name, l]));

    expect(porEvento['Etapa Ano 1 — segunda'].affiliation.name, 'o passado é da A').toBe('NPC Mato Grosso');
    expect(porEvento['Etapa Ano 1 — segunda'].affiliationNumber).toBe('X-88281');

    expect(porEvento['Etapa Ano 2'].affiliation.name, 'o presente é da B').toBe('NPC São Paulo');
    expect(porEvento['Etapa Ano 2'].affiliationNumber).toBe('Y-99999');

    // E a filiação ATUAL do cadastro é a B — sem ter contaminado o histórico.
    const minha = await api().get('/api/v1/me/affiliation').set(contaDoAtleta.auth());
    expect(minha.body.affiliation.name).toBe('NPC São Paulo');
    expect(minha.body.affiliationNumber).toBe('Y-99999');
  });

  it('ponto antigo sem snapshot mostra filiação NULA, e não a de hoje', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA SEM SNAPSHOT'] }
    });
    const id = inscritos.get('ATLETA SEM SNAPSHOT').athleteId;
    await ligarConta(id, contaDoAtleta);

    // Filia DEPOIS de o ponto existir: o ponto nasceu sem filiação, e isso é a
    // verdade sobre ele. Preenchê-lo com a filiação de hoje seria inventar
    // passado.
    await filiar(id, fedA, '88281');

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth());
    const [linha] = resposta.body.items;

    expect(linha.affiliation, 'snapshot indisponível é NULO').toBeNull();
    expect(linha.affiliationNumber).toBeNull();
  });
});

// --------------------------------------------------- IDOR E MULTI-TENANT ---

describe('IDOR e isolamento: o histórico é de quem o pede', () => {
  it('atleta não lê os pontos de outro atleta pela rota com id', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA', 'ATLETA ALHEIA'] }
    });
    const meu = inscritos.get('ATLETA DONA').athleteId;
    const alheio = inscritos.get('ATLETA ALHEIA').athleteId;
    await ligarConta(meu, contaDoAtleta);

    const tentativa = await api().get(`/api/v1/athletes/${alheio}/ranking-points`)
      .set(contaDoAtleta.auth()).query({ seasonId });
    expect([403, 404]).toContain(tentativa.status);
  });

  it('atleta de outra organização não alcança nada daqui', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });
    const meu = inscritos.get('ATLETA DONA').athleteId;
    await ligarConta(meu, contaDoAtleta);

    // Outra federação, outro diretor, outro atleta.
    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin de Fora' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: unico('Outra Federação') });
    const diretorDeFora = await criarUsuario({ name: 'Diretor de Fora' });
    await vincular(outraOrg.id, diretorDeFora, 'EVENT_DIRECTOR');

    for (const rota of [
      `/api/v1/athletes/${meu}/ranking-points`,
      `/api/v1/athletes/${meu}`
    ]) {
      const tentativa = await api().get(rota).set(diretorDeFora.auth());
      expect([403, 404], `${rota} devia recusar`).toContain(tentativa.status);
    }
  });

  it('organizationId no cliente não atravessa tenant no meu histórico', async () => {
    const { inscritos } = await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });
    await ligarConta(inscritos.get('ATLETA DONA').athleteId, contaDoAtleta);

    const outroAdmin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin de Fora' });
    const outraOrg = await criarOrganizacao(outroAdmin, { name: unico('Outra Federação') });

    const resposta = await api().get('/api/v1/me/history').set(contaDoAtleta.auth())
      .query({ organizationId: outraOrg.id, athleteId: 'qualquer-coisa' });

    expect(resposta.status).toBe(200);
    expect(resposta.body.items, 'continua devolvendo o histórico do dono').toHaveLength(1);
  });

  it('conta sem perfil de atleta recebe histórico vazio, não o de outro', async () => {
    await etapa({
      classes: [{ division: 'Absoluta', divisionCode: 'ABS', name: 'Open', code: 'OPEN' }],
      colocacoes: { OPEN: ['ATLETA DONA'] }
    });

    const resposta = await api().get('/api/v1/me/history').set(contaDoOutro.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toHaveLength(0);
    expect(resposta.body.total).toBe(0);
  });

  it('sem token, nada', async () => {
    const resposta = await api().get('/api/v1/me/history');
    expect(resposta.status).toBe(401);
  });
});
