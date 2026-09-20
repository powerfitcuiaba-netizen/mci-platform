import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, criarEventoCompleto, transicionar, gerarCpf, unico, comoAtor
} from './helpers.mjs';
import rankingService from '../src/services/rankingService.js';

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

// ============================================================================
// O TETO SÓ APARECE QUANDO HÁ O QUE CORTAR.
//
// Com uma dúzia de atletas, "ler tudo" e "ler o topo" são a mesma coisa: a
// consulta traz doze linhas dos dois jeitos, e o teto de 200 nunca encosta.
// Foi exatamente isso que a mutação mostrou — desligar o teto não reprovava
// nada, porque nenhum teste chegava perto dele.
//
// Aqui a temporada tem mais atletas pontuando do que o teto permite trazer. A
// semeadura é DIRETA, por SQL, e não pelo fluxo de inscrição: o que está sob
// medição é o volume lido pela consulta de agregação, e montar 260 campeonatos
// pela porta da frente mediria o helper de teste, não a consulta.
//
// Dados de QA, marcados como tal no nome.
// ============================================================================
describe('a consulta pública tem teto, e o teto vale', () => {
  const QUANTOS = 260;
  const TETO_DECLARADO = 200;

  async function semearPontuadoras() {
    await comoAtor(diretor, async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Athlete" (id, "organizationId", "fullName", sex, country, "updatedAt")
        SELECT 'qa-so-atleta-' || lpad(g::text, 4, '0'), $1,
               'QA SUPER OVERALL ' || lpad(g::text, 4, '0'), 'FEMALE', 'BR', now()
        FROM generate_series(1, ${QUANTOS}) AS g
      `, orgId);

      // Totais DISTINTOS e decrescentes: sem empate, o corte é limpo e o
      // número de linhas lidas responde só ao teto.
      await tx.$executeRawUnsafe(`
        INSERT INTO "RankingPoint"
          -- As colunas placing e points VÃO ENTRE ASPAS. PLACING é palavra reservada do
          -- PostgreSQL (vem de OVERLAY(... PLACING ...)), e sem aspas o parser
          -- reprova a lista inteira com "syntax error at or near".
          -- organizationId passou a ser OBRIGATORIO e e ele que a politica de
          -- RLS confere: sem a coluna, o INSERT e recusado por "new row
          -- violates row-level security policy". A tenancy do ledger deixou de
          -- ser deduzida do atleta, que agora pode nao existir.
          -- (sem crase neste bloco: ele vive DENTRO de um template literal, e
          --  uma crase aqui fecha o literal antes da hora.)
          (id, "seasonId", "organizationId", "athleteId", "source", "placing",
           "placementPoints", "overallBonus", "superOverallEligible", "points", "superOverallPoints")
        SELECT 'qa-so-ponto-' || lpad(g::text, 4, '0'), $1, $2,
               'qa-so-atleta-' || lpad(g::text, 4, '0'), 'EVENT', NULL,
               ${QUANTOS + 10} - g, 0, true, ${QUANTOS + 10} - g, ${QUANTOS + 10} - g
        FROM generate_series(1, ${QUANTOS}) AS g
      `, seasonId, orgId);
    });

    // A CONSULTA PÚBLICA LÊ A PROJEÇÃO, e não o ledger — `RankingPoint` tem
    // RLS de operador e esta rota é anônima. Semear por SQL cru enche o ledger
    // e deixa a projeção vazia; é o recálculo que a publica, como em produção.
    const ranking = await import('../src/services/rankingService.js');
    await comoAtor(diretor, () => ranking.recompute_(seasonId));
  }

  it('lê o teto, e não a temporada inteira, mesmo com centenas pontuando', async () => {
    await semearPontuadoras();

    const pontuadoras = await comoAtor(diretor, tx => tx.rankingPoint.count({
      where: { seasonId, superOverallEligible: true }
    }));
    expect(pontuadoras, 'há mais pontuadoras que o teto').toBeGreaterThan(TETO_DECLARADO);

    const publico = await api().get('/api/v1/ranking/super-overall')
      .set('X-MCI-QA-Metrics', '1')
      .query({ seasonId, limit: 100 });

    expect(publico.status).toBe(200);
    const lidas = Number(publico.headers['x-mci-rows-read']);
    expect(Number.isFinite(lidas), 'a rota informa quantas linhas leu').toBe(true);
    expect(lidas, 'o teto da pré-seleção segura a consulta').toBeLessThanOrEqual(TETO_DECLARADO);
    expect(lidas, 'e o teto é o que está segurando, não a falta de dados').toBeLessThan(pontuadoras);
  });

  it('cortar no teto não muda quem aparece no topo público', async () => {
    await semearPontuadoras();

    const publico = await api().get('/api/v1/ranking/super-overall').query({ seasonId, limit: 100 });
    const operador = await api().get('/api/v1/ranking/super-overall').set(diretor.auth()).query({ seasonId, limit: 100 });

    const doPublico = publico.body.items ?? publico.body;
    const doOperador = operador.body.items ?? operador.body;

    expect(doPublico).toHaveLength(5);
    // O operador lê sem teto: as cinco primeiras linhas dele são a referência.
    expect(doPublico, 'o corte econômico devolve o MESMO topo').toEqual(doOperador.slice(0, 5));
    expect(doPublico[0].athlete.fullName).toBe('QA SUPER OVERALL 0001');
    expect(doPublico.map(l => l.position)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ============================================================================
// O CONTRATO DA PRÉ-SELEÇÃO, MEDIDO ONDE ELE EXISTE.
//
// A promessa da consulta com teto é: trazer o topo E, se o corte cair dentro
// de um bloco de empate, trazer o BLOCO INTEIRO — para que `classificar()`
// decida vendo o mesmo conjunto que veria sem corte.
//
// Essa promessa NÃO é observável pela resposta pública: ela mostra cinco
// linhas, e os campos dessas cinco já estão determinados pela sexta. Partir o
// bloco na sexta devolveria exatamente o mesmo JSON. Medir só pela porta da
// frente, portanto, não mede isto — foi o que a mutação mostrou ao partir o
// bloco sem reprovar nada.
//
// Aqui a pré-seleção é chamada direto.
// ============================================================================
describe('pré-seleção: o bloco de empate não é partido no corte', () => {
  // Três totais distintos no topo e SETE atletas empatadas logo abaixo: o
  // corte de cinco cai no meio do bloco.
  async function semearEmpateNoCorte() {
    await comoAtor(diretor, async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Athlete" (id, "organizationId", "fullName", sex, country, "updatedAt")
        SELECT 'qa-emp-atleta-' || lpad(g::text, 3, '0'), $1,
               'QA EMPATE ' || lpad(g::text, 3, '0'), 'FEMALE', 'BR', now()
        FROM generate_series(1, 10) AS g
      `, orgId);

      // g de 1 a 3: totais 30, 29, 28. g de 4 a 10: todas com 20.
      await tx.$executeRawUnsafe(`
        INSERT INTO "RankingPoint"
          -- organizationId e obrigatorio e e ele que a politica de RLS
          -- confere: sem a coluna o INSERT e recusado. (sem crase neste
          -- bloco: ele vive dentro de um template literal.)
          (id, "seasonId", "organizationId", "athleteId", "source", "placing",
           "placementPoints", "overallBonus", "superOverallEligible", "points", "superOverallPoints")
        SELECT 'qa-emp-ponto-' || lpad(g::text, 3, '0'), $1, $2,
               'qa-emp-atleta-' || lpad(g::text, 3, '0'), 'EVENT', NULL,
               CASE WHEN g <= 3 THEN 31 - g ELSE 20 END, 0, true,
               CASE WHEN g <= 3 THEN 31 - g ELSE 20 END,
               CASE WHEN g <= 3 THEN 31 - g ELSE 20 END
        FROM generate_series(1, 10) AS g
      `, seasonId, orgId);
    });

    // A pre-selecao le a PROJECAO publica, e nao o ledger. Semear por SQL cru
    // enche o ledger e deixa a projecao vazia; e o recalculo que a publica.
    await comoAtor(diretor, () => rankingService.recompute_(seasonId));
  }

  it('o corte dentro do empate traz o bloco inteiro, não limite + 1', async () => {
    await semearEmpateNoCorte();

    const { linhas } = await comoAtor(diretor, () => rankingService.agregarSuperOverall({
      seasonId, categoryId: undefined, limite: 5
    }));

    const empatadas = linhas.filter(l => l.totalPoints === 20).map(l => l.athleteId).sort();
    expect(empatadas.length, 'as SETE empatadas chegam ao motor, não só as que cabem no corte')
      .toBe(7);
    expect(linhas.length, 'topo distinto + bloco inteiro').toBe(10);
  });

  it('corte limpo devolve limite + 1, e não mais', async () => {
    // Dez atletas com totais TODOS distintos: o corte de cinco não encosta em
    // empate nenhum, e a pré-seleção pode descartar o excedente.
    await comoAtor(diretor, async tx => {
      await tx.$executeRawUnsafe(`
        INSERT INTO "Athlete" (id, "organizationId", "fullName", sex, country, "updatedAt")
        SELECT 'qa-lmp-atleta-' || lpad(g::text, 3, '0'), $1,
               'QA LIMPO ' || lpad(g::text, 3, '0'), 'FEMALE', 'BR', now()
        FROM generate_series(1, 10) AS g
      `, orgId);
      await tx.$executeRawUnsafe(`
        INSERT INTO "RankingPoint"
          -- organizationId e obrigatorio e e ele que a politica de RLS
          -- confere. (sem crase neste bloco: ele vive dentro de um
          -- template literal.)
          (id, "seasonId", "organizationId", "athleteId", "source", "placing",
           "placementPoints", "overallBonus", "superOverallEligible", "points", "superOverallPoints")
        SELECT 'qa-lmp-ponto-' || lpad(g::text, 3, '0'), $1, $2,
               'qa-lmp-atleta-' || lpad(g::text, 3, '0'), 'EVENT', NULL,
               40 - g, 0, true, 40 - g, 40 - g
        FROM generate_series(1, 10) AS g
      `, seasonId, orgId);
    });

    // A pre-selecao le a PROJECAO publica; e o recalculo que a publica.
    await comoAtor(diretor, () => rankingService.recompute_(seasonId));

    const { linhas, lidas } = await comoAtor(diretor, () => rankingService.agregarSuperOverall({
      seasonId, categoryId: undefined, limite: 5
    }));

    expect(linhas.length, 'cinco do corte mais a vizinha que prova que não há empate').toBe(6);
    expect(lidas, 'lidas conta o que a consulta trouxe, não o que sobrou do corte').toBe(10);
  });
});
