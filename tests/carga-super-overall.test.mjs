import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, prisma, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// FASE 13 — O SUPER OVERALL PÚBLICO NÃO PODE CARREGAR A TEMPORADA INTEIRA.
//
// A medição de carga encontrou: com 10.000 atletas e 100.000 pontos, a rota
// pública do Super Overall trazia 25.000 LINHAS do banco para agregar em
// memória e devolver CINCO. p50 de 224ms e p99 de 334ms, contra 6,5ms do
// ranking comum — e um anônimo pode disparar isso à vontade.
//
// A correção NÃO pode mover a regra esportiva para o SQL. Colocação e empate
// continuam saindo de `classificar()`, que é a autoridade homologada: se a
// hierarquia de desempate existisse em dois lugares, um dia divergiriam.
//
// O que o banco passa a fazer é PRÉ-SELEÇÃO conservadora — agrega por atleta e
// devolve só os primeiros, incluindo TODOS os empatados com o último, para que
// o motor em JavaScript continue vendo o bloco de empate inteiro e decida o
// mesmo que decidia antes.
//
// Os testes abaixo cobram as duas coisas: que a resposta é IDÊNTICA à do
// caminho completo, e que o volume lido encolheu.
// ============================================================================

let admin, diretor, orgId, seasonId;

const cpfSeq = (() => { let n = 250000000; return () => gerarCpf(n += 4451); })();
let cpfPorNome = new Map();
const cpfDe = nome => {
  if (!cpfPorNome.has(nome)) cpfPorNome.set(nome, cpfSeq());
  return cpfPorNome.get(nome);
};

async function etapa(colocadas) {
  const montado = await criarEventoCompleto(diretor, orgId, { seasonId });
  const { event, competitionClass } = montado;
  await transicionar(diretor, event.id, ['PLANNED', 'REGISTRATIONS_OPEN']);

  const inscritos = [];
  for (const nome of colocadas) {
    const inscricao = await api().post(`/api/v1/events/${event.id}/registrations`).set(diretor.auth())
      .send({ cpf: cpfDe(nome), athlete: { fullName: nome, sex: 'FEMALE' }, classIds: [competitionClass.id] });
    expect(inscricao.status, JSON.stringify(inscricao.body)).toBe(201);
    inscritos.push({ nome, registrationId: inscricao.body.registration.id, athleteId: inscricao.body.registration.athlete.id });
  }

  await transicionar(diretor, event.id, ['REGISTRATIONS_CLOSED', 'IN_OPERATION']);
  for (const i of inscritos) {
    await api().post(`/api/v1/registrations/${i.registrationId}/checkin`).set(diretor.auth()).send({});
  }
  await transicionar(diretor, event.id, ['IN_JUDGING']);
  await api().post(`/api/v1/classes/${competitionClass.id}/result`).set(diretor.auth())
    .send({ entries: inscritos.map((item, i) => ({ athleteId: item.athleteId, placing: i + 1 })) });
  await api().post(`/api/v1/classes/${competitionClass.id}/result/publish`).set(diretor.auth())
    .send({ note: 'Homologado' });

  return inscritos;
}

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
  seasonId = temporada.body.id;
});

describe('a vista pública lê pouco — e responde o mesmo', () => {
  it('público e operador concordam sobre o topo', async () => {
    // Oito pontuadoras com totais distintos no topo, como no teste do TOP 5.
    await etapa(['A1', 'A2', 'A3', 'A4', 'A5']);
    await etapa(['A1', 'A2', 'A3', 'A6', 'A7']);
    await etapa(['A1', 'A2', 'A4', 'A5', 'A8']);

    const publico = await api().get('/api/v1/ranking/super-overall').query({ seasonId, limit: 100 });
    const operador = await api().get('/api/v1/ranking/super-overall').set(diretor.auth()).query({ seasonId, limit: 100 });

    expect(publico.status).toBe(200);
    const doPublico = publico.body.items ?? publico.body;
    const doOperador = operador.body.items ?? operador.body;

    expect(doPublico).toHaveLength(5);
    expect(doOperador.length, 'o operador vê todas').toBeGreaterThan(5);

    // As cinco primeiras linhas têm de ser IGUAIS, campo a campo: mesmo
    // atleta, mesma posição, mesmo total, mesmos contadores. Se a pré-seleção
    // no banco mudasse a resposta, seria aqui que apareceria.
    expect(doPublico).toEqual(doOperador.slice(0, 5));
  });

  it('empate no corte continua sem colocação nos dois caminhos', async () => {
    // Duas atletas vencem etapas diferentes: mesmo total, mesmos contadores.
    // A hierarquia oficial não as separa, e nenhuma das duas pode receber
    // colocação — nem quando o corte público passa exatamente por elas.
    await etapa(['EMPATADA A', 'TERCEIRA']);
    await etapa(['EMPATADA B', 'QUARTA']);

    const publico = await api().get('/api/v1/ranking/super-overall').query({ seasonId, limit: 100 });
    const operador = await api().get('/api/v1/ranking/super-overall').set(diretor.auth()).query({ seasonId, limit: 100 });

    const doPublico = publico.body.items ?? publico.body;
    const doOperador = operador.body.items ?? operador.body;

    const empatadasPublicas = doPublico.filter(l => ['EMPATADA A', 'EMPATADA B'].includes(l.athlete.fullName));
    expect(empatadasPublicas, 'as duas aparecem').toHaveLength(2);
    for (const linha of empatadasPublicas) {
      expect(linha.tieUnresolved, `${linha.athlete.fullName}`).toBe(true);
      expect(linha.position).toBeNull();
    }

    // E o operador enxerga exatamente o mesmo bloco.
    const empatadasDoOperador = doOperador.filter(l => ['EMPATADA A', 'EMPATADA B'].includes(l.athlete.fullName));
    expect(empatadasDoOperador.map(l => l.tieUnresolved)).toEqual([true, true]);
  });

  it('a vista pública NÃO carrega todos os pontos da temporada', async () => {
    // Doze atletas, várias etapas: o suficiente para que "ler tudo" e "ler o
    // topo" sejam quantidades diferentes de linhas.
    const nomes = Array.from({ length: 12 }, (_, i) => `ATLETA ${String(i).padStart(2, '0')}`);
    await etapa(nomes.slice(0, 5));
    await etapa(nomes.slice(3, 8));
    await etapa(nomes.slice(6, 11));

    const totalDePontos = await comoAtor(diretor, tx => tx.rankingPoint.count({
      where: { seasonId, superOverallEligible: true }
    }));
    expect(totalDePontos, 'há bem mais pontos do que linhas no topo').toBeGreaterThan(10);

    // O contador de linhas LIDAS pela consulta pública. Sem instrumentar o
    // Prisma, a medida honesta é o tamanho do conjunto que a rota precisa
    // materializar — e a rota expõe isso por cabeçalho no modo de QA.
    const publico = await api().get('/api/v1/ranking/super-overall')
      .set('X-MCI-QA-Metrics', '1')
      .query({ seasonId, limit: 100 });

    expect(publico.status).toBe(200);
    const lidas = Number(publico.headers['x-mci-rows-read']);
    expect(Number.isFinite(lidas), 'a rota informa quantas linhas leu').toBe(true);
    expect(lidas, 'a vista pública lê o topo, não a temporada inteira').toBeLessThan(totalDePontos);
  });
});
