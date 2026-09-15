import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// RANKING PÚBLICO: TOP 5. LEDGER, ADMINISTRATIVO E HISTÓRICO: COMPLETOS.
//
// Decisão homologada pelo responsável. A superfície PÚBLICA do ranking mostra
// os cinco primeiros — e não a tabela inteira.
//
// O risco da regra não é implementá-la: é implementá-la cortando o que não
// devia. Este arquivo existe tanto para provar o corte quanto para provar que
// ele NÃO alcança:
//
//   * o ledger interno (RankingPoint);
//   * o ranking administrativo de quem tem `ranking.read` na organização;
//   * o histórico individual do atleta;
//   * os filtros e a paginação do operador.
//
// E o corte tem de ser DECLARADO na resposta. Uma lista truncada em silêncio é
// pior que uma lista curta: quem consome não tem como saber que está vendo
// parte, e um `nextCursor` apontando para uma página que a regra não entrega
// convidaria a pedir o que não existe.
// ============================================================================

let admin, diretor, gerenteDeRanking, deFora, orgId, seasonId;

const cpfSeq = (() => { let n = 640000000; return () => gerarCpf(n += 5171); })();

// Mesmo nome, mesmo CPF, mesmo atleta em todas as etapas — é o que faz a
// pontuação acumular ao longo da temporada em vez de criar cadastro novo.
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

const atletaPorNome = new Map();

// Uma etapa com as colocadas informadas, na ordem: 1º, 2º, 3º…
async function etapa(colocadas) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  const { event, competitionClass } = montado;
  await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscritos = [];
  for (const nome of colocadas) {
    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    const athleteId = inscricao.body.registration.athlete.id;
    atletaPorNome.set(nome, athleteId);
    inscritos.push({ nome, registrationId: inscricao.body.registration.id, athleteId });
  }

  await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const inscrito of inscritos) {
    await api().post(`/api/v1/registrations/${inscrito.registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, event.id, ['IN_JUDGING']);

  await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: inscritos.map((item, i) => ({ athleteId: item.athleteId, placing: i + 1 })) });
  const publicado = await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });
  expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);

  return { ...montado, inscritos };
}

// OITO atletas com pontuação, e totais DISTINTOS no topo.
//
// Um único evento não serve para provar o corte: da 6ª colocação em diante a
// tabela dá zero, zero não gera linha, e a tabela teria exatamente cinco
// pontuadores — o teste passaria por acidente, sem nada ter sido cortado.
// Foi assim que a primeira versão deste arquivo passou antes de o corte
// existir. Três etapas resolvem: oito atletas com ponto, cinco à frente.
//
//   A1 = 5+5+5 = 15   A2 = 4+4+4 = 12   A3 = 3+3 = 6   A4 = 2+3 = 5
//   A5 = 1+2 = 3      A6 = 2            A7 = 1         A8 = 1
async function temporadaComOitoPontuadoras() {
  const primeira = await etapa(['A1', 'A2', 'A3', 'A4', 'A5']);
  await etapa(['A1', 'A2', 'A3', 'A6', 'A7']);
  await etapa(['A1', 'A2', 'A4', 'A5', 'A8']);
  return primeira;
}

const TOP_5 = ['A1', 'A2', 'A3', 'A4', 'A5'];

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();
  cpfPorNome = new Map();
  atletaPorNome.clear();
  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  diretor = await criarUsuario({ name: 'Diretora' });
  const org = await criarOrganizacao(admin, { name: unico('Federação') });
  orgId = org.id;
  await vincular(orgId, diretor, 'EVENT_DIRECTOR');
  await vincular(orgId, diretor, 'RANKING_MANAGER');

  gerenteDeRanking = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(orgId, gerenteDeRanking, 'RANKING_MANAGER');

  // Autenticado, mas SEM vínculo com esta organização: para a regra ele é
  // público. Privilégio vem do vínculo, nunca do fato de estar logado.
  deFora = await criarUsuario({ name: 'Atleta de Fora' });

  const temporada = await api().post('/api/v1/seasons').set(diretor.auth())
    .send({ organizationId: orgId, name: unico('Temporada'), year: 2026 });
  seasonId = temporada.body.id;
});

describe('a superfície pública entrega cinco, e diz que são cinco', () => {
  it('visitante anônimo recebe no máximo 5 linhas, mesmo pedindo 100', async () => {
    await temporadaComOitoPontuadoras();

    const publico = await api().get('/api/v1/ranking').query({ seasonId, limit: 100 });
    expect(publico.status, JSON.stringify(publico.body)).toBe(200);

    expect(publico.body.items.length).toBeLessThanOrEqual(5);
    expect(publico.body.items).toHaveLength(5);
    expect(publico.body.items.map(l => l.athlete.fullName)).toEqual(TOP_5);
  });

  it('o corte é DECLARADO — e não há cursor apontando para o que não vem', async () => {
    await temporadaComOitoPontuadoras();

    const publico = await api().get('/api/v1/ranking').query({ seasonId, limit: 100 });
    expect(publico.body.publicView, 'a resposta diz que é a vista pública').toBe(true);
    expect(publico.body.publicLimit).toBe(5);
    expect(publico.body.nextCursor, 'nada a paginar na vista pública').toBeNull();
  });

  it('pedir exatamente 5 também não devolve cursor', async () => {
    // O caso que o `limit: 100` esconde: com 5 pedidos e 5 entregues, a
    // condição "veio página cheia, logo há mais" fica verdadeira por acidente,
    // e a vista pública passaria a oferecer uma página que ela não entrega.
    await temporadaComOitoPontuadoras();

    const publico = await api().get('/api/v1/ranking').query({ seasonId, limit: 5 });
    expect(publico.body.items).toHaveLength(5);
    expect(publico.body.nextCursor, 'a vista pública não pagina, nem quando a página enche').toBeNull();
  });

  it('autenticado SEM vínculo com a organização também é público', async () => {
    await temporadaComOitoPontuadoras();

    const resposta = await api().get('/api/v1/ranking').set(deFora.auth()).query({ seasonId, limit: 100 });
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toHaveLength(5);
    expect(resposta.body.publicView).toBe(true);
  });

  it('o Super Overall público também para em 5', async () => {
    await temporadaComOitoPontuadoras();

    const anual = await api().get('/api/v1/ranking/super-overall').query({ seasonId, limit: 100 });
    expect(anual.status, JSON.stringify(anual.body)).toBe(200);
    const linhas = anual.body.items ?? anual.body;
    expect(linhas.length).toBeLessThanOrEqual(5);
  });

  it('os recortes públicos por classe e por evento param em 5', async () => {
    const { competitionClass, event } = await temporadaComOitoPontuadoras();

    for (const recorte of [{ classId: competitionClass.id }, { eventId: event.id }]) {
      const resposta = await api().get('/api/v1/ranking/by').query({ seasonId, limit: 100, ...recorte });
      expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
      const linhas = resposta.body.items ?? resposta.body;
      expect(linhas.length, JSON.stringify(recorte)).toBeLessThanOrEqual(5);
    }
  });
});

describe('as listas sem envelope declaram o corte no cabeçalho', () => {
  it('Super Overall público traz X-MCI-Public-View; o do operador não', async () => {
    await temporadaComOitoPontuadoras();

    const anonimo = await api().get('/api/v1/ranking/super-overall').query({ seasonId, limit: 100 });
    expect(anonimo.headers['x-mci-public-view'], 'o corte é declarado').toBe('top-5');

    const operador = await api().get('/api/v1/ranking/super-overall').set(diretor.auth())
      .query({ seasonId, limit: 100 });
    expect(operador.headers['x-mci-public-view'], 'sem corte, sem cabeçalho').toBeUndefined();
    const linhas = operador.body.items ?? operador.body;
    expect(linhas.length, 'o operador vê as oito').toBe(8);
  });

  it('lista com cinco linhas de FATO não é rotulada como cortada', async () => {
    // Deduzir o corte pelo tamanho da lista rotularia esta resposta como
    // pública. A marca vem do serviço, não da contagem.
    await etapa(['B1', 'B2', 'B3', 'B4', 'B5']);

    const operador = await api().get('/api/v1/ranking/super-overall').set(diretor.auth())
      .query({ seasonId, limit: 100 });
    const linhas = operador.body.items ?? operador.body;
    expect(linhas).toHaveLength(5);
    expect(operador.headers['x-mci-public-view']).toBeUndefined();
  });
});

describe('o corte NÃO alcança quem opera o ranking', () => {
  it('o gerente de ranking vê a tabela inteira', async () => {
    await temporadaComOitoPontuadoras();

    const admin5 = await api().get('/api/v1/ranking').set(gerenteDeRanking.auth())
      .query({ seasonId, limit: 100 });
    expect(admin5.status, JSON.stringify(admin5.body)).toBe(200);

    // Oito atletas pontuaram? Não: da 6ª em diante vale zero, e zero não gera
    // linha. Mas as cinco que pontuaram têm de vir TODAS, e a resposta não
    // pode se declarar pública.
    expect(admin5.body.publicView).toBe(false);
    expect(admin5.body.items.length, 'as OITO pontuadoras, não cinco').toBe(8);
    expect(admin5.body.items.map(l => l.athlete.fullName).slice(0, 5)).toEqual(TOP_5);
  });

  it('a paginação do operador continua funcionando', async () => {
    await temporadaComOitoPontuadoras();

    const primeira = await api().get('/api/v1/ranking').set(diretor.auth()).query({ seasonId, limit: 2 });
    expect(primeira.body.items).toHaveLength(2);
    expect(primeira.body.nextCursor, 'o operador pagina').toBeTruthy();

    const segunda = await api().get('/api/v1/ranking').set(diretor.auth())
      .query({ seasonId, limit: 2, cursor: primeira.body.nextCursor });
    expect(segunda.body.items).toHaveLength(2);
    expect(segunda.body.items.map(l => l.athlete.fullName)).toEqual(['A3', 'A4']);
  });

  it('o filtro por categoria continua valendo para o operador', async () => {
    const { category } = await temporadaComOitoPontuadoras();

    const filtrado = await api().get('/api/v1/ranking').set(diretor.auth())
      .query({ seasonId, categoryId: category.id, limit: 100 });
    expect(filtrado.status).toBe(200);
    expect(filtrado.body.items.length, 'o filtro não corta em 5 para o operador').toBe(8);
  });
});

describe('o corte NÃO alcança o ledger nem o histórico', () => {
  it('o ledger interno continua com todas as linhas', async () => {
    await temporadaComOitoPontuadoras();

    // Três etapas com cinco colocadas cada = 15 lançamentos, e oito atletas.
    const pontos = await comoAtor(diretor, tx => tx.rankingPoint.findMany({ where: { seasonId } }));
    expect(pontos.length, 'o ledger não é cortado').toBe(15);

    const agregados = await comoAtor(diretor, tx => tx.ranking.findMany({ where: { seasonId } }));
    expect(agregados.length, 'o agregado tem as oito').toBe(8);
  });

  it('o histórico individual do atleta vem inteiro para quem pode lê-lo', async () => {
    const { inscritos } = await temporadaComOitoPontuadoras();
    const historico = await api().get(`/api/v1/athletes/${atletaPorNome.get('A1')}/ranking-points`)
      .set(diretor.auth()).query({ seasonId });
    expect(historico.status, JSON.stringify(historico.body)).toBe(200);
    expect(historico.body.items, 'as três participações').toHaveLength(3);
    expect(historico.body.items.reduce((t, p) => t + p.points, 0)).toBe(15);
  });
});

describe('empates: o corte não inventa ordem', () => {
  it('empatados continuam sem colocação na vista pública', async () => {
    // Empate REAL e construído pela via oficial: duas atletas vencem etapas
    // diferentes. Mesmo total, mesmos contadores — a hierarquia oficial não as
    // separa, e a regra manda deixar as duas sem colocação.
    await etapa(['EMPATADA A', 'TERCEIRA']);
    await etapa(['EMPATADA B', 'QUARTA']);

    const publico = await api().get('/api/v1/ranking').query({ seasonId, limit: 100 });
    expect(publico.status, JSON.stringify(publico.body)).toBe(200);

    const empatadas = publico.body.items.filter(l => ['EMPATADA A', 'EMPATADA B'].includes(l.athlete.fullName));
    expect(empatadas, 'as duas aparecem na vista pública').toHaveLength(2);

    for (const linha of empatadas) {
      expect(linha.tieUnresolved, `${linha.athlete.fullName} empatada`).toBe(true);
      expect(linha.position, 'ninguém recebe colocação num empate não resolvido').toBeNull();
      expect(linha.totalPoints).toBe(5);
    }
  });
});
