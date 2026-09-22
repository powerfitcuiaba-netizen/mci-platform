import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  api, limparBanco, garantirCatalogo, criarUsuario, criarOrganizacao,
  vincular, unico, comoAtor
} from './helpers.mjs';

// ============================================================================
// A CAUSA REAL DO "TUDO ZERO" — E ELA NÃO ERA A TELA.
//
// Um campeonato inteiro foi importado e apareceu no ranking com pontuação
// zero em todas as linhas. Nenhum conflito, nenhuma rejeição, "191 aplicados".
//
// A aritmética é esta: `pontuarResultado` procura a colocação na TABELA DA
// TEMPORADA e, não achando, devolve zero — que é o comportamento certo para o
// 6º lugar em diante. Numa temporada SEM TABELA NENHUMA não se acha colocação
// alguma: todo 1º lugar vale zero e a aplicação termina anunciando sucesso.
//
// MEDIDO, E É PRECISO DIZER: pelo caminho normal esse estado NÃO ACONTECE.
// `createSeason` faz a temporada nascer com a tabela homologada, e
// `setPointsRules` exige pelo menos uma regra. Este arquivo constrói o estado
// À MÃO, apagando as regras, porque a proteção precisa existir para quem
// chegar por fora do caminho normal — carga, script, restauração parcial.
//
// A correção não é somar pontos por conta própria: é RECUSAR a aplicação.
// Uma temporada sem tabela homologada não sabe quanto vale um primeiro
// lugar, e a plataforma não vai inventar.
// ============================================================================

let admin;
let gerente;
let organizationId;
let seasonId;

const CABECALHO = 'external_result_id,atleta,filiacao,matricula,categoria,classe,colocacao,evento';

const arquivo = () => [
  CABECALHO,
  'QA-Z-1,QA ATLETA UM,NPC,QA-Z-001,BIKINI,Women\'s Bikini - Open Class A,1,Etapa QA',
  'QA-Z-2,QA ATLETA DOIS,NPC,QA-Z-002,BIKINI,Women\'s Bikini - Open Class A,2,Etapa QA',
  'QA-Z-3,QA ATLETA TRES,NPC,QA-Z-003,BIKINI,Women\'s Bikini - Open Class A,3,Etapa QA'
].join('\n');

beforeAll(() => garantirCatalogo());

beforeEach(async () => {
  await limparBanco();

  admin = await criarUsuario({ role: 'SUPER_ADMIN', name: 'Administrador' });
  const org = await criarOrganizacao(admin, { name: 'MCI Brasil' });
  organizationId = org.id;

  gerente = await criarUsuario({ name: 'Gerente de Ranking' });
  await vincular(organizationId, gerente, 'RANKING_MANAGER');
  await vincular(organizationId, gerente, 'REGISTRATION_OPERATOR');

  await api().post('/api/v1/affiliations').set(admin.auth())
    .send({ organizationId, name: 'NPC Brasil', code: 'NPC' });

  seasonId = (await api().post('/api/v1/seasons').set(admin.auth())
    .send({ organizationId, name: 'Temporada QA 2026', year: 2026 })).body.id;
});

// A temporada nasce COM a tabela homologada. Para medir a proteção é preciso
// desfazer isso à mão — e é justamente por não haver rota que faça isso que a
// proteção é para quem chega por fora.
async function apagarATabelaDaTemporada() {
  await comoAtor(admin, tx => tx.rankingPointsRule.deleteMany({ where: { seasonId } }));
}

async function criarLote() {
  const lote = await api().post('/api/v1/musclewar/imports').set(gerente.auth()).send({
    organizationId, seasonId, sourceType: 'CSV',
    sourceRef: unico('zero') + '.csv', content: arquivo()
  });
  expect(lote.status, JSON.stringify(lote.body).slice(0, 300)).toBe(201);
  return lote.body;
}

describe('temporada sem tabela de pontos não aplica resultado nenhum', () => {
  it('a prévia AVISA, em vez de deixar o operador descobrir no ranking', async () => {
    await apagarATabelaDaTemporada();
    const lote = await criarLote();

    // O aviso é do LOTE, e chega junto com o resumo que o operador já lê.
    expect(lote.summary.seasonWithoutPointsTable, JSON.stringify(lote.summary)).toBe(true);
  });

  it('a aplicação RECUSA, e o ledger continua vazio', async () => {
    await apagarATabelaDaTemporada();
    const lote = await criarLote();

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`)
      .set(gerente.auth());

    expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(422);
    expect(aplicacao.body.error.code).toBe('SEASON_WITHOUT_POINTS_TABLE');

    // NADA foi gravado. Meia aplicação seria pior que nenhuma.
    const gravado = await comoAtor(gerente, async tx => ({
      pontos: await tx.rankingPoint.count(),
      externos: await tx.externalResult.count()
    }));
    expect(gravado).toEqual({ pontos: 0, externos: 0 });
  });

  it('com a tabela homologada — que é como a temporada nasce — valem 5, 4 e 3', async () => {
    const lote = await criarLote();
    expect(lote.summary.seasonWithoutPointsTable).toBe(false);

    const aplicacao = await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`)
      .set(gerente.auth());
    expect(aplicacao.status, JSON.stringify(aplicacao.body).slice(0, 300)).toBe(200);
    expect(aplicacao.body.applied).toBe(3);

    const pontos = await comoAtor(gerente, tx => tx.rankingPoint.findMany({
      where: { seasonId }, select: { placing: true, points: true }, orderBy: { placing: 'asc' }
    }));

    expect(pontos.map(p => [p.placing, p.points])).toEqual([[1, 5], [2, 4], [3, 3]]);
  });

  it('e o ranking mostra o total real, sem fallback que disfarce zero', async () => {
    const lote = await criarLote();
    await api().post(`/api/v1/musclewar/imports/${lote.import.id}/apply`).set(gerente.auth());
    await api().post(`/api/v1/seasons/${seasonId}/recompute`).set(admin.auth());

    const resposta = await api().get('/api/v1/ranking').query({ seasonId });
    expect(resposta.status).toBe(200);

    const totais = resposta.body.items.map(linha => linha.totalPoints).sort((a, b) => b - a);
    expect(totais).toEqual([5, 4, 3]);
    // E a categoria aparece: "Geral" na tela é sinal de categoria nula.
    expect(resposta.body.items.every(linha => linha.category?.code === 'BIKINI')).toBe(true);
  });
});
