// A INSTRUMENTAÇÃO PRECISA VIR ANTES DE A APLICAÇÃO CARREGAR. Ver o cabeçalho
// de `instrumentacao-consultas.mjs`: `prismaPublico` guarda a instância no topo
// do módulo, e depois disso não há mais o que envolver.
import { comecarAMedir, pararDeMedir } from './instrumentacao-consultas.mjs';

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// §14 — O RANKING PÚBLICO NÃO FAZ UMA IDA AO BANCO POR COMPETIDOR.
//
// O QUE MUDOU E POR QUE ISSO PRECISA SER MEDIDO AGORA
//
// Antes desta fase, o ranking público era montado a partir de `RankingPoint`,
// que carrega a relação com `Athlete`. Agora ele lê `PublicRankingEntry`, uma
// projeção materializada que já traz o nome de exibição na própria linha —
// justamente para que o competidor SEM CADASTRO tenha nome sem precisar de
// junção com uma tabela que, para ele, não tem linha.
//
// Essa troca resolve o problema de identidade, mas abre um risco de
// desempenho que não existia: se qualquer ponto do caminho voltar a buscar o
// atleta linha a linha — para "enriquecer" o nome, para resolver a categoria,
// para qualquer coisa —, uma etapa de 191 competidores vira 191 idas ao banco
// e ninguém percebe, porque o resultado continua CORRETO. N+1 não quebra
// teste de comportamento. Só aparece na conta.
//
// COMO A MEDIÇÃO FUNCIONA
//
// Duas temporadas idênticas em tudo menos no tamanho: uma com 5 competidores,
// outra com 191. A mesma rota, o mesmo ator (anônimo), a mesma resposta 200.
// Conta-se quantas consultas cada requisição dispara.
//
// O CRITÉRIO É A DIFERENÇA, NÃO O VALOR. Um teto absoluto ("menos de 20
// consultas") envelhece mal e vira ruído na primeira refatoração legítima. O
// que não pode mudar é a INCLINAÇÃO: se 191 competidores custam o mesmo número
// de consultas que 5, a leitura é em lote. Se custam 186 a mais, é N+1, e o
// número diz exatamente isso.
//
// A duração também é registrada, mas como observação. Runner compartilhado
// mede tempo mal; contagem de consulta é determinística.
// ============================================================================

const PEQUENA = 5;
const GRANDE = 191;

// EQUIPE E EMPRESA ENTRAM NO ARQUIVO DE PROPÓSITO.
//
// Sem elas, `/ranking/teams` e `/ranking/companies` respondem com a lista
// vazia, e a consulta que busca os nomes sai como `WHERE 1=0`. A medição
// passaria — e não teria medido nada, porque o N+1 que se procura nessas duas
// rotas é justamente a busca de nome por equipe. Vinte equipes e dez empresas
// dão à consulta em lote algo que resolver.
const CABECALHO =
  'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento,equipe,empresa';

const EQUIPES = 20;
const EMPRESAS = 10;

// Colocações de 1 a 7 em ciclo: exercita a faixa pontuada e a faixa de zero.
function arquivo(quantidade, prefixo) {
  const linhas = [CABECALHO];
  for (let i = 0; i < quantidade; i += 1) {
    linhas.push([
      `${prefixo}-${i}`, `QA COMPETIDOR ${i}`, 'NPC', `${prefixo}-${100000 + i}`,
      'BIKINI', 'OPEN', (i % 7) + 1, 'Etapa QA',
      `QA Equipe ${i % EQUIPES}`, `QA Empresa ${i % EMPRESAS}`
    ].join(','));
  }
  return linhas.join('\n');
}

let admin;
let gerente;
let organizationId;

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  organizationId = (await criarOrganizacao(admin, { name: 'MCI Brasil' })).id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  // O importador NÃO cria equipe nem empresa a partir do nome no arquivo: ele
  // só reconhece as que já existem na organização. Elas precisam ser semeadas
  // aqui, senão as duas rotas medem a lista vazia.
  for (let i = 0; i < EMPRESAS; i += 1) {
    const criada = await api().post('/api/v1/companies').set(admin.auth())
      .send({ organizationId, name: `QA Empresa ${i}` });
    expect(criada.status, JSON.stringify(criada.body).slice(0, 200)).toBe(201);
  }
  for (let i = 0; i < EQUIPES; i += 1) {
    const criada = await api().post('/api/v1/teams').set(admin.auth())
      .send({ organizationId, name: `QA Equipe ${i}` });
    expect(criada.status, JSON.stringify(criada.body).slice(0, 200)).toBe(201);
  }
});

// `ano` é PARÂMETRO, e não derivado do tamanho. Derivá-lo custou caro: com
// `2020 + quantidade`, a temporada de 191 competidores pedia o ano 2211, a
// criação era recusada pela validação, `seasonId` saía `undefined` — e aí o
// Prisma IGNORA a chave `undefined` no `where`, então a contagem "da temporada
// grande" devolvia as linhas da pequena, e a rota sem temporada caía em
// `temporadaPadrao()`, que é uma consulta a mais. Dois sintomas, uma causa, e
// nenhum deles no produto. A asserção de status existe para que a próxima
// falha de semeadura apareça como falha de semeadura.
async function temporadaCom(quantidade, prefixo, ano) {
  const criada = await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: `Temporada ${prefixo}`, year: ano });
  expect(criada.status, `criar temporada ${prefixo}: ${JSON.stringify(criada.body).slice(0, 300)}`)
    .toBe(201);
  const seasonId = criada.body.id;
  expect(seasonId, 'sem id de temporada a medição inteira mede outra coisa').toBeTruthy();

  // A TABELA HOMOLOGADA, e nenhuma outra.
  await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
    rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
      { placing: 4, points: 2 }, { placing: 5, points: 1 }]
  });

  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico(prefixo) + '.csv', content: arquivo(quantidade, prefixo)
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);

  const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
    .set(gerente.auth());
  expect(aplicacao.body.applied).toBe(quantidade);

  // A PROJEÇÃO é o que as rotas leem, então é ela que precisa ter o tamanho
  // que a medição diz estar medindo. Conferir `applied` não basta: ele conta
  // item de lote, não linha publicada.
  const publicadas = await comoAtor(gerente,
    tx => tx.publicRankingEntry.count({ where: { seasonId } }));
  expect(publicadas, `a temporada ${prefixo} precisa ter ${quantidade} linhas publicadas`)
    .toBe(quantidade);

  // E precisam ter equipe: sem isso a medição das rotas de equipe e empresa
  // não tem objeto. Esta asserção é o que impede a medição de passar vazia.
  const comEquipe = await comoAtor(gerente,
    tx => tx.publicRankingEntry.count({ where: { seasonId, teamId: { not: null } } }));
  expect(comEquipe, `a temporada ${prefixo} precisa ter linhas com equipe`).toBe(quantidade);

  return seasonId;
}

// Mede UMA requisição anônima, isolada: a medição começa depois de tudo estar
// gravado, para que a semeadura não entre na conta.
async function medirRanking(seasonId) {
  comecarAMedir();
  const comecou = Date.now();
  const resposta = await api().get('/api/v1/ranking').query({ seasonId });
  const duracao = Date.now() - comecou;
  const consultas = pararDeMedir();
  return { resposta, consultas, duracao };
}

describe('§14 o ranking público lê em lote, e não por competidor', () => {
  it('191 competidores custam o MESMO número de consultas que 5', async () => {
    const temporadaPequena = await temporadaCom(PEQUENA, 'peq', 2025);
    const temporadaGrande = await temporadaCom(GRANDE, 'gra', 2026);

    const pequena = await medirRanking(temporadaPequena);
    const grande = await medirRanking(temporadaGrande);

    // Primeiro: as duas respostas são de verdade. Uma rota quebrada dispara
    // zero consulta e passaria numa asserção que só olhasse a diferença.
    expect(pequena.resposta.status).toBe(200);
    expect(grande.resposta.status).toBe(200);
    expect(pequena.consultas.length, 'a instrumentação precisa estar medindo')
      .toBeGreaterThan(0);

    // O CORPO DAS DUAS RESPOSTAS TEM O MESMO TAMANHO, e isso é o desenho: a
    // vista anônima é cortada no topo 5 (`TOP_PUBLICO`). Comparar o número de
    // itens devolvidos não diria nada sobre N+1 — o que diferencia as duas
    // medições é quantas linhas a consulta ATRAVESSOU, e isso `temporadaCom`
    // já conferiu na projeção. Aqui só se confirma que o corte é o mesmo nas
    // duas, para que a diferença de consultas não tenha outra explicação.
    expect(pequena.resposta.body.items.length).toBe(PEQUENA);
    expect(grande.resposta.body.items.length).toBe(PEQUENA);

    const diferenca = grande.consultas.length - pequena.consultas.length;

    // A ASSERÇÃO. Inclinação zero: o custo não acompanha o tamanho.
    expect(diferenca,
      `${PEQUENA} competidores: ${pequena.consultas.length} consultas; ` +
      `${GRANDE}: ${grande.consultas.length}. ` +
      `Diferença ${diferenca} — se acompanhar o tamanho, voltou N+1.`
    ).toBe(0);

    // Observação, não gate: o tempo é medido e registrado para quem ler o log.
    expect(grande.duracao,
      `${GRANDE} competidores responderam em ${grande.duracao}ms ` +
      `(${PEQUENA} em ${pequena.duracao}ms)`
    ).toBeLessThan(10000);
  }, 120_000);

  it('Super Overall, equipes e empresas também leem em lote', async () => {
    const temporadaPequena = await temporadaCom(PEQUENA, 'peq', 2025);
    const temporadaGrande = await temporadaCom(GRANDE, 'gra', 2026);

    // Os outros três recortes públicos passaram a ler a mesma projeção nesta
    // fase. Nenhum deles tem teste de comportamento que denunciaria um N+1.
    const rotas = [
      '/api/v1/ranking/super-overall',
      '/api/v1/ranking/teams',
      '/api/v1/ranking/companies'
    ];

    for (const rota of rotas) {
      comecarAMedir();
      const pequena = await api().get(rota).query({ seasonId: temporadaPequena });
      const consultasPequena = pararDeMedir();

      comecarAMedir();
      const grande = await api().get(rota).query({ seasonId: temporadaGrande });
      const consultasGrande = pararDeMedir();

      expect(pequena.status, `${rota} com ${PEQUENA}`).toBe(200);
      expect(grande.status, `${rota} com ${GRANDE}`).toBe(200);
      expect(consultasPequena.length, `${rota} precisa consultar algo`).toBeGreaterThan(0);

      expect(consultasGrande.length - consultasPequena.length,
        `${rota}: ${consultasPequena.length} consultas para ${PEQUENA} ` +
        `e ${consultasGrande.length} para ${GRANDE}`
      ).toBe(0);
    }
  }, 120_000);

  it('aplicar uma etapa inteira não faz uma transação por linha', async () => {
    const seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
      .send({ organizationId, name: 'Temporada da carga', year: 2031 })).body.id;
    await api().put(`/api/v1/seasons/${seasonId}/points-rules`).set(admin.auth()).send({
      rules: [{ placing: 1, points: 5 }, { placing: 2, points: 4 }, { placing: 3, points: 3 },
        { placing: 4, points: 2 }, { placing: 5, points: 1 }]
    });
    const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
      organizationId, seasonId, sourceType: 'CSV',
      sourceRef: unico('carga') + '.csv', content: arquivo(GRANDE, 'car')
    });

    comecarAMedir();
    const comecou = Date.now();
    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.body.import.id}/apply`)
      .set(gerente.auth());
    const duracao = Date.now() - comecou;
    const consultas = pararDeMedir();

    expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
    expect(aplicacao.body.applied).toBe(GRANDE);

    // Aqui a escrita é por linha por construção — cada resultado é uma linha
    // nova com chave de idempotência própria, e agrupar isso em `createMany`
    // custaria a capacidade de dizer QUAL linha conflitou. Então o teto não é
    // "constante": é "proporcional com constante pequena".
    //
    // O que este número protege é o RESTO do caminho: resolução de identidade,
    // categoria, classe, temporada. Se qualquer um deles virar uma busca por
    // linha, a razão salta, e é a razão que a asserção fixa.
    const porLinha = consultas.length / GRANDE;
    expect(porLinha,
      `${consultas.length} consultas para ${GRANDE} linhas = ` +
      `${porLinha.toFixed(2)} por linha, em ${duracao}ms`
    ).toBeLessThan(12);

    // E o ledger tem exatamente uma linha por competidor — nem repetida nem
    // perdida no caminho em lote.
    const pontos = await comoAtor(gerente, tx => tx.rankingPoint.count());
    expect(pontos).toBe(GRANDE);
  }, 120_000);
});
