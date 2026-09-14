import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao, vincular, criarEventoCompleto, transicionar, gerarCpf } from './helpers.mjs';

// ============================================================================
// O TÍTULO OVERALL, PROVADO PELO NEGATIVO.
//
// O Momento Campeão é o ponto de maior intensidade do produto — é o único
// efeito de nível 5. Provar que ele FUNCIONA é a parte fácil e já estava
// feita. O que decide se ele pode ir a produção é o contrário:
//
//   provar que ele NÃO acontece quando não deveria.
//
// A plataforma NÃO decide campeão. Ela registra uma declaração da organização
// (`EventOverallTitle`). Cada teste abaixo é uma porta que precisa estar
// trancada para que essa frase continue verdadeira.
// ============================================================================

let organizacao, admin, diretor, gerenteDeRanking, semPermissao, evento, classe, categoria;
let atletaA, atletaB;
let outraOrg, outroEvento, atletaDaOutraOrg, diretorDaOutraOrg;

const inscrever = async (eventId, classId, nome, semente) => {
  const resposta = await api()
    .post(`/api/v1/events/${eventId}/registrations`)
    .set(diretor.auth())
    .send({
      cpf: gerarCpf(semente),
      athlete: { fullName: nome, sex: 'FEMALE', birthDate: '1996-05-10', state: 'MT', city: 'Cuiabá' },
      classIds: [classId]
    });
  if (resposta.status !== 201) throw new Error(`inscrição: ${resposta.status} ${JSON.stringify(resposta.body)}`);
  // A rota devolve `{ registration, athleteRecognized }` — o atleta está
  // dentro da inscrição, e não na raiz.
  return resposta.body.registration;
};

beforeAll(async () => {
  garantirCatalogo();
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin' });
  organizacao = await criarOrganizacao(admin, { name: 'MCI Brasil' });

  diretor = await criarUsuario({ name: 'Diretor' });
  await vincular(organizacao.id, diretor, 'EVENT_DIRECTOR');
  gerenteDeRanking = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizacao.id, gerenteDeRanking, 'RANKING_MANAGER');
  // Vinculado à organização, mas SEM `ranking.manage`: é o caso que importa.
  // Um estranho sem vínculo nenhum seria fácil demais de barrar.
  semPermissao = await criarUsuario({ name: 'Operador de Check-in' });
  await vincular(organizacao.id, semPermissao, 'CHECKIN_OPERATOR');

  const montado = await criarEventoCompleto(diretor, organizacao.id);
  evento = montado.event;
  classe = montado.competitionClass;
  categoria = montado.category;
  await transicionar(diretor, evento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  atletaA = (await inscrever(evento.id, classe.id, 'Carlos Mendes', 900001)).athlete;
  atletaB = (await inscrever(evento.id, classe.id, 'Marina Alves', 900002)).athlete;

  // Uma segunda organização inteira: é o que permite provar isolamento.
  const admin2 = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Admin 2' });
  outraOrg = await criarOrganizacao(admin2, { name: 'Outra Federação' });
  diretorDaOutraOrg = await criarUsuario({ name: 'Diretor 2' });
  await vincular(outraOrg.id, diretorDaOutraOrg, 'EVENT_DIRECTOR');
  await vincular(outraOrg.id, diretorDaOutraOrg, 'RANKING_MANAGER');
  const montado2 = await criarEventoCompleto(diretorDaOutraOrg, outraOrg.id, { categoryCode: 'WELLNESS' });
  outroEvento = montado2.event;
  await transicionar(diretorDaOutraOrg, outroEvento.id, ['PLANNED', 'REGISTRATIONS_OPEN']);
  const resposta = await api()
    .post(`/api/v1/events/${outroEvento.id}/registrations`)
    .set(diretorDaOutraOrg.auth())
    .send({
      cpf: gerarCpf(900003),
      athlete: { fullName: 'Atleta de Fora', sex: 'FEMALE', birthDate: '1996-05-10', state: 'SP', city: 'Santos' },
      classIds: [montado2.competitionClass.id]
    });
  atletaDaOutraOrg = resposta.body.registration.athlete;
}, 240000);

afterAll(async () => { await prisma.$disconnect(); });

const declarar = (usuario, eventId, corpo) => api()
  .post(`/api/v1/events/${eventId}/overall`)
  .set(usuario.auth())
  .send(corpo);

// -------------------------------------------------------------------- A
describe('A — resultado normal, sem Overall', () => {
  it('um evento com inscritos e sem declaração NÃO tem título nenhum', async () => {
    const titulos = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id } });
    expect(titulos.length, 'existe título sem ninguém ter declarado').toBe(0);

    const resposta = await api().get(`/api/v1/events/${evento.id}/overall`).set(diretor.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items).toEqual([]);
  });

  it('lançar e publicar resultado NÃO cria título Overall por tabela', async () => {
    // O ponto: primeiro lugar numa classe não é campeão Overall. Se o sistema
    // inferisse o Overall da colocação, ele estaria decidindo — e ele não
    // decide.
    const lancado = await api().post(`/api/v1/classes/${classe.id}/result`).set(diretor.auth()).send({
      entries: [
        { athleteId: atletaA.id, placing: 1, status: 'RANKED' },
        { athleteId: atletaB.id, placing: 2, status: 'RANKED' }
      ],
      source: 'EXTERNAL'
    });
    expect([200, 201], JSON.stringify(lancado.body).slice(0, 200)).toContain(lancado.status);
    const publicado = await api().post(`/api/v1/classes/${classe.id}/result/publish`).set(diretor.auth()).send({});
    expect(publicado.status, JSON.stringify(publicado.body)).toBe(200);

    const titulos = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id } });
    expect(titulos.length, 'a plataforma inventou um campeão a partir da colocação').toBe(0);
  });
});

// -------------------------------------------------------------------- C
describe('C — quem não tem a permissão não declara', () => {
  it('operador vinculado à organização, mas sem ranking.manage, é recusado', async () => {
    const resposta = await declarar(semPermissao, evento.id, { athleteId: atletaA.id });
    expect(resposta.status).toBe(403);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(0);
  });

  it('sem autenticação nenhuma, 401', async () => {
    const resposta = await api().post(`/api/v1/events/${evento.id}/overall`).send({ athleteId: atletaA.id });
    expect(resposta.status).toBe(401);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(0);
  });

  it('diretor de OUTRA organização não declara neste evento', async () => {
    const resposta = await declarar(diretorDaOutraOrg, evento.id, { athleteId: atletaA.id });
    expect(resposta.status).toBe(403);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(0);
  });
});

// -------------------------------------------------------------------- B
describe('B — o Overall legítimo', () => {
  it('quem tem ranking.manage declara, e o registro fica com autor e momento', async () => {
    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: atletaA.id, note: 'Decisão da comissão' });
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(201);

    const titulo = await prisma.eventOverallTitle.findFirst({ where: { eventId: evento.id } });
    expect(titulo.athleteId).toBe(atletaA.id);
    expect(titulo.categoryId).toBeNull();
    expect(titulo.declaredById, 'o título não registra quem declarou').toBe(gerenteDeRanking.id);
    expect(titulo.declaredAt).toBeTruthy();
  });

  // Lido pela ROTA de auditoria, não pelo banco: sob RLS, uma consulta direta
  // fora do contexto de um ator não enxerga a linha — e o que interessa aqui é
  // justamente o que o auditor vê.
  it('e a declaração fica na auditoria', async () => {
    const resposta = await api()
      .get(`/api/v1/audit?entity=Event&entityId=${evento.id}&organizationId=${organizacao.id}`)
      .set(admin.auth());
    expect(resposta.status, JSON.stringify(resposta.body)).toBe(200);
    const declaracoes = resposta.body.items.filter(item => item.action === 'OVERALL_DECLARE');
    expect(declaracoes.length, 'declarar campeão não deixou rastro').toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------- D
describe('D — declarar de novo não cria um segundo título', () => {
  it('a segunda declaração ATUALIZA a mesma linha', async () => {
    const antes = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id, categoryId: null } });
    expect(antes.length).toBe(1);

    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: atletaB.id, note: 'Correção' });
    expect(resposta.status).toBe(201);

    const depois = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id, categoryId: null } });
    expect(depois.length, 'o evento passou a ter dois campeões Overall').toBe(1);
    expect(depois[0].id, 'criou linha nova em vez de corrigir a existente').toBe(antes[0].id);
    expect(depois[0].athleteId).toBe(atletaB.id);
  });

  it('duas declarações ao mesmo tempo continuam resultando em UM título', async () => {
    const [um, dois] = await Promise.all([
      declarar(gerenteDeRanking, evento.id, { athleteId: atletaA.id }),
      declarar(gerenteDeRanking, evento.id, { athleteId: atletaB.id })
    ]);
    expect([um.status, dois.status].every(s => s === 201 || s === 409)).toBe(true);
    const titulos = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id, categoryId: null } });
    expect(titulos.length, 'a corrida entre dois cliques criou dois campeões').toBe(1);
  });
});

// -------------------------------------------------------------------- F e G
describe('F/G — o recorte por categoria', () => {
  it('declarar com categoryId cria um título SEPARADO, sem apagar o do evento', async () => {
    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: atletaA.id, categoryId: categoria.id });
    expect(resposta.status).toBe(201);
    expect(resposta.body.categoryId).toBe(categoria.id);

    const doEvento = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id, categoryId: null } });
    const daCategoria = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id, categoryId: categoria.id } });
    expect(doEvento.length, 'o Overall do evento sumiu ao declarar o da categoria').toBe(1);
    expect(daCategoria.length).toBe(1);
  });

  // O item G do roteiro pedia o caso "payload sem categoryId quando
  // obrigatório". Ele NÃO EXISTE neste produto, e isso é decisão de domínio,
  // não esquecimento: ausência de recorte significa "Overall do evento
  // inteiro", que é um título legítimo e distinto. O que precisa ser
  // verdade — e é o que este teste trava — é que a ausência não seja
  // CONFUNDIDA com um recorte: são duas linhas diferentes, e uma não
  // sobrescreve a outra.
  it('recorte ausente e recorte presente não se confundem', async () => {
    const todos = await prisma.eventOverallTitle.findMany({ where: { eventId: evento.id } });
    expect(todos.length).toBe(2);
    expect(todos.filter(t => t.categoryId === null).length).toBe(1);
    expect(todos.filter(t => t.categoryId === categoria.id).length).toBe(1);
  });

  it('categoria inventada é recusada, e não vira Overall do evento em silêncio', async () => {
    const antes = await prisma.eventOverallTitle.count({ where: { eventId: evento.id } });
    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: atletaA.id, categoryId: 'nao-existe' });
    expect(resposta.status, 'categoria inexistente foi aceita').toBeGreaterThanOrEqual(400);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(antes);
  });
});

// -------------------------------------------------------------------- E
describe('E — isolamento entre eventos e organizações', () => {
  it('o título de um evento não aparece no outro', async () => {
    const resposta = await api().get(`/api/v1/events/${outroEvento.id}/overall`).set(diretorDaOutraOrg.auth());
    expect(resposta.status).toBe(200);
    expect(resposta.body.items, 'o Overall vazou para outro evento').toEqual([]);
  });

  it('atleta de outra organização NÃO pode ser declarado campeão aqui', async () => {
    const antes = await prisma.eventOverallTitle.count({ where: { eventId: evento.id } });
    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: atletaDaOutraOrg.id });

    // MEDIDO: vem 404 ATHLETE_NOT_FOUND, e não o 422 ATHLETE_OTHER_ORGANIZATION
    // que o serviço também sabe devolver. O RLS barra antes: para este ator o
    // atleta da outra federação simplesmente não existe. É a resposta MAIS
    // segura das duas — o 422 confirmaria a existência do atleta a quem não
    // pode vê-lo. O que o teste trava é o efeito: nenhum título criado.
    expect(resposta.status).toBe(404);
    expect(resposta.body.error.code).toBe('ATHLETE_NOT_FOUND');
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(antes);
  });

  it('atleta inexistente não cria título', async () => {
    const antes = await prisma.eventOverallTitle.count({ where: { eventId: evento.id } });
    const resposta = await declarar(gerenteDeRanking, evento.id, { athleteId: 'atleta-que-nao-existe' });
    expect(resposta.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.eventOverallTitle.count({ where: { eventId: evento.id } })).toBe(antes);
  });
});

// -------------------------------------------------------------------- H
describe('H — não existe segunda porta para o nível 5', () => {
  // Esta é a trava estrutural. Se amanhã alguém criar um `EventOverallTitle`
  // em outro serviço — num importador, num seed, numa rotina de migração —
  // o efeito máximo do produto passa a ter um gatilho que ninguém auditou.
  it('só o rankingService escreve em EventOverallTitle', () => {
    const arquivos = listarFontes('src');
    const escrevem = arquivos.filter(caminho => {
      const fonte = readFileSync(caminho, 'utf8');
      return /eventOverallTitle\s*\.\s*(create|update|upsert|createMany|updateMany|delete|deleteMany)/.test(fonte);
    });
    expect(escrevem, `mais de um lugar declara Overall: ${escrevem.join(', ')}`)
      .toEqual(['src/services/rankingService.js']);
  });

  it('a rota de declaração é a única que aceita a declaração', () => {
    const rotas = readFileSync('src/routes/index.js', 'utf8');
    const linhas = rotas.split('\n').filter(linha => /declareOverall/.test(linha));
    expect(linhas.length).toBe(1);
    expect(linhas[0]).toMatch(/requireAuth/);
  });
});

// Varredura simples de arquivos, sem dependência nova.
function listarFontes(raiz) {
  const achados = [];
  const andar = dir => {
    for (const nome of readdirSync(dir)) {
      const caminho = path.join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (caminho.endsWith('.js')) achados.push(caminho);
    }
  };
  andar(raiz);
  return achados;
}
